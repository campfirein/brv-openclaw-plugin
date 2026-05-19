#!/usr/bin/env node
/**
 * Tier 3 smoke for the OpenClaw plugin v2 — drives the registered
 * `brv-curate` + `brv-query` agent tools end-to-end against a real `brv`
 * CLI (post-ENG-2851 envelope). Validates that the plugin's tool
 * factories wire up correctly and that `bridge.persistHtml` /
 * `bridge.queryEnvelope` reach the daemon through the OpenClaw shape.
 *
 * Requirements:
 *   - `brv` on PATH (dev build with ENG-2851 / proj/byterover-tool-mode)
 *   - `@byterover/brv-bridge` v2 linked into this plugin (npm link)
 *
 * Run:   node smoke/v2-plugin.mjs
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// resolveWorkspaceDir reads ~/.openclaw/openclaw.json and returns
// agents.defaults.workspace when present — which on a real machine usually
// overrides the smoke's cwd. Point HOME at a temp dir BEFORE the plugin
// loads so the read ENOENTs and the plugin falls back to bridgeConfig.cwd.
// ---------------------------------------------------------------------------
const HOME_DIR = "/tmp/brv-openclaw-plugin-smoke-home";
if (existsSync(HOME_DIR)) rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(HOME_DIR, { recursive: true });
process.env.HOME = HOME_DIR;

const byteRoverPlugin = (await import("../dist/index.js")).default;

const SMOKE_DIR = "/tmp/brv-openclaw-plugin-smoke";

// ---------------------------------------------------------------------------
// Tiny assertion harness (mirrors v2-bridge.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`);
    failed++;
    failures.push(label);
  }
}

async function scenario(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (err) {
    console.log(`  ✗ scenario threw — ${err?.message ?? err}`);
    failed++;
    failures.push(`${name}: threw`);
  }
}

// ---------------------------------------------------------------------------
// Setup: fresh smoke directory + brv init
// ---------------------------------------------------------------------------

console.log(`Setting up ${SMOKE_DIR}...`);
if (existsSync(SMOKE_DIR)) rmSync(SMOKE_DIR, { recursive: true, force: true });
mkdirSync(SMOKE_DIR, { recursive: true });

try {
  execSync("brv vc init", { cwd: SMOKE_DIR, stdio: "pipe" });
} catch (err) {
  console.error("brv init failed:", err.stderr?.toString() || err.message);
  process.exit(1);
}

const brvVersion = execSync("brv --version", { encoding: "utf8" }).trim();
console.log(`brv:    ${brvVersion}`);

// ---------------------------------------------------------------------------
// Mock OpenClawPluginApi — captures registered tools + context engine
// ---------------------------------------------------------------------------

const registeredTools = [];
let registeredEngineFactory = null;

const logger = {
  debug: (m) => process.env.SMOKE_VERBOSE && console.log(`  [debug] ${m}`),
  info:  (m) => process.env.SMOKE_VERBOSE && console.log(`  [info]  ${m}`),
  warn:  (m) => console.log(`  [warn]  ${m}`),
  error: (m) => console.log(`  [error] ${m}`),
};

const api = {
  config: {},
  pluginConfig: { cwd: SMOKE_DIR },
  logger,
  runtime: {},
  registerContextEngine(id, factory) {
    registeredEngineFactory = factory;
    if (process.env.SMOKE_VERBOSE) console.log(`  [api] registerContextEngine(${id})`);
  },
  registerTool(factory, opts) {
    registeredTools.push({ factory, opts });
    if (process.env.SMOKE_VERBOSE) console.log(`  [api] registerTool(${opts.name})`);
  },
};

// Load the plugin (invokes register)
byteRoverPlugin.register(api);

// Resolve the engine instance for the assemble-flow scenarios
const engine = await Promise.resolve(registeredEngineFactory());

// ---------------------------------------------------------------------------
// Scenario 0 — registration sanity
// ---------------------------------------------------------------------------

await scenario("0. plugin.register wires up context engine + 2 tools", async () => {
  check("context engine factory registered", typeof registeredEngineFactory === "function");
  check("2 tools registered", registeredTools.length === 2,
    `got ${registeredTools.length} tools`);
  check("first tool is brv-curate", registeredTools[0]?.opts.name === "brv-curate");
  check("second tool is brv-query", registeredTools[1]?.opts.name === "brv-query");
});

// ---------------------------------------------------------------------------
// Helpers — build tool, invoke execute, return payload
// ---------------------------------------------------------------------------

function buildTool(name) {
  const reg = registeredTools.find((r) => r.opts.name === name);
  if (!reg) throw new Error(`tool ${name} not registered`);
  return reg.factory({ workspaceDir: SMOKE_DIR });
}

async function callTool(name, args) {
  const tool = buildTool(name);
  const result = await tool.execute("smoke-call", args);
  return result.payload ?? JSON.parse(result.text);
}

// ---------------------------------------------------------------------------
// Scenario A — brv-curate happy path through the tool
// ---------------------------------------------------------------------------

await scenario("A. brv-curate tool — happy path writes a topic", async () => {
  const html =
    '<bv-topic path="security/jwt_signing" title="JWT signing">' +
    '<bv-decision id="d-rs256" severity="must">Use RS256 for JWT signing.</bv-decision>' +
    '<bv-reason>Public-key verifiers; private key only on issuer.</bv-reason>' +
    "</bv-topic>";

  const result = await callTool("brv-curate", { html });

  check("status === 'ok'", result.status === "ok", `got ${JSON.stringify(result)}`);
  if (result.status === "ok") {
    check("filePath sensible", result.filePath === "security/jwt_signing.html",
      `got filePath=${result.filePath}`);
    check("topicPath extensionless", result.topicPath === "security/jwt_signing",
      `got topicPath=${result.topicPath}`);
    check("file exists on disk",
      existsSync(`${SMOKE_DIR}/.brv/context-tree/${result.filePath}`),
      `expected ${SMOKE_DIR}/.brv/context-tree/${result.filePath}`);
  }
});

// ---------------------------------------------------------------------------
// Scenario B — brv-curate with meta (HITL plumbing)
// ---------------------------------------------------------------------------

await scenario("B. brv-curate tool — with meta envelope (HITL surfacing)", async () => {
  const html =
    '<bv-topic path="security/token_refresh" title="Token refresh">' +
    '<bv-rule severity="must">Rotate refresh tokens on every use.</bv-rule>' +
    "</bv-topic>";
  const meta = {
    type: "ADD",
    impact: "high",
    reason: "Reduces blast radius on token theft.",
    summary: "Refresh token rotation policy.",
  };

  const result = await callTool("brv-curate", { html, meta });
  check("status === 'ok' with meta", result.status === "ok",
    `got ${JSON.stringify(result)}`);
  if (result.status === "ok") {
    check("topic file exists",
      existsSync(`${SMOKE_DIR}/.brv/context-tree/security/token_refresh.html`));
  }

  // The curate-log entry lives under the global data dir, NOT the project
  // .brv (curate-log is per-project but rooted at the global brv data dir
  // — see `getProjectDataDir` in byterover-cli).
  // brv subprocesses inherit the overridden HOME — curate-log lands under
  // the smoke HOME's global brv data dir, and the project path is the
  // resolved (realpath) form, so on macOS /tmp → /private/tmp.
  const resolved = realpathSync(SMOKE_DIR);
  const sanitized = resolved.replace(/^\//, "").replaceAll("/", "--");
  const logDir = `${process.env.HOME}/Library/Application Support/brv/projects/${sanitized}/curate-log`;
  // macOS-only fallback path; on other platforms the global data dir differs.
  // We treat this as a best-effort assertion — the in-process log persistence
  // is verified by unit tests; here we just confirm SOME log entry was made.
  const found = existsSync(logDir);
  check("curate-log directory exists (HITL log dual-write fired)", found,
    `expected ${logDir} (advisory — global data dir varies per OS)`);
});

// ---------------------------------------------------------------------------
// Scenario C — brv-curate validation-failed surfaces structured errors
// ---------------------------------------------------------------------------

await scenario("C. brv-curate tool — malformed HTML returns validation-failed (no throw)", async () => {
  const result = await callTool("brv-curate", { html: "<div>not a bv-topic</div>" });

  check("status === 'validation-failed'",
    result.status === "validation-failed",
    `got ${JSON.stringify(result)}`);
  if (result.status === "validation-failed") {
    check("errors[] is non-empty", Array.isArray(result.errors) && result.errors.length > 0);
    check("first error names missing-bv-topic",
      result.errors.some((e) => e.kind?.includes("bv-topic") || e.message?.includes("bv-topic")),
      `errors=${JSON.stringify(result.errors)}`);
  }
});

// ---------------------------------------------------------------------------
// Scenario D — brv-query tool returns the raw envelope
// ---------------------------------------------------------------------------

await scenario("D. brv-query tool — returns raw QueryToolModeResult envelope", async () => {
  const result = await callTool("brv-query", { query: "JWT signing tokens" });

  check("envelope has status field", result.status === "ok" || result.status === "no-matches",
    `got status=${result.status}`);
  check("envelope has matchedDocs[]", Array.isArray(result.matchedDocs));
  check("envelope has metadata", typeof result.metadata === "object" && result.metadata !== null);
  if (result.metadata) {
    check("metadata.tier is number", typeof result.metadata.tier === "number");
    check("metadata.durationMs is number", typeof result.metadata.durationMs === "number");
  }
  if (result.matchedDocs?.length > 0) {
    const doc = result.matchedDocs[0];
    check("matched doc has rendered_md", typeof doc.rendered_md === "string" && doc.rendered_md.length > 0);
    check("matched doc has format html|markdown",
      doc.format === "html" || doc.format === "markdown");
  }
});

// ---------------------------------------------------------------------------
// Scenario E — assemble injects guidance + recalled context
// ---------------------------------------------------------------------------

await scenario("E. ContextEngine.assemble — injects guidance + recall content", async () => {
  const result = await engine.assemble({
    sessionId: "smoke-s1",
    messages: [],
    prompt: "JWT signing tokens",
  });

  check("systemPromptAddition is a non-empty string",
    typeof result.systemPromptAddition === "string" && result.systemPromptAddition.length > 0);
  check("contains <byterover-curate-guidance>",
    result.systemPromptAddition?.includes("<byterover-curate-guidance>"));
  // Should also include the recall context (matches from scenarios A+B were written).
  check("contains <byterover-context> when recall surfaces matches",
    result.systemPromptAddition?.includes("<byterover-context>"),
    `addition (truncated): ${result.systemPromptAddition?.slice(0, 200)}`);
});

// ---------------------------------------------------------------------------
// Scenario F — assemble injects guidance-only when query has no matches
// ---------------------------------------------------------------------------

await scenario("F. ContextEngine.assemble — guidance only when no matches", async () => {
  const result = await engine.assemble({
    sessionId: "smoke-s1",
    messages: [],
    prompt: "an obscure unmatched topic about quantum knitting patterns",
  });

  check("addition still has guidance",
    result.systemPromptAddition?.includes("<byterover-curate-guidance>"));
  // No-matches → no context block. (If brv returned anything BM25-ish on
  // 'topic', it would still surface; this scenario is best-effort and
  // tolerates either outcome.)
});

// ---------------------------------------------------------------------------
// Scenario G — afterTurn is a no-op (does NOT write a topic)
// ---------------------------------------------------------------------------

await scenario("G. ContextEngine.afterTurn — no-op (does NOT write a topic)", async () => {
  const before = countTopics();
  await engine.afterTurn({
    sessionId: "smoke-s1",
    sessionFile: "/tmp/fake-session.jsonl",
    messages: [
      { role: "user", content: "Decide: use Postgres for this project." },
      { role: "assistant", content: "Got it; let's use Postgres." },
    ],
    prePromptMessageCount: 0,
  });
  const after = countTopics();
  check("no new topic files after afterTurn", after === before,
    `before=${before}, after=${after}`);
});

function countTopics() {
  try {
    return execSync(
      `find ${SMOKE_DIR}/.brv/context-tree -type f -name '*.html' | wc -l`,
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "0";
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("All plugin smoke checks passed ✓");

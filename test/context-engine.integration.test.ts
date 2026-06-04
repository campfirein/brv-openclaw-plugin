/**
 * Integration tests — exercise the engine end-to-end with a real spawn against
 * a tiny fake `recall.mjs` placed in a temp dir. Mocks the openclaw.json read
 * so resolveWorkspaceDir's lookup doesn't leak the developer's config.
 *
 * The fake recall script honours the same CLI contract as
 * `byterover-mono/packages/skill-runtime/src/entries/recall.ts` — it accepts
 * positional `<query>` and flags `--cwd`, `--limit`, and emits the same
 * `{ ok, data: { content, matchedDocs } }` envelope on stdout. That way the
 * subprocess pipeline (spawn → JSON parse → coerce) is exercised verbatim;
 * only the engine that produces the envelope is faked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ByteRoverContextEngine } from "../src/context-engine.js";
import type { PluginLogger } from "../src/types.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      const path = args[0];
      if (typeof path === "string" && path.includes("openclaw.json")) {
        throw new Error("ENOENT: openclaw.json not present in test env");
      }
      return actual.readFileSync(...args);
    }),
  };
});

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Fake recall.mjs helpers
// ---------------------------------------------------------------------------

function writeFakeRecall(dir: string, body: string): string {
  const path = join(dir, "recall.mjs");
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

/**
 * Script body that prints a fixed JSON envelope and exits 0. The first
 * positional arg is the query — we echo it back inside the content so tests
 * can assert query passthrough. cwd is captured too.
 */
function happyRecallScript(matched: Array<{
  path: string;
  title: string;
  score: number;
  snippet: string;
}>): string {
  return [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const query = args[0] ?? '';",
    "const cwdIdx = args.indexOf('--cwd');",
    "const cwd = cwdIdx !== -1 ? args[cwdIdx + 1] : '';",
    `const matched = ${JSON.stringify(matched)};`,
    "const content = matched.length",
    "  ? matched.map(d => `<bv-topic path=\"${d.path}\" title=\"${d.title}\">${d.snippet} (q=${query}; cwd=${cwd})</bv-topic>`).join('\\n\\n---\\n\\n')",
    "  : '';",
    "process.stdout.write(JSON.stringify({ ok: true, data: { content, matchedDocs: matched } }));",
    "",
  ].join("\n");
}

/** Recall script that throws — used to assert best-effort behavior. */
const throwingRecallScript = `#!/usr/bin/env node\nprocess.stderr.write('recall blew up\\n');\nprocess.exit(1);\n`;

/** Recall script that emits malformed JSON. */
const malformedRecallScript = `#!/usr/bin/env node\nprocess.stdout.write('not json at all');\n`;

/** Recall script that hangs forever (tests timeout). */
const hangingRecallScript = `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "byterover-plugin-integ-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ByteRoverContextEngine integration", () => {
  it("assemble: real spawn → JSON envelope → systemPromptAddition with both blocks", async () => {
    const recallScript = writeFakeRecall(
      tmpDir,
      happyRecallScript([
        {
          path: "ts/strict.html",
          title: "TS strict mode",
          score: 7.2,
          snippet: "User prefers TypeScript with strict mode.",
        },
      ]),
    );
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript },
      makeLogger(),
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [{ role: "user", content: "Tell me about TS config" }] as unknown[],
      prompt: "Tell me about TS config",
    });

    expect(result.systemPromptAddition).toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("User prefers TypeScript with strict mode.");
    expect(result.systemPromptAddition).toContain("q=Tell me about TS config");
    expect(result.systemPromptAddition).toContain(`cwd=${tmpDir}`);
    expect(result.systemPromptAddition).toContain("</byterover-context>");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
  });

  it("assemble: empty matched docs → no context block, but curate guidance still ships", async () => {
    const recallScript = writeFakeRecall(tmpDir, happyRecallScript([]));
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript },
      makeLogger(),
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "obscure topic",
    });

    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
  });

  it("assemble: subprocess throws → engine falls back to empty content, guidance still ships", async () => {
    const recallScript = writeFakeRecall(tmpDir, throwingRecallScript);
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript },
      logger,
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "tell me about config",
    });

    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
  });

  it("assemble: malformed JSON → engine falls back to empty content", async () => {
    const recallScript = writeFakeRecall(tmpDir, malformedRecallScript);
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript },
      makeLogger(),
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "tell me about config",
    });

    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
  });

  it("assemble: missing recallScript path → empty content, guidance still ships, warn logged", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript: join(tmpDir, "does-not-exist.mjs") },
      logger,
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "tell me about config",
    });

    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("recall script not found"),
    );
  });

  it("assemble: timeout fires → empty content, guidance still ships", async () => {
    const recallScript = writeFakeRecall(tmpDir, hangingRecallScript);
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript, recallTimeoutMs: 250 },
      makeLogger(),
    );

    const start = Date.now();
    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "tell me about config",
    });
    const elapsed = Date.now() - start;

    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    // Sanity: the timeout fires well before the assemble deadline cap.
    expect(elapsed).toBeLessThan(2_000);
  }, 5_000);

  it("assemble: no cwd configured → still emits curate guidance (recall is best-effort)", async () => {
    // Note: resolveWorkspaceDir falls back to ~/.openclaw/workspace when
    // baseCwd is undefined, so recall will still spawn but against a path
    // that likely has no .brv tree. Either way, guidance always ships.
    const recallScript = writeFakeRecall(tmpDir, happyRecallScript([]));
    const engine = new ByteRoverContextEngine(
      { recallScript },
      makeLogger(),
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "tell me about config",
    });

    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
  });

  it("ingest is a no-op (mono has no afterTurn auto-curate)", async () => {
    const recallScript = writeFakeRecall(tmpDir, happyRecallScript([]));
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript },
      makeLogger(),
    );

    const result = await engine.ingest({
      sessionId: "s1",
      message: { role: "user", content: "hi" },
    });
    expect(result).toEqual({ ingested: false });
  });

  it("dispose is a no-op", async () => {
    const recallScript = writeFakeRecall(tmpDir, happyRecallScript([]));
    const engine = new ByteRoverContextEngine(
      { cwd: tmpDir, recallScript },
      makeLogger(),
    );
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});

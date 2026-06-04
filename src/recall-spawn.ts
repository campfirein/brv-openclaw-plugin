/**
 * Spawn-and-parse helper for mono's `recall.mjs` script.
 *
 * This replaces what `@byterover/brv-bridge.recall()` did in the cli flavor
 * of this plugin. Mono ships a purpose-built `recall.mjs` entry point that
 * returns the same `{ content, matchedDocs }` envelope we feed into the
 * assemble result.
 *
 * Contract (matches `packages/skill-runtime/src/commands.ts` → case "recall"):
 *   stdin:  unused
 *   args:   "<query>" --cwd <abs-path> [--limit N]
 *   stdout: one line of JSON — { "ok": true, "data": { content, matchedDocs } }
 *           (best-effort: any internal error returns the empty envelope; the
 *            script never exits non-zero for an empty / missing tree).
 *
 * MUST NOT throw to the caller on recall failure. Spawn errors, JSON parse
 * errors, timeouts, and missing scripts all collapse to the empty envelope
 * so a recall outage cannot block the host's assemble step.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PluginLogger } from "./types.js";

export interface RecallSpawnConfig {
  /** Absolute path to recall.mjs. Defaults to ~/.openclaw/skills/byterover/scripts/recall.mjs. */
  readonly recallScript?: string;
  /** Hard deadline for the subprocess. Defaults to 10s, capped at the agent-ready budget. */
  readonly timeoutMs?: number;
  /** Path to the node binary. Defaults to "node" (PATH lookup). */
  readonly nodePath?: string;
}

export interface RecallSpawnOptions {
  /** Working directory passed to recall.mjs as `--cwd`. */
  readonly cwd: string;
  /** Limit on returned hits (becomes `--limit N`). */
  readonly limit?: number;
  /** AbortSignal honored alongside the timeoutMs deadline. */
  readonly signal?: AbortSignal;
}

export interface RecallMatchedDoc {
  readonly path: string;
  readonly title: string;
  readonly score: number;
  readonly snippet: string;
}

export interface RecallResult {
  readonly content: string;
  readonly matchedDocs: RecallMatchedDoc[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const ABSOLUTE_TIMEOUT_CAP_MS = 10_000;
const EMPTY_RESULT: RecallResult = Object.freeze({ content: "", matchedDocs: [] });

function defaultRecallScriptPath(): string {
  return join(homedir(), ".openclaw", "skills", "byterover", "scripts", "recall.mjs");
}

/**
 * Resolve the recall script path. Honors:
 *   1. explicit `config.recallScript` (highest precedence)
 *   2. OPENCLAW_BYTEROVER_RECALL_SCRIPT env var
 *   3. default at ~/.openclaw/skills/byterover/scripts/recall.mjs
 */
export function resolveRecallScript(config: RecallSpawnConfig = {}): string {
  if (config.recallScript) return config.recallScript;
  const envPath = process.env.OPENCLAW_BYTEROVER_RECALL_SCRIPT;
  if (envPath && envPath.trim()) return envPath.trim();
  return defaultRecallScriptPath();
}

/**
 * Run recall.mjs as a subprocess and return the parsed result. Best-effort:
 * returns the empty envelope on any failure path.
 */
export async function spawnRecall(
  query: string,
  options: RecallSpawnOptions,
  config: RecallSpawnConfig = {},
  logger?: PluginLogger,
): Promise<RecallResult> {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return EMPTY_RESULT;

  const script = resolveRecallScript(config);
  if (!existsSync(script)) {
    logger?.warn(
      `[byterover] recall script not found at ${script}; returning empty (set OPENCLAW_BYTEROVER_RECALL_SCRIPT or install ~/.openclaw/skills/byterover/)`,
    );
    return EMPTY_RESULT;
  }

  const nodeBin = config.nodePath ?? "node";
  const timeoutMs = Math.min(
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ABSOLUTE_TIMEOUT_CAP_MS,
  );

  const args: string[] = [script, trimmed, "--cwd", options.cwd];
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    args.push("--limit", String(options.limit));
  }

  return new Promise<RecallResult>((resolve) => {
    let settled = false;
    const settleEmpty = (reason?: string) => {
      if (settled) return;
      settled = true;
      if (reason) logger?.debug?.(`[byterover] recall fallback to empty: ${reason}`);
      resolve(EMPTY_RESULT);
    };
    const settle = (result: RecallResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(nodeBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // We intentionally do NOT pass cwd here — recall.mjs's entry script
        // chdir's into the --cwd flag value before delegating to commands.ts.
      });
    } catch (err) {
      settleEmpty(`spawn threw: ${String(err)}`);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      settleEmpty(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      settleEmpty("aborted by signal");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      settleEmpty(`child error: ${String(err)}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);

      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      // recall.mjs is best-effort and should always exit 0 with a JSON
      // envelope; treat non-zero exit defensively.
      if (code !== 0 && code !== null) {
        if (stderr) logger?.debug?.(`[byterover] recall stderr: ${stderr.slice(0, 200)}`);
        settleEmpty(`exit code ${code}`);
        return;
      }

      if (!stdout) {
        settleEmpty("empty stdout");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        settleEmpty(`JSON parse: ${String(err)}; stdout head=${stdout.slice(0, 120)}`);
        return;
      }

      const result = coerceRecallResult(parsed);
      settle(result);
    });
  });
}

/**
 * Coerce arbitrary parsed JSON into a strict `RecallResult`. Unknown shapes
 * collapse to the empty envelope — better to lose a recall than to inject
 * malformed content into the host's system prompt.
 */
function coerceRecallResult(parsed: unknown): RecallResult {
  if (!parsed || typeof parsed !== "object") return EMPTY_RESULT;
  const root = parsed as { ok?: unknown; data?: unknown };
  if (root.ok !== true) return EMPTY_RESULT;

  const data = root.data;
  if (!data || typeof data !== "object") return EMPTY_RESULT;
  const d = data as { content?: unknown; matchedDocs?: unknown };

  const content = typeof d.content === "string" ? d.content : "";
  const matchedDocs: RecallMatchedDoc[] = [];
  if (Array.isArray(d.matchedDocs)) {
    for (const raw of d.matchedDocs) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      if (typeof m.path !== "string") continue;
      matchedDocs.push({
        path: m.path,
        title: typeof m.title === "string" ? m.title : "",
        score: typeof m.score === "number" ? m.score : 0,
        snippet: typeof m.snippet === "string" ? m.snippet : "",
      });
    }
  }

  return { content, matchedDocs };
}

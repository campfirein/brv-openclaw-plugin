/**
 * In-process recall — replaces the `recall.mjs` subprocess.
 *
 * The cli/spawn flavor shelled out to `node recall.mjs …`, which made
 * OpenClaw's install scanner reject the plugin (`child_process` =
 * "dangerous code patterns"). Mono's recall command is a thin wrapper over
 * `@byterover/core` primitives (`search` + topic reads), so we reproduce it
 * here in-process — no subprocess, no `child_process`, scanner-clean.
 *
 * Contract preserved: returns the same `{ content, matchedDocs }` envelope the
 * spawn path returned (mirrors `byterover-mono` commands.ts → case "recall").
 *
 * RECORD is unaffected: the agent still runs `record.mjs` via its own
 * shell/code-exec tool (see `resolveScriptsDir` + the curate guidance) — this
 * plugin never spawns it.
 *
 * Best-effort: any failure collapses to the empty envelope so a recall outage
 * never blocks the host's assemble step.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveContextRoot, resolveWithinTree, search } from "@byterover/core";
import type { PluginLogger } from "./types.js";

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

export interface RecallOptions {
  /** Project working directory; mono maps it to the centralized tree. */
  readonly cwd: string;
  /** Top-N hit cap. Defaults to 5. */
  readonly limit?: number;
}

const EMPTY_RESULT: RecallResult = Object.freeze({ content: "", matchedDocs: [] });
const DEFAULT_LIMIT = 5;

/**
 * Resolve the directory holding the bundled `.mjs` scripts — used only to bake
 * the `record.mjs` path into the curate guidance (the agent runs record via its
 * shell tool). Pure path logic; no I/O, no subprocess.
 *
 * Precedence: explicit `recallScript` (its parent dir) → the
 * `OPENCLAW_BYTEROVER_RECALL_SCRIPT` env var → the first existing install dir.
 *
 * OpenClaw 2026.6+ installs skills under `~/.agents/skills`; older builds used
 * `~/.openclaw/skills`. Prefer whichever exists, defaulting to `.agents`.
 */
export function resolveScriptsDir(opts: { recallScript?: string } = {}): string {
  const explicit = opts.recallScript?.trim() || process.env.OPENCLAW_BYTEROVER_RECALL_SCRIPT?.trim();
  if (explicit) return dirname(explicit);
  const candidates = [
    join(homedir(), ".agents", "skills", "byterover", "scripts"),
    join(homedir(), ".openclaw", "skills", "byterover", "scripts"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * Run recall in-process and return the `{ content, matchedDocs }` envelope.
 * Never throws.
 */
export async function recall(
  query: string,
  options: RecallOptions,
  logger?: PluginLogger,
): Promise<RecallResult> {
  const trimmed = (query ?? "").trim();
  if (!trimmed) return EMPTY_RESULT;

  try {
    // Resolve the tree from the project cwd WITHOUT chdir — the host process is
    // long-running, so we pass the base dir to the resolver instead.
    const root = await resolveContextRoot(options.cwd);
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit)
        ? options.limit
        : DEFAULT_LIMIT;

    const hits = await search(root, trimmed, limit, { now: new Date().toISOString() });

    const blocks: string[] = [];
    const matchedDocs: RecallMatchedDoc[] = [];
    for (const hit of hits) {
      try {
        const raw = await readFile(resolveWithinTree(root, hit.path), "utf8");
        blocks.push(raw);
        matchedDocs.push({
          path: hit.path,
          title: hit.title,
          score: hit.score,
          snippet: hit.snippet,
        });
      } catch {
        // Skip a hit whose file fails to read; continue with the rest.
      }
    }

    return { content: blocks.join("\n\n---\n\n"), matchedDocs };
  } catch (err) {
    logger?.warn?.(`[byterover] in-process recall failed (best-effort): ${String(err)}`);
    return EMPTY_RESULT;
  }
}

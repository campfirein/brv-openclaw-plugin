/**
 * In-process recall.
 *
 * Mono's recall command is a thin wrapper over `@byterover/core` primitives
 * (`search` + topic reads), so the plugin reproduces it directly here.
 *
 * Contract preserved: returns the same `{ content, matchedDocs }` envelope the
 * spawn path returned (mirrors `byterover-mono` commands.ts → case "recall").
 *
 * RECORD is also in-process through the registered `brv_record` tool.
 *
 * Best-effort: any failure collapses to the empty envelope so a recall outage
 * never blocks the host's assemble step.
 */

import { readFile } from "node:fs/promises";
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

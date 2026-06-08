/**
 * Minimal ambient typings for the subset of `@byterover/core` this plugin uses.
 *
 * `@byterover/core` is not published to npm; at build time `build.mjs` inlines
 * the real core (from the byterover-mono checkout) via an esbuild alias. This
 * shim only exists so `tsc --noEmit` resolves the import without pulling core's
 * full source into the plugin's typecheck. Keep in sync with the recall path
 * in byterover-mono `commands.ts` → case "recall".
 */
declare module "@byterover/core" {
  /** Resolve the centralized context-tree root for a project base directory. */
  export function resolveContextRoot(baseDir: string): Promise<string>;

  /** Like resolveContextRoot, but bootstraps the space/tree if missing. */
  export function ensureContextRoot(
    baseDir?: string,
    opts?: { space_id?: string; displayName?: string },
  ): Promise<string>;

  /** Resolve a tree-relative topic path to an absolute path within `root`. */
  export function resolveWithinTree(root: string, relPath: string): string;

  export interface SearchHit {
    path: string;
    title: string;
    score: number;
    snippet: string;
  }

  /** BM25 + signal-weighted search over a context tree. */
  export function search(
    root: string,
    query: string,
    limit: number,
    options?: { now?: string; [key: string]: unknown },
  ): Promise<SearchHit[]>;

  export type HtmlWriteResult =
    | { ok: true; created: boolean; relPath: string; warnings?: unknown[] }
    | { ok: false; errors: { message: string }[] };

  /** Validate + atomically write a <bv-topic> HTML document to the tree. */
  export function writeTopic(
    root: string,
    options: {
      agent?: string;
      confirmOverwrite?: boolean;
      rawHtml: string;
      now?: string;
    },
  ): Promise<HtmlWriteResult>;
}

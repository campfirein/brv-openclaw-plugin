/**
 * In-process `brv_record` tool — the agent-facing memory-write path.
 *
 * Why a tool: the context engine injects curate guidance, but prose alone is
 * not a reliable persistence path. A first-class tool gives the model a
 * direct memory-write action, and writing in-process via `@byterover/core`
 * keeps the dist `child_process`-free (scanner-clean), same as recall.
 *
 * Contract mirrors byterover-mono commands.ts → case "record":
 *   writeTopic(root, { agent, confirmOverwrite, rawHtml }).
 *
 * Never throws — failures come back as a structured tool result.
 */

import { Type, type Static } from "typebox";
import { ensureContextRoot, resolveWithinTree, writeTopic } from "@byterover/core";
import { resolveWorkspaceDir } from "./message-utils.js";
import type { PluginLogger } from "./types.js";

/** Agent slug stamped as createdby/updatedby on writes. */
const RECORD_AGENT = "openclaw";

/** Tool parameters (TypeBox — the schema shape OpenClaw's registerTool expects). */
export const RecordParams = Type.Object({
  path: Type.String({
    description:
      'Topic path, slash-separated snake_case (e.g. "security/auth"). No ".html" — the writer appends it. Must match the <bv-topic path="…"> attribute.',
  }),
  html: Type.String({
    description:
      "The full <bv-topic>...</bv-topic> HTML document to persist. Author it per the <byterover-curate-guidance> block (bv-task plus the appropriate bv-* elements for the knowledge kind).",
  }),
  overwrite: Type.Optional(
    Type.Boolean({
      description:
        "Overwrite an existing topic at this path. MERGE first (read + preserve prior bv-* elements) — never shrink.",
    }),
  ),
});

export type RecordArgs = Static<typeof RecordParams>;

export interface RecordResult {
  ok: boolean;
  created?: boolean;
  relPath?: string;
  filePath?: string;
  warnings?: unknown[];
  error?: string;
}

/** Resolve the tree cwd the SAME way assemble/recall does, so record and
 *  recall target the same tree. */
function resolveCwd(
  ctx: { sessionKey?: string; workspaceDir?: string },
  baseCwd?: string,
): string | undefined {
  return resolveWorkspaceDir(ctx.sessionKey, baseCwd) ?? baseCwd ?? ctx.workspaceDir;
}

/** Write a topic in-process. Never throws. */
export async function recordTopic(
  cwd: string,
  args: { path?: string; html?: string; overwrite?: boolean },
  logger?: PluginLogger,
): Promise<RecordResult> {
  const path = (args.path ?? "").trim();
  const html = (args.html ?? "").trim();
  if (!path) return { ok: false, error: "path is required and must be non-empty" };
  if (!html) return { ok: false, error: "html is required and must be non-empty" };

  try {
    // ensure (not just resolve) — bootstrap the space if this workspace has no
    // tree yet, so the first curate doesn't fail with NoDefaultSpaceError.
    const root = await ensureContextRoot(cwd);
    const result = await writeTopic(root, {
      agent: RECORD_AGENT,
      confirmOverwrite: args.overwrite === true,
      rawHtml: html,
    });
    if (!result.ok) {
      return { ok: false, error: result.errors.map((e) => e.message).join("; ") };
    }
    return {
      ok: true,
      created: result.created,
      relPath: result.relPath,
      filePath: resolveWithinTree(root, result.relPath),
      warnings: result.warnings ?? [],
    };
  } catch (err) {
    logger?.warn?.(`[byterover] in-process record failed (best-effort): ${String(err)}`);
    return { ok: false, error: String(err) };
  }
}

/**
 * Build the `brv_record` tool definition for `api.registerTool`. `ctx` is the
 * per-invocation OpenClaw tool context (carries sessionKey/workspaceDir).
 */
export function makeRecordTool(
  ctx: { sessionKey?: string; workspaceDir?: string },
  opts: { baseCwd?: string; logger?: PluginLogger } = {},
) {
  return {
    name: "brv_record",
    label: "ByteRover record",
    description:
      "Save durable project knowledge to ByteRover as a <bv-topic> HTML document (decisions, rules, bug+fix, conventions, gotchas, or facts the user asks you to remember). Author the HTML per the <byterover-curate-guidance> block; this tool persists it.",
    promptSnippet:
      "brv_record - save durable project knowledge to ByteRover after decisions, gotchas, workflow/design patterns, bug fixes, conventions, or explicit remember-this facts.",
    promptGuidelines: [
      "Use `brv_record` after work that produced durable project memory: decisions and reasons, rules/conventions, bug root cause plus fix, non-obvious gotchas or constraints, reusable workflow/design patterns, or facts the user explicitly asked you to remember.",
      "Do not record general explanations, definitions, summaries, or facts unless the user asked to remember them. Do not record what code, git history, or recently edited files already make obvious.",
      "Prefer updating an existing topic over creating a near-duplicate. If retrieved context already covers the knowledge, skip recording or merge only the new durable part.",
      "Match the user's language for human-readable content, title, and summary; keep tag names, attribute names, enum values, fact subjects, and topic paths in English.",
      "Author one proper `<bv-topic>` HTML document per stable subject. Use `<bv-task>` plus the element that matches the knowledge kind (`<bv-decision>`, `<bv-rule>`, `<bv-bug>` + `<bv-fix>`, `<bv-structure>`, `<bv-examples>`, `<bv-fact>`, etc.). Use `<bv-pattern>` only for regex patterns; use `<bv-structure>` or `<bv-examples>` for workflow/design patterns.",
      "For a single durable fact, keep the HTML topic small but still structured: `<bv-task>`, one concise `<bv-highlights>` or `<bv-structure>`, and one `<bv-fact>`. Do not force `<bv-decision>` or `<bv-reason>` unless it is actually a decision or the reason matters.",
      "Never put secrets in topic titles or prose. Sensitive specifics belong in `<bv-fact>` elements; facts default restricted unless `disclosure=\"public\"` is explicitly safe.",
      "Use `brv_record` only for ByteRover memory writes. Do not use `skill_workshop`, skill proposals, web search, or file writes to store ByteRover knowledge.",
      "Only say you saved something after `brv_record` returns `ok: true`; otherwise surface the error plainly.",
    ],
    parameters: RecordParams,
    execute: async (_toolCallId: string, params: RecordArgs): Promise<{
      content: { type: "text"; text: string }[];
      details: RecordResult;
    }> => {
      const cwd = resolveCwd(ctx, opts.baseCwd);
      if (!cwd) {
        const details: RecordResult = {
          ok: false,
          error: "no workspace cwd — set plugin config 'cwd' or an agent workspace",
        };
        return { content: [{ type: "text", text: details.error! }], details };
      }
      const res = await recordTopic(cwd, params, opts.logger);
      const text = res.ok
        ? `Saved to ByteRover at \`${res.relPath ?? params.path}\`${res.created ? "" : " (updated existing)"}.`
        : `ByteRover record failed: ${res.error}`;
      return { content: [{ type: "text", text }], details: res };
    },
  };
}

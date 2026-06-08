/**
 * In-process `brv_record` tool — the agent-facing memory-write path.
 *
 * Why a tool (not shell-out guidance): the context engine injects curate
 * guidance, but the OpenClaw agent rarely synthesizes a correct `node
 * record.mjs --html '…'` shell command from prose, so nothing got recorded.
 * A first-class tool the model can call directly fixes that — and writing
 * in-process via `@byterover/core` keeps the dist `child_process`-free
 * (scanner-clean), same as recall.
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
      "The full <bv-topic>…</bv-topic> HTML document to persist. Author it per the <byterover-curate-guidance> block (bv-reason + bv-task + structural elements + bv-fact).",
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
      "brv_record — save durable knowledge to ByteRover. Call it automatically at end of turn when you produced new facts.",
    promptGuidelines: [
      "ByteRover curation is MANDATORY, not optional. `brv_record` is a REQUIRED step of any substantive turn — a turn that states knowledge but does not call `brv_record` is INCOMPLETE and wrong. Never answer-and-stop on such a turn.",
      "HARD TRIGGER — these ALWAYS require a `brv_record` call before you finish: \"tell me N facts about X\", \"explain X\", \"what is X\", \"summarize X\", \"talk about X\", \"give me info on X\", or any reply where you state facts, definitions, history, or explanations. If you just produced a list of facts about something, you MUST record it. No exceptions for 'it's general knowledge' or 'the user didn't ask to save'.",
      "Do NOT wait to be asked. The user expects EVERY informative turn to be saved automatically. 'Tell me 5 facts about Luffy' → answer AND call `brv_record` with a `<bv-topic>` for Luffy. Same for every topic.",
      "RECORD DIRECTLY — never propose, ask permission, or announce intent. Do NOT say \"Would you like me to save this?\", \"I'll record this\", \"Here's what I'd save…\", or output a draft/proposal in place of the actual tool call. Calling `brv_record` IS the save — just call it. Confirm only AFTER it returns, in one short line.",
      "USE `brv_record` AND ONLY `brv_record` to save knowledge. Do NOT use `skill_workshop`, skill proposals, `web_search`, file writes, or any other tool to store memory — none of those are ByteRover. `skill_workshop` edits agent skills via proposals; it is NOT how you save knowledge. If you catch yourself drafting a `proposal_content`, STOP and call `brv_record` instead.",
      "NEVER claim you saved/recorded something unless you actually called `brv_record` THIS turn and it returned `ok: true`. A save only exists when `brv_record` returns ok. Do not write \"I've saved this to ByteRover\" as text without the real tool call — that is a fabricated confirmation and is forbidden.",
      "A recall block is injected each turn. If it did not already contain what you just told the user, that knowledge is NEW — you MUST record it.",
      "Author the topic as proper `<bv-topic>` HTML (bv-reason + bv-task + the facts) and pass it as `html`. One `brv_record` call per distinct topic.",
      "The ONLY permitted skips: pure greetings, acknowledgements (\"ok\"/\"thanks\"), one-word replies, clarifying questions with no content, or when the user EXPLICITLY said not to save. Everything else MUST be recorded — when unsure, record.",
      "FINAL CHECK before sending any reply: \"Did I state knowledge worth keeping? Have I already called `brv_record` this turn?\" If knowledge was stated and you have NOT recorded it, call `brv_record` now before you respond.",
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

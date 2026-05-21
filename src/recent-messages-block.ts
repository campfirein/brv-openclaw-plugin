/**
 * Renders the last N user/assistant messages as a structured block that
 * `assemble` injects into systemPromptAddition. Gives the calling agent
 * visibility into the prior turns without bloating tool descriptions.
 *
 * Behaviour:
 *   - toolResult messages are skipped (internal plumbing, not conversation).
 *   - User-metadata sentinel blocks are stripped before rendering.
 *   - Each message body is capped at MAX_MESSAGE_CHARS (~500).
 *   - When `excludeLatest: true`, the most-recent message is dropped from
 *     the slice — caller's current prompt is already shown to the agent
 *     as the actual user message slot; no need to duplicate it here.
 */

import { stripUserMetadata } from "./message-utils.js";

const DEFAULT_LIMIT = 5;
const MAX_MESSAGE_CHARS = 500;

export type BuildRecentMessagesBlockOptions = {
  /** Drop the last user/assistant message from the slice. Default false. */
  excludeLatest?: boolean;
  /** Max number of messages to include. Default 5. */
  limit?: number;
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as { type?: string }).type === "text")
      .map((b: unknown) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function buildRecentMessagesBlock(
  messages: unknown[],
  options: BuildRecentMessagesBlockOptions = {},
): string {
  const limit = options.limit ?? DEFAULT_LIMIT;

  // Step 1: keep only conversational messages (user/assistant).
  const conv = messages.filter((m) => {
    const role = (m as { role?: string }).role;
    return role === "user" || role === "assistant";
  });

  // Step 2: optionally drop the latest (caller's current prompt).
  const eligible = options.excludeLatest ? conv.slice(0, -1) : conv;

  // Step 3: take the last `limit`.
  const slice = eligible.slice(-limit);
  if (slice.length === 0) return "";

  // Step 4: render each.
  const lines: string[] = [];
  for (const msg of slice) {
    const m = msg as { role: string; content: unknown };
    let text = extractTextContent(m.content);
    if (m.role === "user") text = stripUserMetadata(text);
    text = text.trim();
    if (!text) continue;
    text = truncate(text, MAX_MESSAGE_CHARS);
    lines.push(`[${m.role}]: ${text}`);
  }

  if (lines.length === 0) return "";

  return [
    "<byterover-recent-messages>",
    `The most recent ${lines.length} conversational message${lines.length === 1 ? "" : "s"} from this session:`,
    "",
    lines.join("\n\n"),
    "</byterover-recent-messages>",
  ].join("\n");
}

import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
  PluginLogger,
} from "./types.js";
import { recall } from "./recall.js";
import { buildCurateGuidance } from "./curate-guidance.js";
import { resolveWorkspaceDir, stripUserMetadata, extractTextContent } from "./message-utils.js";

/**
 * Per-plugin config consumed by index.ts. Replaces the bridge's
 * `BrvBridgeConfig` since this build talks to byterover-mono directly.
 */
export interface ByteRoverPluginConfig {
  /** Default working directory when sessionKey doesn't resolve to one. */
  cwd?: string;
  /**
   * Deprecated no-op retained for config compatibility with the script-backed
   * mono prototype. Recall and record are both in-process on this branch.
   */
  recallScript?: string;
  /** Deprecated/ignored; recall is in-process and this timeout is ignored. */
  recallTimeoutMs?: number;
  /** Top-N hit cap passed to recall. Defaults to 5. */
  recallLimit?: number;
}

/** Default top-N when the caller doesn't override. */
const DEFAULT_RECALL_LIMIT = 5;

/** Minimum query length worth running a recall for. */
const MIN_QUERY_LENGTH = 5;

/**
 * ByteRoverContextEngine — mono-backed implementation of the OpenClaw
 * context-engine kind.
 *
 * Diverges from the cli-backed sibling on `release/2.0.0` in two ways:
 *   - No `afterTurn` lifecycle. The agent records durable knowledge by calling
 *     the registered `brv_record` tool.
 *   - `assemble` recalls in-process via `@byterover/core` instead of an
 *     external CLI path.
 *
 * Best-effort everywhere: any recall failure collapses to an empty
 * content block, and the curate guidance still ships, so the host can
 * keep the conversation going even when byterover is unavailable.
 */
export class ByteRoverContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "byterover",
    name: "ByteRover",
    version: "3.0.0-mono.0",
    ownsCompaction: false,
  };

  private readonly logger: PluginLogger;
  private readonly baseCwd: string | undefined;
  private readonly recallLimit: number;
  private readonly curateGuidance: string;

  constructor(config: ByteRoverPluginConfig, logger: PluginLogger) {
    this.logger = logger;
    this.baseCwd = config.cwd;
    this.recallLimit = config.recallLimit ?? DEFAULT_RECALL_LIMIT;
    this.curateGuidance = buildCurateGuidance({});
    this.logger.debug?.(
      `[byterover] mono engine ready (in-process recall, ` +
        `limit=${this.recallLimit})`,
    );
  }

  // ---------------------------------------------------------------------------
  // ingest — no-op. Mono has no afterTurn auto-curate; the agent records via
  // the brv_record tool guided by the block injected in assemble.
  // ---------------------------------------------------------------------------

  async ingest(_params: {
    sessionId: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  // ---------------------------------------------------------------------------
  // assemble — run recall, build the system-prompt addition (retrieved
  // content + curate guidance). Never throws to the host.
  // ---------------------------------------------------------------------------

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: unknown[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<AssembleResult> {
    const query = this.resolveQuery(params);
    const cwd = resolveWorkspaceDir(params.sessionKey, this.baseCwd) ?? this.baseCwd;

    // Recall is gated on having both a substantive query AND a workspace cwd.
    // Curate guidance ships regardless — the agent should still know how to
    // record even if this turn produced no retrievable hits.
    let retrievedContent = "";
    if (query && cwd) {
      try {
        const result = await recall(query, { cwd, limit: this.recallLimit }, this.logger);
        retrievedContent = result.content;
        if (result.matchedDocs.length > 0) {
          this.logger.info(
            `[byterover] assemble: ${result.matchedDocs.length} hit(s) for query "` +
              `${query.slice(0, 80)}${query.length > 80 ? "…" : ""}" (cwd=${cwd})`,
          );
        }
      } catch (err) {
        // recall already swallows; this catch is belt-and-suspenders.
        this.logger.warn(`[byterover] assemble recall threw (best-effort): ${String(err)}`);
      }
    } else if (!query) {
      this.logger.debug?.("[byterover] assemble: no usable query — skipping recall");
    } else {
      this.logger.debug?.(
        "[byterover] assemble: no workspace cwd — skipping recall (set plugin config 'cwd' or define an agent workspace)",
      );
    }

    const systemPromptAddition = buildSystemPromptAddition(
      retrievedContent,
      this.curateGuidance,
    );
    return {
      messages: params.messages as AssembleResult["messages"],
      estimatedTokens: 0,
      systemPromptAddition,
    };
  }

  // ---------------------------------------------------------------------------
  // compact — not owned by byterover.
  // ---------------------------------------------------------------------------

  async compact(_params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: "ByteRover does not own compaction; delegating to runtime.",
    };
  }

  // ---------------------------------------------------------------------------
  // dispose — no resources to release (no daemon, no bridge, no persistent
  // process). Kept so the runtime can invoke it without checking optionality.
  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.logger.debug?.("[byterover] dispose called (no-op for mono engine)");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolveQuery(params: { messages: unknown[]; prompt?: string }): string | null {
    const rawPrompt = params.prompt ?? null;
    const fromPrompt = rawPrompt ? stripUserMetadata(rawPrompt).trim() : "";
    const candidate = fromPrompt || extractLatestUserQuery(params.messages) || "";
    if (!candidate) return null;
    if (candidate.length < MIN_QUERY_LENGTH) {
      this.logger.debug?.(`[byterover] assemble: query too short ("${candidate}") — skipping recall`);
      return null;
    }
    return candidate;
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Compose the system-prompt addition that openclaw inlines into the host LLM
 * call. Always returns a string — the curate-guidance block is injected even
 * when recall produced nothing, so the agent always knows how to record.
 *
 * When there IS retrieved content, we wrap it with directive language so the
 * model treats it as authoritative project knowledge to BUILD ON, not just
 * reading material to acknowledge. Earlier wording ("The following curated
 * knowledge is from ByteRover") was too passive — models read it and moved
 * on. The new wrapper tells the model what to DO with the content.
 *
 * The curate-guidance argument is pre-rendered once by the engine; we append it.
 */
export function buildSystemPromptAddition(
  retrievedContent: string,
  curateGuidance: string,
): string {
  if (retrievedContent && retrievedContent.trim()) {
    return (
      `<byterover-context>\n` +
      `# Project knowledge retrieved from ByteRover (authoritative — use it)\n\n` +
      `The topics below are facts, decisions, and rules the user's team has\n` +
      `already curated for this project. Treat them as the ground truth for\n` +
      `anything they cover.\n\n` +
      `**Instructions for using this context:**\n` +
      `1. READ each <bv-topic> before drafting your answer.\n` +
      `2. ALIGN your answer with the decisions and rules you find here — if a\n` +
      `   <bv-rule severity="must"> exists for the topic, do not contradict it.\n` +
      `3. CITE the topic path (e.g. "per security/auth") when your answer relies\n` +
      `   on retrieved knowledge, so the user can verify it.\n` +
      `4. SUPPLEMENT — don't duplicate. If the context already covers the\n` +
      `   question, lean on it; don't re-derive from scratch.\n` +
      `5. FLAG conflicts. If the user's request contradicts a retrieved rule,\n` +
      `   surface the conflict explicitly rather than silently overriding.\n\n` +
      `---\n\n` +
      `${retrievedContent}\n` +
      `</byterover-context>\n\n` +
      curateGuidance
    );
  }
  return curateGuidance;
}

/**
 * Extract the latest user message text from the messages array, stripping
 * OpenClaw metadata so the recall query sees only the user's actual words.
 */
export function extractLatestUserQuery(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "user") continue;
    const raw = extractTextContent(m.content);
    const clean = stripUserMetadata(raw).trim();
    return clean || null;
  }
  return null;
}

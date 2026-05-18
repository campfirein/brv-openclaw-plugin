import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  PluginLogger,
} from "./types.js";
import { BrvBridge, type BrvBridgeConfig } from "@byterover/brv-bridge";
import { stripUserMetadata, resolveWorkspaceDir } from "./message-utils.js";

const CURATE_GUIDANCE = `<byterover-curate-guidance>
You have access to brv-curate (for saving knowledge) and brv-query (for retrieving it).

Call brv-curate when your turn produces:
  - decisions (architecture choices, library selections, design trade-offs)
  - patterns (recurring code structures, error-handling conventions)
  - facts (environment details, file locations, version info)
  - rules (must-do or must-not-do constraints with rationale)

Author a single <bv-topic> document capturing the knowledge. Use the bv-* element vocabulary described in the brv-curate tool's parameter schema. Set meta.impact to "high" for load-bearing decisions or rules that downstream code depends on.

Skip brv-curate when the turn was conversational, exploratory without conclusions, or covered material already in your retrieved context.
</byterover-curate-guidance>`;

/**
 * ByteRoverContextEngine integrates ByteRover as an OpenClaw context engine
 * via the brv-bridge standard interface.
 *
 * v2 lifecycle:
 *   - assemble   → bridge.recall() returns curated knowledge; ALSO injects
 *                  brv-curate guidance every turn so the agent knows when
 *                  to call the registered `brv-curate` tool.
 *   - afterTurn  → no-op. Curate is agent-initiated in v2; the agent calls
 *                  the brv-curate tool directly during a turn.
 *   - ingest     → no-op (legacy).
 *   - compact    → not owned (runtime handles compaction).
 */
export class ByteRoverContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "byterover",
    name: "ByteRover",
    version: "2.0.0",
    ownsCompaction: false,
  };

  private readonly bridge: BrvBridge;
  private readonly logger: PluginLogger;
  private readonly baseCwd: string | undefined;

  constructor(config: BrvBridgeConfig, logger: PluginLogger) {
    this.bridge = new BrvBridge({ ...config, logger });
    this.logger = logger;
    this.baseCwd = config.cwd;
  }

  // ---------------------------------------------------------------------------
  // ingest — no-op (afterTurn handled it pre-v2; v2 has no auto-curate)
  // ---------------------------------------------------------------------------

  async ingest(_params: {
    sessionId: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  // ---------------------------------------------------------------------------
  // afterTurn — no-op. Curate is agent-initiated in v2; see assemble's
  // injected `<byterover-curate-guidance>` block. ContextEngine interface
  // still requires the method, so we keep it as a returning stub.
  // ---------------------------------------------------------------------------

  async afterTurn(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: unknown[];
    prePromptMessageCount: number;
    isHeartbeat?: boolean;
  }): Promise<void> {
    // No-op: the agent invokes the brv-curate tool directly when its turn
    // produces curate-worthy content. See `assemble` for the guidance.
  }

  // ---------------------------------------------------------------------------
  // assemble — recall curated knowledge AND inject curate guidance
  // ---------------------------------------------------------------------------

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: unknown[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<AssembleResult> {
    // Use the incoming prompt (new upstream field) — this is the actual user
    // message for this turn. Fall back to history scan for older runtimes.
    const rawPrompt = params.prompt ?? null;
    const query = rawPrompt
      ? stripUserMetadata(rawPrompt).trim() || null
      : extractLatestUserQuery(params.messages);

    // Build the systemPromptAddition. The curate-guidance block is included
    // EVERY turn — even when no recall content surfaces — so the agent
    // always knows the tools are available.
    let systemPromptAddition: string | undefined = CURATE_GUIDANCE;

    // Skip the recall network call when we have no usable query.
    if (!query) {
      this.logger.debug?.("assemble skipped brv recall (no user message found)");
      return {
        messages: params.messages as AssembleResult["messages"],
        estimatedTokens: 0,
        systemPromptAddition,
      };
    }

    // Skip trivially short queries (e.g. "ok", "hi", "yes") — not worth a brv spawn.
    if (query.length < 5) {
      this.logger.debug?.(`assemble skipped brv recall (query too short: "${query}")`);
      return {
        messages: params.messages as AssembleResult["messages"],
        estimatedTokens: 0,
        systemPromptAddition,
      };
    }

    const cwd = resolveWorkspaceDir(params.sessionKey, this.baseCwd) ?? this.baseCwd;

    // Abort-based deadline so we never exceed the agent ready timeout (15s).
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), 10_000);

    this.logger.debug?.(
      `assemble querying brv: "${query.slice(0, 100)}${query.length > 100 ? "..." : ""}" (cwd=${cwd})`,
    );

    try {
      const result = await this.bridge.recall(query, { signal: ac.signal, cwd });

      if (result.content) {
        const contextBlock =
          `<byterover-context>\n` +
          `The following curated knowledge is from ByteRover context engine:\n\n` +
          `${result.content}\n` +
          `</byterover-context>`;
        systemPromptAddition = `${contextBlock}\n\n${CURATE_GUIDANCE}`;
        this.logger.info(
          `assemble injecting systemPromptAddition (${systemPromptAddition.length} chars: ${result.content.length} recall + guidance)`,
        );
      } else {
        this.logger.debug?.("assemble brv query returned empty result — guidance-only addition");
      }
    } catch (err) {
      this.logger.warn(`recall failed (best-effort): ${String(err)}`);
    } finally {
      clearTimeout(deadline);
    }

    return {
      messages: params.messages as AssembleResult["messages"],
      estimatedTokens: 0,
      systemPromptAddition,
    };
  }

  // ---------------------------------------------------------------------------
  // compact — we don't own compaction; return not-compacted
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
  // dispose — delegate to bridge shutdown
  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    await this.bridge.shutdown();
    this.logger.debug?.("dispose called");
  }

  // ---------------------------------------------------------------------------
  // Bridge accessor — used by index.ts so tools share the same instance
  // ---------------------------------------------------------------------------

  /** Internal accessor: lets the plugin's `register` share the bridge with the agent tools. */
  getBridge(): BrvBridge {
    return this.bridge;
  }
}

// ---------------------------------------------------------------------------
// Helpers — kept for `assemble`'s fallback path. The auto-curate-only
// helpers (`serializeMessagesForCurate`, `extractSenderInfo`,
// `stripAssistantTags`) are removed in v2; the agent now authors HTML
// directly via the brv-curate tool.
// ---------------------------------------------------------------------------

/** Extract text from string content or ContentBlock[] arrays. */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => (b as { type?: string }).type === "text")
      .map((b: unknown) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/**
 * Extract the latest user message text to use as the brv recall query.
 * Strips OpenClaw metadata so brv receives only the actual question.
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

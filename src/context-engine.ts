/**
 * ByteRoverContextEngine — OpenClaw ContextEngine implementation.
 *
 * Retrieval-augmented context engine:
 *   assemble → brv query → systemPromptAddition
 *
 * Lifecycle mapping:
 *   assemble   → brv query    Retrieve curated knowledge, inject as system prompt.
 *   ingest     → no-op        Not used by this engine.
 *   compact    → delegates    ownsCompaction=false; runtime handles compaction.
 */

import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  PluginLogger,
} from "./types.js";
import { brvQuery, type BrvProcessConfig } from "./brv-process.js";
import { stripUserMetadata } from "./message-utils.js";

export class ByteRoverContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "byterover",
    name: "ByteRover",
    version: "0.1.0",
    ownsCompaction: false,
  };

  private readonly config: BrvProcessConfig;
  private readonly logger: PluginLogger;

  constructor(config: BrvProcessConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // ingest — no-op
  // ---------------------------------------------------------------------------

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  // ---------------------------------------------------------------------------
  // assemble — query brv for curated knowledge, inject as system prompt
  // ---------------------------------------------------------------------------

  async assemble(params: {
    sessionId: string;
    messages: unknown[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<AssembleResult> {
    const passthrough: AssembleResult = {
      messages: params.messages,
      estimatedTokens: 0,
    };

    // Use the incoming prompt (upstream field from openclaw#43920) — this is
    // the actual user message for this turn. Fall back to scanning the message
    // history for older runtimes that don't pass prompt yet.
    const rawPrompt = params.prompt ?? null;
    const query = rawPrompt
      ? stripUserMetadata(rawPrompt).trim() || null
      : extractLatestUserQuery(params.messages);

    if (!query) {
      this.logger.debug?.("assemble skipped brv query (no user message found)");
      return passthrough;
    }

    // Skip trivially short queries (e.g. "ok", "hi", "yes") — not worth a
    // brv spawn. Applied after metadata stripping so inflated raw prompts
    // don't bypass this gate.
    if (query.length < 5) {
      this.logger.debug?.(`assemble skipped brv query (query too short: "${query}")`);
      return passthrough;
    }

    // Abort-based deadline: default 10s, capped to stay within the agent
    // ready timeout (15s). Signal propagates to runBrv → child process kill.
    const assembleTimeout = this.config.queryTimeoutMs
      ? Math.min(this.config.queryTimeoutMs, 10_000)
      : 10_000;

    this.logger.debug?.(
      `assemble querying brv: "${query.slice(0, 100)}${query.length > 100 ? "..." : ""}" (timeout=${assembleTimeout}ms)`,
    );

    let systemPromptAddition: string | undefined;
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), assembleTimeout);

    try {
      const result = await brvQuery({
        config: this.config,
        logger: this.logger,
        query,
        signal: ac.signal,
      });

      const answer = result.data?.result ?? result.data?.content;
      if (answer && answer.trim()) {
        systemPromptAddition =
          `<byterover-context>\n` +
          `The following curated knowledge is from ByteRover context engine:\n\n` +
          `${answer.trim()}\n` +
          `</byterover-context>`;
        this.logger.info(
          `assemble injecting systemPromptAddition (${systemPromptAddition.length} chars)`,
        );
      } else {
        this.logger.debug?.("assemble brv query returned empty result");
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("aborted")) {
        this.logger.warn(
          `assemble brv query timed out after ${assembleTimeout}ms — proceeding without context`,
        );
      } else {
        this.logger.warn(`query failed (best-effort): ${msg}`);
      }
    } finally {
      clearTimeout(deadline);
    }

    return {
      messages: params.messages,
      estimatedTokens: 0,
      systemPromptAddition,
    };
  }

  // ---------------------------------------------------------------------------
  // compact — not owned; delegate to runtime
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
  // dispose
  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.logger.debug?.("dispose called");
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
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
 * Extract the latest user message text from a message array.
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

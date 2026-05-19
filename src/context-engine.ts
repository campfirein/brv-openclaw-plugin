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

# When to call brv-curate

When your turn produces:
  - decisions (architecture choices, library selections, design trade-offs)
  - patterns (recurring code structures, error-handling conventions)
  - facts (environment details, file locations, version info)
  - rules (must-do / must-not-do constraints with rationale)

Skip when the turn was conversational, exploratory without conclusions, or covered material already in your retrieved context block above.

# Quality bar — go BEYOND the literal assertion

A 500-byte topic with one <bv-rule> + one <bv-reason> is too thin to be useful when retrieved months later. Aim for richer entries that future-you (or a teammate) can act on without re-asking the user.

ALWAYS on <bv-topic>:
  - summary="<one-line semantic, ~10-20 words>" — drives BM25 matching
  - tags="<3-5 comma-separated>" — domain, technology, area
  - keywords="<5-10 comma-separated>" — concrete terms a future query might use

USE THE RIGHT CONTAINER (combine as relevant — most topics need 3-5 of these):
  - <bv-decision> — chosen option + rationale
  - <bv-rule severity="must|should"> — load-bearing constraint
  - <bv-fact subject="X" category="environment|convention|project|...">  — concrete setup detail (version, path, port, account, key)
  - <bv-files><li><code>src/x/y.ts</code></li>...</bv-files> — anchor topics to code paths so codebase queries match
  - <bv-flow><h3>title</h3><ol><li>...</li></ol></bv-flow> — ordered procedures
  - <bv-structure><h3>title</h3><ul>...</ul></bv-structure> — grouped state (file layouts, naming conventions)
  - <bv-examples> — sample code or usage
  - <bv-bug severity="..."> + <bv-fix> — incident runbook
  - <bv-reason> at the end — the WHY this topic exists

# meta field — always set summary + reason

The meta envelope drives HITL surfacing in 'brv review pending'. Always supply:
  - meta.summary — the one-line gist (mirrors <bv-topic summary>)
  - meta.reason — one sentence on why this curation matters (shown to human reviewers)
  - meta.impact — "high" for load-bearing decisions/rules/patterns; "low" for refinements
  - meta.type — "ADD" for new path, "UPDATE" to replace existing, "MERGE" if combining with prior content
  - meta.previousSummary — set only on UPDATE/MERGE; one-line of what existed before

# Quick example

A "we use RS256 for JWT signing" topic should look like:

<bv-topic path="security/jwt_signing" title="JWT signing algorithm"
  summary="RS256 chosen over HS256 — verifiers only need the public key."
  tags="auth,jwt,security,signing"
  keywords="jwt,rs256,asymmetric,public key,jwks,verifier,signing,algorithm">
  <bv-decision id="d-rs256" severity="must">Use RS256 (asymmetric) for JWT signing across the project.</bv-decision>
  <bv-rule severity="must">Verifiers MUST only hold the public key; the private key never leaves the issuer service.</bv-rule>
  <bv-fact subject="jwks-endpoint" category="environment">JWKS published at /.well-known/jwks.json with 7-day overlap on key rotation.</bv-fact>
  <bv-files><li><code>src/auth/jwt-signer.ts</code></li><li><code>src/auth/jwks-publisher.ts</code></li></bv-files>
  <bv-reason>Locks the JWT signing algorithm; downstream verifier code and key-rotation policy depend on this choice.</bv-reason>
</bv-topic>

with meta:
  { type: "ADD", impact: "high", reason: "Locks JWT signing; downstream verifier + key-rotation depend on it.", summary: "RS256 chosen for JWT signing over HS256." }
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

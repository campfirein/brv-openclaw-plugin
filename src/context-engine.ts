import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
  PluginLogger,
} from "./types.js";
import {
  resolveRecallScript,
  spawnRecall,
  type RecallSpawnConfig,
} from "./recall-spawn.js";
import { CURATE_GUIDANCE } from "./curate-guidance.js";
import { resolveWorkspaceDir, stripUserMetadata, extractTextContent } from "./message-utils.js";

/**
 * Per-plugin config consumed by index.ts. Replaces the bridge's
 * `BrvBridgeConfig` since this build talks to byterover-mono directly.
 */
export interface ByteRoverPluginConfig {
  /** Default working directory when sessionKey doesn't resolve to one. */
  cwd?: string;
  /** Path to mono's `recall.mjs`. Defaults to `~/.openclaw/skills/byterover/scripts/recall.mjs`. */
  recallScript?: string;
  /** Hard deadline for the recall subprocess. Defaults to 10s. */
  recallTimeoutMs?: number;
  /** Top-N hit cap passed to recall.mjs. Defaults to 5. */
  recallLimit?: number;
}

/**
 * Hard cap on the assemble deadline, kept under OpenClaw's agent-ready
 * timeout (15s) so a slow recall can't block the runtime. The effective
 * deadline is `min(config.recallTimeoutMs, ASSEMBLE_DEADLINE_CAP_MS)`.
 */
const ASSEMBLE_DEADLINE_CAP_MS = 10_000;

/** Default top-N when the caller doesn't override. */
const DEFAULT_RECALL_LIMIT = 5;

/** Minimum query length worth spawning a subprocess for. */
const MIN_QUERY_LENGTH = 5;

/**
 * ByteRoverContextEngine — mono-backed implementation of the OpenClaw
 * context-engine kind.
 *
 * Diverges from the cli-backed sibling on `release/2.0.0` in two ways:
 *   - No `afterTurn` lifecycle. Mono has no `brv curate` session protocol
 *     for the engine to drive; the agent itself runs `record.mjs` via its
 *     shell / code-exec tool when guided by the curate block we inject
 *     in `assemble`.
 *   - `assemble` spawns `recall.mjs` (a one-shot Node script) instead of
 *     calling `@byterover/brv-bridge.recall()`. Same envelope shape, so
 *     the downstream concatenation + system-prompt-addition is identical.
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
  private readonly assembleDeadlineMs: number;
  private readonly recallConfig: RecallSpawnConfig;

  constructor(config: ByteRoverPluginConfig, logger: PluginLogger) {
    this.logger = logger;
    this.baseCwd = config.cwd;
    this.recallLimit = config.recallLimit ?? DEFAULT_RECALL_LIMIT;
    const configured = config.recallTimeoutMs ?? ASSEMBLE_DEADLINE_CAP_MS;
    this.assembleDeadlineMs = Math.min(configured, ASSEMBLE_DEADLINE_CAP_MS);
    this.recallConfig = {
      recallScript: config.recallScript,
      timeoutMs: this.assembleDeadlineMs,
    };
    this.logger.debug?.(
      `[byterover] mono engine ready (recall=${resolveRecallScript(this.recallConfig)}, ` +
        `timeoutMs=${this.assembleDeadlineMs}, limit=${this.recallLimit})`,
    );
  }

  // ---------------------------------------------------------------------------
  // ingest — no-op. Mono has no afterTurn auto-curate; the agent self-services
  // via record.mjs guided by the block injected in assemble.
  // ---------------------------------------------------------------------------

  async ingest(_params: {
    sessionId: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  // ---------------------------------------------------------------------------
  // assemble — spawn recall.mjs, build the system-prompt addition (retrieved
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
      const ac = new AbortController();
      const deadline = setTimeout(() => ac.abort(), this.assembleDeadlineMs);
      try {
        const result = await spawnRecall(
          query,
          { cwd, limit: this.recallLimit, signal: ac.signal },
          this.recallConfig,
          this.logger,
        );
        retrievedContent = result.content;
        if (result.matchedDocs.length > 0) {
          this.logger.info(
            `[byterover] assemble: ${result.matchedDocs.length} hit(s) for query "` +
              `${query.slice(0, 80)}${query.length > 80 ? "…" : ""}" (cwd=${cwd})`,
          );
        }
      } catch (err) {
        // spawnRecall already swallows; this catch is belt-and-suspenders.
        this.logger.warn(`[byterover] assemble recall threw (best-effort): ${String(err)}`);
      } finally {
        clearTimeout(deadline);
      }
    } else if (!query) {
      this.logger.debug?.("[byterover] assemble: no usable query — skipping recall");
    } else {
      this.logger.debug?.(
        "[byterover] assemble: no workspace cwd — skipping recall (set plugin config 'cwd' or define an agent workspace)",
      );
    }

    const systemPromptAddition = buildSystemPromptAddition(retrievedContent);
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
 */
export function buildSystemPromptAddition(retrievedContent: string): string {
  if (retrievedContent && retrievedContent.trim()) {
    return (
      `<byterover-context>\n` +
      `The following curated knowledge is from ByteRover:\n\n` +
      `${retrievedContent}\n` +
      `</byterover-context>\n\n` +
      CURATE_GUIDANCE
    );
  }
  return CURATE_GUIDANCE;
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

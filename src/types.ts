/**
 * Standalone type definitions mirroring openclaw/plugin-sdk.
 *
 * These are structurally compatible with the types exported by the OpenClaw
 * plugin SDK. When the plugin runs inside OpenClaw, TypeScript's structural
 * typing ensures our implementation satisfies the real interfaces.
 *
 * Source of truth: openclaw/src/context-engine/types.ts
 *                  openclaw/src/plugins/types.ts
 */

// ---------------------------------------------------------------------------
// PluginLogger — subset of openclaw/src/plugins/types.ts → PluginLogger
// ---------------------------------------------------------------------------

export type PluginLogger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// Context engine types — openclaw/src/context-engine/types.ts
// ---------------------------------------------------------------------------

export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction: boolean;
};

export type AssembleResult = {
  messages: unknown[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    tokensBefore: number;
    tokensAfter: number;
    details?: Record<string, unknown>;
  };
};

export type IngestResult = {
  ingested: boolean;
};

export type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
};

export type IngestBatchResult = {
  ingestedCount: number;
};

/**
 * ContextEngine — the plugin-sdk interface a context engine must satisfy.
 *
 * Required methods: info, ingest, assemble, compact.
 * Optional methods: bootstrap, ingestBatch, afterTurn, prepareSubagentSpawn,
 *                   onSubagentEnded, dispose.
 *
 * ByteRover implements: ingest (no-op), afterTurn, assemble, compact, dispose.
 */
export interface ContextEngine {
  readonly info: ContextEngineInfo;

  bootstrap?(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;

  ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: unknown;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  ingestBatch?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: unknown[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;

  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: unknown[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void>;

  assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: unknown[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<AssembleResult>;

  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    force?: boolean;
  }): Promise<CompactResult>;

  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<unknown>;

  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: string;
  }): Promise<void>;

  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool registration — openclaw/src/plugins/tool-types.ts
// ---------------------------------------------------------------------------

/**
 * Context passed to a tool factory per turn. Structurally compatible with
 * `OpenClawPluginToolContext` in openclaw-official; we use structural typing
 * so OpenClaw may add new fields without breaking compilation. We only read
 * `workspaceDir` (and fallback to `agentDir`); the rest stays opaque.
 */
export type OpenClawPluginToolContext = {
  config?: unknown;
  runtimeConfig?: unknown;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

// ---------------------------------------------------------------------------
// Plugin API — openclaw/src/plugins/types.ts → OpenClawPluginApi
// ---------------------------------------------------------------------------

export type OpenClawPluginApi = {
  /** Validated runtime config (agents, session, etc.). */
  config: unknown;
  /** Raw plugin config from plugins.entries.<id>.config in openclaw.json. */
  pluginConfig?: Record<string, unknown>;
  /** Scoped logger for this plugin. */
  logger: PluginLogger;
  /** OpenClaw runtime surfaces (config loader, channel, subagent, etc.). */
  runtime: unknown;
  /** Register a context engine factory under a slot name. */
  registerContextEngine(
    id: string,
    factory: () => ContextEngine | Promise<ContextEngine>,
  ): void;
  /**
   * Register an agent-facing tool. The factory runs once per turn; the
   * returned object must satisfy OpenClaw's `AnyAgentTool` shape
   * (label, name, description, parameters, execute).
   */
  registerTool(
    factory: (ctx: OpenClawPluginToolContext) => unknown,
    opts: { name: string },
  ): void;
};

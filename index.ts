import {
  ByteRoverContextEngine,
  type ByteRoverPluginConfig,
} from "./src/context-engine.js";
import type { OpenClawPluginApi } from "./src/types.js";

// Keep this string identical to `openclaw.plugin.json` → description.
// The manifest is what OpenClaw renders in the UI; this one is the in-process
// default for hosts that pass the plugin object directly.
const PLUGIN_DESCRIPTION =
  "ByteRover context engine (mono) — recalls curated knowledge from a centralized ~/.brv/projects/<flat>/context-tree/ into the assemble system prompt; agent invokes `record.mjs` via its shell/code-exec tool to save new knowledge.";

const byteRoverPlugin = {
  id: "byterover",
  name: "ByteRover",
  description: PLUGIN_DESCRIPTION,
  kind: "context-engine" as const,
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;

    const engineConfig: ByteRoverPluginConfig = {
      cwd: typeof pluginConfig.cwd === "string" ? pluginConfig.cwd : undefined,
      recallScript:
        typeof pluginConfig.recallScript === "string"
          ? pluginConfig.recallScript
          : undefined,
      recallTimeoutMs:
        typeof pluginConfig.recallTimeoutMs === "number"
          ? pluginConfig.recallTimeoutMs
          : typeof pluginConfig.queryTimeoutMs === "number"
            ? pluginConfig.queryTimeoutMs // legacy alias from the cli flavor
            : undefined,
      recallLimit:
        typeof pluginConfig.recallLimit === "number"
          ? pluginConfig.recallLimit
          : undefined,
    };

    api.registerContextEngine(
      "byterover",
      () => new ByteRoverContextEngine(engineConfig, api.logger),
    );

    api.logger.info(
      "[byterover] Plugin loaded (mono, context-engine only — no brv-bridge)",
    );
  },
};

export default byteRoverPlugin;

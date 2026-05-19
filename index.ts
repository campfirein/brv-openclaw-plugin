import type { BrvBridgeConfig } from "@byterover/brv-bridge";

import { ByteRoverContextEngine } from "./src/context-engine.js";
import type { OpenClawPluginApi } from "./src/types.js";

const byteRoverPlugin = {
  id: "byterover",
  name: "ByteRover",
  description:
    "ByteRover context engine — recall curated knowledge into the assemble system prompt; curate via the `brv curate` CLI.",
  kind: "context-engine" as const,
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;

    const bridgeConfig: BrvBridgeConfig = {
      brvPath: typeof pluginConfig.brvPath === "string" ? pluginConfig.brvPath : undefined,
      cwd: typeof pluginConfig.cwd === "string" ? pluginConfig.cwd : undefined,
      recallTimeoutMs:
        typeof pluginConfig.queryTimeoutMs === "number" ? pluginConfig.queryTimeoutMs : undefined,
      persistTimeoutMs:
        typeof pluginConfig.curateTimeoutMs === "number" ? pluginConfig.curateTimeoutMs : undefined,
    };

    api.registerContextEngine("byterover", () => new ByteRoverContextEngine(bridgeConfig, api.logger));

    api.logger.info("[byterover] Plugin loaded (context-engine only)");
  },
};

export default byteRoverPlugin;

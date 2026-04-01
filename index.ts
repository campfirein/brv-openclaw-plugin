import type { OpenClawPluginApi } from "./src/types.js";
import type { BrvBridgeConfig } from "@byterover/brv-bridge";
import { ByteRoverContextEngine } from "./src/context-engine.js";

const byteRoverPlugin = {
  id: "byterover",
  name: "ByteRover",
  description: "ByteRover context engine — curates and queries conversation context via brv CLI",
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

    api.logger.info("[byterover] Plugin loaded");
  },
};

export default byteRoverPlugin;

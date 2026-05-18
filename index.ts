import type { BrvBridgeConfig } from "@byterover/brv-bridge";

import { ByteRoverContextEngine } from "./src/context-engine.js";
import { registerByteRoverTools } from "./src/tools/index.js";
import type { OpenClawPluginApi } from "./src/types.js";

const byteRoverPlugin = {
  id: "byterover",
  name: "ByteRover",
  description:
    "ByteRover context engine + agent tools — curate / query the project context tree via brv CLI",
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

    // Single ContextEngine instance shared between the runtime's registry
    // lookup and the agent-tool factories — the engine owns the BrvBridge,
    // so both consumers reuse one set of timeouts / logger / paths.
    const engine = new ByteRoverContextEngine(bridgeConfig, api.logger);

    api.registerContextEngine("byterover", () => engine);
    registerByteRoverTools(api, engine.getBridge());

    api.logger.info("[byterover] Plugin loaded (with brv-curate + brv-query tools)");
  },
};

export default byteRoverPlugin;

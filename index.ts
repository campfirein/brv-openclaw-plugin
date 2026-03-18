/**
 * @byterover/openclaw-plugin — ByteRover context engine plugin for OpenClaw.
 *
 * Curates conversation turns via `brv curate` and retrieves relevant
 * curated knowledge via `brv query`, injected as systemPromptAddition.
 */

import type { OpenClawPluginApi } from "./src/types.js";
import type { BrvProcessConfig } from "./src/brv-process.js";
import { ByteRoverContextEngine } from "./src/context-engine.js";

const byteRoverPlugin = {
  id: "byterover",
  name: "ByteRover",
  description:
    "ByteRover context engine — curates and queries conversation context via brv CLI",
  kind: "context-engine" as const,

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;

    const brvConfig: BrvProcessConfig = {
      brvPath: typeof pluginConfig.brvPath === "string" ? pluginConfig.brvPath : undefined,
      cwd: typeof pluginConfig.cwd === "string" ? pluginConfig.cwd : undefined,
      queryTimeoutMs:
        typeof pluginConfig.queryTimeoutMs === "number" ? pluginConfig.queryTimeoutMs : undefined,
      curateTimeoutMs:
        typeof pluginConfig.curateTimeoutMs === "number" ? pluginConfig.curateTimeoutMs : undefined,
    };

    api.registerContextEngine(
      "byterover",
      () => new ByteRoverContextEngine(brvConfig, api.logger),
    );

    api.logger.info("[byterover] Plugin loaded");
  },
};

export default byteRoverPlugin;

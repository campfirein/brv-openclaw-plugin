import type { BrvBridge } from "@byterover/brv-bridge";

import type { OpenClawPluginApi } from "../types.js";
import { registerBrvCurateTool } from "./brv-curate.js";
import { registerBrvQueryTool } from "./brv-query.js";

/**
 * Register both ByteRover agent tools (`brv-curate` and `brv-query`). The
 * shared `BrvBridge` instance is constructed once in the plugin's top-level
 * `register(api)` and threaded into both tool factories so they reuse a
 * single set of timeouts / logger / paths.
 */
export function registerByteRoverTools(api: OpenClawPluginApi, bridge: BrvBridge): void {
  registerBrvCurateTool(api, bridge);
  registerBrvQueryTool(api, bridge);
}

export { BrvCurateParameters } from "./brv-curate.js";
export { BrvQueryParameters } from "./brv-query.js";
export { BRV_CURATE_DESCRIPTION, BRV_QUERY_DESCRIPTION } from "./descriptions.js";

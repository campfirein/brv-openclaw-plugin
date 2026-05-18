import { Type } from "@sinclair/typebox";
import type { BrvBridge, QueryToolModeResult } from "@byterover/brv-bridge";

import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../types.js";
import { BRV_QUERY_DESCRIPTION } from "./descriptions.js";

/**
 * typebox schema for `brv-query` tool parameters. Mirrors the MCP zod
 * schema; parity asserted by `test/tools/schema-parity.test.ts`.
 */
export const BrvQueryParameters = Type.Object({
  query: Type.String({
    description: "Natural language question about the codebase or project knowledge.",
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Max matches to return (1-50, default 10).",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Override the workspace directory. Defaults to the session workspace.",
    }),
  ),
});

function jsonResult(payload: unknown): unknown {
  return {
    type: "text" as const,
    text: JSON.stringify(payload, null, 2),
    payload,
  };
}

type BrvQueryArgs = { query: string; limit?: number; cwd?: string };

/**
 * Register the `brv-query` agent tool. Returns the raw `QueryToolModeResult`
 * envelope so the calling LLM can read `matchedDocs[].rendered_md` directly.
 * Never throws — bridge errors surface as structured tool results.
 */
export function registerBrvQueryTool(api: OpenClawPluginApi, bridge: BrvBridge): void {
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => ({
      label: "ByteRover Query",
      name: "brv-query",
      description: BRV_QUERY_DESCRIPTION,
      parameters: BrvQueryParameters,
      execute: async (_toolCallId: string, args: unknown): Promise<unknown> => {
        const params = args as BrvQueryArgs;
        const cwd = params.cwd ?? ctx.workspaceDir;
        try {
          const envelope: QueryToolModeResult = await bridge.queryEnvelope(params.query, {
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(cwd ? { cwd } : {}),
          });
          return jsonResult(envelope);
        } catch (err) {
          return jsonResult({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
    { name: "brv-query" },
  );
}

import { Type } from "@sinclair/typebox";
import type { BrvBridge, CurateMeta, PersistHtmlResult } from "@byterover/brv-bridge";

import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../types.js";
import { BRV_CURATE_DESCRIPTION } from "./descriptions.js";

/**
 * typebox schema for `brv-curate` tool parameters. Mirrors the MCP zod
 * schema in byterover-cli — the parity test in `test/tools/schema-parity.test.ts`
 * asserts structural equivalence.
 */
export const BrvCurateParameters = Type.Object({
  html: Type.String({
    minLength: 1,
    description: "Full <bv-topic>...</bv-topic> document authored by the agent.",
  }),
  meta: Type.Optional(
    Type.Object({
      type: Type.Optional(
        Type.Union([Type.Literal("ADD"), Type.Literal("UPDATE"), Type.Literal("MERGE")]),
      ),
      impact: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("low")])),
      reason: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      previousSummary: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("low")])),
    }),
  ),
  confirmOverwrite: Type.Optional(Type.Boolean()),
  cwd: Type.Optional(
    Type.String({
      description: "Override the workspace directory. Defaults to the session workspace.",
    }),
  ),
});

/** Tool result wrapper — mirrors openclaw's `textResult(JSON.stringify(payload), payload)`. */
function jsonResult(payload: unknown): unknown {
  return {
    type: "text" as const,
    text: JSON.stringify(payload, null, 2),
    payload,
  };
}

type BrvCurateArgs = {
  html: string;
  meta?: CurateMeta;
  confirmOverwrite?: boolean;
  cwd?: string;
};

/**
 * Register the `brv-curate` agent tool. The factory closure captures the
 * shared `BrvBridge` instance; the per-turn ctx supplies `workspaceDir` as
 * the default cwd. The tool never throws — bridge errors and validation
 * failures both surface as structured tool results so the agent can decide
 * whether to retry with corrected HTML.
 */
export function registerBrvCurateTool(api: OpenClawPluginApi, bridge: BrvBridge): void {
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => ({
      label: "ByteRover Curate",
      name: "brv-curate",
      description: BRV_CURATE_DESCRIPTION,
      parameters: BrvCurateParameters,
      execute: async (_toolCallId: string, args: unknown): Promise<unknown> => {
        const params = args as BrvCurateArgs;
        const cwd = params.cwd ?? ctx.workspaceDir;
        try {
          const result: PersistHtmlResult = await bridge.persistHtml(
            {
              html: params.html,
              ...(params.meta ? { meta: params.meta } : {}),
              ...(params.confirmOverwrite !== undefined
                ? { confirmOverwrite: params.confirmOverwrite }
                : {}),
            },
            cwd ? { cwd } : {},
          );
          return jsonResult(result);
        } catch (err) {
          return jsonResult({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
    { name: "brv-curate" },
  );
}

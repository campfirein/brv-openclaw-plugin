import { describe, it, expect, vi } from "vitest";
import type { BrvBridge, QueryToolModeResult } from "@byterover/brv-bridge";

import { registerBrvQueryTool } from "../../src/tools/brv-query.js";
import type { OpenClawPluginApi } from "../../src/types.js";

function makeMockApi() {
  type RegisteredTool = {
    factory: (ctx: { workspaceDir?: string }) => unknown;
    opts: { name: string };
  };
  const registered: RegisteredTool[] = [];
  const api = {
    config: {},
    pluginConfig: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {},
    registerContextEngine: vi.fn(),
    registerTool: vi.fn((factory: RegisteredTool["factory"], opts: RegisteredTool["opts"]) => {
      registered.push({ factory, opts });
    }),
  } as unknown as OpenClawPluginApi;
  return { api, registered };
}

function makeMockBridge() {
  return {
    persistHtml: vi.fn(),
    queryEnvelope: vi.fn(),
  } as unknown as BrvBridge;
}

function invokeTool(registered: { factory: (ctx: { workspaceDir?: string }) => unknown }[], ctx: { workspaceDir?: string }) {
  return registered[0].factory(ctx) as {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, args: unknown) => Promise<{ payload: unknown }>;
  };
}

describe("registerBrvQueryTool", () => {
  it("registers under the name 'brv-query'", () => {
    const { api, registered } = makeMockApi();
    registerBrvQueryTool(api, makeMockBridge());
    expect(registered).toHaveLength(1);
    expect(registered[0].opts.name).toBe("brv-query");
  });

  it("tool factory returns label/name/description/parameters/execute", () => {
    const { api, registered } = makeMockApi();
    registerBrvQueryTool(api, makeMockBridge());
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    expect(tool.name).toBe("brv-query");
    expect(tool.label).toBe("ByteRover Query");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBeDefined();
  });

  it("execute calls bridge.queryEnvelope with query + limit + cwd", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    const env: QueryToolModeResult = {
      status: "ok",
      matchedDocs: [],
      metadata: { durationMs: 5, skippedSharedCount: 0, tier: 2, topScore: 0, totalFound: 0 },
    };
    (bridge.queryEnvelope as ReturnType<typeof vi.fn>).mockResolvedValue(env);

    registerBrvQueryTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    const result = await tool.execute("call-1", { query: "what is auth?", limit: 5 });

    expect(bridge.queryEnvelope).toHaveBeenCalledWith(
      "what is auth?",
      expect.objectContaining({ limit: 5, cwd: "/ws" }),
    );
    expect(result.payload).toEqual(env);
  });

  it("execute prefers args.cwd over ctx.workspaceDir", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    (bridge.queryEnvelope as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "no-matches",
      matchedDocs: [],
      metadata: { durationMs: 1, skippedSharedCount: 0, tier: 2, topScore: 0, totalFound: 0 },
    });

    registerBrvQueryTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    await tool.execute("c", { query: "x", cwd: "/override" });

    expect(bridge.queryEnvelope).toHaveBeenCalledWith(
      "x",
      expect.objectContaining({ cwd: "/override" }),
    );
  });

  it("execute returns raw envelope verbatim (status: 'no-matches' is data, not error)", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    const env: QueryToolModeResult = {
      status: "no-matches",
      matchedDocs: [],
      metadata: { durationMs: 1, skippedSharedCount: 0, tier: 2, topScore: 0, totalFound: 0 },
    };
    (bridge.queryEnvelope as ReturnType<typeof vi.fn>).mockResolvedValue(env);

    registerBrvQueryTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    const result = await tool.execute("c", { query: "anything" });
    expect(result.payload).toEqual(env);
  });

  it("execute converts bridge errors to {status:'error', message} (no throw)", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    (bridge.queryEnvelope as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("daemon down"));

    registerBrvQueryTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    const result = await tool.execute("c", { query: "x" });

    expect(result.payload).toEqual({ status: "error", message: "daemon down" });
  });
});

import { describe, it, expect, vi } from "vitest";
import type { BrvBridge, PersistHtmlResult } from "@byterover/brv-bridge";

import { registerBrvCurateTool } from "../../src/tools/brv-curate.js";
import type { OpenClawPluginApi } from "../../src/types.js";

// -----------------------------------------------------------------------------
// Test harness — captures the tool factory + invocation surface so we can
// drive `execute` directly without spinning up OpenClaw.
// -----------------------------------------------------------------------------

function makeMockApi() {
  type RegisteredTool = {
    factory: (ctx: { workspaceDir?: string }) => unknown;
    opts: { name: string };
  };
  const registered: RegisteredTool[] = [];
  const api = {
    config: {},
    pluginConfig: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
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
  const tool = registered[0].factory(ctx) as {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, args: unknown) => Promise<{ payload: unknown }>;
  };
  return tool;
}

describe("registerBrvCurateTool", () => {
  it("registers under the name 'brv-curate'", () => {
    const { api, registered } = makeMockApi();
    registerBrvCurateTool(api, makeMockBridge());
    expect(registered).toHaveLength(1);
    expect(registered[0].opts.name).toBe("brv-curate");
  });

  it("tool factory returns label, name, description, parameters, execute", () => {
    const { api, registered } = makeMockApi();
    registerBrvCurateTool(api, makeMockBridge());
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    expect(tool.name).toBe("brv-curate");
    expect(tool.label).toBe("ByteRover Curate");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBeDefined();
  });

  it("execute calls bridge.persistHtml with html + ctx.workspaceDir as cwd", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    const okResult: PersistHtmlResult = { status: "ok", filePath: "x.html", topicPath: "x", overwrote: false };
    (bridge.persistHtml as ReturnType<typeof vi.fn>).mockResolvedValue(okResult);

    registerBrvCurateTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    const result = await tool.execute("call-1", { html: "<bv-topic path=\"a/b\"></bv-topic>" });

    expect(bridge.persistHtml).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<bv-topic path=\"a/b\"></bv-topic>" }),
      expect.objectContaining({ cwd: "/ws" }),
    );
    expect(result.payload).toEqual(okResult);
  });

  it("execute prefers args.cwd over ctx.workspaceDir", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    (bridge.persistHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      filePath: "x.html",
      topicPath: "x",
      overwrote: false,
    });

    registerBrvCurateTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    await tool.execute("call-1", { html: "<bv-topic></bv-topic>", cwd: "/override" });

    expect(bridge.persistHtml).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/override" }),
    );
  });

  it("execute threads meta through to the bridge", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    (bridge.persistHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      filePath: "x.html",
      topicPath: "x",
      overwrote: false,
    });

    registerBrvCurateTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    const meta = { type: "ADD" as const, impact: "high" as const, reason: "test" };
    await tool.execute("c", { html: "<bv-topic></bv-topic>", meta });

    expect(bridge.persistHtml).toHaveBeenCalledWith(
      expect.objectContaining({ meta }),
      expect.anything(),
    );
  });

  it("execute returns validation-failed payload structurally (no throw)", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    (bridge.persistHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "validation-failed",
      errors: [{ kind: "missing-bv-topic", message: "no root" }],
    });

    registerBrvCurateTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    const result = await tool.execute("c", { html: "not a topic" });

    expect(result.payload).toEqual({
      status: "validation-failed",
      errors: [{ kind: "missing-bv-topic", message: "no root" }],
    });
  });

  it("execute converts bridge errors to {status:'error', message} (no throw)", async () => {
    const { api, registered } = makeMockApi();
    const bridge = makeMockBridge();
    (bridge.persistHtml as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("daemon down"));

    registerBrvCurateTool(api, bridge);
    const tool = invokeTool(registered, { workspaceDir: "/ws" });
    const result = await tool.execute("c", { html: "<bv-topic></bv-topic>" });

    expect(result.payload).toEqual({ status: "error", message: "daemon down" });
  });
});

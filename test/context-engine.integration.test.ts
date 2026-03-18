import type { PluginLogger } from "../src/types.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrvJsonResponse, BrvQueryResult } from "../src/brv-process.js";
import { ByteRoverContextEngine } from "../src/context-engine.js";

// ---------------------------------------------------------------------------
// Mock brv-process so no real CLI is spawned
// ---------------------------------------------------------------------------

type BrvQueryFn = typeof import("../src/brv-process.js").brvQuery;

const mocks = vi.hoisted(() => ({
  brvQuery: vi.fn<BrvQueryFn>(),
}));

vi.mock("../src/brv-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/brv-process.js")>();
  return {
    ...actual,
    brvQuery: mocks.brvQuery,
  };
});

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeQueryResponse(result: string): BrvJsonResponse<BrvQueryResult> {
  return {
    command: "query",
    success: true,
    timestamp: new Date().toISOString(),
    data: { status: "completed", result },
  };
}

// ---------------------------------------------------------------------------
// Integration tests — assemble → brvQuery with mocked brv
// ---------------------------------------------------------------------------

describe("ByteRoverContextEngine integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // assemble → brvQuery
  // -------------------------------------------------------------------------

  describe("assemble → brvQuery", () => {
    it("calls brvQuery with cleaned prompt and injects systemPromptAddition", async () => {
      mocks.brvQuery.mockResolvedValue(
        makeQueryResponse("User prefers TypeScript with strict mode."),
      );
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);
      const messages = [{ role: "user", content: "Tell me about TS config" }] as unknown[];

      const result = await engine.assemble({
        sessionId: "s1",
        messages,
        prompt: "Tell me about TS config",
      });

      expect(mocks.brvQuery).toHaveBeenCalledOnce();
      const call = mocks.brvQuery.mock.calls[0][0];
      expect(call.query).toBe("Tell me about TS config");
      expect(call.signal).toBeInstanceOf(AbortSignal);

      expect(result.systemPromptAddition).toContain("<byterover-context>");
      expect(result.systemPromptAddition).toContain("User prefers TypeScript with strict mode.");
      expect(result.systemPromptAddition).toContain("</byterover-context>");
      expect(result.messages).toBe(messages);
    });

    it("strips metadata from prompt before querying brv", async () => {
      mocks.brvQuery.mockResolvedValue(makeQueryResponse("some context"));
      const engine = new ByteRoverContextEngine({}, makeLogger());

      const prompt = [
        "Sender (untrusted metadata):",
        "```json",
        '{"name": "Bob"}',
        "```",
        "How do I configure plugins?",
      ].join("\n");

      await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt,
      });

      const call = mocks.brvQuery.mock.calls[0][0];
      expect(call.query).toBe("How do I configure plugins?");
      expect(call.query).not.toContain("untrusted metadata");
    });

    it("falls back to extracting query from messages when no prompt", async () => {
      mocks.brvQuery.mockResolvedValue(makeQueryResponse("relevant context"));
      const engine = new ByteRoverContextEngine({}, makeLogger());

      const messages = [
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "What are context engines?" },
      ] as unknown[];

      const result = await engine.assemble({ sessionId: "s1", messages });

      const call = mocks.brvQuery.mock.calls[0][0];
      expect(call.query).toBe("What are context engines?");
      expect(result.systemPromptAddition).toContain("relevant context");
    });

    it("returns no systemPromptAddition when brvQuery returns empty result", async () => {
      mocks.brvQuery.mockResolvedValue(makeQueryResponse(""));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "some question here" }] as unknown[],
        prompt: "some question here",
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith("assemble brv query returned empty result");
    });

    it("returns no systemPromptAddition when brvQuery throws", async () => {
      mocks.brvQuery.mockRejectedValue(new Error("connection refused"));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "a valid question",
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("query failed (best-effort)"),
      );
    });

    it("logs timeout warning when brvQuery is aborted", async () => {
      mocks.brvQuery.mockRejectedValue(new Error("brv query aborted"));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "a valid question",
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    });

    it("uses result.content as fallback when result.result is missing", async () => {
      mocks.brvQuery.mockResolvedValue({
        command: "query",
        success: true,
        timestamp: new Date().toISOString(),
        data: { status: "completed" as const, content: "fallback content here" },
      });
      const engine = new ByteRoverContextEngine({}, makeLogger());

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "tell me something",
      });

      expect(result.systemPromptAddition).toContain("fallback content here");
    });
  });
});

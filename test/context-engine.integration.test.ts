import type { PluginLogger } from "../src/types.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ByteRoverContextEngine } from "../src/context-engine.js";

// ---------------------------------------------------------------------------
// Mock @byterover/brv-bridge so no real CLI is spawned
// ---------------------------------------------------------------------------

const mockRecall = vi.fn();
const mockPersist = vi.fn();
const mockShutdown = vi.fn();

vi.mock("@byterover/brv-bridge", () => ({
  BrvBridge: vi.fn().mockImplementation(() => ({
    recall: mockRecall,
    persist: mockPersist,
    shutdown: mockShutdown,
    ready: vi.fn().mockResolvedValue(true),
  })),
}));

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Integration tests — assemble → bridge.recall with mocked bridge
// ---------------------------------------------------------------------------

describe("ByteRoverContextEngine integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // assemble → bridge.recall
  // -------------------------------------------------------------------------

  describe("assemble → bridge.recall", () => {
    it("calls recall with cleaned prompt and injects systemPromptAddition", async () => {
      mockRecall.mockResolvedValue({
        content: "User prefers TypeScript with strict mode.",
      });
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, logger);
      const messages = [{ role: "user", content: "Tell me about TS config" }] as unknown[];

      const result = await engine.assemble({
        sessionId: "s1",
        messages,
        prompt: "Tell me about TS config",
      });

      expect(mockRecall).toHaveBeenCalledOnce();
      const call = mockRecall.mock.calls[0];
      expect(call[0]).toBe("Tell me about TS config");
      expect(call[1]).toHaveProperty("signal");

      expect(result.systemPromptAddition).toContain("<byterover-context>");
      expect(result.systemPromptAddition).toContain("User prefers TypeScript with strict mode.");
      expect(result.systemPromptAddition).toContain("</byterover-context>");
      expect(result.messages).toBe(messages);
    });

    it("strips metadata from prompt before querying", async () => {
      mockRecall.mockResolvedValue({ content: "some context" });
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

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

      const query = mockRecall.mock.calls[0][0];
      expect(query).toBe("How do I configure plugins?");
      expect(query).not.toContain("untrusted metadata");
    });

    it("falls back to extracting query from messages when no prompt", async () => {
      mockRecall.mockResolvedValue({ content: "relevant context" });
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      const messages = [
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "What are context engines?" },
      ] as unknown[];

      const result = await engine.assemble({ sessionId: "s1", messages });

      const query = mockRecall.mock.calls[0][0];
      expect(query).toBe("What are context engines?");
      expect(result.systemPromptAddition).toContain("relevant context");
    });

    it("returns no systemPromptAddition when recall returns empty content", async () => {
      mockRecall.mockResolvedValue({ content: "" });
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "some question here" }] as unknown[],
        prompt: "some question here",
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith("assemble brv query returned empty result");
    });

    it("returns no systemPromptAddition when recall throws", async () => {
      mockRecall.mockRejectedValue(new Error("connection refused"));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "a valid question",
      });

      expect(result.systemPromptAddition).toBeUndefined();
    });

    it("passes cwd override from resolveWorkspaceDir", async () => {
      mockRecall.mockResolvedValue({ content: "answer" });
      const engine = new ByteRoverContextEngine({ cwd: "/base/dir" }, makeLogger());

      await engine.assemble({
        sessionId: "s1",
        sessionKey: "agent:sub1:channel",
        messages: [],
        prompt: "a valid question",
      });

      const options = mockRecall.mock.calls[0][1];
      expect(options.cwd).toBe("/base/dir-sub1");
    });
  });

  // -------------------------------------------------------------------------
  // afterTurn → bridge.persist
  // -------------------------------------------------------------------------

  describe("afterTurn → bridge.persist", () => {
    it("calls persist with serialized conversation", async () => {
      mockPersist.mockResolvedValue({ status: "queued" });
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      const messages = [
        { role: "user", content: "What is ByteRover?" },
        { role: "assistant", content: "ByteRover is a context engine." },
      ] as unknown[];

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages,
        prePromptMessageCount: 0,
      });

      expect(mockPersist).toHaveBeenCalledOnce();
      const context = mockPersist.mock.calls[0][0];
      expect(context).toContain("What is ByteRover?");
      expect(context).toContain("ByteRover is a context engine.");
    });

    it("skips heartbeat turns", async () => {
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [{ role: "user", content: "hi" }] as unknown[],
        prePromptMessageCount: 0,
        isHeartbeat: true,
      });

      expect(mockPersist).not.toHaveBeenCalled();
    });

    it("skips when no new messages", async () => {
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [{ role: "user", content: "old" }] as unknown[],
        prePromptMessageCount: 1,
      });

      expect(mockPersist).not.toHaveBeenCalled();
    });
  });
});

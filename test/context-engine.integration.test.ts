import type { PluginLogger } from "../src/types.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ByteRoverContextEngine } from "../src/context-engine.js";

// ---------------------------------------------------------------------------
// Mock @byterover/brv-bridge so no real CLI is spawned
// ---------------------------------------------------------------------------

const mockRecall = vi.fn();
const mockPersistHtml = vi.fn();
const mockQueryEnvelope = vi.fn();
const mockShutdown = vi.fn();

vi.mock("@byterover/brv-bridge", () => ({
  BrvBridge: vi.fn().mockImplementation(() => ({
    recall: mockRecall,
    persistHtml: mockPersistHtml,
    queryEnvelope: mockQueryEnvelope,
    shutdown: mockShutdown,
    ready: vi.fn().mockResolvedValue(true),
  })),
}));

// ---------------------------------------------------------------------------
// Mock node:fs so resolveWorkspaceDir's read of ~/.openclaw/openclaw.json
// doesn't leak the developer's actual config into the test.
// ---------------------------------------------------------------------------

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      const path = args[0];
      if (typeof path === "string" && path.includes("openclaw.json")) {
        throw new Error("ENOENT: openclaw.json not present in test env");
      }
      return actual.readFileSync(...args);
    }),
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

// ---------------------------------------------------------------------------
// Integration tests — assemble → bridge.recall with mocked bridge
// ---------------------------------------------------------------------------

describe("ByteRoverContextEngine integration (v2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // assemble → bridge.recall (+ guidance every turn)
  // -------------------------------------------------------------------------

  describe("assemble → bridge.recall", () => {
    it("calls recall with cleaned prompt and injects context + guidance", async () => {
      mockRecall.mockResolvedValue({
        content: "User prefers TypeScript with strict mode.",
        matchedDocs: [
          {
            format: "markdown",
            path: "prefs/typescript.md",
            rendered_md: "User prefers TypeScript with strict mode.",
            score: 0.9,
            title: "TypeScript preferences",
          },
        ],
      });
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
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
      expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
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

      await engine.assemble({ sessionId: "s1", messages: [], prompt });

      const query = mockRecall.mock.calls[0][0];
      expect(query).toBe("How do I configure plugins?");
      expect(query).not.toContain("untrusted metadata");
    });

    it("falls back to extracting query from messages when no prompt", async () => {
      mockRecall.mockResolvedValue({
        content: "relevant context",
        matchedDocs: [
          { format: "html", path: "x.md", rendered_md: "relevant context", score: 0.9, title: "X" },
        ],
      });
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

    it("injects guidance-only (no context block) when recall returns empty content", async () => {
      mockRecall.mockResolvedValue({ content: "", matchedDocs: [] });
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "some question here" }] as unknown[],
        prompt: "some question here",
      });

      expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
      expect(result.systemPromptAddition).not.toContain("<byterover-context>");
    });

    it("injects guidance-only when recall throws (best-effort)", async () => {
      mockRecall.mockRejectedValue(new Error("connection refused"));
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "a valid question",
      });

      expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
      expect(result.systemPromptAddition).not.toContain("<byterover-context>");
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
  // afterTurn → no-op (v2 dropped auto-curate; agent calls brv-curate tool)
  // -------------------------------------------------------------------------

  describe("afterTurn → no-op", () => {
    it("does NOT call persistHtml regardless of message content", async () => {
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

      expect(mockPersistHtml).not.toHaveBeenCalled();
    });

    it("is a no-op for heartbeat turns", async () => {
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [{ role: "user", content: "hi" }] as unknown[],
        prePromptMessageCount: 0,
        isHeartbeat: true,
      });

      expect(mockPersistHtml).not.toHaveBeenCalled();
    });

    it("is a no-op when there are no new messages", async () => {
      const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [{ role: "user", content: "old" }] as unknown[],
        prePromptMessageCount: 1,
      });

      expect(mockPersistHtml).not.toHaveBeenCalled();
    });
  });
});

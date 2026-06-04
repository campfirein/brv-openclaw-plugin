import { describe, expect, it, vi } from "vitest";
import {
  ByteRoverContextEngine,
  buildSystemPromptAddition,
  extractLatestUserQuery,
} from "../src/context-engine.js";
import { extractTextContent } from "../src/message-utils.js";
import type { PluginLogger } from "../src/types.js";

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// ByteRoverContextEngine — lifecycle shape (no real subprocess; recallScript
// is pinned to a non-existent path so spawnRecall returns empty fast.)
// ---------------------------------------------------------------------------

const NO_RECALL = { recallScript: "/tmp/byterover-test-no-such-recall.mjs" };

describe("ByteRoverContextEngine", () => {
  it("has correct info fields", () => {
    const engine = new ByteRoverContextEngine(
      { cwd: "/tmp/test", ...NO_RECALL },
      makeLogger(),
    );
    expect(engine.info.id).toBe("byterover");
    expect(engine.info.name).toBe("ByteRover");
    expect(engine.info.ownsCompaction).toBe(false);
    expect(engine.info.version).toMatch(/mono/);
  });

  it("ingest is a no-op (no afterTurn auto-curate in mono)", async () => {
    const engine = new ByteRoverContextEngine(
      { cwd: "/tmp/test", ...NO_RECALL },
      makeLogger(),
    );
    const result = await engine.ingest({
      sessionId: "s1",
      message: { role: "user", content: "hi" },
    });
    expect(result).toEqual({ ingested: false });
  });

  it("compact returns not-compacted", async () => {
    const engine = new ByteRoverContextEngine(
      { cwd: "/tmp/test", ...NO_RECALL },
      makeLogger(),
    );
    const result = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
    });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
  });

  it("dispose is a no-op (no daemon, no bridge)", async () => {
    const engine = new ByteRoverContextEngine(
      { cwd: "/tmp/test", ...NO_RECALL },
      makeLogger(),
    );
    await expect(engine.dispose()).resolves.toBeUndefined();
  });

  it("assemble emits curate guidance even when no query is available", async () => {
    const engine = new ByteRoverContextEngine(
      { cwd: "/tmp/test", ...NO_RECALL },
      makeLogger(),
    );
    const messages = [{ role: "assistant", content: "hello" }] as unknown[];
    const result = await engine.assemble({ sessionId: "s1", messages });
    expect(result.messages).toBe(messages);
    expect(result.estimatedTokens).toBe(0);
    // Per the integration plan: curate guidance ships every assemble so the
    // agent always knows how to record. No retrieved content here (no query).
    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
  });

  it("assemble skips recall for trivially short prompts but still emits guidance", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine(
      { cwd: "/tmp/test", ...NO_RECALL },
      logger,
    );
    const messages = [{ role: "user", content: "ok" }] as unknown[];
    const result = await engine.assemble({ sessionId: "s1", messages, prompt: "ok" });
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("query too short"));
  });

  it("assemble strips user metadata before measuring query length", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine(
      { cwd: "/tmp/test", ...NO_RECALL },
      logger,
    );
    const prompt = [
      "Sender (untrusted metadata):",
      "```json",
      '{"name": "Alice"}',
      "```",
      "hi",
    ].join("\n");
    const result = await engine.assemble({ sessionId: "s1", messages: [], prompt });
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("query too short"));
  });
});

// ---------------------------------------------------------------------------
// buildSystemPromptAddition
// ---------------------------------------------------------------------------

describe("buildSystemPromptAddition", () => {
  it("returns curate guidance only when retrieved content is empty", () => {
    const out = buildSystemPromptAddition("", "<byterover-curate-guidance>STUB</byterover-curate-guidance>");
    expect(out).toContain("byterover-curate-guidance");
    expect(out).not.toContain("# Project knowledge retrieved from ByteRover");
  });

  it("returns context block + curate guidance when content is present", () => {
    const out = buildSystemPromptAddition(`<bv-topic path="x" title="X"></bv-topic>`, "<byterover-curate-guidance>STUB</byterover-curate-guidance>");
    expect(out).toContain("# Project knowledge retrieved from ByteRover");
    expect(out).toContain(`<bv-topic path="x"`);
    expect(out).toContain("byterover-curate-guidance");
  });

  it("treats whitespace-only content as empty", () => {
    const out = buildSystemPromptAddition("   \n  \t  ", "<byterover-curate-guidance>STUB</byterover-curate-guidance>");
    expect(out).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(out).toContain("byterover-curate-guidance");
  });
});

// ---------------------------------------------------------------------------
// extractTextContent (hoisted into message-utils for the mono build)
// ---------------------------------------------------------------------------

describe("extractTextContent", () => {
  it("returns string content directly", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("extracts text from ContentBlock array", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "image", url: "x" },
      { type: "text", text: "second" },
    ];
    expect(extractTextContent(blocks)).toBe("first\nsecond");
  });

  it("returns empty string for non-string/non-array", () => {
    expect(extractTextContent(42)).toBe("");
    expect(extractTextContent(null)).toBe("");
    expect(extractTextContent(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractLatestUserQuery
// ---------------------------------------------------------------------------

describe("extractLatestUserQuery", () => {
  it("returns the last user message text", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ];
    expect(extractLatestUserQuery(messages)).toBe("second question");
  });

  it("strips metadata from user message", () => {
    const messages = [
      {
        role: "user",
        content: [
          "Sender (untrusted metadata):",
          "```json",
          '{"name": "X"}',
          "```",
          "actual query",
        ].join("\n"),
      },
    ];
    expect(extractLatestUserQuery(messages)).toBe("actual query");
  });

  it("returns null when no user messages exist", () => {
    const messages = [{ role: "assistant", content: "hi" }];
    expect(extractLatestUserQuery(messages)).toBeNull();
  });

  it("returns null when user message is metadata-only", () => {
    const messages = [
      {
        role: "user",
        content: ["Sender (untrusted metadata):", "```json", '{"name": "X"}', "```"].join("\n"),
      },
    ];
    expect(extractLatestUserQuery(messages)).toBeNull();
  });
});

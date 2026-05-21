import type { PluginLogger } from "../src/types.js";
import { describe, it, expect, vi } from "vitest";
import { ByteRoverContextEngine, extractTextContent, extractLatestUserQuery } from "../src/context-engine.js";

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// ByteRoverContextEngine — lifecycle shape
// ---------------------------------------------------------------------------

describe("ByteRoverContextEngine", () => {
  it("has correct info fields and reports v2", () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    expect(engine.info.id).toBe("byterover");
    expect(engine.info.name).toBe("ByteRover");
    expect(engine.info.ownsCompaction).toBe(false);
    expect(engine.info.version).toBe("2.0.0");
  });

  it("ingest returns { ingested: false }", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    const result = await engine.ingest({
      sessionId: "s1",
      message: { role: "user", content: "hi" },
    });
    expect(result).toEqual({ ingested: false });
  });

  it("compact returns not-compacted", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    const result = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
    });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // afterTurn — no-op stub; plugin is context-engine-only, no auto-curate
  // -------------------------------------------------------------------------

  it("afterTurn is a no-op and does NOT call the bridge", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    const persistSpy = vi.spyOn(engine["bridge"], "persistHtml").mockResolvedValue({
      status: "ok",
      filePath: "x.html",
      topicPath: "x",
      overwrote: false,
    });

    await engine.afterTurn({
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      messages: [{ role: "user", content: "anything" }, { role: "assistant", content: "reply" }],
      prePromptMessageCount: 0,
    });

    expect(persistSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // assemble — guidance is injected every turn even when recall is skipped
  // -------------------------------------------------------------------------

  it("assemble injects curate guidance even with no prompt and no user messages", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    const messages = [{ role: "assistant", content: "hello" }] as unknown[];
    const result = await engine.assemble({
      sessionId: "s1",
      messages,
    });
    expect(result.messages).toBe(messages);
    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
    // No recall happened, so no <byterover-context> block.
    expect(result.systemPromptAddition).not.toContain("<byterover-context>");
  });

  it("assemble injects guidance-only when prompt is too short to query", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, logger);
    const messages = [{ role: "user", content: "ok" }] as unknown[];
    const result = await engine.assemble({
      sessionId: "s1",
      messages,
      prompt: "ok",
    });
    expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
    expect(result.systemPromptAddition).not.toContain("<byterover-context>");
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("query too short"));
  });

  it("assemble skips recall after metadata stripping makes the prompt trivial", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    const prompt = [
      "Sender (untrusted metadata):",
      "```json",
      '{"name": "Alice"}',
      "```",
      "hi",
    ].join("\n");
    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt,
    });
    expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
    expect(result.systemPromptAddition).not.toContain("<byterover-context>");
  });

  it("assemble combines recall + guidance when bridge.recall returns content", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    vi.spyOn(engine["bridge"], "recall").mockResolvedValue({
      content: "## Auth\nUse RS256.",
      matchedDocs: [
        { format: "html", path: "security/auth.md", rendered_md: "## Auth\nUse RS256.", score: 0.91, title: "Auth" },
      ],
    });

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "How do we sign JWTs?",
    });

    expect(result.systemPromptAddition).toContain("<byterover-context>");
    expect(result.systemPromptAddition).toContain("## Auth");
    expect(result.systemPromptAddition).toContain("Use RS256.");
    // Guidance block comes after the context block.
    expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
    const ctxIdx = result.systemPromptAddition!.indexOf("<byterover-context>");
    const guidanceIdx = result.systemPromptAddition!.indexOf("<byterover-curate-guidance>");
    expect(guidanceIdx).toBeGreaterThan(ctxIdx);
  });

  it("assemble guidance-only when bridge.recall returns empty content", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    vi.spyOn(engine["bridge"], "recall").mockResolvedValue({
      content: "",
      matchedDocs: [],
    });

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "an unmatched question with enough length",
    });

    expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
    expect(result.systemPromptAddition).not.toContain("<byterover-context>");
  });

  it("assemble degrades to guidance-only when bridge.recall throws", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, logger);
    vi.spyOn(engine["bridge"], "recall").mockRejectedValue(new Error("daemon down"));

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "a long enough query",
    });

    expect(result.systemPromptAddition).toContain("<byterover-curate-guidance>");
    expect(result.systemPromptAddition).not.toContain("<byterover-context>");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("recall failed"));
  });

  // -------------------------------------------------------------------------
  // assemble — recent-messages block
  // -------------------------------------------------------------------------

  it("assemble injects <byterover-recent-messages> when prior history exists", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    vi.spyOn(engine["bridge"], "recall").mockResolvedValue({ content: "" });
    const messages = [
      { role: "user", content: "We discussed Postgres yesterday." },
      { role: "assistant", content: "Yes, we agreed on RS256 too." },
      { role: "user", content: "What's the test framework?" }, // current prompt
    ] as unknown[];

    const result = await engine.assemble({
      sessionId: "s1",
      messages,
      prompt: "What's the test framework?",
    });

    expect(result.systemPromptAddition).toContain("<byterover-recent-messages>");
    expect(result.systemPromptAddition).toContain("Postgres");
    expect(result.systemPromptAddition).toContain("RS256");
    // Current prompt is excluded — it's already the actual user message.
    // The body of the recent-messages block should NOT repeat the current prompt's text:
    const recentBody = result.systemPromptAddition!.match(/<byterover-recent-messages>([\s\S]*?)<\/byterover-recent-messages>/)?.[1] ?? "";
    expect(recentBody).not.toContain("What's the test framework?");
  });

  it("assemble omits recent-messages block when there's no prior history", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    vi.spyOn(engine["bridge"], "recall").mockResolvedValue({ content: "" });
    const result = await engine.assemble({
      sessionId: "s1",
      messages: [{ role: "user", content: "first message" }] as unknown[],
      prompt: "first message",
    });
    expect(result.systemPromptAddition).not.toContain("<byterover-recent-messages>");
  });

  it("assemble orders blocks: context → recent → guidance", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    vi.spyOn(engine["bridge"], "recall").mockResolvedValue({
      content: "## Auth\nUse RS256.",
      matchedDocs: [
        { format: "html", path: "security/auth.md", rendered_md: "## Auth\nUse RS256.", score: 0.9, title: "Auth" },
      ],
    });

    const messages = [
      { role: "user", content: "earlier-discussion message" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "current question" },
    ] as unknown[];

    const result = await engine.assemble({
      sessionId: "s1",
      messages,
      prompt: "current question",
    });

    const addition = result.systemPromptAddition!;
    const contextIdx = addition.indexOf("<byterover-context>");
    const recentIdx = addition.indexOf("<byterover-recent-messages>");
    const guidanceIdx = addition.indexOf("<byterover-curate-guidance>");

    expect(contextIdx).toBeGreaterThan(-1);
    expect(recentIdx).toBeGreaterThan(contextIdx);
    expect(guidanceIdx).toBeGreaterThan(recentIdx);
  });

  // -------------------------------------------------------------------------
  // guidance content — points at the `brv curate` CLI, not an agent tool
  // -------------------------------------------------------------------------

  it("guidance describes retrieved-context usage and points at the brv CLI", async () => {
    const engine = new ByteRoverContextEngine({ cwd: "/tmp/test" }, makeLogger());
    const result = await engine.assemble({ sessionId: "s1", messages: [] });
    const guidance = result.systemPromptAddition!;
    expect(guidance).toContain("<byterover-curate-guidance>");
    expect(guidance).toContain("retrieved context block above");
    expect(guidance).toContain("brv curate");
    // Should NOT advertise a brv-curate tool — no such tool registered in v2.0
    expect(guidance).not.toMatch(/call brv-curate/);
  });
});

// ---------------------------------------------------------------------------
// extractTextContent
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

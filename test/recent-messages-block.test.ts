import { describe, it, expect } from "vitest";

import { buildRecentMessagesBlock } from "../src/recent-messages-block.js";

function user(text: string): unknown { return { role: "user", content: text }; }
function assistant(text: string): unknown { return { role: "assistant", content: text }; }
function toolResult(): unknown { return { role: "toolResult", content: "ignored" }; }

describe("buildRecentMessagesBlock", () => {
  it("returns empty string when no messages", () => {
    expect(buildRecentMessagesBlock([], { excludeLatest: false })).toBe("");
  });

  it("returns empty string when only toolResult messages exist", () => {
    expect(buildRecentMessagesBlock([toolResult(), toolResult()], { excludeLatest: false })).toBe("");
  });

  it("renders a block with the last 5 user/assistant messages", () => {
    const messages = [
      user("msg 1"),
      assistant("msg 2"),
      user("msg 3"),
      assistant("msg 4"),
      user("msg 5"),
      assistant("msg 6"),
      user("msg 7"),
    ];
    const block = buildRecentMessagesBlock(messages, { excludeLatest: false });
    expect(block).toContain("<byterover-recent-messages>");
    expect(block).toContain("</byterover-recent-messages>");
    // Last 5 → msg 3, 4, 5, 6, 7
    expect(block).toContain("msg 3");
    expect(block).toContain("msg 4");
    expect(block).toContain("msg 5");
    expect(block).toContain("msg 6");
    expect(block).toContain("msg 7");
    // Not the older ones
    expect(block).not.toContain("msg 1");
    expect(block).not.toContain("msg 2");
  });

  it("filters out toolResult messages before slicing the last 5", () => {
    const messages = [
      user("U1"),
      toolResult(),
      assistant("A1"),
      toolResult(),
      user("U2"),
      assistant("A2"),
      toolResult(),
      user("U3"),
    ];
    const block = buildRecentMessagesBlock(messages, { excludeLatest: false });
    expect(block).toContain("U1");
    expect(block).toContain("U2");
    expect(block).toContain("U3");
    expect(block).toContain("A1");
    expect(block).toContain("A2");
    expect(block).not.toContain("ignored");
  });

  it("excludes the latest user message when excludeLatest: true (current-prompt mode)", () => {
    const messages = [
      user("history 1"),
      assistant("history 2"),
      user("history 3"),
      assistant("history 4"),
      user("current prompt — should be excluded"),
    ];
    const block = buildRecentMessagesBlock(messages, { excludeLatest: true });
    expect(block).toContain("history 1");
    expect(block).toContain("history 2");
    expect(block).toContain("history 3");
    expect(block).toContain("history 4");
    expect(block).not.toContain("current prompt — should be excluded");
  });

  it("returns empty string when excludeLatest leaves nothing", () => {
    const messages = [user("only message")];
    expect(buildRecentMessagesBlock(messages, { excludeLatest: true })).toBe("");
  });

  it("strips user-metadata sentinels before rendering", () => {
    const messages = [
      user(
        [
          "Sender (untrusted metadata):",
          "```json",
          '{"name": "Alice"}',
          "```",
          "real user content",
        ].join("\n"),
      ),
    ];
    const block = buildRecentMessagesBlock(messages, { excludeLatest: false });
    expect(block).toContain("real user content");
    expect(block).not.toContain("Sender (untrusted metadata)");
    expect(block).not.toContain("Alice");
  });

  it("caps each message excerpt at 500 chars with an ellipsis", () => {
    const long = "x".repeat(600);
    const block = buildRecentMessagesBlock([user(long)], { excludeLatest: false });
    // Ellipsis marker present
    expect(block).toContain("…");
    // No run of 500+ consecutive xs (would mean the cap didn't fire)
    expect(block).not.toMatch(/x{500}/);
    // But ~499 should be present
    expect(block).toMatch(/x{499}/);
  });

  it("labels role explicitly: [user] / [assistant]", () => {
    const block = buildRecentMessagesBlock(
      [user("a"), assistant("b")],
      { excludeLatest: false },
    );
    expect(block).toContain("[user]:");
    expect(block).toContain("[assistant]:");
  });

  it("handles ContentBlock[] arrays (text-typed blocks)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "first part" },
          { type: "image", url: "x" },
          { type: "text", text: "second part" },
        ],
      },
    ];
    const block = buildRecentMessagesBlock(messages, { excludeLatest: false });
    expect(block).toContain("first part");
    expect(block).toContain("second part");
  });

  it("respects a custom limit", () => {
    const messages = [
      user("m1"),
      user("m2"),
      user("m3"),
      user("m4"),
    ];
    const block = buildRecentMessagesBlock(messages, { excludeLatest: false, limit: 2 });
    expect(block).not.toContain("m1");
    expect(block).not.toContain("m2");
    expect(block).toContain("m3");
    expect(block).toContain("m4");
  });
});

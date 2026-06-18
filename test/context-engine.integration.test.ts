import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ByteRoverContextEngine } from "../src/context-engine.js";
import { recordTopic } from "../src/record.js";
import type { PluginLogger } from "../src/types.js";

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

let prevBrvDataDir: string | undefined;
let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  prevBrvDataDir = process.env.BRV_DATA_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "byterover-plugin-integ-"));
  process.env.BRV_DATA_DIR = join(tmpDir, ".brvdata");
  workspaceDir = join(tmpDir, "workspace");
});

afterEach(() => {
  if (prevBrvDataDir === undefined) {
    delete process.env.BRV_DATA_DIR;
  } else {
    process.env.BRV_DATA_DIR = prevBrvDataDir;
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.clearAllMocks();
});

describe("ByteRoverContextEngine integration (mono)", () => {
  it("assemble recalls a topic written through the in-process record path", async () => {
    const write = await recordTopic(workspaceDir, {
      path: "typescript/strict_mode",
      html:
        '<bv-topic path="typescript/strict_mode" title="TypeScript strict mode" ' +
        'summary="Project preference for TypeScript strict mode." ' +
        'keywords="typescript,strict,tsconfig,noImplicitAny" tags="typescript,config">' +
        "<bv-task>Preserve the TypeScript strict-mode preference.</bv-task>" +
        "<bv-highlights>Use strict TypeScript settings for new TypeScript work.</bv-highlights>" +
        '<bv-fact subject="typescript_strict_mode" category="preference" value="enabled">' +
        "The project prefers TypeScript strict mode and noImplicitAny for new TypeScript work." +
        "</bv-fact>" +
        "</bv-topic>",
    });
    expect(write.ok).toBe(true);

    const logger = makeLogger();
    const engine = new ByteRoverContextEngine(
      { cwd: workspaceDir, recallLimit: 3 },
      logger,
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [{ role: "user", content: "What TypeScript config should I use?" }] as unknown[],
      prompt: "What TypeScript strict config should I use?",
    });

    expect(result.systemPromptAddition).toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain('path="typescript/strict_mode"');
    expect(result.systemPromptAddition).toContain("noImplicitAny");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[byterover] assemble: 1 hit(s)"),
    );
  });

  it("assemble falls back to guidance only when the workspace has no context tree", async () => {
    const logger = makeLogger();
    const engine = new ByteRoverContextEngine(
      { cwd: workspaceDir },
      logger,
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "tell me about missing project knowledge",
    });

    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[byterover] in-process recall failed"),
    );
  });

  it("ignores deprecated script and timeout config while keeping guidance", async () => {
    const engine = new ByteRoverContextEngine(
      {
        cwd: workspaceDir,
        recallScript: join(tmpDir, "does-not-exist.mjs"),
        recallTimeoutMs: 1,
      },
      makeLogger(),
    );

    const result = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "tell me about config",
    });

    expect(result.systemPromptAddition).toContain("byterover-curate-guidance");
    expect(result.systemPromptAddition).not.toContain("# Project knowledge retrieved from ByteRover");
  });

  it("ingest, compact, and dispose remain host-safe no-ops", async () => {
    const engine = new ByteRoverContextEngine(
      { cwd: workspaceDir },
      makeLogger(),
    );

    await expect(
      engine.ingest({
        sessionId: "s1",
        message: { role: "user", content: "hi" },
      }),
    ).resolves.toEqual({ ingested: false });

    await expect(
      engine.compact({
        sessionId: "s1",
        sessionFile: join(tmpDir, "s1.jsonl"),
      }),
    ).resolves.toMatchObject({ ok: true, compacted: false });

    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});

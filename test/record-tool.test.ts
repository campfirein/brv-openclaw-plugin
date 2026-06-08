import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeRecordTool } from "../src/record.js";

describe("brv_record tool (in-process)", () => {
  let ws: string;
  beforeEach(() => {
    const sb = mkdtempSync(join(tmpdir(), "brvtool-"));
    process.env.BRV_DATA_DIR = join(sb, ".brvdata"); // isolate the tree
    ws = join(sb, "workspace");
    mkdirSync(ws, { recursive: true });
  });

  it("exposes the expected schema", () => {
    const tool = makeRecordTool({ workspaceDir: ws }, { baseCwd: ws });
    expect(tool.name).toBe("brv_record");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["html", "overwrite", "path"]);
  });

  it("writes a topic to the tree via execute()", async () => {
    const tool = makeRecordTool({ workspaceDir: ws }, { baseCwd: ws });
    const html =
      '<bv-topic path="tech/t" title="T"><bv-reason>r</bv-reason>' +
      '<bv-task>task</bv-task>' +
      '<bv-fact subject="x" category="other" value="v">A fact.</bv-fact></bv-topic>';
    const res = await tool.execute("c1", { path: "tech/t", html });
    expect(res.details.ok).toBe(true);
    expect(res.details.created).toBe(true);
    expect(res.content[0]!.text).toContain("Saved to ByteRover");
    expect(existsSync(res.details.filePath!)).toBe(true);
  });

  it("returns a structured error on missing input (never throws)", async () => {
    const tool = makeRecordTool({ workspaceDir: ws }, { baseCwd: ws });
    const res = await tool.execute("c2", { path: "", html: "x" });
    expect(res.details.ok).toBe(false);
    expect(res.details.error).toMatch(/path is required/);
  });
});

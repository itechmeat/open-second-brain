import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildComplexityReport,
  complexityPathFactors,
} from "../../src/core/discipline/complexity.ts";

describe("complexity report", () => {
  test("weights path-derived structure factors", () => {
    const root = mkdtempSync(join(tmpdir(), "o2b-disc-complexity-"));
    mkdirSync(join(root, "notes", "deep", "templates"), { recursive: true });
    writeFileSync(
      join(root, "notes", "deep", "templates", "daily.md"),
      "---\ntags: [workflow, review]\n---\n#brain/review\n",
    );
    writeFileSync(join(root, ".obsidian.json"), "{}\n");

    const pathFactors = complexityPathFactors([
      { root, relativePath: "notes/deep/templates/daily.md" },
      { root, relativePath: ".obsidian.json" },
    ]);
    const report = buildComplexityReport({
      thinkingActivity: 1,
      structuralFilesChanged: 2,
      ...pathFactors,
    });

    expect(report.factors).toContainEqual({
      name: "max_folder_depth",
      value: 3,
      weight: 1,
    });
    expect(report.factors).toContainEqual({
      name: "template_changes",
      value: 1,
      weight: 2,
    });
    expect(report.factors).toContainEqual({
      name: "config_changes",
      value: 1,
      weight: 2,
    });
    expect(report.factors).toContainEqual({
      name: "tag_proliferation",
      value: 3,
      weight: 1,
    });
    expect(report.warning).toBe(true);
    rmSync(root, { recursive: true });
  });
});

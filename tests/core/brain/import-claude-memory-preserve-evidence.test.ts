import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importClaudeMemory } from "../../../src/core/brain/import-claude-memory.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

describe("UPDATE preserves accumulated evidence", () => {
  test("preserves _applied_count and _evidenced_by across re-import", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-cm-pres-"));
    bootstrapBrain(vault);
    const mem = mkdtempSync(join(tmpdir(), "o2b-cm-pres-mem-"));
    writeFileSync(
      join(mem, "feedback_x.md"),
      "---\nname: rule-x\ndescription: V1.\nmetadata:\n  type: feedback\n---\n\nBody v1.\n",
      "utf8",
    );
    importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true, now: new Date("2026-05-19T10:00:00Z") });

    // Simulate accumulated evidence.
    const prefPath = join(vault, "Brain", "preferences", "pref-rule-x.md");
    let pref = readFileSync(prefPath, "utf8");
    pref = pref
      .replace("_applied_count: 0", "_applied_count: 7")
      .replace("_violated_count: 0", "_violated_count: 2")
      .replace("_evidenced_by: []", "_evidenced_by: ['[[a.md]]', '[[b.md]]']")
      .replace("pinned: false", "pinned: true");
    writeFileSync(prefPath, pref, "utf8");

    // Update memory body so sha256 changes → UPDATE branch.
    writeFileSync(
      join(mem, "feedback_x.md"),
      "---\nname: rule-x\ndescription: V2.\nmetadata:\n  type: feedback\n---\n\nBody v2.\n",
      "utf8",
    );
    importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true, now: new Date("2026-05-19T10:00:01Z") });

    const after = readFileSync(prefPath, "utf8");
    expect(after).toContain("_applied_count: 7");
    expect(after).toContain("_violated_count: 2");
    expect(after).toContain("_evidenced_by: ['[[a.md]]', '[[b.md]]']");
    expect(after).toContain("pinned: true");
    expect(after).toContain("principle: \"V2.\"");
    expect(after).toContain("Body v2.");

    rmSync(vault, { recursive: true });
    rmSync(mem, { recursive: true });
  });
});

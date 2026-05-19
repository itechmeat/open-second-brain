import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConflictsError,
  importClaudeMemory,
} from "../../../src/core/brain/import-claude-memory.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

describe("CONFLICT path", () => {
  test("apply throws ConflictsError when pref exists with no manifest entry", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-cm-conf-"));
    bootstrapBrain(vault, { primaryAgent: "@t" });
    // Pre-create the preference by hand.
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-rule-c.md"),
      "---\nid: pref-rule-c\nkind: brain-preference\n---\n\nManual.\n",
      "utf8",
    );

    const mem = mkdtempSync(join(tmpdir(), "o2b-cm-conf-mem-"));
    writeFileSync(
      join(mem, "feedback_rule_c.md"),
      "---\nname: rule-c\ndescription: From memory.\nmetadata:\n  type: feedback\n---\n\nBody.\n",
      "utf8",
    );

    expect(() =>
      importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true }),
    ).toThrow(ConflictsError);

    rmSync(vault, { recursive: true });
    rmSync(mem, { recursive: true });
  });

  test("dry-run reports the conflict but does not throw", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-cm-conf2-"));
    bootstrapBrain(vault, { primaryAgent: "@t" });
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-rule-c.md"),
      "---\nid: pref-rule-c\n---\n\n",
      "utf8",
    );
    const mem = mkdtempSync(join(tmpdir(), "o2b-cm-conf2-mem-"));
    writeFileSync(
      join(mem, "feedback_rule_c.md"),
      "---\nname: rule-c\ndescription: x.\nmetadata:\n  type: feedback\n---\n\nb.\n",
      "utf8",
    );
    const res = importClaudeMemory({ vault, memoryDir: mem, mode: "dry-run", allowArbitraryMemoryPath: true });
    expect(res.conflicts.length).toBe(1);
    expect(res.conflicts[0]?.prefId).toBe("pref-rule-c");

    rmSync(vault, { recursive: true });
    rmSync(mem, { recursive: true });
  });
});

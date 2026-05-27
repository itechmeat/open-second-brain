import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importClaudeMemory } from "../../../src/core/brain/import-claude-memory.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

function setupVault(): string {
  const v = mkdtempSync(join(tmpdir(), "o2b-cm-orch-"));
  bootstrapBrain(v);
  return v;
}

function setupMemory(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-cm-mem-"));
  writeFileSync(
    join(dir, "feedback_a.md"),
    "---\nname: rule-a\ndescription: Rule A.\nmetadata:\n  type: feedback\n---\n\nBody A.\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "feedback_b.md"),
    "---\nname: rule-b\ndescription: Rule B.\nmetadata:\n  type: feedback\n---\n\nBody B.\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "user_who.md"),
    "---\nname: who\ndescription: User.\nmetadata:\n  type: user\n---\n\nBody.\n",
    "utf8",
  );
  writeFileSync(join(dir, "MEMORY.md"), "# index\n- a\n", "utf8");
  return dir;
}

describe("importClaudeMemory", () => {
  test("dry-run reports plan, performs no writes", () => {
    const vault = setupVault();
    const mem = setupMemory();
    const res = importClaudeMemory({
      vault,
      memoryDir: mem,
      mode: "dry-run",
      allowArbitraryMemoryPath: true,
    });
    expect(res.plans.map((p) => p.action).toSorted()).toEqual(["CREATE", "CREATE"]);
    expect(res.skipped.length).toBe(1); // user_who.md; MEMORY.md is filtered earlier
    expect(existsSync(join(vault, "Brain", "preferences", "pref-rule-a.md"))).toBe(false);
    rmSync(vault, { recursive: true });
    rmSync(mem, { recursive: true });
  });

  test("apply writes preferences, manifest, and log event", () => {
    const vault = setupVault();
    const mem = setupMemory();
    const res = importClaudeMemory({
      vault,
      memoryDir: mem,
      mode: "apply",
      allowArbitraryMemoryPath: true,
      now: new Date("2026-05-18T10:00:00Z"),
    });
    expect(res.applied.length).toBe(2);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-rule-a.md"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-rule-b.md"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(vault, "Brain", ".imports", "claude-memory.json"), "utf8"),
    );
    expect(Object.keys(manifest.imports).toSorted()).toEqual(["feedback_a.md", "feedback_b.md"]);
    const log = readFileSync(join(vault, "Brain", "log", res.localDate + ".md"), "utf8");
    expect(log).toContain("import-claude-memory");
    expect(log).toContain("created: 2");
    rmSync(vault, { recursive: true });
    rmSync(mem, { recursive: true });
  });

  test("second apply with no change → SKIP_UNCHANGED, zero writes", () => {
    const vault = setupVault();
    const mem = setupMemory();
    importClaudeMemory({ vault, memoryDir: mem, mode: "apply", allowArbitraryMemoryPath: true });
    const before = readFileSync(join(vault, "Brain", "preferences", "pref-rule-a.md"), "utf8");
    const res2 = importClaudeMemory({
      vault,
      memoryDir: mem,
      mode: "apply",
      allowArbitraryMemoryPath: true,
    });
    expect(res2.applied.length).toBe(0);
    expect(res2.skippedUnchanged.length).toBe(2);
    const after = readFileSync(join(vault, "Brain", "preferences", "pref-rule-a.md"), "utf8");
    expect(after).toBe(before);
    rmSync(vault, { recursive: true });
    rmSync(mem, { recursive: true });
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import {
  ApprovalDigestError,
  importClaudeMemory,
} from "../../../src/core/brain/import-claude-memory.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";

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
    try {
      const res = importClaudeMemory({
        vault,
        memoryDir: mem,
        mode: "dry-run",
        allowArbitraryMemoryPath: true,
      });
      expect(res.plans.map((p) => p.action).toSorted()).toEqual(["CREATE", "CREATE"]);
      expect(res.skipped.length).toBe(1); // user_who.md; MEMORY.md is filtered earlier
      expect(existsSync(join(vault, "Brain", "preferences", "pref-rule-a.md"))).toBe(false);
    } finally {
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    }
  });

  test("apply writes preferences, manifest, and log event", () => {
    const vault = setupVault();
    const mem = setupMemory();
    try {
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
    } finally {
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    }
  });

  test("second apply with no change → SKIP_UNCHANGED, zero writes", () => {
    const vault = setupVault();
    const mem = setupMemory();
    try {
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
    } finally {
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    }
  });
});

/**
 * Forward-slash relative paths hashed, so the comparison is stable on
 * every host. Empty prefixes match everything.
 */
function treeDigests(root: string, prefixes: ReadonlyArray<string> = [""]): string {
  const rows: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isDirectory()) visit(abs);
      else if (prefixes.some((p) => rel === p || rel.startsWith(`${p}/`)))
        rows.push(`${rel} ${sha256Hex(readFileSync(abs))}`);
    }
  };
  if (existsSync(root)) visit(root);
  return rows.join("\n");
}

describe("importClaudeMemory approval digest (t_18fda844)", () => {
  // What the operator approves and the apply lands: the preference
  // files and the imports manifest. (The `.snapshots` archives are
  // excluded: they encode the vault's absolute path and the host's
  // file metadata, so their bytes differ across directories even when
  // the run is behaviorally identical - snapshot EXISTENCE is asserted
  // instead.)
  const WRITES = ["Brain/preferences", "Brain/.imports"] as const;

  test("dry-run carries a plan digest that excludes wall-clock fields", () => {
    const vault = setupVault();
    const mem = setupMemory();
    try {
      const morning = importClaudeMemory({
        vault,
        memoryDir: mem,
        mode: "dry-run",
        allowArbitraryMemoryPath: true,
        now: new Date("2026-05-18T10:00:00Z"),
      });
      const later = importClaudeMemory({
        vault,
        memoryDir: mem,
        mode: "dry-run",
        allowArbitraryMemoryPath: true,
        now: new Date("2027-01-01T23:59:59Z"),
      });
      expect(morning.digest).toMatch(/^[0-9a-f]{64}$/);
      // The same content planned on another day seals to the same digest:
      // an approval must bind the plan, never the moment it was printed.
      expect(later.digest).toBe(morning.digest);
    } finally {
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    }
  });

  test("apply with the approval digest lands exactly the approved plan", () => {
    const vault = setupVault();
    const mem = setupMemory();
    try {
      const dry = importClaudeMemory({
        vault,
        memoryDir: mem,
        mode: "dry-run",
        allowArbitraryMemoryPath: true,
      });
      const res = importClaudeMemory({
        vault,
        memoryDir: mem,
        mode: "apply",
        allowArbitraryMemoryPath: true,
        approvalDigest: dry.digest,
        now: new Date("2026-05-18T10:00:00Z"),
      });
      const approved = dry.plans
        .filter((p) => p.action !== "CONFLICT" && p.action !== "SKIP_UNCHANGED")
        .map((p) => `${p.action} ${p.prefId}`)
        .toSorted();
      expect(res.applied.map((p) => `${p.action} ${p.prefId}`).toSorted()).toEqual(approved);
      expect(res.digest).toBe(dry.digest);
    } finally {
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    }
  });

  test("a vault mutation after the dry run makes apply refuse before any write", () => {
    const vault = setupVault();
    const mem = setupMemory();
    try {
      const dry = importClaudeMemory({
        vault,
        memoryDir: mem,
        mode: "dry-run",
        allowArbitraryMemoryPath: true,
      });
      // The mutation flips rule-a's CREATE into a CONFLICT, so the
      // re-computed plan no longer matches the approved one.
      writeFileSync(join(vault, "Brain", "preferences", "pref-rule-a.md"), "hand-made\n", "utf8");
      const before = treeDigests(vault);

      let refusal: ApprovalDigestError | null = null;
      try {
        importClaudeMemory({
          vault,
          memoryDir: mem,
          mode: "apply",
          allowArbitraryMemoryPath: true,
          approvalDigest: dry.digest,
          now: new Date("2026-05-18T10:00:00Z"),
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ApprovalDigestError);
        refusal = err as ApprovalDigestError;
      }
      expect(refusal).not.toBeNull();
      expect(refusal!.message).toContain("--dry-run");
      expect(treeDigests(vault)).toBe(before);
    } finally {
      rmSync(vault, { recursive: true });
      rmSync(mem, { recursive: true });
    }
  });

  test("apply with the approval digest is byte-identical to today's clean path", () => {
    // One memory source, two identical vaults: the digest-gated apply
    // and today's apply must land the same bytes. (The rendered
    // preference carries the memory file's absolute path, so the two
    // runs must share the source for a byte comparison to be meaningful
    // at all - the digests, by contrast, agree even across sources.)
    const mem = setupMemory();
    const approved = { vault: setupVault() };
    const legacy = { vault: setupVault() };
    try {
      const dry = importClaudeMemory({
        vault: approved.vault,
        memoryDir: mem,
        mode: "dry-run",
        allowArbitraryMemoryPath: true,
      });
      importClaudeMemory({
        vault: approved.vault,
        memoryDir: mem,
        mode: "apply",
        allowArbitraryMemoryPath: true,
        approvalDigest: dry.digest,
        now: new Date("2026-05-18T10:00:00Z"),
      });
      importClaudeMemory({
        vault: legacy.vault,
        memoryDir: mem,
        mode: "apply",
        allowArbitraryMemoryPath: true,
        now: new Date("2026-05-18T10:00:00Z"),
      });
      for (const prefix of WRITES) {
        expect(treeDigests(approved.vault, [prefix])).toBe(treeDigests(legacy.vault, [prefix]));
      }
      // Both runs took the pre-apply snapshot; only its archive bytes
      // differ, because they encode each vault's absolute path.
      expect(readdirSync(join(approved.vault, "Brain", ".snapshots")).toSorted()).toEqual(
        readdirSync(join(legacy.vault, "Brain", ".snapshots")).toSorted(),
      );
    } finally {
      rmSync(approved.vault, { recursive: true });
      rmSync(legacy.vault, { recursive: true });
      rmSync(mem, { recursive: true });
    }
  });
});

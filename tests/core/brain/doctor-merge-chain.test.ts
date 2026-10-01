/**
 * The dangling `merged_into:` doctor check (t_ff8bb8a8).
 *
 * A page that was de-canonicalised points at its canonical through a
 * `merged_into:` field, and every duplicate detector asks the
 * pointer-presence question - so a page whose canonical was later
 * deleted is excluded from dedup candidacy forever, and nothing named
 * why: `o2b brain lint --consolidate` walks chains but a DANGLING
 * terminal resolves silently (only CYCLE/DEPTH/MALFORMED throw and are
 * surfaced as unresolvable links). This check owns the dangling class.
 *
 * What is pinned here: the walk/report helper's outcomes (the check
 * classifies through it rather than through try/catch, and
 * `resolveCanonicalId`'s throw contract is unchanged for lint), which
 * pointers are reported and which are deliberately not (resolved
 * chains, the lint-owned DEPTH/CYCLE/MALFORMED classes), that retired/
 * pages are in scope, that one finding names the pointer's own carrier
 * exactly once however many upstream chains lead to it, and that an
 * unreadable directory is uncertainty rather than a clean bill.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MergeChainError,
  MERGE_CHAIN_MAX_DEPTH,
  reportMergeChain,
  resolveCanonicalId,
} from "../../../src/core/brain/page-meta/page-id.ts";
import {
  MERGE_CHAIN_DANGLING_CODE,
  mergeChainDanglingCheck,
} from "../../../src/core/brain/doctor/merge-chain-check.ts";
import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { DOCTOR_EXIT_EXCLUSIONS, doctorExitReason } from "../../../src/core/brain/doctor-exits.ts";
import { resolveNextStep } from "../../../src/core/brain/next-step.ts";
import type { DoctorUncertainEntry } from "../../../src/core/brain/doctor/report.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import type { DoctorIssue } from "../../../src/core/brain/types.ts";
import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let tmp: string;
let vault: string;
let locked: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-merge-chain-"));
  vault = join(tmp, "vault");
  bootstrapBrain(vault);
  locked = [];
});

afterEach(() => {
  for (const path of locked) chmodSync(path, 0o700);
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a pointer page with exactly the frontmatter the check reads. */
function writePointerPage(dir: string, id: string, target: string | null): string {
  const path = join(dir, `${id}.md`);
  const fields = [`id: ${id}`, ...(target !== null ? [`merged_into: ${target}`] : [])];
  writeFileSync(path, `---\n${fields.join("\n")}\n---\n\nkept body\n`, "utf8");
  return path;
}

function runCheck(): {
  issues: ReadonlyArray<DoctorIssue>;
  uncertain: ReadonlyArray<DoctorUncertainEntry>;
} {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  mergeChainDanglingCheck.run(
    // Only `vault` is read; the rest of the context belongs to other checks.
    { vault } as unknown as Parameters<typeof mergeChainDanglingCheck.run>[0],
    { issues, uncertain },
  );
  return { issues, uncertain };
}

describe("reportMergeChain outcomes", () => {
  test("a chain ending at a page with no pointer resolves", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-b");
    writePointerPage(prefs, "pref-b", null);

    const report = reportMergeChain(vault, "pref-a");
    expect(report.outcome).toBe("resolved");
    expect(report.at).toBe("pref-b");
    expect(report.visited).toEqual(["pref-a", "pref-b"]);
  });

  test("a chain ending at a page nobody kept is dangling", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-b");

    const report = reportMergeChain(vault, "pref-a");
    expect(report.outcome).toBe("dangling");
    expect(report.at).toBe("pref-b");
    expect(report.visited).toEqual(["pref-a", "pref-b"]);
  });

  test("a terminal id with no known prefix is malformed", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "not-a-page-id");

    const report = reportMergeChain(vault, "pref-a");
    expect(report.outcome).toBe("malformed");
    expect(report.at).toBe("not-a-page-id");
  });

  test("a chain that comes back to a visited id is a cycle", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-b");
    writePointerPage(prefs, "pref-b", "pref-a");

    const report = reportMergeChain(vault, "pref-a");
    expect(report.outcome).toBe("cycle");
    expect(report.at).toBe("pref-a");
  });

  test("a chain past the depth cap is depth", () => {
    const prefs = brainDirs(vault).preferences;
    // MERGE_CHAIN_MAX_DEPTH hops are followed, so a chain of depth + 2
    // ids is the shortest one the cap cuts off.
    const ids: string[] = [];
    for (let i = 0; i < MERGE_CHAIN_MAX_DEPTH + 2; i++) {
      const id = `pref-depth-${i}`;
      ids.push(id);
      writePointerPage(prefs, id, i < MERGE_CHAIN_MAX_DEPTH + 1 ? `pref-depth-${i + 1}` : null);
    }

    const report = reportMergeChain(vault, ids[0]!);
    expect(report.outcome).toBe("depth");
  });
});

describe("resolveCanonicalId's throw contract is unchanged", () => {
  test("a dangling terminal is returned, not thrown", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-gone");

    expect(resolveCanonicalId(vault, "pref-a")).toBe("pref-gone");
  });

  test("CYCLE, DEPTH and MALFORMED still throw MergeChainError by code", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-b");
    writePointerPage(prefs, "pref-b", "pref-a");
    writePointerPage(prefs, "pref-c", "not-a-page-id");
    const ids: string[] = [];
    for (let i = 0; i < MERGE_CHAIN_MAX_DEPTH + 2; i++) {
      ids.push(`pref-deep-${i}`);
      writePointerPage(
        prefs,
        `pref-deep-${i}`,
        i < MERGE_CHAIN_MAX_DEPTH + 1 ? `pref-deep-${i + 1}` : null,
      );
    }

    try {
      resolveCanonicalId(vault, "pref-a");
      throw new Error("expected CYCLE");
    } catch (err) {
      expect(err).toBeInstanceOf(MergeChainError);
      expect((err as MergeChainError).code).toBe("CYCLE");
    }
    try {
      resolveCanonicalId(vault, ids[0]!);
      throw new Error("expected DEPTH");
    } catch (err) {
      expect(err).toBeInstanceOf(MergeChainError);
      expect((err as MergeChainError).code).toBe("DEPTH");
    }
    try {
      resolveCanonicalId(vault, "pref-c");
      throw new Error("expected MALFORMED");
    } catch (err) {
      expect(err).toBeInstanceOf(MergeChainError);
      expect((err as MergeChainError).code).toBe("MALFORMED");
    }
  });
});

describe("the dangling-pointer check", () => {
  test("a pointer whose target has no file is reported with page and target", () => {
    const prefs = brainDirs(vault).preferences;
    const path = writePointerPage(prefs, "pref-a", "pref-gone");

    const { issues, uncertain } = runCheck();
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.code).toBe(MERGE_CHAIN_DANGLING_CODE);
    expect(issues[0]!.path).toBe(path);
    expect(issues[0]!.field).toBe("merged_into");
    expect(issues[0]!.target).toBe("pref-gone");
    expect(issues[0]!.message).toContain("merged_into -> pref-gone");
    expect(issues[0]!.message).toContain("no file exists for pref-gone");
    expect(uncertain).toEqual([]);
  });

  test("a chain that resolves is not reported", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-b");
    writePointerPage(prefs, "pref-b", null);

    const { issues, uncertain } = runCheck();
    expect(issues).toEqual([]);
    expect(uncertain).toEqual([]);
  });

  test("a vault with no pointer pages is quiet", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-solo", null);

    const { issues, uncertain } = runCheck();
    expect(issues).toEqual([]);
    expect(uncertain).toEqual([]);
  });

  test("a deeper chain reports the pointer's own carrier exactly once", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-b");
    const carrierPath = writePointerPage(prefs, "pref-b", "pref-gone");

    const { issues } = runCheck();
    expect(issues.length).toBe(1);
    expect(issues[0]!.path).toBe(carrierPath);
    expect(issues[0]!.target).toBe("pref-gone");
    expect(issues[0]!.message).not.toContain("pref-a");
  });

  test("an over-deep chain of existing pages is lint's finding, not this check's", () => {
    const prefs = brainDirs(vault).preferences;
    for (let i = 0; i < MERGE_CHAIN_MAX_DEPTH + 2; i++) {
      writePointerPage(
        prefs,
        `pref-deep-${i}`,
        i < MERGE_CHAIN_MAX_DEPTH + 1 ? `pref-deep-${i + 1}` : null,
      );
    }

    const { issues } = runCheck();
    expect(issues).toEqual([]);
  });

  test("retired pages are in scope, including as mid-chain carriers", () => {
    const prefs = brainDirs(vault).preferences;
    const retired = brainDirs(vault).retired;
    writePointerPage(retired, "ret-old", "pref-gone");
    writePointerPage(prefs, "pref-a", "ret-b");
    const carrierPath = writePointerPage(retired, "ret-b", "pref-gone-2");

    const { issues } = runCheck();
    expect(issues.length).toBe(2);
    const byTarget = new Map(issues.map((i) => [i.target, i]));
    expect(byTarget.get("pref-gone")!.path).toBe(join(retired, "ret-old.md"));
    expect(byTarget.get("pref-gone-2")!.path).toBe(carrierPath);
  });

  test("a malformed target is not reported as dangling", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "not-a-page-id");

    const { issues } = runCheck();
    expect(issues).toEqual([]);
  });

  test("a cycle is not a dangling pointer", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-a", "pref-b");
    writePointerPage(prefs, "pref-b", "pref-a");

    const { issues } = runCheck();
    expect(issues).toEqual([]);
  });

  test("two pages pointing at the same missing canonical are two findings, ordered by path", () => {
    const prefs = brainDirs(vault).preferences;
    writePointerPage(prefs, "pref-b", "pref-gone");
    writePointerPage(prefs, "pref-a", "pref-gone");

    const { issues } = runCheck();
    expect(issues.length).toBe(2);
    expect(issues[0]!.path).toBe(join(prefs, "pref-a.md"));
    expect(issues[1]!.path).toBe(join(prefs, "pref-b.md"));
  });

  test("an absent retired directory is quiet, not uncertain", () => {
    const prefs = brainDirs(vault).preferences;
    rmSync(brainDirs(vault).retired, { recursive: true, force: true });
    writePointerPage(prefs, "pref-a", "pref-gone");

    const { issues, uncertain } = runCheck();
    expect(issues.length).toBe(1);
    expect(uncertain).toEqual([]);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a directory that exists but cannot be listed is uncertainty, and the rest of the sweep still reports",
    () => {
      const prefs = brainDirs(vault).preferences;
      writePointerPage(prefs, "pref-a", "pref-gone");
      const retired = brainDirs(vault).retired;
      chmodSync(retired, 0o000);
      locked.push(retired);

      const { issues, uncertain } = runCheck();
      expect(issues.length).toBe(1);
      expect(issues[0]!.target).toBe("pref-gone");
      const skipped = uncertain.filter((e) => e.code === DEGRADATION_CODE.vaultWalkEntrySkipped);
      expect(skipped.length).toBe(1);
      expect(skipped.map((e) => e.path)).toEqual([retired]);
      expect(skipped[0]!.message).toContain("no merged_into pointer under it was read");
    },
  );

  test("the code is excluded from the exit census, not registered", () => {
    // The repair is a content judgement (re-point, un-merge, or restore
    // the canonical), so no structural command can be named honestly:
    // the settled classification is an exclusion row with that reason.
    expect(DIAGNOSTIC_SIGNALS.has(MERGE_CHAIN_DANGLING_CODE)).toBe(false);
    expect(DOCTOR_EXIT_EXCLUSIONS.has(MERGE_CHAIN_DANGLING_CODE)).toBe(true);
    const reason = doctorExitReason(MERGE_CHAIN_DANGLING_CODE);
    if (reason === null) throw new Error("the exclusion row did not resolve to a reason");
    expect(reason).toContain("re-point");
    expect(resolveNextStep(MERGE_CHAIN_DANGLING_CODE)).toBeNull();
  });
});

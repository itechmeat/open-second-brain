/**
 * A phase request that cannot be honoured is refused by name
 * (no-dead-ends, Unit E).
 *
 * The five `DREAM_PHASE` labels are a reporting layer, not callable units,
 * and two of the planning steps behind them mutate each other's
 * accumulators specifically so a preference is never both refreshed and
 * retired. Asking for one of those alone must raise a named error that says
 * which steps ARE independently runnable and why the requested one is not -
 * never a partial run, never a full-looking result whose fields are empty
 * because the work did not happen.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { DREAM_PHASE } from "../../../src/core/brain/dream-phases.ts";
import {
  DREAM_STEP,
  DREAM_STEP_RUNNABLE,
  DreamStepNotRunnableError,
  runDreamStep,
} from "../../../src/core/brain/dream-step.ts";
import { brainDirs, dreamRunsDir } from "../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-step-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-step-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Three same-sign signals: enough that a full pass would promote them. */
function seedPromotion(): void {
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(vault, {
      topic: "step-topic",
      signal: "positive",
      agent: "claude",
      principle: "Prefer the stepped approach",
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `step-${i}`,
      scope: "writing",
    });
  }
}

/** Recursive `<relative path>:<sha256>` digest of a tree, sorted. */
function treeDigest(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        lines.push(
          `${relative(root, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
    }
  };
  walk(root);
  return lines.join("\n");
}

function makeNotes(): { refPath: string } {
  const notes = join(vault, "Notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "Acme.md"), "---\ntitle: Acme\n---\nThe Acme page.\n", "utf8");
  const refPath = join(notes, "ref.md");
  writeFileSync(refPath, "---\ntitle: Ref\n---\nwe rely on Acme daily\n", "utf8");
  return { refPath };
}

// ----- The refusal ---------------------------------------------------------

describe("runDreamStep refuses what it cannot honour", () => {
  test("the coupled synthesize label is refused, by name, and writes nothing", () => {
    seedPromotion();
    const before = treeDigest(vault);

    expect(() => runDreamStep(vault, DREAM_PHASE.synthesize)).toThrow(DreamStepNotRunnableError);

    let caught: DreamStepNotRunnableError | undefined;
    try {
      runDreamStep(vault, DREAM_PHASE.synthesize);
    } catch (err) {
      caught = err as DreamStepNotRunnableError;
    }
    expect(caught?.requested).toBe(DREAM_PHASE.synthesize);
    expect(caught?.runnable).toEqual([...DREAM_STEP_RUNNABLE]);
    // Names the coupling itself, not a generic "unsupported phase".
    expect(caught?.message).toContain("planRefresh");
    expect(caught?.message).toContain("planAutoRetires");
    expect(caught?.message).toContain("refresh.updated");
    expect(caught?.message).toContain("plan.retires");
    // And it names the way out.
    for (const step of DREAM_STEP_RUNNABLE) expect(caught?.message).toContain(step);

    expect(treeDigest(vault)).toBe(before);
    expect(existsSync(dreamRunsDir(vault))).toBe(false);
    expect(readdirSync(brainDirs(vault).preferences)).toEqual([]);
  });

  test("the heal label is refused for the same coupling and points at heal-enrich", () => {
    seedPromotion();
    const before = treeDigest(vault);

    let caught: DreamStepNotRunnableError | undefined;
    try {
      runDreamStep(vault, DREAM_PHASE.heal);
    } catch (err) {
      caught = err as DreamStepNotRunnableError;
    }
    expect(caught).toBeInstanceOf(DreamStepNotRunnableError);
    expect(caught?.message).toContain("planAutoRetires");
    expect(caught?.message).toContain(DREAM_STEP.healEnrich);
    expect(treeDigest(vault)).toBe(before);
  });

  test("every remaining phase label is refused with its own specific reason", () => {
    const reasons = new Map<string, string>();
    for (const phase of [DREAM_PHASE.close, DREAM_PHASE.reconcile, DREAM_PHASE.log]) {
      let caught: DreamStepNotRunnableError | undefined;
      try {
        runDreamStep(vault, phase);
      } catch (err) {
        caught = err as DreamStepNotRunnableError;
      }
      expect(caught).toBeInstanceOf(DreamStepNotRunnableError);
      expect(caught?.requested).toBe(phase);
      reasons.set(phase, caught!.reason);
    }
    // No two labels share a reason: each refusal explains that label.
    expect(new Set(reasons.values()).size).toBe(reasons.size);
    expect(reasons.get(DREAM_PHASE.close)).toContain(DREAM_STEP.scan);
  });

  test("an unknown step name is refused rather than silently ignored", () => {
    let caught: DreamStepNotRunnableError | undefined;
    try {
      runDreamStep(vault, "not-a-phase");
    } catch (err) {
      caught = err as DreamStepNotRunnableError;
    }
    expect(caught).toBeInstanceOf(DreamStepNotRunnableError);
    expect(caught?.requested).toBe("not-a-phase");
    expect(caught?.runnable).toEqual([...DREAM_STEP_RUNNABLE]);
  });
});

// ----- The honoured steps --------------------------------------------------

describe("runDreamStep performs exactly the step requested", () => {
  test("scan reports the tree and mutates nothing", () => {
    seedPromotion();
    const before = treeDigest(vault);

    const result = runDreamStep(vault, DREAM_STEP.scan);

    expect(result).toEqual({
      step: DREAM_STEP.scan,
      partial: true,
      active_signals: 3,
      processed_signals: 0,
      preferences: 0,
      retired: 0,
      corrupted: [],
    });
    // Nothing that a full pass would have done has happened: no
    // preference, no signal move, no log, no workrun.
    expect(treeDigest(vault)).toBe(before);
    expect(existsSync(dreamRunsDir(vault))).toBe(false);
  });

  test("scan surfaces corrupted entries as paths rather than swallowing them", () => {
    writeFileSync(join(brainDirs(vault).inbox, "sig-broken.md"), "not frontmatter\n", "utf8");

    const result = runDreamStep(vault, DREAM_STEP.scan);

    expect(result.step).toBe(DREAM_STEP.scan);
    expect(result).toMatchObject({ corrupted: ["Brain/inbox/sig-broken.md"] });
  });

  test("heal-enrich enriches user pages and does nothing else", () => {
    const { refPath } = makeNotes();
    seedPromotion();

    const result = runDreamStep(vault, DREAM_STEP.healEnrich);

    expect(result).toMatchObject({ step: DREAM_STEP.healEnrich, partial: true, enriched: 1 });
    expect(readFileSync(refPath, "utf8")).toContain("[[Acme]]");
    // The promotion the full pass would have made did not happen.
    expect(readdirSync(brainDirs(vault).preferences)).toEqual([]);
    expect(readdirSync(brainDirs(vault).inbox).filter((n) => n.endsWith(".md"))).toHaveLength(3);
    expect(existsSync(dreamRunsDir(vault))).toBe(false);
  });
});

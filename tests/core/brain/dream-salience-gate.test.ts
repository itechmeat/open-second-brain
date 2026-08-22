/**
 * The salience gate inside one dream pass (salience-lifecycle-
 * enrichment, unit 1, t_de8a0b2d).
 *
 * The dream pass has no per-item model lane: its entire model delegation
 * is the count-triggered rollup ladder. So the gate governs exactly one
 * thing - which facts enter the ladder's fold set - and nothing else.
 *
 * Claims pinned here:
 *   1. With no `dream.salience_threshold` configured the gate is OPEN
 *      and says so: the summary carries `threshold: null`, admits every
 *      fact, and the ladder counts the unfiltered fold set.
 *   2. The open gate scores nothing. Observed-use records - the one
 *      scorer input the rest of the pass never reads - cannot change a
 *      run with the threshold unset: two vaults identical but for those
 *      records produce the same summary and the same decisions on disk.
 *   3. That probe is load-bearing: with a threshold set, the same
 *      records DO change the partition, so claim 2 is not vacuous.
 *   4. A configured threshold keeps low-salience facts out of the fold
 *      set, so a ladder rung that would have fired on the raw count does
 *      not fire on the admitted count.
 *   5. An excluded fact is never silently dropped: the summary names it
 *      by id and path and carries the score and the three raw signals.
 *   6. The gate is reported on the no-op summary too - a pass that
 *      changed nothing still has to explain what it considered.
 *   7. A malformed threshold in `_brain.yaml` is refused by name, not
 *      ignored.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { emitObservedUse } from "../../../src/core/brain/observed-use.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";

const NOW = new Date("2026-06-01T00:00:00Z");
/** Facts the ladder needs before it emits a rollup envelope. */
const FACT_THRESHOLD = 3;
/** Fold-set members: one loud fact, three quiet ones. */
const LOUD = "loud";
const QUIET = ["quiet-a", "quiet-b", "quiet-c"] as const;
/** A threshold every quiet fact misses and the loud one clears. */
const THRESHOLD = 0.2;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dream-salience-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** `_brain.yaml` with the ladder armed and, optionally, a gate threshold. */
function configBody(threshold: number | string | null): string {
  const gate = threshold === null ? "" : `dream:\n  salience_threshold: ${threshold}\n`;
  return (
    `schema_version: 1\n${gate}` +
    `rollup:\n  fact_threshold: ${FACT_THRESHOLD}\n  identity_threshold: 5\n`
  );
}

/**
 * A vault holding one loud fact (repeated applied-evidence) and three
 * quiet ones (no evidence at all).
 */
function makeVault(name: string, threshold: number | string | null): string {
  const vault = join(tmp, name);
  bootstrapBrain(vault, {});
  atomicWriteFileSync(brainConfigPath(vault), configBody(null));
  for (const slug of [LOUD, ...QUIET]) {
    const loud = slug === LOUD;
    writePreference(vault, {
      slug,
      topic: slug,
      principle: `principle for ${slug}`,
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      // Recent confirmation keeps the stale-no-evidence auto-retire off
      // every fact, the quiet ones included: the refresh pass recomputes
      // `last_evidence_at` from the log, so a fact with no log events
      // falls back to `confirmed_at` for that check. The quiet facts
      // therefore differ from the loud one in exactly what the gate
      // reads - no counters, no apply-evidence, no observed use.
      confirmed_at: "2026-05-30T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      applied_count: loud ? 8 : 0,
      violated_count: 0,
      last_evidence_at: loud ? "2026-05-30T00:00:00Z" : null,
      confidence_value: loud ? 0.8 : 0,
    });
  }
  for (const day of ["2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30"]) {
    appendLogEvent(vault, {
      timestamp: `${day}T00:00:00Z`,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        preference: `[[pref-${LOUD}]]`,
        artifact: "[[src/foo.ts]]",
        agent: "tester",
        result: BRAIN_APPLY_RESULT.applied,
      },
    });
  }
  // The threshold lands last: a refused config would otherwise stop the
  // fixture's own writes before the pass under test ever runs.
  atomicWriteFileSync(brainConfigPath(vault), configBody(threshold));
  return vault;
}

/** Observed-use verdicts for every quiet fact: the gate-only probe. */
function seedReuse(vault: string): void {
  emitObservedUse(vault, {
    host: "test",
    createdAt: "2026-05-31T00:00:00Z",
    entries: QUIET.map((slug) => ({ id: `pref-${slug}`, verdict: "USED" as const })),
  });
}

/**
 * Everything a pass durably DECIDES, and nothing that merely records the
 * run or names the vault. The audit log is excluded because it stamps
 * the pre-run archive's byte size, and the probe below legitimately
 * makes that archive bigger by adding a continuity record; `_BRAIN.md`
 * and `vault-id.json` carry the vault's own name and random id. What
 * those artifacts wrap is this list, and the run summary is compared
 * separately.
 */
const DECISION_PATHS = [
  "preferences",
  "retired",
  "inbox",
  "active.md",
  "lessons.md",
  "rollup-ladder.json",
] as const;

/** Content digest over the pass's durable decisions. */
function brainDigest(vault: string): string {
  const rows: string[] = [];
  const walk = (path: string, rel: string): void => {
    if (!existsSync(path)) return;
    if (!statSync(path).isDirectory()) {
      rows.push(`${rel}=${readFileSync(path, "utf8")}`);
      return;
    }
    for (const name of readdirSync(path).toSorted()) walk(join(path, name), `${rel}/${name}`);
  };
  for (const entry of DECISION_PATHS) walk(join(vault, "Brain", entry), entry);
  return sha256Hex(rows.join("\n"));
}

/** One summary as JSON, with the vault's own root elided. */
function withoutVaultRoot(summary: unknown, vault: string): string {
  return JSON.stringify(summary).replaceAll(vault, "<vault>");
}

test("with no threshold the gate reports itself absent and admits every fact", () => {
  const vault = makeVault("open", null);
  const summary = dream(vault, { now: NOW, dryRun: true });
  expect(summary.salience_gate.threshold).toBeNull();
  expect(summary.salience_gate.considered).toBe(4);
  expect(summary.salience_gate.admitted).toBe(4);
  expect(summary.salience_gate.excluded).toEqual([]);
  // Four facts against a ladder threshold of three: the rung fires.
  expect(summary.rollups).toHaveLength(1);
});

test("the open gate scores nothing: observed-use records cannot change the run", () => {
  const control = makeVault("control", null);
  const probe = makeVault("probe", null);
  seedReuse(probe);

  const a = dream(control, { now: NOW });
  const b = dream(probe, { now: NOW });
  expect(withoutVaultRoot(b, probe)).toBe(withoutVaultRoot(a, control));
  expect(brainDigest(probe)).toBe(brainDigest(control));
});

test("the same probe does change the partition once a threshold is set", () => {
  const control = makeVault("gated-control", THRESHOLD);
  const probe = makeVault("gated-probe", THRESHOLD);
  seedReuse(probe);

  const a = dream(control, { now: NOW, dryRun: true });
  const b = dream(probe, { now: NOW, dryRun: true });
  expect(a.salience_gate.admitted).toBe(1);
  expect(b.salience_gate.admitted).toBe(4);
  expect(b.salience_gate.excluded).toEqual([]);
});

test("a configured threshold keeps low-salience facts out of the fold set", () => {
  const vault = makeVault("gated", THRESHOLD);
  const summary = dream(vault, { now: NOW, dryRun: true });
  expect(summary.salience_gate.threshold).toBe(THRESHOLD);
  expect(summary.salience_gate.considered).toBe(4);
  expect(summary.salience_gate.admitted).toBe(1);
  // One admitted fact is below the ladder's threshold of three, so the
  // rung the raw count would have fired does not fire.
  expect(summary.rollups).toEqual([]);
});

test("every excluded fact is named with its score and its three raw signals", () => {
  const vault = makeVault("named", THRESHOLD);
  const summary = dream(vault, { now: NOW, dryRun: true });
  expect(summary.salience_gate.excluded.map((e) => e.pref_id)).toEqual(
    QUIET.map((slug) => `pref-${slug}`),
  );
  for (const entry of summary.salience_gate.excluded) {
    expect(entry.path).toBe(`Brain/preferences/${entry.pref_id}.md`);
    expect(entry.score).toBeLessThan(THRESHOLD);
    expect(entry.mass).toBe(0);
    expect(entry.confidence).toBe(0);
    expect(entry.reuse).toBe(0);
  }
});

test("a no-op run still explains what the gate considered", () => {
  const vault = makeVault("noop", THRESHOLD);
  // The first pass settles whatever the fixture changes; the second
  // changes nothing and takes the no-op path.
  dream(vault, { now: NOW });
  const summary = dream(vault, { now: NOW });
  expect(summary.changed).toBe(false);
  expect(summary.salience_gate.threshold).toBe(THRESHOLD);
  expect(summary.salience_gate.considered).toBe(4);
  expect(summary.salience_gate.excluded).toHaveLength(3);
});

test("a malformed threshold is refused by name rather than ignored", () => {
  for (const bad of ["2", "-0.5", "yes"]) {
    const vault = makeVault(`bad-${bad}`, bad);
    expect(() => dream(vault, { now: NOW, dryRun: true })).toThrow(/dream\.salience_threshold/);
  }
});

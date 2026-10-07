import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

import {
  NEAR_DUPLICATE_CANDIDATE_CAP,
  READ_ALL_REFS,
} from "../../../src/core/brain/near-duplicate.ts";
import {
  planRetireSiblings,
  RETIRE_SIBLING_TRIGGER_REASONS,
  retireSiblingPool,
  type RetireSibling,
} from "../../../src/core/brain/retire-siblings.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_RETIRED_REASON, type BrainRetiredReason } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";

const RULE = "always run the formatter before every commit in this repository";
const PARAPHRASE = "always run the formatter before each commit in this repository";
const UNRELATED = "prefer tabs over spaces inside every makefile you touch";

const hideSibling = (ref: string) => ref !== "pref-paraphrase";
const hideRetiring = (ref: string) => ref !== "pref-old";
const NO_GATE = { readable: READ_ALL_REFS, gated: new Set<string>() };

function retiring(reason: BrainRetiredReason, id = "pref-old") {
  return [{ id, principle: RULE, reason }];
}

const ACTIVE = [
  { id: "pref-paraphrase", principle: PARAPHRASE },
  { id: "pref-unrelated", principle: UNRELATED },
];

describe("planRetireSiblings", () => {
  test("only the four context-driven reasons nominate", () => {
    expect([...RETIRE_SIBLING_TRIGGER_REASONS].toSorted()).toEqual([
      "quarantine-violated",
      "rebutted",
      "superseded-by-context",
      "user-rejected",
    ]);
    for (const reason of RETIRE_SIBLING_TRIGGER_REASONS) {
      const out = planRetireSiblings(ACTIVE, retiring(reason), NO_GATE);
      expect(out).toEqual([
        { retiring_id: "pref-old", sibling_id: "pref-paraphrase", score: 0.818, method: "lexical" },
      ]);
    }
  });

  test("decay reasons and merged-into never nominate", () => {
    for (const reason of [
      BRAIN_RETIRED_REASON.staleNoEvidence,
      BRAIN_RETIRED_REASON.expiredUnconfirmed,
      BRAIN_RETIRED_REASON.mergedInto,
    ]) {
      expect(planRetireSiblings(ACTIVE, retiring(reason), NO_GATE)).toEqual([]);
    }
  });

  test("siblings of a gated id are dropped", () => {
    const out = planRetireSiblings(ACTIVE, retiring(BRAIN_RETIRED_REASON.rebutted), {
      readable: READ_ALL_REFS,
      gated: new Set(["pref-old"]),
    });
    expect(out).toEqual([]);
  });

  test("an unreadable sibling or retiring id is never listed", () => {
    const reason = BRAIN_RETIRED_REASON.rebutted;
    const gated = new Set<string>();
    expect(planRetireSiblings(ACTIVE, retiring(reason), { readable: hideSibling, gated })).toEqual(
      [],
    );
    expect(planRetireSiblings(ACTIVE, retiring(reason), { readable: hideRetiring, gated })).toEqual(
      [],
    );
  });

  test("merge-resolved pages are excluded from the pool", () => {
    const pool = retireSiblingPool([
      { id: "pref-paraphrase", principle: PARAPHRASE, merged_into: "pref-canonical" },
      { id: "pref-live", principle: PARAPHRASE },
    ]);
    expect(pool).toEqual([{ id: "pref-live", principle: PARAPHRASE }]);
    const out = planRetireSiblings(pool, retiring(BRAIN_RETIRED_REASON.rebutted), NO_GATE);
    expect(out.map((s) => s.sibling_id)).toEqual(["pref-live"]);
  });

  test("preferences from other topics and scopes are compared", () => {
    // The planner takes no topic or scope: the whole active set is one pool.
    const active = [{ id: "pref-other-topic-slug", principle: PARAPHRASE }];
    const out = planRetireSiblings(active, retiring(BRAIN_RETIRED_REASON.rebutted), NO_GATE);
    expect(out.map((s) => s.sibling_id)).toEqual(["pref-other-topic-slug"]);
  });

  test("the retiring set is never its own sibling and siblings are not cascaded", () => {
    const secondHop = `${PARAPHRASE} today`;
    const active = [
      { id: "pref-old", principle: RULE },
      { id: "pref-paraphrase", principle: PARAPHRASE },
      { id: "pref-second-hop", principle: `each ${secondHop} quickly` },
    ];
    const out = planRetireSiblings(active, retiring(BRAIN_RETIRED_REASON.rebutted), NO_GATE);
    expect(out.map((s) => s.sibling_id)).toEqual(["pref-paraphrase"]);
  });

  test("another retiring preference is not offered as a sibling", () => {
    const both = [
      { id: "pref-old", principle: RULE, reason: BRAIN_RETIRED_REASON.rebutted },
      {
        id: "pref-paraphrase",
        principle: PARAPHRASE,
        reason: BRAIN_RETIRED_REASON.staleNoEvidence,
      },
    ];
    expect(planRetireSiblings(ACTIVE, both, NO_GATE)).toEqual([]);
  });

  test("a sibling sorting past the near-duplicate candidate cap is still scored", () => {
    const fillers = Array.from({ length: NEAR_DUPLICATE_CANDIDATE_CAP + 50 }, (_, i) => ({
      id: `pref-filler-${String(i).padStart(4, "0")}`,
      principle: UNRELATED,
    }));
    const active = [...fillers, { id: "pref-zzz-dup", principle: RULE }];
    const out = planRetireSiblings(active, retiring(BRAIN_RETIRED_REASON.rebutted), NO_GATE);
    expect(out.map((s) => s.sibling_id)).toEqual(["pref-zzz-dup"]);
  });

  test("the output is stable across runs and input orders", () => {
    const active = [
      { id: "pref-b", principle: PARAPHRASE },
      { id: "pref-a", principle: PARAPHRASE },
      { id: "pref-c", principle: RULE },
    ];
    const retires = [
      { id: "pref-y", principle: RULE, reason: BRAIN_RETIRED_REASON.rebutted },
      { id: "pref-x", principle: RULE, reason: BRAIN_RETIRED_REASON.userRejected },
    ];
    const first = planRetireSiblings(active, retires, NO_GATE);
    const again = planRetireSiblings(active.toReversed(), retires.toReversed(), NO_GATE);
    expect(again).toEqual(first);
    expect(first.map((s) => `${s.retiring_id}>${s.sibling_id}`)).toEqual([
      "pref-x>pref-c",
      "pref-x>pref-a",
      "pref-x>pref-b",
      "pref-y>pref-c",
      "pref-y>pref-a",
      "pref-y>pref-b",
    ]);
  });
});

const FLAG_ENV = "OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED";
const NOW = new Date("2026-06-10T12:00:00Z");

describe("dream retire_siblings", () => {
  let vault: string;
  let configHome: string;
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[FLAG_ENV];
    delete process.env[FLAG_ENV];
    vault = mkdtempSync(join(tmpdir(), "o2b-retire-siblings-vault-"));
    configHome = mkdtempSync(join(tmpdir(), "o2b-retire-siblings-cfg-"));
    const configPath = join(configHome, "config.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath });
    seedPreference("old", "formatting", RULE);
    seedPreference("paraphrase", "commit-hygiene", PARAPHRASE);
    seedPreference("unrelated", "makefiles", UNRELATED);
    appendApplyEvidence(
      vault,
      { pref_id: "pref-old", artifact: "[[AA-artifact]]", result: "outdated", agent: "test-agent" },
      { now: new Date("2026-06-09T12:00:00Z") },
    );
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG_ENV];
    else process.env[FLAG_ENV] = savedFlag;
    rmSync(vault, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  });

  function seedPreference(slug: string, topic: string, principle: string): void {
    writePreference(vault, {
      slug,
      topic,
      principle,
      created_at: "2026-06-01T00:00:00Z",
      confirmed_at: "2026-06-02T00:00:00Z",
      unconfirmed_until: "2026-06-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-1]]"],
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-06-02T00:00:00Z",
      confidence: "low",
    });
  }

  const EXPECTED: RetireSibling[] = [
    { retiring_id: "pref-old", sibling_id: "pref-paraphrase", score: 0.818, method: "lexical" },
  ];

  test("with the key on, the dry run and the real run report the same siblings", () => {
    process.env[FLAG_ENV] = "1";
    const before = digestVaultTree(vault);
    const preview = dream(vault, { dryRun: true, now: NOW });
    expect(digestVaultTree(vault)).toBe(before);
    expect(preview.retired).toEqual([{ id: "ret-old", reason: "superseded-by-context" }]);
    expect(preview.retire_siblings).toEqual(EXPECTED);
    const real = dream(vault, { now: NOW });
    expect(real.retire_siblings).toEqual(EXPECTED);
  });

  test("with the key off, the field is absent and the summary is otherwise unchanged", () => {
    const off = dream(vault, { dryRun: true, now: NOW });
    expect("retire_siblings" in off).toBe(false);
    process.env[FLAG_ENV] = "1";
    const { retire_siblings: _siblings, ...on } = dream(vault, { dryRun: true, now: NOW });
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  test("a sibling of a gated retire does not appear, in the dry run or the real run", () => {
    process.env[FLAG_ENV] = "1";
    const yamlPath = join(vault, "Brain", "_brain.yaml");
    const yaml = readFileSync(yamlPath, "utf8").replace(
      "# confirmed_evidence_min_threshold: 3",
      "confirmed_evidence_min_threshold: 50",
    );
    writeFileSync(yamlPath, yaml);
    const preview = dream(vault, { dryRun: true, now: NOW });
    expect(preview.retired).toEqual([{ id: "ret-old", reason: "superseded-by-context" }]);
    expect("retire_siblings" in preview).toBe(false);
    const real = dream(vault, { now: NOW });
    expect(real.gated_retires.map((g) => g.pref_id)).toEqual(["pref-old"]);
    expect("retire_siblings" in real).toBe(false);
  });
});

/**
 * R1a: the recoverability verdict the destructive gate never had.
 *
 * The defect. `snapshot-gate.ts` promises in its own header that "no
 * destructive brain mutation runs without a recovery point on disk
 * first", and `withDestructiveSnapshot` either produced a
 * `DestructiveSnapshot` or threw. There was nowhere in that shape to say
 * "a recovery point exists and it does not cover all of this" - which is
 * exactly what `deleteBySource --include-originals` needed to say, and
 * did not: the archive covers top-level entries under `Brain/` and
 * nothing else (`path-constants.ts:116-119`), the originals that flag
 * deletes are outside `Brain/` by construction (`source-cleanup.ts:462`),
 * and the result still reported a `snapshotRunId` and a `snapshotPath` as
 * though one recovery point covered both. A caller reading that response
 * is told a lie in the most expensive direction available.
 *
 * What this file covers: the three vocabularies' trio shape, the pure
 * classifier's independent gates, and the wrapper carrying the verdict
 * out alongside its result. Plus the acceptance criterion that matters
 * most for a change to a shared gate - the two pre-existing call sites
 * returning payloads whose bytes did not move.
 *
 * What it deliberately does NOT cover:
 *
 *   - the throw paths. A snapshot that cannot be written is a FAILURE,
 *     not an unproven verdict, and collapsing the two would be precisely
 *     the misleading fallback this release argues against. Those paths
 *     stay throws and stay tested in `snapshot-gate.test.ts`.
 *   - which operations declare which blast radius. That is the
 *     destructive-site registry's census (R1b) and the per-operation
 *     wiring (B1), not this classifier's business - the classifier is
 *     pure and takes the declaration as given.
 *   - archive CONTENT. Whether the tar actually holds the bytes it says
 *     it does is `snapshot-derived-store.test.ts`'s question.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyRecoverability,
  isRecoverabilityBlocker,
  isRecoverabilityState,
  isRecoveryCoverage,
  RECOVERABILITY_BLOCKER,
  RECOVERABILITY_BLOCKERS,
  RECOVERABILITY_STATE,
  RECOVERABILITY_STATES,
  RECOVERY_COVERAGE,
  RECOVERY_COVERAGES,
} from "../../../../src/core/brain/gates/recoverability.ts";
import { withDestructiveSnapshot } from "../../../../src/core/brain/snapshot-gate.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { deleteBySource } from "../../../../src/core/brain/source-cleanup.ts";
import { pruneEntityLabels } from "../../../../src/core/brain/entities/label-hygiene.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { writeFrontmatterAtomic } from "../../../../src/core/vault.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../../src/core/brain/types.ts";

const NOW = new Date("2026-06-01T00:00:00Z");

/**
 * A payload with the vault's tmpdir root masked - the one value that
 * cannot be a literal. Everything else, key order included, is compared
 * byte for byte: a new key, a dropped key or a reordered array all fail,
 * which is what a byte comparison buys over a shape assertion.
 *
 * The expected strings further down were MEASURED against the pre-R1a
 * tree and pasted, not written from the types. That is what makes them a
 * proof rather than a restatement of whatever the code now does.
 */
function stablePayload(value: unknown, vaultRoot: string): string {
  return JSON.stringify(value, null, 2).split(vaultRoot).join("<vault>");
}

// ----- The three vocabularies ----------------------------------------------

describe("the recoverability vocabularies follow the four-piece idiom", () => {
  const TRIO = [
    ["RECOVERABILITY_STATE", RECOVERABILITY_STATE, RECOVERABILITY_STATES, isRecoverabilityState],
    ["RECOVERY_COVERAGE", RECOVERY_COVERAGE, RECOVERY_COVERAGES, isRecoveryCoverage],
    [
      "RECOVERABILITY_BLOCKER",
      RECOVERABILITY_BLOCKER,
      RECOVERABILITY_BLOCKERS,
      isRecoverabilityBlocker,
    ],
  ] as const;

  for (const [name, values, members, guard] of TRIO) {
    test(`${name} is frozen, listed and guarded`, () => {
      expect(Object.isFrozen(values)).toBe(true);
      expect(Object.values(values).toSorted()).toEqual(members.toSorted());
      for (const member of members) expect(guard(member)).toBe(true);
    });

    test(`${name}'s guard takes unknown and rejects non-members`, () => {
      // The census passes `null`, `42` and `{}` at every guard it holds;
      // a guard typed `(value: string)` would not compile against it.
      for (const outsider of ["", " ", "not-a-member", null, undefined, 42, {}]) {
        expect(guard(outsider)).toBe(false);
      }
    });
  }

  test("the three sets are disjoint, which is why they are three", () => {
    const all = [
      ...Object.values(RECOVERABILITY_STATE),
      ...Object.values(RECOVERY_COVERAGE),
      ...Object.values(RECOVERABILITY_BLOCKER),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ----- The pure classifier --------------------------------------------------

describe("classifyRecoverability", () => {
  test("a covered operation names the region the archive holds", () => {
    const verdict = classifyRecoverability({
      recoveryPoint: true,
      blastRadius: { brainTopLevel: true },
    });
    expect(verdict.state).toBe(RECOVERABILITY_STATE.covered);
    expect(verdict.coverage).toEqual([RECOVERY_COVERAGE.brainTopLevel]);
    expect(verdict.blockers).toEqual([]);
  });

  test("the verdict is frozen through its arrays", () => {
    const verdict = classifyRecoverability({
      recoveryPoint: true,
      blastRadius: { brainTopLevel: true },
    });
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(Object.isFrozen(verdict.coverage)).toBe(true);
    expect(Object.isFrozen(verdict.blockers)).toBe(true);
  });

  test("a blast radius that leaves Brain/ is partial, not covered", () => {
    // The `--include-originals` shape: the archive holds the derived
    // pages and has never held the imported original.
    const verdict = classifyRecoverability({
      recoveryPoint: true,
      blastRadius: { brainTopLevel: true, outsideBrainRoot: true },
    });
    expect(verdict.state).toBe(RECOVERABILITY_STATE.partial);
    expect(verdict.coverage).toEqual([RECOVERY_COVERAGE.brainTopLevel]);
    expect(verdict.blockers).toEqual([RECOVERABILITY_BLOCKER.outsideBrainRoot]);
  });

  test("no recovery point at all is unproven, not covered", () => {
    const verdict = classifyRecoverability({
      recoveryPoint: false,
      blastRadius: { brainTopLevel: true },
    });
    expect(verdict.state).toBe(RECOVERABILITY_STATE.unproven);
    expect(verdict.coverage).toEqual([]);
    expect(verdict.blockers).toEqual([RECOVERABILITY_BLOCKER.noRecoveryPoint]);
  });

  test("gates are independent, so several blockers surface together", () => {
    // `pruneSnapshots`: it destroys archives, which live in an entry no
    // archive contains, and it cannot be gated on taking one.
    const verdict = classifyRecoverability({
      recoveryPoint: false,
      blastRadius: { snapshotExcludedEntries: true, derivedStore: true },
    });
    expect(verdict.state).toBe(RECOVERABILITY_STATE.unproven);
    expect(verdict.blockers).toEqual([
      RECOVERABILITY_BLOCKER.derivedStoreNotArchived,
      RECOVERABILITY_BLOCKER.noRecoveryPoint,
      RECOVERABILITY_BLOCKER.snapshotExcludedEntry,
    ]);
  });

  test("blockers and coverage are sorted, so the token arrays are stable", () => {
    const verdict = classifyRecoverability({
      recoveryPoint: true,
      derivedStoreArchived: true,
      blastRadius: {
        brainTopLevel: true,
        derivedStore: true,
        outsideBrainRoot: true,
        snapshotExcludedEntries: true,
      },
    });
    expect(verdict.coverage).toEqual([...verdict.coverage].toSorted());
    expect(verdict.blockers).toEqual([...verdict.blockers].toSorted());
    expect(verdict.state).toBe(RECOVERABILITY_STATE.partial);
  });

  test("a derived store in the blast radius is uncovered unless it was archived", () => {
    const notArchived = classifyRecoverability({
      recoveryPoint: true,
      derivedStoreArchived: false,
      blastRadius: { brainTopLevel: true, derivedStore: true },
    });
    expect(notArchived.blockers).toEqual([RECOVERABILITY_BLOCKER.derivedStoreNotArchived]);
    expect(notArchived.state).toBe(RECOVERABILITY_STATE.partial);

    const archived = classifyRecoverability({
      recoveryPoint: true,
      derivedStoreArchived: true,
      blastRadius: { brainTopLevel: true, derivedStore: true },
    });
    expect(archived.coverage).toEqual([
      RECOVERY_COVERAGE.brainTopLevel,
      RECOVERY_COVERAGE.derivedStore,
    ]);
    expect(archived.state).toBe(RECOVERABILITY_STATE.covered);
  });

  test("an empty blast radius says nothing is at risk rather than claiming cover", () => {
    // A confirmed run with nothing to remove is a no-op. Reporting it as
    // `covered` would claim a recovery point that was never taken;
    // reporting it as `unproven` would alarm about a deletion that never
    // happened. Both are lies, in opposite directions.
    const verdict = classifyRecoverability({ recoveryPoint: false, blastRadius: {} });
    expect(verdict.state).toBe(RECOVERABILITY_STATE.nothingAtRisk);
    expect(verdict.coverage).toEqual([]);
    expect(verdict.blockers).toEqual([]);
  });

  test("the classifier is pure: the same facts give the same verdict", () => {
    const facts = {
      recoveryPoint: true,
      blastRadius: { brainTopLevel: true, outsideBrainRoot: true },
    } as const;
    expect(classifyRecoverability(facts)).toEqual(classifyRecoverability(facts));
  });
});

// ----- The wrapper carries the verdict out ----------------------------------

describe("withDestructiveSnapshot returns the verdict beside the result", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-recoverability-"));
    bootstrapBrain(vault);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("an undeclared blast radius is the Brain tree, and it is covered", () => {
    const gated = withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.deleteBySource, () => 7, {
      now: NOW,
    });
    expect(gated.result).toBe(7);
    expect(gated.recoverability.state).toBe(RECOVERABILITY_STATE.covered);
    expect(gated.recoverability.coverage).toEqual([RECOVERY_COVERAGE.brainTopLevel]);
  });

  test("a declared blast radius outside Brain/ makes the same call partial", () => {
    const gated = withDestructiveSnapshot(vault, BRAIN_SNAPSHOT_REASON.deleteBySource, () => 7, {
      now: NOW,
      blastRadius: { brainTopLevel: true, outsideBrainRoot: true },
    });
    expect(gated.recoverability.state).toBe(RECOVERABILITY_STATE.partial);
    expect(gated.recoverability.blockers).toEqual([RECOVERABILITY_BLOCKER.outsideBrainRoot]);
    // The recovery point is real and still reported - the verdict
    // qualifies it, it does not replace it.
    expect(gated.snapshot.runId.startsWith(BRAIN_SNAPSHOT_REASON.deleteBySource)).toBe(true);
  });
});

// ----- The acceptance criterion: the two live call sites did not move -------

describe("the two pre-existing call sites return byte-identical payloads", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-recoverability-callsite-"));
    mkdirSync(join(vault, "imports"), { recursive: true });
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("deleteBySource's confirmed plan is exactly the payload it shipped with", () => {
    writeFileSync(join(vault, "imports", "benchmark.md"), "benchmark rows\n", "utf8");
    ingestSource(
      vault,
      {
        sourcePath: "imports/benchmark.md",
        summary: "Benchmark import summary.",
        extraction: { entities: [{ category: "concept", name: "BenchWidget" }] },
      },
      { agent: "tester", now: NOW },
    );

    const plan = deleteBySource(vault, "imports/benchmark.md", { confirm: true, now: NOW });

    expect(stablePayload(plan, vault)).toBe(
      [
        "{",
        '  "source": "imports/benchmark.md",',
        '  "confirmed": true,',
        '  "includeOriginals": false,',
        '  "derived": [',
        "    {",
        '      "path": "Brain/entities/concept/ent-concept-benchwidget.md",',
        '      "id": "ent-concept-benchwidget",',
        '      "kind": "entity",',
        '      "match": "wikilink",',
        '      "isIndexArtifact": false,',
        '      "deletable": true',
        "    },",
        "    {",
        '      "path": "Brain/sources/src-imports-benchmark-md-54d80ede894c.md",',
        '      "id": "src-imports-benchmark-md-54d80ede894c",',
        '      "kind": "summary",',
        '      "match": "source_path",',
        '      "isIndexArtifact": true,',
        '      "deletable": true',
        "    }",
        "  ],",
        '  "mentions": [],',
        '  "originals": [',
        '    "imports/benchmark.md"',
        "  ],",
        '  "manifestEntry": "imports/benchmark.md",',
        '  "deleted": [',
        '    "Brain/entities/concept/ent-concept-benchwidget.md",',
        '    "Brain/sources/src-imports-benchmark-md-54d80ede894c.md"',
        "  ],",
        '  "manifestEntryRemoved": true,',
        '  "auditRecordId": "ctn_20260601000000_a68bcc9d65569947",',
        '  "snapshotRunId": "delete-by-source-2026-06-01-000000",',
        '  "snapshotPath": "<vault>/Brain/.snapshots/delete-by-source-2026-06-01-000000.tar.zst",',
        // The one key B1 added, and the only difference from the payload
        // measured against the pre-R1a tree. It is here rather than
        // absent because a deliberate change to a response shape must be
        // deliberate: the byte comparison is what forced it to be typed
        // out rather than to slip in.
        '  "recoverability": {',
        '    "state": "covered",',
        '    "coverage": [',
        '      "brain_top_level"',
        "    ],",
        '    "blockers": []',
        "  },",
        '  "blastRadius": 3',
        "}",
      ].join("\n"),
    );
  });

  test("pruneEntityLabels' confirmed result is exactly the payload it shipped with", () => {
    bootstrapBrain(vault);
    const dir = join(brainDirs(vault).entities, "concept");
    mkdirSync(dir, { recursive: true });
    writeFrontmatterAtomic(
      join(dir, "concept-blank.md"),
      {
        kind: "brain-entity",
        entity_id: "concept-blank",
        category: "concept",
        name: "  ",
        status: "active",
        created_at: "2026-07-18T00:00:00Z",
        updated_at: "2026-07-18T00:00:00Z",
        tags: ["brain", "brain/entity"],
      },
      "# blank",
      { overwrite: true },
    );

    const result = pruneEntityLabels(vault, {
      confirm: true,
      now: NOW,
      denylist: new Set<string>(),
    });

    expect(stablePayload(result, vault)).toBe(
      [
        "{",
        '  "confirmed": true,',
        '  "candidates": [',
        "    {",
        '      "id": "concept-blank",',
        '      "path": "<vault>/Brain/entities/concept/concept-blank.md",',
        '      "category": "concept",',
        '      "name": "  ",',
        '      "status": "active",',
        '      "reason": "empty",',
        '      "inboundReferences": []',
        "    }",
        "  ],",
        '  "removed": [',
        '    "<vault>/Brain/entities/concept/concept-blank.md"',
        "  ],",
        '  "edgesStripped": 0,',
        '  "snapshotRunId": "entity-prune-2026-06-01-000000",',
        '  "snapshotPath": "<vault>/Brain/.snapshots/entity-prune-2026-06-01-000000.tar.zst"',
        "}",
      ].join("\n"),
    );
  });
});

/**
 * The intake's disposition contract (PR #247 review M4 residual).
 *
 * The ingest pipeline resolves the review disposition ONCE, before the
 * intake, so a deny refuses the whole ingest before anything is written -
 * that arm is pinned here at the pipeline level, regression-free. On a
 * `stage` verdict the summary page alone used to stage while the intake's
 * entity pages published straight into the canonical registry, so review
 * approved half of what had already happened. Under a `stage` disposition
 * the intake now stages every page it CREATED into the review queue
 * (`Brain/pending/notes/`, the one lane whose publish target can address
 * the entity tree) instead of leaving it published, byte-identical and
 * carrying the relations applied before staging, so applying the queue
 * entry publishes exactly the page a publish-disposition intake would
 * have written. The update arm is untouched - the review boundary is
 * entry, not mutation.
 *
 * Two review follow-ups pin here too: a store-learned label refusal
 * skips one entity and is counted instead of aborting the batch (M4),
 * and a staged intake defers a relation pointing into a staged page
 * from a published one, so no published page ever carries a link to an
 * entity that exists only in the queue (M13) - while a re-ingest of a
 * source still staged dedupes onto the open queue entries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { canonicalNotePath } from "../../../src/core/path-safety.ts";
import { getEntity, listEntities } from "../../../src/core/brain/entities/registry.ts";
import {
  deriveEntityLexicon,
  writeEntityLexicon,
} from "../../../src/core/brain/entities/lexicon.ts";
import { entityPath } from "../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  intakeExtraction,
  IntakeValidationError,
  type ExtractionIntake,
  type IntakeOptions,
  type IntakeResult,
} from "../../../src/core/brain/intake/extract-intake.ts";
import { ingestSource } from "../../../src/core/brain/ingest/ingest.ts";
import {
  applyPendingLane,
  listPendingLane,
} from "../../../src/core/brain/pending/pending-lanes.ts";
import { REVIEW_LANE } from "../../../src/core/brain/write-gate.ts";
import { WriteRefusedError } from "../../../src/core/brain/write-disposition.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-14T09:00:00Z");
const SOURCE = "Articles/restaking-primer.md";

const SAMPLE: ExtractionIntake = {
  entities: [
    { category: "concept", name: "Restaking" },
    { category: "concept", name: "Validators", aliases: ["Validator nodes"] },
  ],
  relations: [{ from: "Restaking", relation: "related", to: "Validators" }],
};

function seed(rel: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `bytes of ${rel}\n`, "utf8");
}

function opts(overrides: Partial<IntakeOptions> = {}): IntakeOptions {
  seed(SOURCE);
  return {
    agent: "ingest-agent",
    now: NOW,
    provenance: { level: "stated", sources: [`[[${SOURCE}]]`], premises: [] },
    ...overrides,
  };
}

/** The canonical vault-relative path of a created entity's page. */
function canonicalPage(category: string, id: string): string {
  return canonicalNotePath(relative(vault, entityPath(vault, category, id)));
}

function writePermissionsDoc(text: string): void {
  atomicWriteFileSync(join(vault, "Brain", "_permissions.yaml"), text);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-intake-stage-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-intake-stage-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("intakeExtraction under a stage disposition", () => {
  test("created entity pages stage into review instead of publishing", () => {
    const res = intakeExtraction(vault, SAMPLE, opts({ disposition: "stage" }));
    expect(res.entitiesCreated).toHaveLength(2);
    // Nothing published: the canonical registry cannot see the pages.
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
    expect(listEntities(vault, { category: "concept", status: "quarantine" })).toHaveLength(0);
    // The queue holds one entry per created page, publishing at the page's
    // canonical path.
    const listing = listPendingLane(vault, REVIEW_LANE.notes);
    expect(listing.entries).toHaveLength(2);
    const targets = listing.entries.map((e) => e.publishTarget).toSorted();
    expect(targets).toEqual(
      res.entitiesCreated.map((id) => canonicalPage("concept", id)).toSorted(),
    );
    // The result names the staged entries so the caller can report them.
    expect(res.stagedEntityPages).toHaveLength(2);
    for (const staged of res.stagedEntityPages ?? []) {
      expect(staged.publishTarget).toBe(canonicalPage("concept", staged.entityId));
      expect(listing.entries.some((e) => e.id === staged.pendingId)).toBe(true);
    }
  });

  test("applying the staged entry publishes the page verbatim at its canonical path", () => {
    const res = intakeExtraction(vault, SAMPLE, opts({ disposition: "stage" }));
    const staged = res.stagedEntityPages?.find((s) => s.entityId === res.entitiesCreated[0]);
    expect(staged).toBeDefined();
    const stagedBytes = readFileSync(
      join(vault, "Brain", "pending", "notes", `${staged!.pendingId}.md`),
      "utf8",
    );
    applyPendingLane(vault, staged!.pendingId);
    const page = canonicalPage("concept", staged!.entityId);
    expect(existsSync(join(vault, page))).toBe(true);
    expect(readFileSync(join(vault, page), "utf8")).toBe(stagedBytes);
    // The published record is a first-class entity: lookup, provenance and
    // the relation applied before staging all carried through the queue.
    const entity = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(entity?.id).toBe(staged!.entityId);
    expect(entity?.body).toContain("## Sources");
    expect(entity?.relations.some((r) => r.relation === "related")).toBe(true);
  });

  test("the staged bytes are byte-identical to a publish-disposition intake", () => {
    const staged = intakeExtraction(vault, SAMPLE, opts({ disposition: "stage" }));
    const stagedEntry = staged.stagedEntityPages?.[0];
    expect(stagedEntry).toBeDefined();
    const stagedBytes = readFileSync(
      join(vault, "Brain", "pending", "notes", `${stagedEntry!.pendingId}.md`),
      "utf8",
    );
    // The same extraction into a second vault, disposition absent, is the
    // control: staging must change nothing about the page itself.
    const controlVault = mkdtempSync(join(tmpdir(), "o2b-intake-stage-ctrl-"));
    try {
      const controlConfig = join(configHome, "ctrl-config.yaml");
      atomicWriteFileSync(controlConfig, `vault: ${controlVault}\n`);
      bootstrapBrain(controlVault, { configPath: controlConfig });
      const abs = join(controlVault, SOURCE);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, `bytes of ${SOURCE}\n`, "utf8");
      intakeExtraction(controlVault, SAMPLE, {
        agent: "ingest-agent",
        now: NOW,
        provenance: { level: "stated", sources: [`[[${SOURCE}]]`], premises: [] },
      });
      const controlPage = canonicalNotePath(
        relative(controlVault, entityPath(controlVault, "concept", stagedEntry!.entityId)),
      );
      expect(readFileSync(join(controlVault, controlPage), "utf8")).toBe(stagedBytes);
    } finally {
      rmSync(controlVault, { recursive: true, force: true });
    }
  });

  test("the update arm is untouched: an updated page stays published", () => {
    intakeExtraction(vault, SAMPLE, opts());
    const before = listEntities(vault, { category: "concept" })
      .map((e) => e.id)
      .toSorted();
    const res = intakeExtraction(vault, SAMPLE, opts({ disposition: "stage" }));
    expect(res.entitiesCreated).toHaveLength(0);
    expect(res.entitiesUpdated).toHaveLength(2);
    expect(res.stagedEntityPages).toBeUndefined();
    expect(
      listEntities(vault, { category: "concept" })
        .map((e) => e.id)
        .toSorted(),
    ).toEqual(before);
    expect(listPendingLane(vault, REVIEW_LANE.notes).entries).toHaveLength(0);
  });

  test("an absent disposition keeps the publish arm byte-identical", () => {
    const res = intakeExtraction(vault, SAMPLE, opts());
    expect(res.stagedEntityPages).toBeUndefined();
    expect(listEntities(vault, { category: "concept" })).toHaveLength(2);
    expect(listPendingLane(vault, REVIEW_LANE.notes).entries).toHaveLength(0);
  });

  test("a malformed extraction still refuses before any write", () => {
    expect(() =>
      intakeExtraction(
        vault,
        { entities: [{ category: "concept", name: "" }] },
        opts({ disposition: "stage" }),
      ),
    ).toThrow(IntakeValidationError);
    expect(listPendingLane(vault, REVIEW_LANE.notes).entries).toHaveLength(0);
  });
});

describe("the manifest row owes the disposition verdict too", () => {
  // No permissions document: the ingest lane's write-approval toggle alone
  // decides, and `true` yields the stage verdict the manifest row must share.
  const INGEST_ENV = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[INGEST_ENV];
    process.env[INGEST_ENV] = "true";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[INGEST_ENV];
    else process.env[INGEST_ENV] = saved;
    saved = undefined;
  });

  test("a staged ingest records no manifest row while its output awaits review", () => {
    seed(SOURCE);
    const res = ingestSource(
      vault,
      { sourcePath: SOURCE, summary: "A summary.", extraction: SAMPLE },
      { agent: "ingest-agent", now: NOW },
    );
    // The stage arm engaged: the summary went to the review queue.
    expect(res.staged).toBe(true);
    expect(res.pendingId).toBeDefined();
    expect(listPendingLane(vault, REVIEW_LANE.ingest).entries).toHaveLength(1);
    // The manifest would vouch that this source is ingested current; a
    // staged ingest must not record itself as done while its output
    // awaits review - the row shares the page's verdict. Nothing else in
    // this flow creates the manifest, so its absence is the strongest
    // form of "no row recorded".
    const manifestPath = join(vault, ".open-second-brain", "ingest-manifest.json");
    const recorded = existsSync(manifestPath)
      ? readFileSync(manifestPath, "utf8").includes(canonicalNotePath(SOURCE))
      : false;
    expect(recorded).toBe(false);
  });

  test("a staged ingest stages its created entity pages too - nothing publishes", () => {
    seed(SOURCE);
    const res = ingestSource(
      vault,
      { sourcePath: SOURCE, summary: "A summary.", extraction: SAMPLE },
      { agent: "ingest-agent", now: NOW },
    );
    // The stage arm engaged for the summary page.
    expect(res.staged).toBe(true);
    // End-to-end regression (the manifest-row half is pinned above): the
    // entity half owes the same verdict. The created pages must sit in the
    // notes review queue - never in the canonical registry beside a summary
    // that is itself only staged.
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
    expect(listEntities(vault, { category: "concept", status: "quarantine" })).toHaveLength(0);
    const notesEntries = listPendingLane(vault, REVIEW_LANE.notes).entries;
    expect(notesEntries).toHaveLength(2);
    expect(notesEntries.map((e) => e.publishTarget).toSorted()).toEqual(
      res.entitiesCreated.map((id) => canonicalPage("concept", id)).toSorted(),
    );
    // Applying the staged entries publishes exactly what a publish-disposition
    // ingest would have left behind.
    for (const entry of notesEntries) applyPendingLane(vault, entry.id);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(2);
  });

  test("a published ingest still records the manifest row", () => {
    delete process.env[INGEST_ENV];
    seed(SOURCE);
    const res = ingestSource(
      vault,
      { sourcePath: SOURCE, summary: "A summary.", extraction: SAMPLE },
      { agent: "ingest-agent", now: NOW },
    );
    expect(res.staged).toBeUndefined();
    const manifest = readFileSync(
      join(vault, ".open-second-brain", "ingest-manifest.json"),
      "utf8",
    );
    expect(manifest).toContain(canonicalNotePath(SOURCE));
  });
});

describe("a refused label does not abort the intake batch (review M4)", () => {
  /**
   * Teach the lexicon from a corpus page, then rebuild the artifact - the
   * same store-learned vocabulary the registry's creation gate refuses
   * with. The source file is seeded FIRST so the corpus signature it is
   * validated against is the one the intake runs under.
   */
  function seedLexicon(corpus: string): void {
    seed(SOURCE);
    writeFileSync(join(vault, "corpus-page.md"), `${corpus}\n`, "utf8");
    writeEntityLexicon(vault, deriveEntityLexicon(vault, { now: NOW }));
  }

  const JUNK_BATCH: ExtractionIntake = {
    entities: [
      { category: "concept", name: "Restaking" },
      // A single learned common word: the registry's creation gate refuses
      // it with `function-word-run`.
      { category: "concept", name: "Notes" },
      { category: "concept", name: "Validators" },
    ],
    relations: [{ from: "Restaking", relation: "related", to: "Validators" }],
  };

  test("a batch with one junk label completes: the skip is counted and the other entities are created", () => {
    seedLexicon(
      "Notes about the setup. The runner kept notes. Notes ran, notes ran. Restaking wraps staking. Restaking compounds. Restaking again.",
    );
    const res = intakeExtraction(vault, JUNK_BATCH, opts());
    // The refused label is skipped and counted - it never aborts the batch.
    expect(res.entitiesSkipped).toBe(1);
    expect(res.entitiesCreated).toHaveLength(2);
    expect(res.relationsApplied).toBe(1);
    expect(res.relationsSkipped).toBe(0);
    // The refused label wrote nothing, under any name.
    const names = listEntities(vault, { category: "concept" }).map((e) => e.name);
    expect(names).not.toContain("Notes");
    expect(names).not.toContain("notes");
  });

  test("a relation touching a skipped label is skipped and counted too", () => {
    seedLexicon(
      "Notes about the setup. The runner kept notes. Notes ran, notes ran. Restaking wraps staking. Restaking compounds. Restaking again.",
    );
    const res = intakeExtraction(
      vault,
      {
        entities: [
          { category: "concept", name: "Restaking" },
          { category: "concept", name: "Notes" },
        ],
        relations: [{ from: "Restaking", relation: "related", to: "Notes" }],
      },
      opts(),
    );
    expect(res.entitiesSkipped).toBe(1);
    expect(res.entitiesCreated).toHaveLength(1);
    // The edge cannot resolve its refused endpoint; it is skipped by name,
    // not a crash the batch dies on.
    expect(res.relationsApplied).toBe(0);
    expect(res.relationsSkipped).toBe(1);
  });

  test("a retry is idempotent: the same skip, no duplicates", () => {
    seedLexicon(
      "Notes about the setup. The runner kept notes. Notes ran, notes ran. Restaking wraps staking. Restaking compounds. Restaking again.",
    );
    const first = intakeExtraction(vault, JUNK_BATCH, opts());
    const second = intakeExtraction(vault, JUNK_BATCH, opts({ now: LATER }));
    expect(second.entitiesCreated).toHaveLength(0);
    expect(second.entitiesUpdated).toHaveLength(2);
    expect(second.entitiesSkipped).toBe(1);
    expect(second.relationsApplied).toBe(1);
    expect(second.relationsSkipped).toBe(0);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(2);
    expect(first.entitiesCreated).toHaveLength(2);
  });

  test("a non-admission label refusal still refuses the batch", () => {
    // No lexicon: the structural gate alone. A label past the length bound
    // is a hard refusal - only the store-learned admission verdicts skip.
    seed(SOURCE);
    expect(() =>
      intakeExtraction(
        vault,
        {
          entities: [
            { category: "concept", name: `X`.repeat(201) },
            { category: "concept", name: "Restaking" },
          ],
        },
        opts(),
      ),
    ).toThrow(/invalid entity label/);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
  });
});

describe("staged intake defers relations into published pages (review M13)", () => {
  /**
   * Validators is admitted by a publish intake first, so it is a published
   * page; the batch under `stage` then re-states it (an update - it stays
   * published) and creates Restaking, relating the published entity to the
   * staged one - the shape that used to write `[[new-id]]` into the
   * published page before review.
   */
  const ANCHORED_BATCH: ExtractionIntake = {
    entities: [
      { category: "concept", name: "Validators" },
      { category: "concept", name: "Restaking" },
    ],
    relations: [{ from: "Validators", relation: "related", to: "Restaking" }],
  };

  function stageValidatorsToRestaking(): IntakeResult {
    intakeExtraction(vault, { entities: [{ category: "concept", name: "Validators" }] }, opts());
    return intakeExtraction(vault, ANCHORED_BATCH, opts({ disposition: "stage" }));
  }

  test("a relation from a published entity into a staged one writes no dangling link", () => {
    const res = stageValidatorsToRestaking();
    expect(res.entitiesCreated).toHaveLength(1);
    expect(res.stagedEntityPages).toHaveLength(1);
    // The published page never names the entity that exists only in the
    // queue - a rejection of the staged page must not leave a dead link.
    const validators = getEntity(vault, { category: "concept", query: "Validators" });
    expect(validators?.relations ?? []).toEqual([]);
    // The deferral surfaces in the disposition result, so the publish flow
    // can apply the edge once the staged page is admitted.
    expect(res.deferredRelations).toEqual([
      { from: "Validators", relation: "related", to: "Restaking" },
    ]);
  });

  test("a relation between two created pages still rides the staged bytes", () => {
    // Both endpoints stage together, so the edge is written before staging
    // exactly as before - it publishes with the pages it lives on.
    const res = intakeExtraction(vault, SAMPLE, opts({ disposition: "stage" }));
    expect(res.deferredRelations).toBeUndefined();
    expect(res.relationsApplied).toBe(1);
  });

  test("after the queue applies, a re-run of the same intake applies the deferred relation", () => {
    const res = stageValidatorsToRestaking();
    const staged = res.stagedEntityPages?.[0];
    expect(staged).toBeDefined();
    applyPendingLane(vault, staged!.pendingId);
    // The same extraction again - the re-run the held-back manifest row
    // guarantees. Both endpoints are published now, so nothing is deferred
    // and the edge lands on the published page.
    const rerun = intakeExtraction(vault, ANCHORED_BATCH, opts({ disposition: "stage" }));
    expect(rerun.entitiesCreated).toHaveLength(0);
    expect(rerun.deferredRelations).toBeUndefined();
    expect(rerun.relationsApplied).toBe(1);
    const validators = getEntity(vault, { category: "concept", query: "Validators" });
    expect(validators?.relations).toEqual([{ relation: "related", target: staged!.entityId }]);
    // And the re-run staged nothing: the queue is empty.
    expect(listPendingLane(vault, REVIEW_LANE.notes).entries).toHaveLength(0);
  });

  test("a re-ingest while the staged pages are still pending dedupes onto the open entries", () => {
    const first = intakeExtraction(vault, SAMPLE, opts({ disposition: "stage" }));
    // A different day, so a duplicate staging would carry a different id.
    const second = intakeExtraction(vault, SAMPLE, opts({ now: LATER, disposition: "stage" }));
    // One open entry per publish target - not a second pair.
    const entries = listPendingLane(vault, REVIEW_LANE.notes).entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.publishTarget).toSorted()).toEqual(
      (first.stagedEntityPages ?? []).map((s) => s.publishTarget).toSorted(),
    );
    // The re-ingest reports the SAME open entries instead of staging
    // duplicates of its own.
    expect((second.stagedEntityPages ?? []).map((s) => s.pendingId).toSorted()).toEqual(
      (first.stagedEntityPages ?? []).map((s) => s.pendingId).toSorted(),
    );
    // And the duplicate the re-ingest re-created left no canonical orphan.
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
    expect(listEntities(vault, { category: "concept", status: "quarantine" })).toHaveLength(0);
  });
});

describe("the deny arm publishes nothing (pinned at the ingest pipeline)", () => {
  test("a denying document refuses the whole ingest before any write", () => {
    writePermissionsDoc("version: 1\ndefault_action: deny\n");
    seed(SOURCE);
    expect(() =>
      ingestSource(
        vault,
        { sourcePath: SOURCE, summary: "A summary.", extraction: SAMPLE },
        { agent: "ingest-agent", now: NOW },
      ),
    ).toThrow(WriteRefusedError);
    // No summary page, no entity page, no manifest row, no queue entry.
    expect(existsSync(join(vault, "Brain", "sources"))).toBe(false);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
    expect(existsSync(join(vault, ".open-second-brain", "ingest-manifest.json"))).toBe(false);
    expect(listPendingLane(vault, REVIEW_LANE.notes).entries).toHaveLength(0);
    expect(listPendingLane(vault, REVIEW_LANE.ingest).entries).toHaveLength(0);
  });
});

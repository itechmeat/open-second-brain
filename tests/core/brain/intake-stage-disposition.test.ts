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
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { canonicalNotePath } from "../../../src/core/path-safety.ts";
import { getEntity, listEntities } from "../../../src/core/brain/entities/registry.ts";
import { entityPath } from "../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  intakeExtraction,
  IntakeValidationError,
  type ExtractionIntake,
  type IntakeOptions,
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

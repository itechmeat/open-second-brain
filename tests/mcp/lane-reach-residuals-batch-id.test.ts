/**
 * A batch predicts the id its write takes (change `lane-reach-residuals`,
 * package 10, design R8): below local reach the identity pre-check of an
 * entity batch predicts each create's id by the write's own ladder, from
 * the unsuffixed base of the entity's category and name. Where `<base>` is
 * held and an earlier create of the batch takes `<base>-2`, the next
 * create of that slug is predicted `<base>-3`, as the write takes it; an
 * entity whose own slug ends in `-2` is predicted from its own base, never
 * from a base with that suffix stripped.
 *
 * And a batch refused at one item leaves no earlier item: a staged batch
 * whose second new entity takes a suffixed id that a private staged review
 * entry holds is refused before its first create, the raw records of both
 * partitions unchanged. A local batch on the same kind of store is the
 * control of each case.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { assertUpsertsAtReach, upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { entityPath } from "../../src/core/brain/paths.ts";
import { pendingLaneDir, stageForReview } from "../../src/core/brain/pending/pending-lanes.ts";
import { canonicalNotePath } from "../../src/core/path-safety.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  AGENT,
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const SOURCE = "Notes/zqbatch-source.md";
const NOW = new Date("2026-11-20T10:00:00Z");
/** Ingest approval on: an ingest stages its summary and the entity pages it creates. */
const INGEST_APPROVAL = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED";

const lanes: LaneEnv[] = [];
let savedApproval: string | undefined | null = null;
afterEach(() => {
  // Reverse order of creation: each cleanup restores the process-wide
  // values its environment found, so the first one created restores last.
  for (const lane of lanes.splice(0).toReversed()) lane.cleanup();
  if (savedApproval !== null) {
    if (savedApproval === undefined) delete process.env[INGEST_APPROVAL];
    else process.env[INGEST_APPROVAL] = savedApproval;
    savedApproval = null;
  }
});

function env(prefix: string): LaneEnv {
  const e = makeLaneEnv("store", `osb-lane-batch-id-${prefix}-`);
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, SOURCE), "# Source\n\nWe will ship the report.\n", "utf8");
  return e;
}

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** A shared entity of `name` in `concept`, holding its slug's base id. */
function held(e: LaneEnv, name: string): string {
  const res = upsertEntity(e.vault, { category: "concept", name, agent: AGENT, now: NOW });
  expect(laneEntryInPrivate(e.vault, res.entity.path)).toBe(false);
  return res.entity.id;
}

/** The ids a remote batch of `names` predicts for its creates. */
function predicted(e: LaneEnv, names: ReadonlyArray<string>): string[] {
  return withPrivateWithheld(true, () =>
    assertUpsertsAtReach(
      e.vault,
      names.map((name) => ({ category: "concept", name, agent: AGENT, now: NOW })),
    ),
  ).map((path) => basename(path, ".md"));
}

/** The ids a local batch of `names` takes, one upsert after another. */
function written(e: LaneEnv, names: ReadonlyArray<string>): string[] {
  return names.map(
    (name) =>
      upsertEntity(e.vault, { category: "concept", name, agent: AGENT, now: NOW }).entity.id,
  );
}

const CASES = [
  {
    label: "a held base",
    held: "Zq Widget",
    batch: ["Zq-Widget", "Zq_Widget"],
    ids: ["ent-concept-zq-widget-2", "ent-concept-zq-widget-3"],
  },
  {
    label: "a slug that ends in -2",
    held: "Zq Widget 2",
    batch: ["Zq-Widget 2", "Zq Widget-2"],
    ids: ["ent-concept-zq-widget-2-2", "ent-concept-zq-widget-2-3"],
  },
] as const;

describe("a batch predicts the id its write takes", () => {
  for (const c of CASES) {
    test(`${c.label}: the remote prediction is the ids the write takes`, () => {
      const remote = env("predict");
      held(remote, c.held);
      expect(predicted(remote, c.batch)).toEqual([...c.ids]);
    });

    test(`${c.label}: a local batch takes those ids`, () => {
      const local = env("write");
      held(local, c.held);
      expect(written(local, c.batch)).toEqual([...c.ids]);
    });
  }
});

/** A staged entity batch: the extraction of a `brain_ingest_source` with ingest approval on. */
function stagedBatch(): Record<string, unknown> {
  return {
    agent: AGENT,
    source_path: SOURCE,
    summary: "zqbatch summary of the source.",
    entities: [
      { category: "concept", name: "Zq-Widget" },
      { category: "concept", name: "Zq_Widget" },
    ],
  };
}

/** Ingest approval on, so an ingest's intake stages the pages it creates. */
function stageIngest(): void {
  savedApproval = process.env[INGEST_APPROVAL];
  process.env[INGEST_APPROVAL] = "true";
}

/** A private open review entry whose publish target is `<base>-3`'s entity page. */
function privateStagedEntry(e: LaneEnv): void {
  const target = canonicalNotePath(
    relative(e.vault, entityPath(e.vault, "concept", "ent-concept-zq-widget-3")),
  );
  const { pendingId } = stageForReview(
    e.vault,
    "notes",
    target,
    () => `---\nkind: brain-entity\n---\n\nzqbatch held ${REGION}\n`,
  );
  expect(
    laneEntryInPrivate(e.vault, join(pendingLaneDir(e.vault, "notes"), `${pendingId}.md`)),
  ).toBe(true);
}

describe("a batch refused at one item leaves no earlier item", () => {
  test("a remote staged batch is refused before its first create", async () => {
    const e = env("refused");
    stageIngest();
    held(e, "Zq Widget");
    privateStagedEntry(e);
    const before = rawRecords(e);

    const remote = await callJson(server(e), "brain_ingest_source", stagedBatch());

    expect({
      keys: Object.keys(remote),
      fixed: String(remote["error"]).endsWith(WITHHELD),
    }).toEqual({ keys: ["error"], fixed: true });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local staged batch stages both pages", async () => {
    const e = env("refused-local");
    stageIngest();
    held(e, "Zq Widget");
    privateStagedEntry(e);
    const local = await callJson(localServer(e), "brain_ingest_source", stagedBatch());
    expect({
      error: local["error"] ?? null,
      staged: local["staged"],
      created: local["entities_created"],
    }).toEqual({
      error: null,
      staged: true,
      created: ["ent-concept-zq-widget-2", "ent-concept-zq-widget-3"],
    });
  });
});

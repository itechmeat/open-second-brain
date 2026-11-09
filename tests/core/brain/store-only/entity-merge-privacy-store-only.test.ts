/**
 * An entity merge and a label prune on a store-only machine (task 2.10):
 * one privacy verdict per operation, so when any page the operation reads
 * or rewrites is private (either side of a merge, a retargeted inbound
 * page, a pruned or rewritten page) every record it writes (the pages,
 * the audit row, the log events) lands in `private`, and no content of it
 * reaches `shared`. The one exception is content-free: a page that lived
 * in `shared` gets its tombstone there (a dropped page, or a survivor the
 * merge raises to `private`), so a machine holding only `shared` stops
 * showing it (design D14 item 18).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  applyEntityMerge,
  entityMergePlanHash,
  planEntityMerge,
} from "../../../../src/core/brain/entities/page-merge.ts";
import { __clearEntityIndexCache } from "../../../../src/core/brain/entities/index-builder.ts";
import { pruneEntityLabels } from "../../../../src/core/brain/entities/label-hygiene.ts";
import { relateEntities, upsertEntity } from "../../../../src/core/brain/entities/registry.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { withOperationPrivacy } from "../../../../src/core/store/operation-scope.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  __clearEntityIndexCache();
});

const NOW = new Date("2026-10-17T09:00:00Z");

function switchedEnv(): StoreEnv {
  const e = makeStoreEnv("osb-entity-merge-private-", { dualWrite: false });
  switchDevice(e.storeRoot);
  __clearEntityIndexCache();
  return e;
}

/**
 * The records `run` appends, per partition. Partition reads come back in
 * shard order, not append order, so the new records are told apart by id.
 */
function recordsAddedBy(
  root: string,
  run: () => void,
): { shared: StoreRecord[]; private: StoreRecord[] } {
  const all = () => [...partitionRecords(root, "shared"), ...partitionRecords(root, "private")];
  const before = new Set(all().map((r) => r.id));
  run();
  const added = (partition: "shared" | "private") =>
    partitionRecords(root, partition).filter((r) => !before.has(r.id));
  return { shared: added("shared"), private: added("private") };
}

/** The shared tombstones of `entries`, the only records an operation adds to shared. */
function sharedTombstones(...entries: string[]): string[] {
  return entries.map((entry) => `lane-entry-remove people/${entry}`).toSorted();
}

/** `kind` plus the lane entry or log event type, sorted, for a stable comparison. */
function shapes(records: ReadonlyArray<StoreRecord>): string[] {
  return records
    .map((r) => {
      const detail = r.body["entry"] ?? r.body["event_type"] ?? "";
      return `${r.kind} ${String(detail)}`.trim();
    })
    .toSorted();
}

function person(vault: string, name: string, body: string): string {
  return upsertEntity(vault, { category: "people", name, body, agent: "t", now: NOW }).entity.id;
}

function merge(vault: string, keep: string, drop: string): void {
  const refs = { keep, drop };
  const hash = entityMergePlanHash(planEntityMerge(vault, refs));
  applyEntityMerge(vault, refs, { expectHash: hash, now: NOW });
}

describe("an entity merge once switched", () => {
  test("a private side makes every record of the merge private", () => {
    env = switchedEnv();
    const vault = env.vault;
    const keep = person(vault, "Ada Lovelace", "Analytical engines.");
    const drop = person(vault, "Ada", "Met her at <private>the clinic</private>.");
    const added = recordsAddedBy(env.storeRoot, () => merge(vault, keep, drop));
    // The shared survivor turns private: only its tombstone reaches shared.
    expect(shapes(added.shared)).toEqual(sharedTombstones("ent-people-ada-lovelace"));
    expect(shapes(added.private)).toEqual([
      "lane-entry people/ent-people-ada-lovelace",
      "lane-entry-remove people/ent-people-ada",
      "ledger-row",
      "log-event merge",
      "log-event snapshot",
    ]);
  });

  test("a side private by its partition alone makes every record of the merge private", () => {
    env = switchedEnv();
    const vault = env.vault;
    const keep = person(vault, "Ada Lovelace", "Analytical engines.");
    // Written inside a private operation: no field or region says so.
    const drop = withOperationPrivacy(true, () => person(vault, "Ada", "Met her at the clinic."));
    __clearEntityIndexCache();
    const added = recordsAddedBy(env.storeRoot, () => merge(vault, keep, drop));
    expect(shapes(added.shared)).toEqual(sharedTombstones("ent-people-ada-lovelace"));
    expect(JSON.stringify(partitionRecords(env.storeRoot, "shared"))).not.toContain("clinic");
  });

  test("a private inbound page makes every record of a public pair's merge private", () => {
    env = switchedEnv();
    const vault = env.vault;
    const keep = person(vault, "Ada Lovelace", "Analytical engines.");
    const drop = person(vault, "Ada", "Wrote the first program.");
    person(vault, "Mary Somerville", "Met at <private>the clinic</private>.");
    relateEntities(vault, {
      from: { query: "Mary Somerville" },
      relation: "related",
      to: { query: "Ada" },
      now: NOW,
    });
    __clearEntityIndexCache();
    const added = recordsAddedBy(env.storeRoot, () => merge(vault, keep, drop));
    // Both shared sides leave shared by their tombstones; no content follows.
    expect(shapes(added.shared)).toEqual(
      sharedTombstones("ent-people-ada", "ent-people-ada-lovelace"),
    );
    expect(JSON.stringify(added.shared)).not.toContain("clinic");
    expect(shapes(added.private)).toEqual([
      "lane-entry people/ent-people-ada-lovelace",
      "lane-entry people/ent-people-mary-somerville",
      "ledger-row",
      "log-event merge",
      "log-event snapshot",
    ]);
  });
});

/** An entity page written past the creation gate, as a stale label would sit. */
function entityPage(vault: string, id: string, name: string, body: string, extra = {}): void {
  const meta = {
    kind: "brain-entity",
    entity_id: id,
    category: "people",
    name,
    status: "active",
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    tags: ["brain", "brain/entity"],
    ...extra,
  };
  writeLanePage(vault, join(brainDirs(vault).entities, "people", `${id}.md`), meta, body);
  __clearEntityIndexCache();
}

describe("a label prune once switched", () => {
  test("a pruned page private by its partition alone keeps the prune out of shared", () => {
    env = switchedEnv();
    const vault = env.vault;
    withOperationPrivacy(true, () =>
      entityPage(vault, "ent-people-junk", "***", "Seen at the clinic.\n"),
    );
    entityPage(vault, "ent-people-ada", "Ada", "# Ada\n", { related: ["[[ent-people-junk]]"] });
    const added = recordsAddedBy(env.storeRoot, () => {
      const result = pruneEntityLabels(vault, { confirm: true, now: NOW });
      expect(result.edgesStripped).toBe(1);
    });
    // The shared survivor, rewritten privately, leaves shared by its tombstone.
    expect(shapes(added.shared)).toEqual(sharedTombstones("ent-people-ada"));
    expect(JSON.stringify(partitionRecords(env.storeRoot, "shared"))).not.toContain("clinic");
  });

  test("a private pruned page makes its tombstone and the rewritten survivor private", () => {
    env = switchedEnv();
    const vault = env.vault;
    entityPage(vault, "ent-people-junk", "***", "Seen at <private>the clinic</private>.\n");
    entityPage(vault, "ent-people-ada", "Ada", "# Ada\n", { related: ["[[ent-people-junk]]"] });
    const added = recordsAddedBy(env.storeRoot, () => {
      const result = pruneEntityLabels(vault, { confirm: true, now: NOW });
      expect(result.edgesStripped).toBe(1);
    });
    expect(shapes(added.shared)).toEqual(sharedTombstones("ent-people-ada"));
    expect(shapes(added.private)).toEqual([
      "lane-entry people/ent-people-ada",
      "lane-entry-remove people/ent-people-junk",
      "log-event snapshot",
    ]);
  });
});

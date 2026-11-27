/**
 * A cleanup by source below local reach whose read-back could not be made
 * (change `tool-lane-write-keeps-standing`, the review of the third and
 * fourth batches of `lane-reach-residuals`, finding 2). The derived lane
 * entries go in one store write; once their removals are appended they
 * are removed, and the audit of the cleanup names them as removed even
 * when the read-back of that write fails (`LaneWriteUnverifiedError`):
 * the answer says the write was made and could not be verified, never
 * that nothing was removed. The failure is injected with the fold double
 * of `lane-standing-unverified.test.ts`: the fresh fold read made by the
 * read-back (`assertWriteApplied`).
 *
 * When the read-back says the store did not apply a removal
 * (`LaneWriteNotAppliedError`: a later version of that key holds), the
 * entry is not removed, and the audit does not name it as removed (the
 * last review of version 2.0.5, finding 3). The same fold double keeps
 * the entry's version as it was before the cleanup.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { brainRelOf } from "../../src/core/store/lane-entry-store.ts";
import * as foldCache from "../../src/core/store/lane-fold-cache.ts";
import { lanePlaceOf } from "../../src/core/store/lane-paths.ts";
import { laneEntryKey } from "../../src/core/store/lane-records.ts";
import { lanePageExists } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  AGENT,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const SOURCE = "Notes/zqunverified-source.md";

const lanes: LaneEnv[] = [];
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** A store-only machine holding one ingested source whose derivations are all shared. */
async function seeded(): Promise<{ e: LaneEnv; derived: string[] }> {
  const e = makeLaneEnv("store", "osb-dbs-unverified-");
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, SOURCE), "# Source\n\nWe will ship the report.\n", "utf8");
  const ingested = await callJson(localServer(e), "brain_ingest_source", {
    agent: AGENT,
    source_path: SOURCE,
    summary: "zqunverified summary of the source.",
    entities: [{ category: "concept", name: "Zqunverified Concept" }],
  });
  expect(ingested["error"]).toBeUndefined();
  const dry = await callJson(server(e), "brain_delete_by_source", { source_file: SOURCE });
  expect(dry["error"]).toBeUndefined();
  const derived = (dry["derived"] as ReadonlyArray<{ path: string }>).map((entry) => entry.path);
  expect(derived.length).toBeGreaterThan(0);
  return { e, derived };
}

/** The fresh fold read of the read-back fails, once. */
function failReadBack(): { fired: boolean } {
  const state = { fired: false };
  const original = foldCache.freshLaneStoreFold;
  const spy = spyOn(foldCache, "freshLaneStoreFold").mockImplementation((...args) => {
    if (!state.fired && (new Error().stack ?? "").includes("assertWriteApplied")) {
      state.fired = true;
      throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    }
    return original(...args);
  });
  restore = () => spy.mockRestore();
  return state;
}

describe("a remote cleanup whose read-back could not be made", () => {
  test("names the appended removals as removed in its audit and says the write is unverified", async () => {
    const { e, derived } = await seeded();
    const race = failReadBack();

    const remote = await callJson(server(e), "brain_delete_by_source", {
      source_file: SOURCE,
      confirm: true,
    });
    restore?.();
    restore = null;

    const gone = derived.filter((path) => !lanePageExists(e.vault, join(e.vault, path)));
    const audit = listContinuityRecords(e.vault, { kind: "source_invalidation" });
    expect({
      fired: race.fired,
      unverified: String(remote["error"]).includes("was written and could not be verified"),
      removed: gone.length > 0,
      audits: audit.length,
    }).toEqual({ fired: true, unverified: true, removed: true, audits: 1 });
    expect(String(audit[0]!.payload["reason"])).toContain(
      `removed ${gone.length} derived/original entr${gone.length === 1 ? "y" : "ies"}`,
    );
  });
});

/** The lane key of the vault-relative path `rel`, or null. */
function keyOf(e: LaneEnv, rel: string): string | null {
  const place = lanePlaceOf(brainRelOf(e.vault, join(e.vault, rel)));
  return place === null ? null : laneEntryKey(place.lane, place.entry);
}

/**
 * The fresh fold read of the read-back, once, still holds the version of
 * `key` the fold `before` held, at its authority: a later version of the
 * key holds, and the removal is not applied.
 */
function keepVersionAtReadBack(before: foldCache.LaneFolded, key: string): { fired: boolean } {
  const state = { fired: false };
  const original = foldCache.freshLaneStoreFold;
  const spy = spyOn(foldCache, "freshLaneStoreFold").mockImplementation((...args) => {
    const fold = original(...args);
    if (state.fired || !(new Error().stack ?? "").includes("assertWriteApplied")) return fold;
    state.fired = true;
    return {
      ...fold,
      entries: new Map([...fold.entries, [key, before.entries.get(key)!]]),
      authorities: new Map([...fold.authorities, [key, before.authorities.get(key)!]]),
    };
  });
  restore = () => spy.mockRestore();
  return state;
}

describe("a remote cleanup whose read-back says a removal was not applied", () => {
  test("does not name that entry as removed in its audit", async () => {
    const { e, derived } = await seeded();
    const before = foldCache.freshLaneStoreFold();
    const held = derived.find((rel) => {
      const key = keyOf(e, rel);
      return key !== null && before.entries.has(key) && before.authorities.has(key);
    });
    expect(held).toBeDefined();
    const race = keepVersionAtReadBack(before, keyOf(e, held!)!);

    const remote = await callJson(server(e), "brain_delete_by_source", {
      source_file: SOURCE,
      confirm: true,
    });
    restore?.();
    restore = null;

    const appended = derived.filter((path) => !lanePageExists(e.vault, join(e.vault, path)));
    const audit = listContinuityRecords(e.vault, { kind: "source_invalidation" });
    expect({
      fired: race.fired,
      notApplied: String(remote["error"]).includes("was not changed"),
      heldAppended: appended.includes(held!),
      audits: audit.length,
    }).toEqual({ fired: true, notApplied: true, heldAppended: true, audits: 1 });
    const kept = appended.length - 1;
    expect(String(audit[0]!.payload["reason"])).toContain(
      `removed ${kept} derived/original entr${kept === 1 ? "y" : "ies"}`,
    );
  });
});

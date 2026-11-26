/**
 * A confirmed `brain_delete_by_source` below local reach whose source has
 * a derived entry held in `private` (claim 2): the whole cleanup is
 * refused with the fixed answer before the first removal, so the manifest
 * row, the original, the shared derivations and the private one stay
 * byte-identical, with the tool's name before the fixed text. A local
 * cleanup on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { manifestPath } from "../../src/core/brain/ingest/content-manifest.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const SOURCE = "Notes/zqprove-source.md";
const ARGS = {
  agent: AGENT,
  source_path: SOURCE,
  summary: `zqprove summary of the source. ${REGION}`,
  entities: [{ category: "concept", name: "Zqprove Concept" }],
};

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

async function seeded(): Promise<{
  e: LaneEnv;
  original: string;
  manifest: string;
  derived: string[];
  privateDerived: string[];
}> {
  const e = makeLaneEnv("store", "osb-lane-prove-cleanup-");
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  const original = join(e.vault, SOURCE);
  writeFileSync(original, "# Source\n\nWe will ship the report.\n", "utf8");
  const first = await callJson(localServer(e), "brain_ingest_source", ARGS);
  expect(first["error"]).toBeUndefined();
  const dry = await callJson(localServer(e), "brain_delete_by_source", { source_file: SOURCE });
  expect(dry["error"]).toBeUndefined();
  const derived = (dry["derived"] as ReadonlyArray<{ path: string }>).map((entry) => entry.path);
  const privateDerived = derived.filter((path) => laneEntryInPrivate(e.vault, join(e.vault, path)));
  expect(privateDerived.length).toBeGreaterThan(0);
  expect(privateDerived.length).toBeLessThan(derived.length);
  return { e, original, manifest: manifestPath(e.vault), derived, privateDerived };
}

/** Every record of both partitions of the store, serialized and sorted. */
function storeRecords(e: LaneEnv): string[] {
  return (["shared", "private"] as const)
    .flatMap((partition) =>
      readPartition(join(e.env.storeRoot, partition)).flatMap((shard) => shard.all),
    )
    .map((r) => JSON.stringify(r))
    .toSorted();
}

describe("a confirmed delete_by_source with a private derived entry", () => {
  test("a remote confirmed cleanup is refused and removes nothing", async () => {
    const { e, original, manifest, privateDerived } = await seeded();
    const before = storeRecords(e);
    const manifestBefore = readFileSync(manifest, "utf8");

    const remote = await callJson(server(e), "brain_delete_by_source", {
      source_file: SOURCE,
      confirm: true,
    });

    expect(String(remote["error"])).toBe("this entry cannot be written at this reach");
    expect(Object.keys(remote)).toEqual(["error"]);
    expect({
      records: storeRecords(e),
      original_kept: existsSync(original),
      manifest: readFileSync(manifest, "utf8"),
      private_kept: privateDerived.map((path) => laneEntryInPrivate(e.vault, join(e.vault, path))),
    }).toEqual({
      records: before,
      original_kept: true,
      manifest: manifestBefore,
      private_kept: [true],
    });
  });

  test("a local confirmed cleanup removes the derivations", async () => {
    const { e, manifest, derived } = await seeded();
    const local = await callJson(localServer(e), "brain_delete_by_source", {
      source_file: SOURCE,
      confirm: true,
    });
    expect(local["error"]).toBeUndefined();
    expect({
      deleted: local["deleted"],
      manifest_row_removed: local["manifest_entry_removed"],
    }).toEqual({ deleted: derived, manifest_row_removed: true });
    expect(readFileSync(manifest, "utf8")).not.toContain(SOURCE);
  });
});

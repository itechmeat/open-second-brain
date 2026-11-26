/**
 * A write decision taken from the narrowed view (identity-ingest): a
 * re-ingest whose source archive entry the store holds in `private`.
 *
 * The archive is the machine's own content-addressed store: its dedup
 * reads the fold of every partition whatever the caller's reach, so a
 * remote re-ingest finds the archive entry held in `private`, writes no
 * second one and keeps the summary's stamp, exactly as a local re-ingest
 * does (the control).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { SOURCE_ARCHIVE_HASH_KEY } from "../../src/core/brain/provenance/source-archive.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
} from "./lane-private-partition-reach-writes-fixture.ts";

const SOURCE = "Notes/zqidentity-source.md";
const SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";
const ARGS = {
  source_path: SOURCE,
  summary: "zqidentity summary of the source.",
  entities: [{ category: "concept", name: "Zqidentity Concept" }],
};

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-identity-ingest-");
  lanes.push(lane);
  mkdirSync(join(lane.vault, "Notes"), { recursive: true });
  writeFileSync(join(lane.vault, SOURCE), SOURCE_TEXT, "utf8");
  return lane;
}

/** The lane-entry records of `lane` in `partition`. */
function laneRecordsOf(e: LaneEnv, lane: string, partition: "shared" | "private") {
  return e.laneRecords(partition).filter((r) => r.body["lane"] === lane);
}

describe("a re-ingest whose archive entry is held in private", () => {
  test("a remote re-ingest keeps the private archive entry and stamps the summary as a local one does", async () => {
    const e = env();
    const first = await callJson(localServer(e), "brain_ingest_source", { agent: AGENT, ...ARGS });
    const archiveHash = String(first["source_archive_hash"]);
    expect(archiveHash).toMatch(/^[0-9a-f]{64}$/);
    const archiveBefore = laneRecordsOf(e, "source-archive", "private");
    expect(archiveBefore.map((r) => r.body["lane"])).toEqual(["source-archive"]);
    expect(laneRecordsOf(e, "source-archive", "shared")).toEqual([]);
    const summaryBefore = laneRecordsOf(e, "sources", "shared");
    expect(JSON.stringify(summaryBefore)).toContain(SOURCE_ARCHIVE_HASH_KEY);

    const remote = await callJson(server(e), "brain_ingest_source", { agent: AGENT, ...ARGS });

    const summaryAfter = laneRecordsOf(e, "sources", "shared");
    expect({
      created: remote["created"],
      hash_kept: remote["source_archive_hash"],
      refusal: remote["source_archive_refusal"] ?? null,
      archive_records: laneRecordsOf(e, "source-archive", "private"),
      archive_shared: laneRecordsOf(e, "source-archive", "shared"),
      archive_still_private: laneEntryInPrivate(
        e.vault,
        join(e.vault, "Brain", ".archives", `${archiveHash}.txt`),
      ),
      summary_rewritten: summaryAfter.length - summaryBefore.length,
      stamped: JSON.stringify(summaryAfter.at(-1)).includes(SOURCE_ARCHIVE_HASH_KEY),
    }).toEqual({
      created: false,
      hash_kept: archiveHash,
      refusal: null,
      archive_records: archiveBefore,
      archive_shared: [],
      archive_still_private: true,
      summary_rewritten: 1,
      stamped: true,
    });
  });

  test("a local re-ingest keeps the archive entry and the stamp", async () => {
    const e = env();
    const local = localServer(e);
    const first = await callJson(local, "brain_ingest_source", { agent: AGENT, ...ARGS });
    const archiveHash = String(first["source_archive_hash"]);
    const archiveBefore = laneRecordsOf(e, "source-archive", "private").length;
    const summaryBefore = laneRecordsOf(e, "sources", "shared").length;

    const again = await callJson(local, "brain_ingest_source", { agent: AGENT, ...ARGS });

    expect({
      created: again["created"],
      hash_kept: again["source_archive_hash"],
      refusal: again["source_archive_refusal"] ?? null,
      archive_records: laneRecordsOf(e, "source-archive", "private").length - archiveBefore,
      summary_rewritten: laneRecordsOf(e, "sources", "shared").length - summaryBefore,
      stamped: JSON.stringify(laneRecordsOf(e, "sources", "shared").at(-1)).includes(
        SOURCE_ARCHIVE_HASH_KEY,
      ),
    }).toEqual({
      created: false,
      hash_kept: archiveHash,
      refusal: null,
      archive_records: 0,
      summary_rewritten: 1,
      stamped: true,
    });
  });
});

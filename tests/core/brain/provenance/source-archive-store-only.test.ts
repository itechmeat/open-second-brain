/**
 * The source archive on a machine switched to the brain store (task 2.10,
 * design D14 item 1): an entry is a lane record, so a put writes no file
 * under `<vault>/Brain/`, and read, verify, stats and discard answer from
 * the store. The unswitched cases live in `source-archive.test.ts`.
 * The citation probe finds source pages held as lane records too, so an
 * entry still cited never looks uncited on a switched machine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  discardSourceArchive,
  putSourceArchive,
  readSourceArchiveEntry,
  SOURCE_ARCHIVE_HASH_KEY,
  sourceArchiveCitingPages,
  sourceArchiveStats,
  verifySourceArchive,
} from "../../../../src/core/brain/provenance/source-archive.ts";
import { writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../../lanes/fixtures/lane-env.ts";

let lane: LaneEnv;

beforeEach(() => {
  lane = makeLaneEnv("store", "osb-archive-store-only-");
});

afterEach(() => lane.cleanup());

const SOURCE = "The otter archive, as fetched.";

describe("source archive on a switched machine", () => {
  test("put, read, verify, stats and discard run on the store, with no byte under the vault", () => {
    const before = lane.vaultHash();
    const { hash, bytes } = putSourceArchive(lane.vault, SOURCE);
    expect(lane.vaultHash()).toBe(before);
    expect(readSourceArchiveEntry(lane.vault, hash)).toMatchObject({
      state: "verified",
      hash,
      bytes,
      text: SOURCE,
    });
    expect(verifySourceArchive(lane.vault, hash).state).toBe("verified");
    expect(sourceArchiveStats(lane.vault)).toEqual({ entries: 1, totalBytes: bytes });
    // The same bytes again: one entry, no second record.
    const records = lane.laneRecords().length;
    putSourceArchive(lane.vault, SOURCE);
    expect(lane.laneRecords()).toHaveLength(records);
    expect(discardSourceArchive(lane.vault, hash)).toBe(true);
    expect(readSourceArchiveEntry(lane.vault, hash)).toBeNull();
    expect(sourceArchiveStats(lane.vault)).toEqual({ entries: 0, totalBytes: 0 });
    expect(discardSourceArchive(lane.vault, hash)).toBe(false);
    expect(lane.vaultHash()).toBe(before);
  });

  test("a source page held as a lane record is found as a citing page", () => {
    const { hash } = putSourceArchive(lane.vault, SOURCE);
    writeLanePage(
      lane.vault,
      join(lane.vault, "Brain", "sources", "src-otters.md"),
      { kind: "brain-source", [SOURCE_ARCHIVE_HASH_KEY]: hash },
      "Otters.\n",
    );
    expect(sourceArchiveCitingPages(lane.vault, hash)).toEqual(["Brain/sources/src-otters.md"]);
  });
});

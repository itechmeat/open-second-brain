/**
 * The continuity record envelope, pinned as a known answer.
 *
 * This file is what survives the caller-declared `scope` field that the
 * provenance-at-the-boundary wave built and then removed: the golden
 * fixture below was captured from the store BEFORE that field existed and
 * is unchanged by its removal, which is the exact property the removal had
 * to preserve. Nothing here mentions a scope, because nothing in the store
 * has one any more - what is pinned is the envelope every writer produces.
 *
 * Two properties carry it:
 *
 *   - the envelope is EIGHT fields in one order. `JSON.stringify` emits
 *     insertion order, so a field added anywhere - including at the end -
 *     changes the bytes on disk and fails here. That is the point: a new
 *     envelope field is a schema change, and this test is where it has to
 *     be argued for rather than slipped in.
 *   - the dedup id is sha-256 over `kind`, `createdAt`, `sourceRefs` and
 *     `payload`, and NOTHING else. `docs/observability.md` documents that
 *     formula so a reader can reproduce an id; the second assertion below
 *     recomputes it from the documented inputs rather than from the
 *     implementation, so a hidden input silently joining the hash fails
 *     here instead of stranding everyone who reproduced it from the docs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuityRecord,
  buildContinuityRecord,
  continuityLogPath,
} from "../../../../src/core/brain/continuity/store.ts";
import { loadNormalizedContinuityRecords } from "../../../../src/core/brain/continuity/read-model.ts";
import type {
  AppendContinuityRecordInput,
  ContinuityRecord,
} from "../../../../src/core/brain/continuity/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-record-envelope-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Month shard every fixture below lands in. */
const MONTH = "2026-06";

/** One fixed append input, so every assertion below describes the same write. */
const INPUT: AppendContinuityRecordInput = Object.freeze({
  kind: "recall_telemetry",
  createdAt: "2026-06-14T09:30:00Z",
  sourceRefs: Object.freeze([Object.freeze({ id: "note-a", path: "Brain/notes/a.md" })]),
  payload: Object.freeze({ status: "ok", session_id: "sess-1" }),
});

/**
 * The exact JSONL line {@link INPUT} produces. Pinned as a literal rather
 * than recomputed, because a test that derives its expectation from the
 * implementation cannot notice the implementation moving.
 */
const GOLDEN_LINE =
  '{"schema":"o2b.continuity.v1","id":"ctn_20260614093000_dfa03f037ab006d8",' +
  '"kind":"recall_telemetry","createdAt":"2026-06-14T09:30:00Z",' +
  '"sourceRefs":[{"id":"note-a","path":"Brain/notes/a.md"}],' +
  '"payload":{"status":"ok","session_id":"sess-1"},"private":false,"redacted":false}';

/** The same golden fixture, parsed, for the field-by-field comparison. */
const GOLDEN_RECORD = JSON.parse(GOLDEN_LINE) as ContinuityRecord;

/** Field order of the envelope, in `JSON.stringify` order. */
const GOLDEN_KEYS: ReadonlyArray<string> = Object.freeze([
  "schema",
  "id",
  "kind",
  "createdAt",
  "sourceRefs",
  "payload",
  "private",
  "redacted",
]);

/** Read the month shard back as raw lines, so disk is checked, not memory. */
function shardLines(month: string = MONTH): ReadonlyArray<string> {
  return readFileSync(continuityLogPath(vault, month), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

describe("continuity record envelope", () => {
  test("an append produces the golden envelope, in memory and byte for byte on disk", () => {
    const record = appendContinuityRecord(vault, INPUT);

    expect({ ...record }).toEqual({ ...GOLDEN_RECORD });
    expect(Object.keys(record)).toEqual([...GOLDEN_KEYS]);
    expect(shardLines()).toEqual([GOLDEN_LINE]);
  });

  test("the dedup id is reproducible from the formula the docs publish", () => {
    // `docs/observability.md`: sha-256 over kind + createdAt + sourceRefs
    // + payload, id-stamped with the digits of createdAt. Recomputed from
    // the documented inputs alone - if anything else enters the hash, an
    // operator reproducing an id from the documentation gets a miss and
    // this assertion is what tells us before they do.
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          kind: INPUT.kind,
          createdAt: INPUT.createdAt,
          sourceRefs: INPUT.sourceRefs,
          payload: INPUT.payload,
        }),
        "utf8",
      )
      .digest("hex")
      .slice(0, 16);

    expect(buildContinuityRecord(INPUT).id).toBe(`ctn_20260614093000_${digest}`);
  });

  test("the dry-run builder agrees with the append path", () => {
    // `buildContinuityRecord` exists so a caller can predict the write.
    // A field threaded into one path and not the other would break that.
    expect({ ...buildContinuityRecord(INPUT) }).toEqual({ ...GOLDEN_RECORD });
  });

  test("the read-model surfaces the envelope with no extra declaration on it", () => {
    appendContinuityRecord(vault, INPUT);
    const [normalized] = loadNormalizedContinuityRecords(vault);
    expect(normalized).toBeDefined();
    expect(normalized!.id).toBe(GOLDEN_RECORD.id);
    expect("scope" in normalized!).toBe(false);
  });
});

/**
 * A caller-DECLARED continuity scope (provenance-at-the-boundary, unit G,
 * t_77efc212).
 *
 * The record envelope already carries a `private` flag, but that flag is
 * INFERRED: `safeContinuityPayload` sets it when it finds a `<private>`
 * region inside the payload the caller happened to write. A second
 * inference - a `<shared>` marker read back out of content - is exactly
 * what this unit rejects. The scope is therefore declared by the caller on
 * the append input, or it is absent; nothing derives it from text.
 *
 * Two properties carry the whole feature and both are pinned here:
 *
 *   - absent means TODAY. An append with no scope produces the same
 *     record, field for field and byte for byte on disk, that the same
 *     append produced before the field existed - including the dedup id,
 *     whose golden value below was captured from the store as it stood
 *     before this unit was written.
 *   - a declared scope is opt-in on the read side. A record declaring one
 *     is retained only by a read-model filter that asks for that scope,
 *     and is excluded by every filter that does not - so a scope nothing
 *     requests can never widen what an existing reader already sees.
 *
 * The write side keeps a CLOSED vocabulary (an unknown token is refused at
 * the store boundary) while the read side is deliberately open (an unknown
 * token on disk stays readable and stays excluded). That asymmetry is the
 * additive-evolution rule of the read-model: a record written by a newer
 * version is never leaked to an older reader, and never silently dropped
 * as malformed either.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  appendContinuityRecord,
  buildContinuityRecord,
  continuityLogPath,
} from "../../../../src/core/brain/continuity/store.ts";
import {
  loadNormalizedContinuityRecords,
  normalizeContinuityRecord,
} from "../../../../src/core/brain/continuity/read-model.ts";
import {
  CONTINUITY_RECORD_SCOPE,
  CONTINUITY_SCHEMA_VERSION,
} from "../../../../src/core/brain/continuity/types.ts";
import type {
  AppendContinuityRecordInput,
  ContinuityRecord,
} from "../../../../src/core/brain/continuity/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-declared-scope-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Month shard every fixture below lands in. */
const MONTH = "2026-06";

/**
 * One fixed append input, reused so the unscoped and scoped cases differ
 * in exactly one thing: whether a scope was declared.
 */
const INPUT: AppendContinuityRecordInput = Object.freeze({
  kind: "recall_telemetry",
  createdAt: "2026-06-14T09:30:00Z",
  sourceRefs: Object.freeze([Object.freeze({ id: "note-a", path: "Brain/notes/a.md" })]),
  payload: Object.freeze({ status: "ok", session_id: "sess-1" }),
});

/**
 * The exact JSONL line {@link INPUT} produced BEFORE the scope field
 * existed, captured by running the store at HEAD~ of this unit. Pinned as
 * a literal rather than recomputed, because a test that derives the
 * expectation from the implementation cannot notice the implementation
 * moving. Key order is part of it: `JSON.stringify` emits insertion order,
 * so a new field inserted anywhere but the end would fail here.
 */
const GOLDEN_UNSCOPED_LINE =
  '{"schema":"o2b.continuity.v1","id":"ctn_20260614093000_dfa03f037ab006d8",' +
  '"kind":"recall_telemetry","createdAt":"2026-06-14T09:30:00Z",' +
  '"sourceRefs":[{"id":"note-a","path":"Brain/notes/a.md"}],' +
  '"payload":{"status":"ok","session_id":"sess-1"},"private":false,"redacted":false}';

/** The same golden fixture, parsed, for the field-by-field comparison. */
const GOLDEN_UNSCOPED_RECORD = JSON.parse(GOLDEN_UNSCOPED_LINE) as ContinuityRecord;

/** Field order of the pre-scope envelope, in `JSON.stringify` order. */
const GOLDEN_UNSCOPED_KEYS: ReadonlyArray<string> = Object.freeze([
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

/** Hand-write one raw JSONL row - the only way to forge an on-disk shape. */
function writeRawRow(row: Readonly<Record<string, unknown>>, month: string = MONTH): void {
  const path = continuityLogPath(vault, month);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", flag: "a" });
}

describe("declared continuity scope - absent is today", () => {
  test("an append with no scope is byte-identical to the pre-scope record", () => {
    const record = appendContinuityRecord(vault, INPUT);

    // Field for field, in memory...
    expect({ ...record }).toEqual({ ...GOLDEN_UNSCOPED_RECORD });
    expect(Object.keys(record)).toEqual([...GOLDEN_UNSCOPED_KEYS]);
    expect("scope" in record).toBe(false);

    // ...and byte for byte on disk, key order included.
    expect(shardLines()).toEqual([GOLDEN_UNSCOPED_LINE]);
  });

  test("the dry-run builder agrees with the append path when no scope is declared", () => {
    // `buildContinuityRecord` exists so a caller can predict the write.
    // A field threaded into one path and not the other would break that.
    expect({ ...buildContinuityRecord(INPUT) }).toEqual({ ...GOLDEN_UNSCOPED_RECORD });
  });

  test("an explicitly undefined scope is the same record as an omitted one", () => {
    // An optional field a caller spreads in as `undefined` must not
    // become a distinct record - that is the shape every conditional
    // spread in this codebase produces when its condition is false.
    const omitted = buildContinuityRecord(INPUT);
    const explicit = buildContinuityRecord({ ...INPUT, scope: undefined });
    expect({ ...explicit }).toEqual({ ...omitted });
    expect(explicit.id).toBe(omitted.id);
  });

  test("the read-model reports no scope for an unscoped record", () => {
    appendContinuityRecord(vault, INPUT);
    const [normalized] = loadNormalizedContinuityRecords(vault);
    expect(normalized).toBeDefined();
    expect("scope" in normalized!).toBe(false);
  });
});

describe("declared continuity scope - a declaration is threaded and honoured", () => {
  test("a declared scope reaches the record and the shard", () => {
    const record = appendContinuityRecord(vault, {
      ...INPUT,
      scope: CONTINUITY_RECORD_SCOPE.shared,
    });
    expect(record.scope).toBe(CONTINUITY_RECORD_SCOPE.shared);
    // Appended last, so the pre-scope prefix of the line is untouched.
    expect(Object.keys(record)).toEqual([...GOLDEN_UNSCOPED_KEYS, "scope"]);
    expect(shardLines()[0]).toContain(`"scope":"${CONTINUITY_RECORD_SCOPE.shared}"`);
  });

  test("a declared scope makes a distinct record rather than colliding on id", () => {
    // The dedup id is a content hash. Scope is part of what the record
    // IS, not a version stamp, so two records that differ only in their
    // declaration must not dedupe onto one id.
    const unscoped = buildContinuityRecord(INPUT);
    const shared = buildContinuityRecord({ ...INPUT, scope: CONTINUITY_RECORD_SCOPE.shared });
    expect(shared.id).not.toBe(unscoped.id);
  });

  test("a filter that requests the scope retains it; one that does not excludes it", () => {
    appendContinuityRecord(vault, INPUT);
    appendContinuityRecord(vault, {
      ...INPUT,
      createdAt: "2026-06-14T09:31:00Z",
      scope: CONTINUITY_RECORD_SCOPE.shared,
    });

    const requested = loadNormalizedContinuityRecords(vault, {
      scope: CONTINUITY_RECORD_SCOPE.shared,
    });
    expect(requested.map((entry) => entry.scope)).toEqual([
      undefined,
      CONTINUITY_RECORD_SCOPE.shared,
    ]);

    // The default filter - what all four read-model callers pass today.
    const unrequested = loadNormalizedContinuityRecords(vault);
    expect(unrequested).toHaveLength(1);
    expect(unrequested[0]!.createdAt).toBe(INPUT.createdAt);
  });

  test("requesting a scope does not resurrect a private record", () => {
    // The two policies are independent: a scope request must not become
    // a back door around the masking drop.
    appendContinuityRecord(vault, {
      ...INPUT,
      scope: CONTINUITY_RECORD_SCOPE.shared,
      payload: { note: "<private>secret</private>" },
    });
    expect(
      loadNormalizedContinuityRecords(vault, { scope: CONTINUITY_RECORD_SCOPE.shared }),
    ).toEqual([]);
    const kept = loadNormalizedContinuityRecords(vault, {
      scope: CONTINUITY_RECORD_SCOPE.shared,
      keepPrivate: true,
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.private).toBe(true);
  });
});

describe("declared continuity scope - closed on write, open and fail-closed on read", () => {
  test("an unknown scope token is refused at the store boundary", () => {
    const rogue = { ...INPUT, scope: "world-readable" } as unknown as AppendContinuityRecordInput;
    expect(() => appendContinuityRecord(vault, rogue)).toThrow(/scope/);
    // Refused before any byte lands: the shard was never created.
    expect(() => shardLines()).toThrow();
  });

  test("an unknown scope already on disk stays readable and stays excluded", () => {
    writeRawRow({
      schema: CONTINUITY_SCHEMA_VERSION,
      id: "ctn_20260614093200_ffffffffffffffff",
      kind: "recall_telemetry",
      createdAt: "2026-06-14T09:32:00Z",
      sourceRefs: [],
      payload: {},
      private: false,
      redacted: false,
      scope: "o2b.scope.from-a-newer-version",
    });

    // Readable - not normalized to null the way a malformed row is.
    const normalized = normalizeContinuityRecord(
      JSON.parse(shardLines()[0]!) as Record<string, unknown>,
    );
    expect(normalized).not.toBeNull();
    expect(normalized!.scope).toBe("o2b.scope.from-a-newer-version");

    // Fail-closed - an older reader never leaks a newer version's scope.
    expect(loadNormalizedContinuityRecords(vault)).toEqual([]);
    expect(
      loadNormalizedContinuityRecords(vault, { scope: CONTINUITY_RECORD_SCOPE.shared }),
    ).toEqual([]);
    expect(
      loadNormalizedContinuityRecords(vault, {
        scope: "o2b.scope.from-a-newer-version",
      }),
    ).toHaveLength(1);
  });

  test("a non-string scope on disk is not a declaration", () => {
    // Absence and junk are different answers; junk must not read as
    // "declared", which would silently hide the record from every filter.
    writeRawRow({
      schema: CONTINUITY_SCHEMA_VERSION,
      id: "ctn_20260614093300_eeeeeeeeeeeeeeee",
      kind: "recall_telemetry",
      createdAt: "2026-06-14T09:33:00Z",
      sourceRefs: [],
      payload: {},
      private: false,
      redacted: false,
      scope: 7,
    });
    const [normalized] = loadNormalizedContinuityRecords(vault);
    expect(normalized).toBeDefined();
    expect("scope" in normalized!).toBe(false);
  });
});

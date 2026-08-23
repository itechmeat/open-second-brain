/**
 * The durable multi-artifact write dead letter (nothing-writes-silently,
 * unit E).
 *
 * Claims pinned here:
 *
 *   1. A record round-trips: what `recordDeadLetter` wrote is what
 *      `readDeadLetter` and `listDeadLetters` return, in the shared
 *      reconciliation vocabulary (`attempted` / `found` / `missing`, the
 *      missing keys NAMED).
 *   2. It lands under `<vault>/.open-second-brain/`, the machine-artifact
 *      root the ingest checkpoint and content manifest already use, at a
 *      path the module resolves and the state catalogue can name.
 *   3. Two records of the same failure collapse onto one file, and two
 *      different failures do not.
 *   4. An unknown `schema_version` and a corrupt file are HARD errors on
 *      read - never a silent skip, which would turn "the record of a
 *      partial write is unreadable" into "there was no partial write".
 *   5. A report with nothing missing is refused: a dead letter that names
 *      no unwritten item is not a record of anything.
 *   6. `tryRecordDeadLetter` never throws - it reports why it could not
 *      write - because it runs inside a catch block whose original error
 *      must survive.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  DEAD_LETTER_SCHEMA_VERSION,
  DeadLetterError,
  deadLetterDir,
  deadLetterPath,
  listDeadLetters,
  readDeadLetter,
  recordDeadLetter,
  tryRecordDeadLetter,
  type DeadLetterEnvelopeIdentity,
} from "../../../src/core/brain/dead-letter.ts";
import { DERIVED_STORE_DIR } from "../../../src/core/brain/path-constants.ts";
import { buildReconciliationReport } from "../../../src/core/reconciliation-report.ts";

const NOW = new Date("2026-08-23T10:15:00Z");

const ENVELOPE: DeadLetterEnvelopeIdentity = Object.freeze({
  lane: "extract-signals",
  step: "extract-signals",
  reference: "sess-2026-08-23",
  target: "Brain/inbox",
});

function vault(): string {
  return mkdtempSync(join(tmpdir(), "o2b-dead-letter-"));
}

function report(missing: ReadonlyArray<string>, found = 1) {
  return buildReconciliationReport({ attempted: found + missing.length, found, missing });
}

describe("a dead letter round-trips", () => {
  test("it names the unwritten items, the lane, the envelope and the first error", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:module-names", "items[2]:no-abbrev"]),
      firstError: new Error("EACCES: permission denied"),
      now: NOW,
    });

    expect(record.schema_version).toBe(DEAD_LETTER_SCHEMA_VERSION);
    expect(record.lane).toBe("extract-signals");
    expect(record.step).toBe("extract-signals");
    expect(record.reference).toBe("sess-2026-08-23");
    expect(record.target).toBe("Brain/inbox");
    expect(record.attempted).toBe(3);
    expect(record.found).toBe(1);
    expect(record.missing).toEqual(["items[1]:module-names", "items[2]:no-abbrev"]);
    expect(record.outcome).toBe("partial");
    expect(record.first_error).toContain("EACCES");
    expect(record.recorded_at).toBe("2026-08-23T10:15:00Z");

    const back = readDeadLetter(v, record.id);
    expect(back).toEqual(record);
    expect(listDeadLetters(v)).toEqual([record]);
  });

  test("it lands in the machine-artifact root, at the path the module resolves", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[0]:only"]),
      firstError: "disk full",
      now: NOW,
    });
    const path = deadLetterPath(v, record.id);
    expect(existsSync(path)).toBe(true);
    expect(dirname(path)).toBe(deadLetterDir(v));
    expect(deadLetterDir(v).startsWith(join(v, DERIVED_STORE_DIR))).toBe(true);
    expect(basename(path)).toBe(`${record.id}.json`);
  });

  test("the same failure collapses onto one file; a different one does not", () => {
    const v = vault();
    const input = {
      envelope: ENVELOPE,
      report: report(["items[1]:module-names"]),
      firstError: "disk full",
      now: NOW,
    };
    const first = recordDeadLetter(v, input);
    const again = recordDeadLetter(v, input);
    expect(again.id).toBe(first.id);
    expect(listDeadLetters(v)).toHaveLength(1);

    const other = recordDeadLetter(v, {
      ...input,
      report: report(["items[2]:something-else"]),
    });
    expect(other.id).not.toBe(first.id);
    expect(listDeadLetters(v)).toHaveLength(2);
  });

  test("a retry minutes later still collapses onto the same file", () => {
    // The id is derived from the record's CONTENT and nothing else. When
    // the clock was part of it, a deterministically-failing payload
    // retried twenty times left twenty byte-identical files in a
    // directory nothing prunes - and an operator could not tell twenty
    // partial writes from one repeated one.
    const v = vault();
    const input = {
      envelope: ENVELOPE,
      report: report(["items[1]:module-names"]),
      firstError: "disk full",
      now: NOW,
    };
    const first = recordDeadLetter(v, input);
    const later = recordDeadLetter(v, { ...input, now: new Date("2026-08-23T10:26:00Z") });
    expect(later.id).toBe(first.id);
    expect(listDeadLetters(v)).toHaveLength(1);
    // The one file names the most recent attempt.
    expect(listDeadLetters(v)[0]!.recorded_at).toBe("2026-08-23T10:26:00Z");
  });

  test("the listing is chronological across lanes, not lexical by id", () => {
    const v = vault();
    const older = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[0]:zulu"]),
      firstError: "disk full",
      now: NOW,
    });
    const newer = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[0]:alpha"]),
      firstError: "disk full",
      now: new Date("2026-08-23T11:00:00Z"),
    });
    expect(listDeadLetters(v).map((r) => r.id)).toEqual([older.id, newer.id]);
  });

  test("an empty vault lists nothing rather than failing", () => {
    expect(listDeadLetters(vault())).toEqual([]);
  });
});

describe("an unreadable record is an error, never a skip", () => {
  test("an unknown schema_version is refused by name", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    const path = deadLetterPath(v, record.id);
    writeFileSync(path, JSON.stringify({ ...record, schema_version: 99 }));
    expect(() => readDeadLetter(v, record.id)).toThrow(DeadLetterError);
    expect(() => readDeadLetter(v, record.id)).toThrow(/schema_version/);
    expect(() => listDeadLetters(v)).toThrow(/schema_version/);
  });

  test("a corrupt file is refused by name", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    writeFileSync(deadLetterPath(v, record.id), "{ not json");
    expect(() => readDeadLetter(v, record.id)).toThrow(/corrupt/);
  });

  test("a record missing a field the vocabulary needs is refused by name", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    const { missing: _dropped, ...withoutMissing } = record;
    writeFileSync(deadLetterPath(v, record.id), JSON.stringify(withoutMissing));
    expect(() => readDeadLetter(v, record.id)).toThrow(/missing/);
  });

  test("a record that was never written reads as null", () => {
    expect(readDeadLetter(vault(), "extract-signals-0011aabb2233")).toBeNull();
  });
});

describe("what a dead letter refuses to be", () => {
  test("a report with nothing missing is not a dead letter", () => {
    expect(() =>
      recordDeadLetter(vault(), {
        envelope: ENVELOPE,
        report: buildReconciliationReport({ attempted: 2, found: 2, missing: [] }),
        firstError: "boom",
        now: NOW,
      }),
    ).toThrow(DeadLetterError);
  });

  test("an envelope identity with a blank field is refused by name", () => {
    expect(() =>
      recordDeadLetter(vault(), {
        envelope: { ...ENVELOPE, reference: "  " },
        report: report(["items[1]:x"]),
        firstError: "boom",
        now: NOW,
      }),
    ).toThrow(/reference/);
  });
});

describe("the recorder used inside a catch block cannot throw", () => {
  test("a write it cannot perform is reported, not raised", () => {
    // A vault path that is a FILE, not a directory: the write has nowhere
    // to land, and the caller is mid-catch holding the real error.
    const parent = mkdtempSync(join(tmpdir(), "o2b-dead-letter-"));
    const notAVault = join(parent, "file-not-a-dir");
    writeFileSync(notAVault, "");
    const outcome = tryRecordDeadLetter(notAVault, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    expect(outcome.recorded).toBe(false);
    if (!outcome.recorded) expect(outcome.reason.length).toBeGreaterThan(0);
  });

  test("a write it can perform reports where the record landed", () => {
    const v = vault();
    const outcome = tryRecordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    expect(outcome.recorded).toBe(true);
    if (outcome.recorded) {
      expect(existsSync(outcome.path)).toBe(true);
      expect(readDeadLetter(v, outcome.id)).not.toBeNull();
    }
  });
});

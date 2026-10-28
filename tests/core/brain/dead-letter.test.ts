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
 *   7. Schema v2 freezes the failing commit's validated payload into the
 *      record, so recovery can re-run it without a second model call; a
 *      v1 letter parses unchanged and carries no payload; an unknown
 *      version still refuses.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  DEAD_LETTER_SCHEMA_VERSION,
  DeadLetterError,
  deadLetterDir,
  deadLetterPath,
  listDeadLetters,
  PARSED_DEAD_LETTER_SCHEMA_VERSIONS,
  readDeadLetter,
  recordDeadLetter,
  tryRecordDeadLetter,
  type DeadLetterEnvelopeIdentity,
} from "../../../src/core/brain/dead-letter.ts";
import { commitExtractedSignals } from "../../../src/core/brain/extract-signals.ts";
import { computeDedupHash } from "../../../src/core/brain/dedup-hash.ts";
import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";
import { DERIVED_STORE_DIR } from "../../../src/core/brain/path-constants.ts";
import { buildReconciliationReport } from "../../../src/core/reconciliation-report.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const mkTemp = tempDirs();

const NOW = new Date("2026-08-23T10:15:00Z");

const ENVELOPE: DeadLetterEnvelopeIdentity = Object.freeze({
  lane: "extract-signals",
  step: "extract-signals",
  reference: "sess-2026-08-23",
  target: "Brain/inbox",
});

function vault(): string {
  return mkTemp("o2b-dead-letter-");
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
    const parent = mkTemp("o2b-dead-letter-");
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

// ----- Schema v2: the frozen payload (one-command recovery, t_50794f57) ------
//
//  7. The current schema version is 2, and a v2 record carries the
//     failing commit's validated payload so recovery can re-run it
//     without a second model call.
//  8. A record without a payload carries no payload key at all - absent,
//     never present-and-null.
//  9. Parsing is strict PER VERSION: a v1 letter keeps parsing and names
//     no payload; a v1 letter that claims a payload is refused; a v2
//     payload that is not an object is refused; an unknown version still
//     refuses with the same error as before.

const PAYLOAD = Object.freeze({
  items: [
    {
      topic: "module-names",
      signal: "positive",
      principle: "Never abbreviate a module name.",
      confidence: 0.9,
    },
  ],
});

describe("schema v2 freezes the payload", () => {
  test("the current schema version is 2", () => {
    expect(DEAD_LETTER_SCHEMA_VERSION).toBe(2);
  });

  test("a v2 record round-trips with the payload", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:module-names"]),
      firstError: "disk full",
      now: NOW,
      payload: PAYLOAD,
    });
    expect(record.schema_version).toBe(2);
    expect(record.payload).toEqual(PAYLOAD);
    const back = readDeadLetter(v, record.id);
    expect(back).toEqual(record);
    expect(back?.payload).toEqual(PAYLOAD);
    expect(listDeadLetters(v)[0]?.payload).toEqual(PAYLOAD);
  });

  test("a record without a payload carries no payload key, on disk least of all", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    expect("payload" in record).toBe(false);
    const raw = JSON.parse(readFileSync(deadLetterPath(v, record.id), "utf8")) as Record<
      string,
      unknown
    >;
    expect("payload" in raw).toBe(false);
  });

  test("the payload sits in the fixed serialized field order, after the missing list", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:module-names"]),
      firstError: "disk full",
      now: NOW,
      payload: PAYLOAD,
    });
    const raw = JSON.parse(readFileSync(deadLetterPath(v, record.id), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw)).toEqual([
      "schema_version",
      "id",
      "lane",
      "step",
      "reference",
      "target",
      "attempted",
      "found",
      "missing",
      "payload",
      "outcome",
      "first_error",
      "recorded_at",
    ]);
    expect(record.id.length).toBeGreaterThan(0);
  });

  test("two failures differing only in their payload get different ids", () => {
    const v = vault();
    const withPayload = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "disk full",
      now: NOW,
      payload: PAYLOAD,
    });
    const without = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "disk full",
      now: NOW,
    });
    expect(without.id).not.toBe(withPayload.id);
    expect(listDeadLetters(v)).toHaveLength(2);
  });

  test("a v1 letter parses unchanged and carries no payload", () => {
    // Hand-written exactly as schema v1 wrote it, so the back-compat path
    // is pinned against the real on-disk shape and not a v2 record with
    // the version number edited.
    const v = vault();
    const v1: Record<string, unknown> = {
      schema_version: 1,
      id: "extract-signals-000000000000",
      lane: "extract-signals",
      step: "extract-signals",
      reference: "sess-2026-08-23",
      target: "Brain/inbox",
      attempted: 2,
      found: 1,
      missing: ["items[1]:module-names"],
      outcome: "partial",
      first_error: "disk full",
      recorded_at: "2026-08-23T10:15:00Z",
    };
    mkdirSync(deadLetterDir(v), { recursive: true });
    writeFileSync(
      deadLetterPath(v, "extract-signals-000000000000"),
      `${JSON.stringify(v1, null, 2)}\n`,
    );
    const parsed = readDeadLetter(v, "extract-signals-000000000000");
    expect(parsed).not.toBeNull();
    expect(parsed?.schema_version).toBe(1);
    expect("payload" in (parsed ?? {})).toBe(false);
    expect(parsed?.missing).toEqual(["items[1]:module-names"]);
    expect(listDeadLetters(v)).toHaveLength(1);
  });

  test("a v1 record that claims a payload is refused by name", () => {
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    writeFileSync(
      deadLetterPath(v, record.id),
      JSON.stringify({ ...record, schema_version: 1, payload: PAYLOAD }),
    );
    expect(() => readDeadLetter(v, record.id)).toThrow(DeadLetterError);
    expect(() => readDeadLetter(v, record.id)).toThrow(/payload/);
    expect(() => listDeadLetters(v)).toThrow(/payload/);
  });

  test("a v2 payload that is not an object is refused by name", () => {
    for (const bad of [[PAYLOAD], "nope", null]) {
      const v = vault();
      const record = recordDeadLetter(v, {
        envelope: ENVELOPE,
        report: report(["items[1]:x"]),
        firstError: "boom",
        now: NOW,
        payload: PAYLOAD,
      });
      writeFileSync(deadLetterPath(v, record.id), JSON.stringify({ ...record, payload: bad }));
      expect(() => readDeadLetter(v, record.id)).toThrow(DeadLetterError);
      expect(() => readDeadLetter(v, record.id)).toThrow(/payload/);
    }
  });

  test("the version gate admits exactly the PARSED_DEAD_LETTER_SCHEMA_VERSIONS list", () => {
    // Derived from the constant, not from literals: a version joining the
    // list must parse the day it lands, and anything outside it must
    // keep refusing - the gate and the list cannot drift apart.
    for (const version of PARSED_DEAD_LETTER_SCHEMA_VERSIONS) {
      const v = vault();
      const record = recordDeadLetter(v, {
        envelope: ENVELOPE,
        report: report(["items[1]:x"]),
        firstError: "boom",
        now: NOW,
      });
      writeFileSync(
        deadLetterPath(v, record.id),
        JSON.stringify({ ...record, schema_version: version }),
      );
      expect(readDeadLetter(v, record.id)?.schema_version).toBe(version);
    }
    const outside = Math.max(...PARSED_DEAD_LETTER_SCHEMA_VERSIONS) + 1;
    const v = vault();
    const record = recordDeadLetter(v, {
      envelope: ENVELOPE,
      report: report(["items[1]:x"]),
      firstError: "boom",
      now: NOW,
    });
    writeFileSync(
      deadLetterPath(v, record.id),
      JSON.stringify({ ...record, schema_version: outside }),
    );
    expect(() => readDeadLetter(v, record.id)).toThrow(DeadLetterError);
    expect(() => readDeadLetter(v, record.id)).toThrow(/schema_version/);
  });
});

describe("the extractor freezes its payload into the letter", () => {
  test("the frozen items are redacted, with the raw text's dedup hash kept beside each", () => {
    // The letter sits in `.open-second-brain/dead-letters/` forever and
    // `show --json` prints it: the same redaction `writeSignal` applies
    // before disk applies at freeze time, and the dedup hash frozen
    // beside each item is the RAW text's, so recovery still matches the
    // original delivery identity (the redacted fields alone would hash
    // differently and a re-delivery of the real content would dedup
    // nothing).
    const v = vault();
    mkdirSync(join(v, "Brain"), { recursive: true });
    importSessionRecall(v, {
      sessionId: ENVELOPE.reference,
      turns: [
        {
          turnId: "t1",
          timestamp: "2026-08-22T09:01:00Z",
          role: "user",
          text: "Never abbreviate a module name.",
        },
      ],
      createdAt: "2026-08-22T10:00:00Z",
    });
    const rawPrinciple = "Use token password=hunter2secret when scraping.";
    const rawScope = "password=hunter2secret";
    const payload = {
      items: [
        {
          topic: "release-style",
          signal: "positive",
          principle: rawPrinciple,
          confidence: 0.9,
        },
        {
          // A colon is not a legal slug character, so this item's write
          // refuses and the commit fails PART WAY through the payload.
          // (Its scope never reaches the tag gate, so a secret-shaped one
          // is safe to freeze-test here.)
          topic: "module:names",
          signal: "positive",
          principle: "Never abbreviate a module name.",
          confidence: 0.9,
          scope: rawScope,
        },
      ],
    };
    expect(() =>
      commitExtractedSignals(v, ENVELOPE.reference, payload, { agent: "tester", now: NOW }),
    ).toThrow(/failed to write extracted signal/);
    const letters = listDeadLetters(v);
    expect(letters).toHaveLength(1);
    expect(letters[0]?.schema_version).toBe(2);
    expect(letters[0]?.missing).toEqual(["items[1]:module:names"]);

    // The letter file - read raw, not through the parser - carries no
    // secret anywhere.
    const rawFile = readFileSync(deadLetterPath(v, letters[0]!.id), "utf8");
    expect(rawFile).not.toContain("hunter2secret");

    const frozen = letters[0]?.payload?.["items"] as Array<Record<string, unknown>>;
    expect(frozen).toHaveLength(2);
    expect(frozen[0]?.["principle"]).not.toContain("hunter2secret");
    expect(frozen[0]?.["principle"]).toContain("***REDACTED***");
    expect(frozen[1]?.["principle"]).toBe("Never abbreviate a module name.");
    expect(frozen[1]?.["scope"]).not.toContain("hunter2secret");
    expect(frozen[1]?.["scope"]).toContain("***REDACTED***");

    // The hashes are the RAW text's identity: exactly what the commit
    // wrote into the delivered page's `dedup_hash` frontmatter.
    expect(frozen[0]?.["dedup_hash"]).toBe(
      computeDedupHash({
        topic: "release-style",
        signal: "positive",
        principle: rawPrinciple,
      }),
    );
    expect(frozen[1]?.["dedup_hash"]).toBe(
      computeDedupHash({
        topic: "module:names",
        signal: "positive",
        principle: "Never abbreviate a module name.",
        scope: rawScope,
      }),
    );
  });
});

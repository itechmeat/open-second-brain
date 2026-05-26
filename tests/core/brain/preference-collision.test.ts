/**
 * Collision-detection expectations for `writePreferenceTxn`. Three
 * factory functions cover the typed collision modes that depend on
 * proposed-vs-existing state. `SourceLock` lives inside the lock
 * acquire itself and is exercised in `preference-txn.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContentHash } from "../../../src/core/brain/content-hash.ts";
import {
  brainDirs,
  preferencePath,
} from "../../../src/core/brain/paths.ts";
import {
  BRAIN_COLLISION_KIND,
  BrainCollisionError,
  expectRevision,
  noDuplicateWriteWithin,
  noUnsafeShrink,
  writePreferenceTxn,
} from "../../../src/core/brain/preference-txn.ts";
import {
  BRAIN_PREFERENCE_STATUS,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pref-collision-"));
  mkdirSync(brainDirs(vault).preferences, { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  slug: "collision-rule",
  topic: "test-topic",
  principle: "the original long-form principle text that has plenty of length",
  created_at: "2026-05-26T12:00:00Z",
  unconfirmed_until: "2026-06-02T12:00:00Z",
  status: BRAIN_PREFERENCE_STATUS.confirmed,
  confirmed_at: "2026-05-27T12:00:00Z",
  evidenced_by: [] as ReadonlyArray<string>,
  ...overrides,
});

describe("expectRevision", () => {
  test("passes when stored revision matches expected", () => {
    writePreferenceTxn(vault, baseInput({ revision: 3 }), [], {});
    // Same revision -> ok.
    writePreferenceTxn(
      vault,
      baseInput({
        revision: 4,
        principle: "the original long-form principle text revised slightly",
      }),
      [expectRevision(3)],
      { overwrite: true },
    );
    const text = readFileSync(preferencePath(vault, "collision-rule"), "utf8");
    expect(text).toContain("_revision: 4");
  });

  test("raises BrainCollisionError(StaleUpdate) when stored revision differs", () => {
    writePreferenceTxn(vault, baseInput({ revision: 5 }), [], {});
    let caught: unknown;
    try {
      writePreferenceTxn(
        vault,
        baseInput({ revision: 6 }),
        [expectRevision(2)],
        { overwrite: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainCollisionError);
    expect((caught as BrainCollisionError).kind).toBe("StaleUpdate");
  });

  test("treats a missing on-disk revision as 0", () => {
    writePreferenceTxn(vault, baseInput({}), [], {}); // no revision field on disk
    // expected=0 matches the absent-as-zero reader semantic.
    writePreferenceTxn(
      vault,
      baseInput({ revision: 1, principle: "edited principle text after the no-revision baseline" }),
      [expectRevision(0)],
      { overwrite: true },
    );
    const text = readFileSync(preferencePath(vault, "collision-rule"), "utf8");
    expect(text).toContain("_revision: 1");
  });
});

describe("noUnsafeShrink", () => {
  test("passes when there is no existing preference (first write)", () => {
    writePreferenceTxn(
      vault,
      baseInput({ slug: "fresh", principle: "short" }),
      [noUnsafeShrink(0.5)],
      {},
    );
    expect(
      require("node:fs").existsSync(preferencePath(vault, "fresh")),
    ).toBe(true);
  });

  test("passes when new principle is the same length or longer", () => {
    writePreferenceTxn(vault, baseInput({}), [], {});
    writePreferenceTxn(
      vault,
      baseInput({
        principle:
          "the original long-form principle text that has plenty of length, now with an extension",
      }),
      [noUnsafeShrink(0.5)],
      { overwrite: true },
    );
  });

  test("raises BrainCollisionError(UnsafeShrink) when new principle drops below the ratio", () => {
    writePreferenceTxn(vault, baseInput({}), [], {});
    let caught: unknown;
    try {
      writePreferenceTxn(
        vault,
        baseInput({ principle: "tiny" }),
        [noUnsafeShrink(0.5)],
        { overwrite: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainCollisionError);
    expect((caught as BrainCollisionError).kind).toBe("UnsafeShrink");
  });

  test("the existing on-disk content is not modified when the shrink gate fires", () => {
    const r = writePreferenceTxn(vault, baseInput({}), [], {});
    const before = readFileSync(r.path, "utf8");
    try {
      writePreferenceTxn(
        vault,
        baseInput({ principle: "x" }),
        [noUnsafeShrink(0.5)],
        { overwrite: true },
      );
    } catch {
      // expected
    }
    const after = readFileSync(r.path, "utf8");
    expect(after).toBe(before);
  });
});

describe("noDuplicateWriteWithin", () => {
  test("passes when the existing preference has no content_hash (legacy)", () => {
    writePreferenceTxn(vault, baseInput({}), [], {});
    writePreferenceTxn(
      vault,
      baseInput({
        principle: "the original long-form principle text that has plenty of length",
        last_evidence_at: "2026-05-26T12:00:00Z",
      }),
      [noDuplicateWriteWithin(60_000, () => new Date("2026-05-26T12:00:30Z"))],
      { overwrite: true },
    );
  });

  test("raises BrainCollisionError(DuplicateWrite) when content_hash matches AND last evidence is within the window", () => {
    const principle = "the original long-form principle text that has plenty of length";
    const hash = computeContentHash(principle, undefined);
    writePreferenceTxn(
      vault,
      baseInput({
        principle,
        content_hash: hash,
        last_evidence_at: "2026-05-26T12:00:00Z",
      }),
      [],
      {},
    );

    let caught: unknown;
    try {
      writePreferenceTxn(
        vault,
        baseInput({
          principle,
          content_hash: hash,
          last_evidence_at: "2026-05-26T12:00:00Z",
        }),
        [noDuplicateWriteWithin(60_000, () => new Date("2026-05-26T12:00:30Z"))],
        { overwrite: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainCollisionError);
    expect((caught as BrainCollisionError).kind).toBe("DuplicateWrite");
  });

  test("passes when the window has elapsed even if content_hash matches", () => {
    const principle = "the original long-form principle text that has plenty of length";
    const hash = computeContentHash(principle, undefined);
    writePreferenceTxn(
      vault,
      baseInput({
        principle,
        content_hash: hash,
        last_evidence_at: "2026-05-26T12:00:00Z",
      }),
      [],
      {},
    );

    writePreferenceTxn(
      vault,
      baseInput({
        principle,
        content_hash: hash,
        last_evidence_at: "2026-05-26T13:00:00Z",
      }),
      [
        noDuplicateWriteWithin(
          60_000,
          // 70s elapsed since the existing last_evidence_at
          () => new Date("2026-05-26T12:01:10Z"),
        ),
      ],
      { overwrite: true },
    );
  });
});

describe("BRAIN_COLLISION_KIND completeness", () => {
  test("all four discriminants are covered by either lock acquire or an expectation factory", () => {
    // Sanity assertion - guards against silent renames of the kind table.
    const expected = [
      "DuplicateWrite",
      "SourceLock",
      "StaleUpdate",
      "UnsafeShrink",
    ] as const;
    const actual = [...Object.values(BRAIN_COLLISION_KIND)].sort();
    const expectedSorted = [...expected].sort();
    expect(actual).toEqual(expectedSorted);
  });
});

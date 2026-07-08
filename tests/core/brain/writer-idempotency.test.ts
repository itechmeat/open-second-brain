/**
 * C1 (t_213f356b): the write path honours an optional client-supplied
 * `idempotency_key` on writeSignal / writePreference / appendApplyEvidence.
 *
 * Invariants under test:
 *  1. No key -> the written file is byte-identical to the historical path.
 *  2. Same key + same payload -> deduped (no second file / no second row).
 *  3. Same key + different payload -> throws IdempotencyPayloadMismatchError.
 *  4. A retried write (same key, same payload, fresh call) is deduped —
 *     the multi-runtime retry-after-crash case.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writeSignal, type WriteSignalInput } from "../../../src/core/brain/signal.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { IdempotencyPayloadMismatchError } from "../../../src/core/brain/idempotency-ledger.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-writer-idem-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function baseSignal(overrides: Partial<WriteSignalInput> = {}): WriteSignalInput {
  return {
    topic: "no-abbrev",
    signal: "positive",
    agent: "tester",
    principle: "spell it out",
    created_at: "2026-05-14T10:00:00Z",
    date: "2026-05-14",
    slug: "no-abbrev",
    ...overrides,
  };
}

function inboxFiles(): string[] {
  return readdirSync(brainDirs(vault).inbox).filter((f) => f.endsWith(".md"));
}

describe("writeSignal idempotency key", () => {
  test("no key writes byte-identically to the historical path", () => {
    writeSignal(vault, baseSignal());
    const withoutKey = readFileSync(join(brainDirs(vault).inbox, inboxFiles()[0]!), "utf8");

    // A separate vault, same input, no key at all.
    const vault2 = mkdtempSync(join(tmpdir(), "o2b-writer-idem2-"));
    bootstrapBrain(vault2);
    const r2 = writeSignal(vault2, baseSignal());
    const other = readFileSync(r2.path, "utf8");
    rmSync(vault2, { recursive: true, force: true });

    expect(other).toBe(withoutKey);
  });

  test("same key + same payload dedupes to a single signal file", () => {
    const first = writeSignal(vault, baseSignal({ idempotency_key: "abc" }));
    expect(first.deduped).toBeUndefined();

    const second = writeSignal(vault, baseSignal({ idempotency_key: "abc" }));
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(inboxFiles()).toHaveLength(1);
  });

  test("same key + different payload throws payload_mismatch", () => {
    writeSignal(vault, baseSignal({ idempotency_key: "abc" }));
    expect(() =>
      writeSignal(vault, baseSignal({ idempotency_key: "abc", principle: "totally different" })),
    ).toThrow(IdempotencyPayloadMismatchError);
    // No partial second file.
    expect(inboxFiles()).toHaveLength(1);
  });

  test("a retried write after a simulated crash is deduped, not duplicated", () => {
    writeSignal(
      vault,
      baseSignal({ idempotency_key: "retry", created_at: "2026-05-14T10:00:00Z" }),
    );
    // Fresh call, later wall-clock — a redelivery of the same logical write.
    const retry = writeSignal(
      vault,
      baseSignal({ idempotency_key: "retry", created_at: "2026-05-14T12:30:00Z" }),
    );
    expect(retry.deduped).toBe(true);
    expect(inboxFiles()).toHaveLength(1);
  });
});

describe("writePreference idempotency key", () => {
  test("same key + same payload dedupes", () => {
    const base = {
      slug: "rule-a",
      topic: "coding",
      principle: "prefer X",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-14T10:00:00Z",
      status: "confirmed" as const,
      evidenced_by: ["[[sig-1]]"],
      idempotency_key: "pref-key",
    };
    const first = writePreference(vault, base);
    const second = writePreference(vault, { ...base, created_at: "2026-05-14T12:00:00Z" });
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test("same key + different payload throws", () => {
    const base = {
      slug: "rule-b",
      topic: "coding",
      principle: "prefer X",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-14T10:00:00Z",
      status: "confirmed" as const,
      evidenced_by: ["[[sig-1]]"],
      idempotency_key: "pref-key-b",
    };
    writePreference(vault, base);
    expect(() => writePreference(vault, { ...base, principle: "prefer Y" })).toThrow(
      IdempotencyPayloadMismatchError,
    );
  });
});

describe("appendApplyEvidence idempotency key", () => {
  beforeEach(() => {
    writePreference(vault, {
      slug: "rule-c",
      topic: "coding",
      principle: "prefer X",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-14T10:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-1]]"],
    });
  });

  test("same key + same payload dedupes to a single log row", () => {
    const first = appendApplyEvidence(vault, {
      pref_id: "rule-c",
      artifact: "[[work]]",
      result: "applied",
      agent: "tester",
      idempotency_key: "ev-key",
    });
    const logBody = readFileSync(first.log_path, "utf8");
    const occurrences = (body: string): number => body.split("apply-evidence").length - 1;
    const before = occurrences(logBody);

    const second = appendApplyEvidence(vault, {
      pref_id: "rule-c",
      artifact: "[[work]]",
      result: "applied",
      agent: "tester",
      idempotency_key: "ev-key",
    });
    expect(second.deduped).toBe(true);
    expect(occurrences(readFileSync(first.log_path, "utf8"))).toBe(before);
  });

  test("same key + different payload throws", () => {
    appendApplyEvidence(vault, {
      pref_id: "rule-c",
      artifact: "[[work]]",
      result: "applied",
      agent: "tester",
      idempotency_key: "ev-key-2",
    });
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "rule-c",
        artifact: "[[other]]",
        result: "applied",
        agent: "tester",
        idempotency_key: "ev-key-2",
      }),
    ).toThrow(IdempotencyPayloadMismatchError);
  });
});

import { describe, expect, test } from "bun:test";

import {
  BLOB_REF_KEY,
  ENVELOPE_FIELDS,
  STORE_FORMAT_VERSION,
} from "../../../src/core/store/constants.ts";
import {
  bodyChecksum,
  buildRecord,
  compareRecords,
  EnvelopeError,
  verifyEnvelope,
} from "../../../src/core/store/envelope.ts";
import { isUlid, newUlid, ulidTime } from "../../../src/core/store/ulid.ts";

describe("ulid", () => {
  test("is 26 Crockford base32 characters carrying the time", () => {
    const id = newUlid(1_762_400_000_123);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBe(1_762_400_000_123);
  });

  test("ids issued in one millisecond are unique and strictly increasing", () => {
    const ids = Array.from({ length: 500 }, () => newUlid(1_762_400_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted()).toEqual(ids);
  });

  test("rejects malformed ids", () => {
    for (const bad of [
      "",
      "01ARZ3NDEKTSV4RRFFQ69G5FA",
      "01ARZ3NDEKTSV4RRFFQ69G5FAVU",
      "01arz3ndektsv4rrffq69g5fav",
      "01ARZ3NDEKTSV4RRFFQ69G5FAI",
    ]) {
      expect(isUlid(bad)).toBe(false);
    }
  });
});

describe("body checksum", () => {
  test("ignores key order, so a re-serialised body still verifies", () => {
    expect(bodyChecksum({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(
      bodyChecksum({ b: { d: "x", c: [1, 2] }, a: 1 }),
    );
  });

  test("is a lowercase sha256 hex", () => {
    expect(bodyChecksum({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("record envelope", () => {
  const base = {
    hlc: { physical: 1_762_400_000_000, counter: 2 },
    device: "dev-a",
    agent: "claude-devbox-agent",
    kind: "feedback",
    scope: "writing",
    topic: null,
    body: { principle: "No exclamation marks in docs", when: new Date(0) },
  };

  test("carries every envelope field in the documented order, and verifies", () => {
    const record = buildRecord(base);
    expect(Object.keys(record)).toEqual([...ENVELOPE_FIELDS]);
    expect(record.v).toBe(STORE_FORMAT_VERSION);
    expect(record.hlc).toBe("1762400000000.2");
    expect(isUlid(record.id)).toBe(true);
    const reparsed = JSON.parse(JSON.stringify(record)) as unknown;
    expect(verifyEnvelope(reparsed)).toEqual({ ok: true, record });
  });

  test("stores the JSON form of the body, so values like dates verify after a round trip", () => {
    const record = buildRecord(base);
    expect(record.body).toEqual({
      principle: "No exclamation marks in docs",
      when: "1970-01-01T00:00:00.000Z",
    });
  });

  test("a tampered body fails verification", () => {
    const record = JSON.parse(JSON.stringify(buildRecord(base))) as Record<string, unknown>;
    (record["body"] as Record<string, unknown>)["principle"] = "changed";
    expect(verifyEnvelope(record)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("checksum"),
    });
  });

  test("a missing field fails verification", () => {
    const record = JSON.parse(JSON.stringify(buildRecord(base))) as Record<string, unknown>;
    delete record["agent"];
    expect(verifyEnvelope(record)).toMatchObject({ ok: false });
  });

  // Folds and digests must agree across platforms, so a Windows reader
  // accepts what a POSIX peer named `nul` wrote (this runs in the Windows job).
  test("a record from a device named like a Windows device verifies on every platform", () => {
    const record = buildRecord({ ...base, device: "nul" });
    const reparsed = JSON.parse(JSON.stringify(record)) as unknown;
    expect(verifyEnvelope(reparsed)).toEqual({ ok: true, record });
  });

  test("an unknown version is reported apart from corruption", () => {
    const record = JSON.parse(JSON.stringify(buildRecord(base))) as Record<string, unknown>;
    record["v"] = STORE_FORMAT_VERSION + 1;
    expect(verifyEnvelope(record)).toMatchObject({
      ok: false,
      unknownVersion: STORE_FORMAT_VERSION + 1,
    });
  });

  test("verification refuses labels and blob references that building would never write", () => {
    const line = (over: Record<string, unknown>): Record<string, unknown> => ({
      ...(JSON.parse(JSON.stringify(buildRecord(base))) as Record<string, unknown>),
      ...over,
    });
    expect(verifyEnvelope(line({ agent: "a".repeat(201) }))).toMatchObject({ ok: false });
    expect(verifyEnvelope(line({ agent: "two\nlines" }))).toMatchObject({ ok: false });
    expect(verifyEnvelope(line({ scope: "" }))).toMatchObject({ ok: false });
    expect(verifyEnvelope(line({ scope: "s".repeat(201) }))).toMatchObject({ ok: false });
    expect(verifyEnvelope(line({ scope: null }))).toMatchObject({ ok: true });
    const record = buildRecord(base);
    for (const bytes of [-1, 1.5]) {
      const spilled = { ...record, body: { [BLOB_REF_KEY]: record.sum, bytes } };
      expect(verifyEnvelope(JSON.parse(JSON.stringify(spilled)))).toMatchObject({ ok: false });
    }
    const valid = { ...record, body: { [BLOB_REF_KEY]: record.sum, bytes: 10 } };
    expect(verifyEnvelope(JSON.parse(JSON.stringify(valid)))).toMatchObject({ ok: true });
  });

  test("refuses invalid input when building", () => {
    expect(() => buildRecord({ ...base, device: "" })).toThrow(EnvelopeError);
    expect(() => buildRecord({ ...base, device: "sync-conflict-x" })).toThrow(EnvelopeError);
    expect(() => buildRecord({ ...base, kind: "Not A Kind" })).toThrow(EnvelopeError);
    expect(() => buildRecord({ ...base, agent: " " })).toThrow(EnvelopeError);
    expect(() => buildRecord({ ...base, topic: "not-a-ulid" })).toThrow(EnvelopeError);
    expect(() => buildRecord({ ...base, body: { [BLOB_REF_KEY]: "x" } })).toThrow(EnvelopeError);
  });

  test("fold order is hlc, then device, then id", () => {
    const a = buildRecord({ ...base, hlc: { physical: 10, counter: 0 }, device: "dev-b" });
    const b = buildRecord({ ...base, hlc: { physical: 10, counter: 0 }, device: "dev-a" });
    const c = buildRecord({ ...base, hlc: { physical: 9, counter: 5 }, device: "dev-z" });
    expect([a, b, c].toSorted(compareRecords).map((r) => r.device)).toEqual([
      "dev-z",
      "dev-a",
      "dev-b",
    ]);
  });
});

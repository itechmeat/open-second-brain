/**
 * A retry is the same write only when it would store the same thing: the
 * project a record carries is stored provenance, so a retry of the same
 * content from another project raises the payload mismatch instead of
 * returning the earlier project's record, the same project dedupes, and a
 * record written before records carried a project (none stored) dedupes a
 * retry from a directory that names none.
 */
import { afterEach, expect, test } from "bun:test";

import { IdempotencyPayloadMismatchError } from "../../../src/core/brain/idempotency-ledger.ts";
import type { RecordOrigin } from "../../../src/core/brain/record-origin.ts";
import { saveSessionCheckpoint } from "../../../src/core/brain/session-checkpoint.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { applyWriteBatch } from "../../../src/core/brain/write-batch.ts";
import { makeFleet, type Fleet } from "../store-migration/fixtures/fleet.ts";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function vault(): string {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  return a.vault;
}

const IN_A: RecordOrigin = { project: "app-a" };
const IN_B: RecordOrigin = { project: "app-b" };

function signal(v: string, origin?: RecordOrigin): ReturnType<typeof writeSignal> {
  return writeSignal(v, {
    topic: "release-notes",
    signal: "positive",
    agent: "solo",
    principle: "Release notes list every step",
    created_at: "2026-11-10T08:00:00.000Z",
    date: "2026-11-10",
    slug: "release-notes",
    idempotency_key: "retry-key-1",
    ...(origin !== undefined ? { origin } : {}),
  });
}

function checkpoint(v: string, origin?: RecordOrigin): ReturnType<typeof saveSessionCheckpoint> {
  return saveSessionCheckpoint(v, {
    sessionId: "session-1",
    agent: "solo",
    request: "Ship the release notes",
    learnings: ["Notes list every step"],
    ...(origin !== undefined ? { origin } : {}),
  });
}

function batch(v: string, origin?: RecordOrigin): string {
  return applyWriteBatch(
    v,
    [{ kind: "append_log_line", input: { text: "Batch note", agent: "solo" } }],
    { requestId: "batch-1", ...(origin !== undefined ? { origin } : {}) },
  ).receipt.status;
}

test("a signal retried from another project is a payload mismatch; the same project dedupes", () => {
  const v = vault();
  const first = signal(v, IN_A);
  expect(signal(v, IN_A).id).toBe(first.id);
  expect(() => signal(v, IN_B)).toThrow(IdempotencyPayloadMismatchError);
});

test("a signal written with no project dedupes a retry from an unlinked directory", () => {
  const v = vault();
  const first = signal(v);
  expect(signal(v, {}).id).toBe(first.id);
});

test("a checkpoint retried from another project is a payload mismatch; the same project dedupes", () => {
  const v = vault();
  checkpoint(v, IN_A);
  expect(checkpoint(v, IN_A).deduped).toBe(true);
  expect(() => checkpoint(v, IN_B)).toThrow(IdempotencyPayloadMismatchError);
});

test("a checkpoint written with no project dedupes a retry from an unlinked directory", () => {
  const v = vault();
  checkpoint(v);
  expect(checkpoint(v, {}).deduped).toBe(true);
});

test("a write batch retried from another project is a payload mismatch; the same project dedupes", () => {
  const v = vault();
  batch(v, IN_A);
  expect(batch(v, IN_A)).toBe("duplicate");
  expect(() => batch(v, IN_B)).toThrow(IdempotencyPayloadMismatchError);
});

test("a write batch recorded with no project dedupes a retry from an unlinked directory", () => {
  const v = vault();
  batch(v);
  expect(batch(v, {})).toBe("duplicate");
});

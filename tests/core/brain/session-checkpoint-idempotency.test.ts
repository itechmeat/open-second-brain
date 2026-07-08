/**
 * CR #127.6: `host` and `sourceTurnIds` are written to disk by
 * `saveSessionCheckpoint`, so a retry with the SAME session id but DIFFERENT
 * provenance must raise `IdempotencyPayloadMismatchError` rather than silently
 * deduping. They must therefore be part of the checkpoint content hash.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSessionCheckpoint } from "../../../src/core/brain/session-checkpoint.ts";
import { IdempotencyPayloadMismatchError } from "../../../src/core/brain/idempotency-ledger.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-checkpoint-idem-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const base = {
  sessionId: "sess-1",
  agent: "tester",
  request: "wire the thing",
  createdAt: "2026-06-01T00:00:00Z",
};

describe("saveSessionCheckpoint idempotency covers provenance (CR #127.6)", () => {
  test("same session id + same payload dedupes", () => {
    const first = saveSessionCheckpoint(vault, { ...base, host: "claude" });
    const second = saveSessionCheckpoint(vault, { ...base, host: "claude" });
    expect(second.deduped).toBe(true);
    expect(first.sessionId).toBe("sess-1");
  });

  test("same session id + different host throws", () => {
    saveSessionCheckpoint(vault, { ...base, host: "claude" });
    expect(() => saveSessionCheckpoint(vault, { ...base, host: "codex" })).toThrow(
      IdempotencyPayloadMismatchError,
    );
  });

  test("same session id + different sourceTurnIds throws", () => {
    saveSessionCheckpoint(vault, { ...base, sourceTurnIds: ["t1", "t2"] });
    expect(() => saveSessionCheckpoint(vault, { ...base, sourceTurnIds: ["t1", "t3"] })).toThrow(
      IdempotencyPayloadMismatchError,
    );
  });
});

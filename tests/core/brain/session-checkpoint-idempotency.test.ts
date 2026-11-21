/**
 * CR #127.6: `host` and `sourceTurnIds` are written to disk by
 * `saveSessionCheckpoint`, so a retry with the SAME session id but DIFFERENT
 * provenance must raise `IdempotencyPayloadMismatchError` rather than silently
 * deduping. They must therefore be part of the checkpoint content hash.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSessionCheckpoint } from "../../../src/core/brain/session-checkpoint.ts";
import { IdempotencyPayloadMismatchError } from "../../../src/core/brain/idempotency-ledger.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-checkpoint-idem-"));
  // A legacy Brain/ tree: an unswitched machine (a vault without one is store-only).
  mkdirSync(join(vault, "Brain"), { recursive: true });
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

describe("checkpoint signals of non-Latin topics", () => {
  // The signal's slug only names its file (the dream pass groups signals by
  // topic); the Latin-only slug made "без восклицаний" `unnamed-<hash>`.
  test("the signal file keeps the topic's words, and a replay still dedupes", () => {
    const input = {
      ...base,
      signals: [
        {
          topic: "без восклицаний",
          signal: "positive" as const,
          principle: "Never use exclamation marks in technical docs",
        },
        {
          topic: "不要感叹号",
          signal: "positive" as const,
          principle: "Never use exclamation marks in Chinese docs",
        },
      ],
    };
    const first = saveSessionCheckpoint(vault, input);
    expect(first.signals.map((s) => s.id.replace(/^sig-\d{4}-\d{2}-\d{2}-/u, ""))).toEqual([
      "без-восклицаний",
      "不要感叹号",
    ]);
    expect(saveSessionCheckpoint(vault, input).deduped).toBe(true);
  });
});

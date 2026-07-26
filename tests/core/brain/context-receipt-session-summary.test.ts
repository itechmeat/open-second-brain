/**
 * Unit I - session-scoped retrieval receipt fold.
 *
 * Every primitive already existed and was durable; what was missing was
 * the join across a session. The assertions below are about the join and
 * about the two ways it could lie: presenting zeros where nothing was
 * recorded, and presenting a bounded scan as a complete one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContextReceiptWindowError,
  emitContextReceipt,
  summarizeContextReceiptSession,
  type ContextReceiptItemInput,
} from "../../../src/core/brain/context-receipts.ts";
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { emitObservedUse, observedReuseRates } from "../../../src/core/brain/observed-use.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-receipt-fold-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function seed(
  createdAt: string,
  sessionId: string,
  items: ReadonlyArray<ContextReceiptItemInput>,
): void {
  emitContextReceipt(vault, {
    options: { host: "unit-test", trigger: "context_pack", createdAt, sessionId },
    items,
    finalText: items.map((i) => i.id).join("|"),
  });
}

describe("summarizeContextReceiptSession", () => {
  test("reports that nothing was recorded instead of zeros presented as a finding", () => {
    const summary = summarizeContextReceiptSession(vault, { sessionId: "s1" });
    expect(summary.recorded).toBe(false);
    // A caller cannot reach a count at all without first branching on
    // `recorded` - which is the entire distinction this unit exists for.
    expect("receipt_count" in summary).toBe(false);
  });

  test("folds a session into distinct items with injection frequency and token cost", () => {
    seed("2026-06-01T10:00:00Z", "s1", [
      { id: "pref-a", path: "Brain/preferences/pref-a.md", tokens: 10 },
      { id: "pref-b", path: "Brain/preferences/pref-b.md", tokens: 20 },
    ]);
    seed("2026-06-01T10:05:00Z", "s1", [
      { id: "pref-a", path: "Brain/preferences/pref-a.md", tokens: 12 },
    ]);
    seed("2026-06-01T10:10:00Z", "s1", [
      { id: "pref-a", path: "Brain/preferences/pref-a.md", tokens: 8 },
      { id: "pref-c", tokens: 5 },
    ]);
    // A different session must not leak into the fold.
    seed("2026-06-01T10:11:00Z", "s2", [{ id: "pref-z", tokens: 99 }]);

    const summary = summarizeContextReceiptSession(vault, { sessionId: "s1" });
    if (!summary.recorded) throw new Error("expected receipts");
    expect(summary.receipt_count).toBe(3);
    expect(summary.item_total).toBe(5);
    expect(summary.distinct_items).toBe(3);
    expect(summary.truncated).toBe(false);
    expect(summary.withheld_receipts).toBe(0);
    expect(summary.items).toEqual([
      { id: "pref-a", path: "Brain/preferences/pref-a.md", injections: 3, tokens: 30 },
      { id: "pref-b", path: "Brain/preferences/pref-b.md", injections: 1, tokens: 20 },
      { id: "pref-c", injections: 1, tokens: 5 },
    ]);
  });

  test("counts a redacted receipt without unfolding its payload into the aggregate", () => {
    seed("2026-06-02T10:00:00Z", "s1", [{ id: "pref-a", tokens: 10 }]);
    seed("2026-06-02T10:01:00Z", "s1", [{ id: "<private>pref-secret</private>", tokens: 1000 }]);

    const summary = summarizeContextReceiptSession(vault, { sessionId: "s1" });
    if (!summary.recorded) throw new Error("expected receipts");
    expect(summary.receipt_count).toBe(2);
    expect(summary.withheld_receipts).toBe(1);
    expect(summary.distinct_items).toBe(1);
    expect(summary.items.map((i) => i.id)).toEqual(["pref-a"]);
    expect(summary.items[0]!.tokens).toBe(10);
  });

  test("reports that the scan bound truncated the input", () => {
    for (let i = 0; i < 5; i++) {
      seed(`2026-06-03T10:0${i}:00Z`, "s1", [{ id: `pref-${i}`, tokens: 1 }]);
    }
    const bounded = summarizeContextReceiptSession(vault, { sessionId: "s1", maxReceipts: 2 });
    if (!bounded.recorded) throw new Error("expected receipts");
    expect(bounded.truncated).toBe(true);
    expect(bounded.max_receipts).toBe(2);
    expect(bounded.receipt_count).toBe(2);

    const complete = summarizeContextReceiptSession(vault, { sessionId: "s1", maxReceipts: 50 });
    if (!complete.recorded) throw new Error("expected receipts");
    expect(complete.truncated).toBe(false);
    expect(complete.receipt_count).toBe(5);
  });

  test("a time window bounds the fold", () => {
    seed("2026-06-04T10:00:00Z", "s1", [{ id: "old", tokens: 1 }]);
    seed("2026-06-06T10:00:00Z", "s1", [{ id: "new", tokens: 1 }]);
    const summary = summarizeContextReceiptSession(vault, { since: "2026-06-05T00:00:00Z" });
    if (!summary.recorded) throw new Error("expected receipts");
    expect(summary.items.map((i) => i.id)).toEqual(["new"]);
  });
});

describe("summarizeContextReceiptSession — receipts that carry no items", () => {
  test("an empty item array is COUNTED, not silently dropped", () => {
    // This is the shape the SessionStart meter writes when the injection
    // loader degraded to its last-good cache: a real receipt with
    // nothing to attribute. It inflates receipt_count and contributes
    // nothing to item_total, and no counter used to name it.
    seed("2026-06-01T10:00:00Z", "s1", [{ id: "pref-a", tokens: 5 }]);
    seed("2026-06-01T10:01:00Z", "s1", []);
    const summary = summarizeContextReceiptSession(vault, { sessionId: "s1" });
    if (!summary.recorded) throw new Error("expected receipts");
    expect(summary.receipt_count).toBe(2);
    expect(summary.item_total).toBe(1);
    expect(summary.empty_receipts).toBe(1);
    expect(summary.malformed_receipts).toBe(0);
  });

  test("a receipt with no item array at all is counted separately", () => {
    seed("2026-06-01T10:00:00Z", "s1", [{ id: "pref-a", tokens: 5 }]);
    appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-06-01T10:02:00Z",
      sourceRefs: [],
      payload: { host: "unit-test", trigger: "context_pack", session_id: "s1", item_count: 0 },
    });
    const summary = summarizeContextReceiptSession(vault, { sessionId: "s1" });
    if (!summary.recorded) throw new Error("expected receipts");
    expect(summary.receipt_count).toBe(2);
    expect(summary.malformed_receipts).toBe(1);
    expect(summary.empty_receipts).toBe(0);
  });
});

describe("summarizeContextReceiptSession — window bounds are validated", () => {
  test("an uncomparable `since` is REFUSED, not reported as 'nothing happened'", () => {
    seed("2026-06-01T10:00:00Z", "s1", [{ id: "pref-a", tokens: 5 }]);
    // "yesterday" sorts after every 2026-… timestamp, so the lexical
    // filter emptied the window and the fold answered `recorded: false`
    // - "nothing was recorded for this filter" for malformed input.
    expect(() => summarizeContextReceiptSession(vault, { since: "yesterday" })).toThrow(
      ContextReceiptWindowError,
    );
  });

  test("a non-UTC offset and an impossible date are refused too", () => {
    expect(() =>
      summarizeContextReceiptSession(vault, { until: "2026-06-01T10:00:00+03:00" }),
    ).toThrow(ContextReceiptWindowError);
    expect(() => summarizeContextReceiptSession(vault, { since: "2026-02-30T00:00:00Z" })).toThrow(
      ContextReceiptWindowError,
    );
  });

  test("the canonical forms already in use still pass", () => {
    seed("2026-06-06T10:00:00Z", "s1", [{ id: "pref-a", tokens: 5 }]);
    expect(
      summarizeContextReceiptSession(vault, {
        since: "2026-06-05T00:00:00Z",
        until: "2026-06-07T00:00:00.000Z",
      }).recorded,
    ).toBe(true);
  });
});

describe("observedReuseRates filtering", () => {
  test("a session filter narrows the lifetime fold", () => {
    emitObservedUse(vault, {
      createdAt: "2026-06-01T10:00:00Z",
      host: "unit-test",
      sessionId: "s1",
      entries: [{ id: "pref-a", verdict: "USED" }],
    });
    emitObservedUse(vault, {
      createdAt: "2026-06-01T11:00:00Z",
      host: "unit-test",
      sessionId: "s2",
      entries: [{ id: "pref-a", verdict: "IGNORED" }],
    });

    expect(observedReuseRates(vault).get("pref-a")!.total).toBe(2);
    const scoped = observedReuseRates(vault, { sessionId: "s1" });
    expect(scoped.get("pref-a")!.total).toBe(1);
    expect(scoped.get("pref-a")!.used).toBe(1);
  });

  test("a time window narrows the lifetime fold", () => {
    emitObservedUse(vault, {
      createdAt: "2026-06-01T10:00:00Z",
      host: "unit-test",
      entries: [{ id: "pref-a", verdict: "USED" }],
    });
    emitObservedUse(vault, {
      createdAt: "2026-06-09T10:00:00Z",
      host: "unit-test",
      entries: [{ id: "pref-a", verdict: "CONTRADICTED" }],
    });
    const scoped = observedReuseRates(vault, { since: "2026-06-05T00:00:00Z" });
    expect(scoped.get("pref-a")!.contradicted).toBe(1);
    expect(scoped.get("pref-a")!.total).toBe(1);
  });
});

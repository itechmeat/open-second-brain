import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DECISION_CHANGE_SCHEMA_VERSION,
  ReceiptError,
  appendDecisionChangeReceipt,
  normalizeDecisionSubject,
  queryDecisionChangeHistory,
  readDecisionChangeReceipts,
} from "../../../../src/core/brain/decisions/receipts.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-receipts-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-07-18T12:00:00Z",
    subject: "pref-no-abbrev",
    before: "confidence:medium(0.55)",
    after: "confidence:high(0.88)",
    evidenceTriggers: ["[[sig-2026-07-01-x]]"],
    confidenceDelta: 0.33,
    alternatives: ["keep as medium"],
    actor: "tester",
    rationale: "accumulated applied evidence",
    reasonCode: "confidence-refresh",
    ...overrides,
  };
}

describe("appendDecisionChangeReceipt", () => {
  test("appends a decision_change.v1 receipt with all accountable fields", () => {
    const res = appendDecisionChangeReceipt(vault, baseInput());
    expect(res.appended).toBe(true);
    expect(res.receipt.v).toBe(DECISION_CHANGE_SCHEMA_VERSION);
    expect(res.receipt.subject).toBe("pref-no-abbrev");
    expect(res.receipt.confidence_delta).toBe(0.33);
    expect(res.receipt.reason_code).toBe("confidence-refresh");
    expect(res.receipt.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("replays are no-ops via the durable idempotency key", () => {
    const first = appendDecisionChangeReceipt(vault, baseInput());
    const second = appendDecisionChangeReceipt(vault, baseInput());
    expect(second.appended).toBe(false);
    expect(second.receipt.idempotency_key).toBe(first.receipt.idempotency_key);
    expect(readDecisionChangeReceipts(vault).receipts.length).toBe(1);
  });

  test("a different before/after produces a distinct key and a new receipt", () => {
    appendDecisionChangeReceipt(vault, baseInput());
    appendDecisionChangeReceipt(vault, baseInput({ after: "confidence:high(0.90)" }));
    expect(readDecisionChangeReceipts(vault).receipts.length).toBe(2);
  });

  test("rejects unexpected free-text reasoning fields", () => {
    expect(() =>
      appendDecisionChangeReceipt(vault, baseInput({ chain_of_thought: "secret reasoning" })),
    ).toThrow(ReceiptError);
  });

  test("rejects a missing required field", () => {
    const input = baseInput();
    delete (input as Record<string, unknown>)["subject"];
    expect(() => appendDecisionChangeReceipt(vault, input)).toThrow(ReceiptError);
  });
});

describe("queryDecisionChangeHistory", () => {
  function seed(n: number): void {
    for (let i = 0; i < n; i++) {
      appendDecisionChangeReceipt(
        vault,
        baseInput({
          ts: `2026-07-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
          after: `confidence:high(0.${80 + i})`,
        }),
      );
    }
  }

  test("paginates with an opaque cursor and reports exact counts", () => {
    seed(5);
    const page1 = queryDecisionChangeHistory(vault, { limit: 2 });
    expect(page1.total).toBe(5);
    expect(page1.receipts.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = queryDecisionChangeHistory(vault, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.receipts.length).toBe(2);
    const page3 = queryDecisionChangeHistory(vault, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.receipts.length).toBe(1);
    expect(page3.nextCursor).toBeNull();

    // No overlap across pages.
    const keys = new Set(
      [...page1.receipts, ...page2.receipts, ...page3.receipts].map((r) => r.idempotency_key),
    );
    expect(keys.size).toBe(5);
  });

  test("filters by subject", () => {
    appendDecisionChangeReceipt(vault, baseInput({ subject: "pref-a" }));
    appendDecisionChangeReceipt(vault, baseInput({ subject: "pref-b" }));
    const page = queryDecisionChangeHistory(vault, { subject: "pref-a" });
    expect(page.total).toBe(1);
    expect(page.receipts[0]!.subject).toBe("pref-a");
  });

  test("a malformed cursor is rejected", () => {
    seed(1);
    expect(() => queryDecisionChangeHistory(vault, { cursor: "!!!not-base64!!!" })).toThrow(
      ReceiptError,
    );
  });
});

describe("lifecycle hook", () => {
  test("tombstone/supersede emits one decision-change receipt", async () => {
    const { writeFrontmatter } = await import("../../../../src/core/vault.ts");
    const { supersede } = await import("../../../../src/core/brain/lifecycle/tombstone.ts");
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFrontmatter(
      join(vault, "Brain", "preferences", "pref-old.md"),
      {
        kind: "brain-preference",
        id: "pref-old",
        _status: "confirmed",
        topic: "t",
        principle: "p",
      },
      "body",
    );
    supersede({
      vault,
      predecessor: "Brain/preferences/pref-old.md",
      successor: "pref-new",
      agent: "tester",
    });
    const { receipts } = readDecisionChangeReceipts(vault);
    expect(receipts.length).toBe(1);
    expect(receipts[0]!.reason_code).toBe("supersede");
    expect(receipts[0]!.after).toContain("superseded_by");
  });
});

describe("normalizeDecisionSubject", () => {
  test("bare id is unchanged", () => {
    expect(normalizeDecisionSubject("decision-adopt-bun")).toBe("decision-adopt-bun");
  });

  test("strips wikilink fencing", () => {
    expect(normalizeDecisionSubject("[[decision-adopt-bun]]")).toBe("decision-adopt-bun");
  });

  test("strips a vault-relative directory prefix and .md extension", () => {
    expect(normalizeDecisionSubject("Brain/decisions/decision-adopt-bun.md")).toBe(
      "decision-adopt-bun",
    );
  });

  test("mixed form (wikilinked path) reduces to the same bare id", () => {
    expect(normalizeDecisionSubject("[[Brain/decisions/decision-adopt-bun.md]]")).toBe(
      "decision-adopt-bun",
    );
  });

  test("distinct subjects stay distinct after normalization", () => {
    expect(normalizeDecisionSubject("decision-adopt-bun")).not.toBe(
      normalizeDecisionSubject("decision-adopt-deno"),
    );
  });
});

describe("queryDecisionChangeHistory subject matching (bare/wikilink/path forms)", () => {
  test("a bare-path-stored subject (lifecycle receipt) matches a bare id query", () => {
    appendDecisionChangeReceipt(
      vault,
      baseInput({ subject: "Brain/decisions/decision-adopt-bun.md" }),
    );
    const page = queryDecisionChangeHistory(vault, { subject: "decision-adopt-bun" });
    expect(page.total).toBe(1);
  });

  test("a bare-path-stored subject matches a wikilinked query", () => {
    appendDecisionChangeReceipt(
      vault,
      baseInput({ subject: "Brain/decisions/decision-adopt-bun.md" }),
    );
    const page = queryDecisionChangeHistory(vault, { subject: "[[decision-adopt-bun]]" });
    expect(page.total).toBe(1);
  });

  test("a wikilink-stored subject (decision record receipt) matches a bare id query", () => {
    appendDecisionChangeReceipt(vault, baseInput({ subject: "[[decision-adopt-bun]]" }));
    const page = queryDecisionChangeHistory(vault, { subject: "decision-adopt-bun" });
    expect(page.total).toBe(1);
  });

  test("--subject bare id and --subject wikilink return identical results", () => {
    appendDecisionChangeReceipt(vault, baseInput({ subject: "[[decision-adopt-bun]]" }));
    appendDecisionChangeReceipt(
      vault,
      baseInput({ subject: "[[decision-adopt-bun]]", after: "confidence:high(0.91)" }),
    );
    const byBareId = queryDecisionChangeHistory(vault, { subject: "decision-adopt-bun" });
    const byWikilink = queryDecisionChangeHistory(vault, { subject: "[[decision-adopt-bun]]" });
    expect(byBareId.total).toBe(2);
    expect(byWikilink.total).toBe(2);
    expect(byBareId.receipts.map((r) => r.idempotency_key)).toEqual(
      byWikilink.receipts.map((r) => r.idempotency_key),
    );
  });

  test("distinct subjects remain distinct: no cross-match", () => {
    appendDecisionChangeReceipt(vault, baseInput({ subject: "[[decision-adopt-bun]]" }));
    appendDecisionChangeReceipt(vault, baseInput({ subject: "[[decision-adopt-deno]]" }));
    const page = queryDecisionChangeHistory(vault, { subject: "decision-adopt-bun" });
    expect(page.total).toBe(1);
    expect(page.receipts[0]!.subject).toBe("[[decision-adopt-bun]]");
  });
});

describe("no receipt on reads", () => {
  test("reading history never creates a receipt file", () => {
    readDecisionChangeReceipts(vault);
    queryDecisionChangeHistory(vault, {});
    const truthDir = join(vault, "Brain", "truth");
    const files = existsSync(truthDir) ? readdirSync(truthDir) : [];
    expect(files.filter((f) => f.startsWith("decision-change")).length).toBe(0);
  });
});

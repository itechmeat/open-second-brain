/**
 * Read-only claim-to-provenance join (answer-trust, task B3): a claim's
 * optional `sample_id` resolves to the context receipt it names and the
 * outcome row posted against that sample. Omit-don't-invent governs
 * every half - a missing side is null, never fabricated - and a claim
 * timestamped before its claimed receipt carries an inversion flag
 * instead of being silently joined.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextPackOutcome } from "../../../../src/core/brain/context-pack-outcome.ts";
import {
  emitContextReceipt,
  listContextReceipts,
} from "../../../../src/core/brain/context-receipts.ts";
import {
  appendContinuityRecord,
  continuityLogPath,
} from "../../../../src/core/brain/continuity/store.ts";
import type { ContinuityRecord } from "../../../../src/core/brain/continuity/types.ts";
import {
  resolveClaimProvenanceFromIndex,
  resolveClaimProvenance,
  loadClaimProvenanceIndex,
} from "../../../../src/core/brain/truth/claim-provenance.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-claim-prov-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const RECEIPT_CREATED = "2026-06-02T09:00:00.000Z";
const CLAIM_TS_AFTER = "2026-06-02T10:00:00Z";

function emitSampleReceipt(): ContinuityRecord {
  return emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "context_pack", createdAt: RECEIPT_CREATED },
    items: [
      { id: "note-alpha", path: "Brain/notes/alpha.md", tokens: 40, trimmed: false },
      { id: "note-beta", path: "Brain/notes/beta.md", tokens: 20, trimmed: true },
    ],
    finalText: "the final answer text",
  });
}

describe("resolveClaimProvenance", () => {
  test("resolves a receipt-backed sample id to receipt items and both verdicts", () => {
    const receipt = emitSampleReceipt();
    emitContextPackOutcome(
      vault,
      {
        createdAt: "2026-06-03T09:00:00.000Z",
        host: "mcp",
        sampleId: receipt.id,
        firstPassSuccess: true,
        evidenceClaim: { itemCount: 2 },
      },
      true,
    );
    const provenance = resolveClaimProvenance(vault, receipt.id, CLAIM_TS_AFTER);
    expect(provenance.sample_id).toBe(receipt.id);
    expect(provenance.receipt).not.toBeNull();
    expect(provenance.receipt!.id).toBe(receipt.id);
    expect(provenance.receipt!.created_at).toBe(RECEIPT_CREATED);
    expect(provenance.receipt!.trigger).toBe("context_pack");
    expect(provenance.receipt!.withheld).toBe(false);
    expect(provenance.receipt!.items).toEqual([
      { id: "note-alpha", path: "Brain/notes/alpha.md", trimmed: false },
      { id: "note-beta", path: "Brain/notes/beta.md", trimmed: true },
    ]);
    expect(provenance.outcome).not.toBeNull();
    expect(provenance.outcome!.first_pass_success).toBe(true);
    expect(provenance.outcome!.evidence_verdict).toBe("match");
    expect(provenance.timestamp_inverted).toBe(false);
  });

  test("a sample id with a receipt but no outcome row is receipt known, outcome unknown", () => {
    // Absent, never invented: the outcome half stays null and no verdict
    // is fabricated for the caller.
    const receipt = emitSampleReceipt();
    const provenance = resolveClaimProvenance(vault, receipt.id, CLAIM_TS_AFTER);
    expect(provenance.receipt).not.toBeNull();
    expect(provenance.outcome).toBeNull();
    expect(provenance.timestamp_inverted).toBe(false);
  });

  test("an outcome-only sample id (opaque request hash) resolves the outcome without a receipt", () => {
    emitContextPackOutcome(
      vault,
      {
        createdAt: "2026-06-03T09:00:00.000Z",
        sampleId: "req-hash:0123456789abcdef",
        firstPassSuccess: false,
        repairRequired: true,
      },
      true,
    );
    const provenance = resolveClaimProvenance(vault, "req-hash:0123456789abcdef", CLAIM_TS_AFTER);
    expect(provenance.receipt).toBeNull();
    expect(provenance.outcome).not.toBeNull();
    expect(provenance.outcome!.first_pass_success).toBe(false);
    expect(provenance.timestamp_inverted).toBe(false);
  });

  test("an unknown sample id resolves nothing on either side", () => {
    const provenance = resolveClaimProvenance(vault, "rcpt-absent", CLAIM_TS_AFTER);
    expect(provenance.sample_id).toBe("rcpt-absent");
    expect(provenance.receipt).toBeNull();
    expect(provenance.outcome).toBeNull();
    expect(provenance.timestamp_inverted).toBe(false);
  });

  test("a claim timestamped before its claimed receipt carries the inversion flag", () => {
    const receipt = emitSampleReceipt();
    const provenance = resolveClaimProvenance(vault, receipt.id, "2026-06-01T10:00:00Z");
    expect(provenance.receipt).not.toBeNull();
    expect(provenance.timestamp_inverted).toBe(true);
  });

  test("a claim at exactly the receipt's created_at is not inverted", () => {
    // "Predates" is strict: the receipt the claim names existed at the
    // claim's own second.
    const receipt = emitSampleReceipt();
    const provenance = resolveClaimProvenance(vault, receipt.id, RECEIPT_CREATED);
    expect(provenance.timestamp_inverted).toBe(false);
  });

  test("a sub-second claim stamp after its receipt's second is not inverted", () => {
    // The compare is between parsed instants, not strings. Lexically, a
    // millis claim stamp (`...:00.500Z`) sorts before a second-precision
    // receipt stamp (`...:00Z`) - "." < "Z" - so a string compare flags
    // a claim written half a second AFTER its receipt as an inversion.
    // The receipts the continuity boundary stamps at second precision
    // are exactly the shape that hits this.
    const receipt = emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-02T09:00:00Z" },
      items: [{ id: "note-alpha", path: "Brain/notes/alpha.md", tokens: 40 }],
      finalText: "the final answer text",
    });
    const provenance = resolveClaimProvenance(vault, receipt.id, "2026-06-02T09:00:00.500Z");
    expect(provenance.receipt).not.toBeNull();
    expect(provenance.timestamp_inverted).toBe(false);
  });

  test("a sub-second claim stamp before its receipt's second is inverted", () => {
    // The parsed-instant form must not weaken the flag either direction:
    // a claim half a second BEFORE the receipt still predates it.
    const receipt = emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-02T09:00:00Z" },
      items: [{ id: "note-alpha", path: "Brain/notes/alpha.md", tokens: 40 }],
      finalText: "the final answer text",
    });
    const provenance = resolveClaimProvenance(vault, receipt.id, "2026-06-02T08:59:59.500Z");
    expect(provenance.timestamp_inverted).toBe(true);
  });

  test("a private receipt is known but its items are never unfolded", () => {
    // The receipts-fold rule, applied at the join: redacted content must
    // not re-enter the vault through a claim's provenance.
    const record = appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: RECEIPT_CREATED,
      sourceRefs: [],
      private: true,
      payload: {
        host: "mcp",
        trigger: "context_pack",
        item_count: 1,
        items: [{ id: "note-secret", path: "Brain/notes/private.md" }],
        final_text_hash: "abc",
      },
    });
    const provenance = resolveClaimProvenance(vault, record.id, CLAIM_TS_AFTER);
    expect(provenance.receipt).not.toBeNull();
    expect(provenance.receipt!.withheld).toBe(true);
    expect(provenance.receipt!.items).toEqual([]);
    expect(JSON.stringify(provenance)).not.toContain("note-secret");
  });

  test("an excluded receipt renders as the unknown-id answer", () => {
    // The caller's receipt-visibility rule (the receipts list's exclude
    // hook, bound below local reach by the surfaces): a store without
    // the excluded receipt answers "no receipt names this id", so the
    // receipt half renders null - never a marker confirming it exists.
    const receipt = emitSampleReceipt();
    emitContextPackOutcome(
      vault,
      { createdAt: "2026-06-03T09:00:00.000Z", sampleId: receipt.id, firstPassSuccess: true },
      true,
    );
    const provenance = resolveClaimProvenance(vault, receipt.id, CLAIM_TS_AFTER, {
      exclude: (record) => record.id === receipt.id,
    });
    expect(provenance.receipt).toBeNull();
    // The outcome half is the caller's to keep: the exclusion is a
    // receipt-visibility rule, not an outcome one.
    expect(provenance.outcome).not.toBeNull();
    expect(provenance.timestamp_inverted).toBe(false);
  });

  test("items the caller may not see leave the unfolded items", () => {
    // The receipts fold's excludeItem hook shape: a surface binds its
    // reach's item rule and the join drops those items before the
    // answer is built, so provenance never discloses an item the caller
    // could not read directly.
    const receipt = emitSampleReceipt();
    const provenance = resolveClaimProvenance(vault, receipt.id, CLAIM_TS_AFTER, {
      excludeItem: (item) => (item as { id?: unknown })["id"] === "note-alpha",
    });
    expect(provenance.receipt!.items).toEqual([
      { id: "note-beta", path: "Brain/notes/beta.md", trimmed: true },
    ]);
  });

  test("an evidence row that never posted leaves the evidence verdict absent", () => {
    // The outcome row's first-pass verdict is the row's own field; the
    // evidence verdict exists only when its own row exists.
    const receipt = emitSampleReceipt();
    const outcome = emitContextPackOutcome(
      vault,
      { createdAt: "2026-06-03T09:00:00.000Z", sampleId: receipt.id, firstPassSuccess: true },
      true,
    );
    expect(outcome).not.toBeNull();
    const provenance = resolveClaimProvenance(vault, receipt.id, CLAIM_TS_AFTER);
    expect(provenance.outcome).not.toBeNull();
    expect(provenance.outcome!.evidence_verdict).toBe("unclaimed");
  });

  test("an outcome row without a first-pass verdict renders unknown, never false", () => {
    // L2.3 regression: the `=== true` coercion turned a MISSING verdict
    // into `false`, inventing a failed first pass for a row that carried
    // none. The outcome writer validates the boolean, but the reader
    // meets whatever the ledger holds, so unknown renders as null.
    const receipt = emitSampleReceipt();
    appendContinuityRecord(vault, {
      kind: "context_pack_outcome",
      createdAt: "2026-06-03T09:00:00.000Z",
      sourceRefs: [],
      payload: { sample_id: receipt.id },
    });
    const provenance = resolveClaimProvenance(vault, receipt.id, CLAIM_TS_AFTER);
    expect(provenance.outcome).not.toBeNull();
    expect(provenance.outcome!.first_pass_success).toBeNull();
  });

  test("a blank sample id refuses by name", () => {
    // Unreachable through the ledger (the store refuses blank ids at
    // write), refused here too so no caller can read silence as an
    // answer.
    expect(() => resolveClaimProvenance(vault, "   ", CLAIM_TS_AFTER)).toThrow(/sample_id/);
  });

  test("a receipt record with a non-canonical createdAt reads as unknown, not a failed read", () => {
    // M4 regression: the continuity reader validates `createdAt` on
    // append only, so a shard synced from another device or edited by
    // hand can carry a stamp no append would accept. The join degrades
    // PER CLAIM - the claim naming the unreadable receipt answers
    // "receipt unknown", exactly as an absent id would - instead of
    // failing the whole events read for every unrelated claim.
    const receipt = emitSampleReceipt();
    const shard = continuityLogPath(vault, receipt.createdAt.slice(0, 7));
    const text = readFileSync(shard, "utf8");
    const unreadable = { ...receipt, createdAt: "2026-06-garbage" };
    writeFileSync(shard, text.replace(JSON.stringify(receipt), JSON.stringify(unreadable)));
    const provenance = resolveClaimProvenance(vault, receipt.id, CLAIM_TS_AFTER);
    expect(provenance.receipt).toBeNull();
    expect(provenance.outcome).toBeNull();
    expect(provenance.timestamp_inverted).toBe(false);
    // The indexed path (what the events report takes) degrades the same
    // way: the unreadable record never enters the index.
    const index = loadClaimProvenanceIndex(vault);
    expect(index.receiptsByReceiptId.has(receipt.id)).toBe(false);
    expect(resolveClaimProvenanceFromIndex(index, receipt.id, CLAIM_TS_AFTER).receipt).toBeNull();
  });
});

describe("listContextReceipts receiptId filter", () => {
  test("filters to exactly the named receipt", () => {
    emitSampleReceipt();
    const middle = emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-03T09:00:00.000Z" },
      items: [{ id: "note-middle" }],
      finalText: "middle",
    });
    emitSampleReceipt();
    const matched = listContextReceipts(vault, { receiptId: middle.id });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.id).toBe(middle.id);
  });

  test("the receiptId match is applied BEFORE the limit", () => {
    // Pinning the order: a receipt lookup with a page bound answers with
    // the NAMED receipt, never with whichever receipts happen to be
    // newest. The oldest receipt is findable at limit 1. The three
    // fixtures stamp DISTINCT createdAt values on DISTINCT payloads so
    // they derive distinct record ids - byte-identical fixtures would
    // collapse into one id and the pin would pass even for a filter
    // applied after the slice, which returns whichever receipt is
    // newest.
    const oldest = emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-02T09:00:00.000Z" },
      items: [{ id: "note-oldest" }],
      finalText: "oldest",
    });
    emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-02T09:05:00.000Z" },
      items: [{ id: "note-middle" }],
      finalText: "middle",
    });
    emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-02T09:10:00.000Z" },
      items: [{ id: "note-newest" }],
      finalText: "newest",
    });
    const matched = listContextReceipts(vault, { receiptId: oldest.id, limit: 1 });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.id).toBe(oldest.id);
  });

  test("an unknown receipt id answers empty", () => {
    emitSampleReceipt();
    expect(listContextReceipts(vault, { receiptId: "rcpt-absent" })).toHaveLength(0);
  });
});

describe("loadClaimProvenanceIndex + resolveClaimProvenanceFromIndex", () => {
  test("resolves every sample id exactly as the single-call join does", () => {
    const first = emitSampleReceipt();
    const second = emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "pre_compress", createdAt: "2026-06-02T11:00:00.000Z" },
      items: [{ id: "note-gamma", path: "Brain/notes/gamma.md", trimmed: false }],
      finalText: "gamma text",
    });
    emitContextPackOutcome(
      vault,
      {
        createdAt: "2026-06-03T09:00:00.000Z",
        sampleId: first.id,
        firstPassSuccess: true,
        evidenceClaim: { itemCount: 2 },
      },
      true,
    );
    const index = loadClaimProvenanceIndex(vault);
    for (const id of [first.id, second.id, "rcpt-absent"]) {
      expect(resolveClaimProvenanceFromIndex(index, id, CLAIM_TS_AFTER)).toEqual(
        resolveClaimProvenance(vault, id, CLAIM_TS_AFTER),
      );
    }
  });

  test("keeps the newest record per sample id when a ledger holds duplicates", () => {
    // The filtered list functions answer newest-first, so the NEWEST
    // row under a key is the answer; an index that let an older row win
    // would resolve a different join than the single call.
    emitContextPackOutcome(
      vault,
      {
        createdAt: "2026-06-02T09:00:00.000Z",
        sampleId: "req-hash:duplicate",
        firstPassSuccess: true,
      },
      true,
    );
    emitContextPackOutcome(
      vault,
      {
        createdAt: "2026-06-03T09:00:00.000Z",
        sampleId: "req-hash:duplicate",
        firstPassSuccess: false,
      },
      true,
    );
    const index = loadClaimProvenanceIndex(vault);
    expect(
      resolveClaimProvenanceFromIndex(index, "req-hash:duplicate", CLAIM_TS_AFTER).outcome!
        .first_pass_success,
    ).toBe(false);
    expect(
      resolveClaimProvenance(vault, "req-hash:duplicate", CLAIM_TS_AFTER).outcome!
        .first_pass_success,
    ).toBe(false);
  });

  test("carries the caller's exclusion hooks to the indexed resolution", () => {
    const receipt = emitSampleReceipt();
    const index = loadClaimProvenanceIndex(vault);
    const provenance = resolveClaimProvenanceFromIndex(index, receipt.id, CLAIM_TS_AFTER, {
      exclude: (record) => record.id === receipt.id,
      excludeItem: (item) => (item as { id?: unknown })["id"] === "note-beta",
    });
    expect(provenance.receipt).toBeNull();
  });
});

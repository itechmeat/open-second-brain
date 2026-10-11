/**
 * One-read-per-ledger provenance hydration (answer-trust repair M3).
 *
 * The events operation hydrates provenance for every sampled claim on
 * its page. Resolving each claim through its own ledger reads would
 * cost three full-ledger scans per claim - remotely triggerable at the
 * page cap - so the report builds one index per ledger and resolves
 * every claim from it. This suite pins the READ COUNT, not just the
 * answer shape: the three ledger readers are wrapped in forwarding
 * module mocks that count calls (the open-store precedent), and a full
 * page of sampled claims must answer from exactly ONE read of each
 * ledger. A page with no sampled claims reads none at all.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendClaimEvent } from "../../../../src/core/brain/truth/store.ts";
import { TRANSPORT_REACH } from "../../../../src/core/graph/transport-reach.ts";
import { claimEventsReport } from "../../../../src/mcp/brain/knowledge-tools.ts";

// The counters live beside forwarding mocks installed over the three
// ledger-reader modules. Captured before the mock is installed, or the
// forward would recurse; inert (byte-transparent forwards) unless this
// file's test turns counting on, so the mocks never answer differently
// for any other test file sharing the process.
import * as receiptsModule from "../../../../src/core/brain/context-receipts.ts";
import * as outcomesModule from "../../../../src/core/brain/context-pack-outcome.ts";
import * as evidenceModule from "../../../../src/core/brain/context-pack-evidence.ts";

const realListContextReceipts = receiptsModule.listContextReceipts;
const realListContextPackOutcomes = outcomesModule.listContextPackOutcomes;
const realListContextPackEvidence = evidenceModule.listContextPackEvidence;

let receiptReads = 0;
let outcomeReads = 0;
let evidenceReads = 0;
let counting = false;

mock.module("../../../../src/core/brain/context-receipts.ts", () => ({
  ...receiptsModule,
  listContextReceipts: (
    ...args: Parameters<typeof realListContextReceipts>
  ): ReturnType<typeof realListContextReceipts> => {
    if (counting) receiptReads += 1;
    return realListContextReceipts(...args);
  },
}));

mock.module("../../../../src/core/brain/context-pack-outcome.ts", () => ({
  ...outcomesModule,
  listContextPackOutcomes: (
    ...args: Parameters<typeof realListContextPackOutcomes>
  ): ReturnType<typeof realListContextPackOutcomes> => {
    if (counting) outcomeReads += 1;
    return realListContextPackOutcomes(...args);
  },
}));

mock.module("../../../../src/core/brain/context-pack-evidence.ts", () => ({
  ...evidenceModule,
  listContextPackEvidence: (
    ...args: Parameters<typeof realListContextPackEvidence>
  ): ReturnType<typeof realListContextPackEvidence> => {
    if (counting) evidenceReads += 1;
    return realListContextPackEvidence(...args);
  },
}));

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-claim-prov-scans-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  receiptReads = 0;
  outcomeReads = 0;
  evidenceReads = 0;
  counting = false;
});

afterEach(() => {
  counting = false;
  rmSync(tmp, { recursive: true, force: true });
});

/** One receipt plus one claim stated against it, times `count`. */
function seedSampledClaims(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const stamp = `2026-06-0${(i % 8) + 1}T09:00:00.000Z`;
    const receipt = receiptsModule.emitContextReceipt(vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: stamp },
      items: [{ id: `note-${i}`, path: `Brain/notes/note-${i}.md`, tokens: 40 }],
      finalText: `the final answer text ${i}`,
    });
    appendClaimEvent(vault, {
      ts: `2026-06-0${(i % 8) + 1}T10:00:00Z`,
      agent: "claude",
      entity: `Entity ${i}`,
      aspect: "employer",
      value: "Google",
      source: "[[Brain/notes/note-0.md]]",
      sample_id: receipt.id,
    });
  }
}

describe("provenance hydration reads each ledger once per report", () => {
  test("a full page of sampled claims answers from one read per ledger", () => {
    seedSampledClaims(5);
    counting = true;
    const body = claimEventsReport(vault, undefined, TRANSPORT_REACH.local, {
      sinceMs: null,
      untilMs: null,
      limit: 200,
    });
    counting = false;
    // The hydration is real - every sampled row carries its receipt -
    // so the count pins below are about a working join, not a skipped
    // one.
    const events = body["events"] as ReadonlyArray<{
      provenance?: { receipt?: { id?: string } | null };
    }>;
    expect(events).toHaveLength(5);
    for (const event of events) {
      expect(event.provenance!.receipt!.id).toBeTruthy();
    }
    // One read per ledger for the WHOLE page - not three reads per
    // claim, which at the page cap is three thousand full-ledger scans
    // per call.
    expect(receiptReads).toBe(1);
    expect(outcomeReads).toBe(1);
    expect(evidenceReads).toBe(1);
  });

  test("a page with no sampled claims reads none of the ledgers", () => {
    appendClaimEvent(vault, {
      ts: "2026-06-01T10:00:00Z",
      agent: "claude",
      entity: "Entity 0",
      aspect: "employer",
      value: "Google",
      source: "[[Brain/notes/note-0.md]]",
    });
    counting = true;
    const body = claimEventsReport(vault, undefined, TRANSPORT_REACH.local, {
      sinceMs: null,
      untilMs: null,
      limit: 200,
    });
    counting = false;
    expect(body["total"]).toBe(1);
    expect(receiptReads + outcomeReads + evidenceReads).toBe(0);
  });
});

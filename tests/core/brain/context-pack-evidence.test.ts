import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextReceipt } from "../../../src/core/brain/context-receipts.ts";
import {
  CONTEXT_PACK_EVIDENCE_BASIS,
  CONTEXT_PACK_EVIDENCE_FIELD,
  CONTEXT_PACK_EVIDENCE_UNRESOLVED,
  CONTEXT_PACK_EVIDENCE_VERDICT,
  judgeContextPackEvidence,
  listContextPackEvidence,
  resolveContextPackEvidence,
} from "../../../src/core/brain/context-pack-evidence.ts";
import {
  emitContextPackOutcome,
  listContextPackOutcomes,
  postContextPackOutcome,
} from "../../../src/core/brain/context-pack-outcome.ts";
import { listTokenImpactOutcomes } from "../../../src/core/brain/token-impact.ts";
import { CONTINUITY_AGENT_ID_KEY } from "../../../src/core/brain/continuity/types.ts";

let tmp: string;
let vault: string;

/** Pack text whose digest the receipt records; the tests never re-hash it. */
const PACKED_TEXT = "preference one\npreference two\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ctx-evidence-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write one real `context_receipt` and hand back its durable id + payload. */
function seedReceipt(): { sampleId: string; finalTextHash: string; itemCount: number } {
  const record = emitContextReceipt(vault, {
    options: { host: "test", trigger: "context_pack", createdAt: "2026-07-01T00:00:00.000Z" },
    items: [
      { id: "pref-a", path: "Brain/preferences/pref-a.md", text: "preference one" },
      { id: "pref-b", path: "Brain/preferences/pref-b.md", text: "preference two" },
    ],
    finalText: PACKED_TEXT,
  });
  return {
    sampleId: record.id,
    finalTextHash: record.payload["final_text_hash"] as string,
    itemCount: record.payload["item_count"] as number,
  };
}

/** Make the continuity log unreadable: the directory is replaced by a file. */
function breakContinuityLog(): void {
  const dir = join(vault, "Brain", "log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "continuity"), "not a directory\n", "utf8");
}

describe("resolveContextPackEvidence reads the sample's receipt back from disk", () => {
  test("a sample backed by a receipt resolves to the digest the kernel recorded", () => {
    const seeded = seedReceipt();
    const evidence = resolveContextPackEvidence(vault, seeded.sampleId);
    expect(evidence.resolved).toBe(true);
    if (!evidence.resolved) return;
    expect(evidence.basis).toBe(CONTEXT_PACK_EVIDENCE_BASIS.contextReceipt);
    expect(evidence.tokens[CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash]).toBe(seeded.finalTextHash);
    expect(evidence.tokens[CONTEXT_PACK_EVIDENCE_FIELD.itemCount]).toBe(String(seeded.itemCount));
    expect(evidence.tokens[CONTEXT_PACK_EVIDENCE_FIELD.finalTextChars]).toBe(
      String([...PACKED_TEXT].length),
    );
  });

  test("absence and inability-to-read are DIFFERENT answers", () => {
    const absent = resolveContextPackEvidence(vault, "ctn_nothing_here");
    expect(absent.resolved).toBe(false);
    if (absent.resolved) return;
    expect(absent.reason).toBe(CONTEXT_PACK_EVIDENCE_UNRESOLVED.sampleAbsent);

    breakContinuityLog();
    const unreadable = resolveContextPackEvidence(vault, "ctn_nothing_here");
    expect(unreadable.resolved).toBe(false);
    if (unreadable.resolved) return;
    expect(unreadable.reason).toBe(CONTEXT_PACK_EVIDENCE_UNRESOLVED.evidenceUnreadable);
    expect(unreadable.reason).not.toBe(absent.reason);
  });
});

describe("judgeContextPackEvidence compares only what the agent asserted", () => {
  test("an agreeing claim is a match", () => {
    const seeded = seedReceipt();
    const verdict = judgeContextPackEvidence(resolveContextPackEvidence(vault, seeded.sampleId), {
      finalTextHash: seeded.finalTextHash,
      itemCount: seeded.itemCount,
    });
    expect(verdict.verdict).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.match);
    expect(verdict.mismatches).toHaveLength(0);
  });

  test("a contradicted claim is a mismatch naming the field, not a rejection", () => {
    const seeded = seedReceipt();
    const verdict = judgeContextPackEvidence(resolveContextPackEvidence(vault, seeded.sampleId), {
      itemCount: 99,
    });
    expect(verdict.verdict).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.mismatch);
    expect(verdict.mismatches).toHaveLength(1);
    expect(verdict.mismatches[0]).toEqual({
      field: CONTEXT_PACK_EVIDENCE_FIELD.itemCount,
      expected: "99",
      actual: String(seeded.itemCount),
    });
  });

  test("no claim is `unclaimed`, never a silent match", () => {
    const seeded = seedReceipt();
    const evidence = resolveContextPackEvidence(vault, seeded.sampleId);
    expect(judgeContextPackEvidence(evidence).verdict).toBe(
      CONTEXT_PACK_EVIDENCE_VERDICT.unclaimed,
    );
    expect(judgeContextPackEvidence(evidence, {}).verdict).toBe(
      CONTEXT_PACK_EVIDENCE_VERDICT.unclaimed,
    );
  });

  test("evidence the kernel could not obtain is `unresolved`, not a match", () => {
    const verdict = judgeContextPackEvidence(resolveContextPackEvidence(vault, "ctn_absent"), {
      itemCount: 1,
    });
    expect(verdict.verdict).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.unresolved);
    expect(verdict.mismatches).toHaveLength(0);
  });
});

describe("posting an outcome also records the kernel-evidence entry", () => {
  test("the second record joins the outcome on the SAME sample id", () => {
    const seeded = seedReceipt();
    const post = postContextPackOutcome(
      vault,
      { sampleId: seeded.sampleId, firstPassSuccess: true },
      true,
    );
    expect(post).not.toBeNull();
    expect(post!.evidence).not.toBeNull();
    expect(post!.evidence!.kind).toBe("context_pack_evidence");
    // one sample id joins all three ledger rows
    expect(post!.outcome.payload["sample_id"]).toBe(seeded.sampleId);
    expect(post!.evidence!.payload["sample_id"]).toBe(seeded.sampleId);
    expect(listTokenImpactOutcomes(vault)[0]!.payload["pack_id"]).toBe(seeded.sampleId);
  });

  test("the evidence record carries the digest the kernel read from disk", () => {
    const seeded = seedReceipt();
    const post = postContextPackOutcome(
      vault,
      { sampleId: seeded.sampleId, firstPassSuccess: true },
      true,
    );
    const payload = post!.evidence!.payload;
    expect(payload["evidence_basis"]).toBe(CONTEXT_PACK_EVIDENCE_BASIS.contextReceipt);
    expect(payload["kernel_evidence"]).toMatchObject({
      [CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash]: seeded.finalTextHash,
      [CONTEXT_PACK_EVIDENCE_FIELD.itemCount]: String(seeded.itemCount),
    });
    expect(payload["verdict"]).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.unclaimed);
  });

  test("a claim CONTRADICTED by the recomputation is recorded, not rejected or corrected", () => {
    const seeded = seedReceipt();
    const post = postContextPackOutcome(
      vault,
      {
        sampleId: seeded.sampleId,
        firstPassSuccess: true,
        evidenceClaim: { finalTextHash: "0".repeat(64), itemCount: 99 },
      },
      true,
    );
    // the outcome row still landed, unchanged
    expect(listContextPackOutcomes(vault)).toHaveLength(1);
    expect(post!.outcome.payload["first_pass_success"]).toBe(true);
    // and the disagreement is on the record, in full
    const payload = post!.evidence!.payload;
    expect(payload["verdict"]).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.mismatch);
    expect(payload["agent_claim"]).toMatchObject({
      [CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash]: "0".repeat(64),
      [CONTEXT_PACK_EVIDENCE_FIELD.itemCount]: "99",
    });
    expect(payload["kernel_evidence"]).toMatchObject({
      [CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash]: seeded.finalTextHash,
    });
    const mismatches = payload["mismatches"] as ReadonlyArray<Record<string, unknown>>;
    expect(mismatches.map((entry) => entry["field"]).toSorted()).toEqual([
      CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash,
      CONTEXT_PACK_EVIDENCE_FIELD.itemCount,
    ]);
  });

  test("a sample with no receipt on disk records the absence, and the outcome still lands", () => {
    const post = postContextPackOutcome(
      vault,
      { sampleId: "opaque_request_hash", firstPassSuccess: false, repairRequired: true },
      true,
    );
    expect(post!.outcome.payload["sample_id"]).toBe("opaque_request_hash");
    const payload = post!.evidence!.payload;
    expect(payload["verdict"]).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.unresolved);
    expect(payload["unresolved_reason"]).toBe(CONTEXT_PACK_EVIDENCE_UNRESOLVED.sampleAbsent);
    expect("kernel_evidence" in payload).toBe(false);
  });
});

describe("the evidence record names a claimant, never a verifier", () => {
  test("no verifier-identity field, and no wording asserting a second actor", () => {
    const seeded = seedReceipt();
    const post = postContextPackOutcome(
      vault,
      {
        sampleId: seeded.sampleId,
        firstPassSuccess: true,
        agentId: "claude-dev-agent",
        evidenceClaim: { itemCount: seeded.itemCount },
      },
      true,
    );
    const payload = post!.evidence!.payload;
    for (const key of ["verifier_id", "verifier", "witness", "witnessed_by", "attested_by"]) {
      expect(key in payload).toBe(false);
    }
    // the only actor named is the ACTING agent, and it is labelled as such
    expect(payload[CONTINUITY_AGENT_ID_KEY]).toBe("claude-dev-agent");
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain("independent");
    expect(serialized).not.toContain("witness");
  });
});

describe("the ledger stays gated, fail-open and byte-identical when unused", () => {
  test("gate off writes neither an outcome nor an evidence record", () => {
    const seeded = seedReceipt();
    expect(
      postContextPackOutcome(vault, { sampleId: seeded.sampleId, firstPassSuccess: true }, false),
    ).toBeNull();
    expect(listContextPackEvidence(vault)).toHaveLength(0);
  });

  test("a blank sample id fails open and writes no evidence record", () => {
    expect(emitContextPackOutcome(vault, { sampleId: "   ", firstPassSuccess: true }, true)).toBe(
      null,
    );
    expect(listContextPackEvidence(vault)).toHaveLength(0);
  });

  test("an outcome posted without an actor omits agent_id rather than inventing one", () => {
    const post = postContextPackOutcome(vault, { sampleId: "s1", firstPassSuccess: true }, true);
    expect(CONTINUITY_AGENT_ID_KEY in post!.outcome.payload).toBe(false);
    expect(CONTINUITY_AGENT_ID_KEY in post!.evidence!.payload).toBe(false);
  });

  test("emitContextPackOutcome keeps returning the outcome record alone", () => {
    const record = emitContextPackOutcome(vault, { sampleId: "s1", firstPassSuccess: true }, true);
    expect(record!.kind).toBe("context_pack_outcome");
  });
});

describe("the outcome row carries the actor field its sibling already had (I2)", () => {
  test("agent_id lands on the outcome row AND on the calibration sibling", () => {
    postContextPackOutcome(
      vault,
      { sampleId: "s1", firstPassSuccess: true, agentId: "claude-dev-agent" },
      true,
    );
    expect(listContextPackOutcomes(vault)[0]!.payload[CONTINUITY_AGENT_ID_KEY]).toBe(
      "claude-dev-agent",
    );
    expect(listTokenImpactOutcomes(vault)[0]!.payload[CONTINUITY_AGENT_ID_KEY]).toBe(
      "claude-dev-agent",
    );
  });
});

describe("listContextPackEvidence", () => {
  test("returns evidence rows newest-first and filters by sample id", () => {
    postContextPackOutcome(
      vault,
      { createdAt: "2026-07-01T00:00:00.000Z", sampleId: "a", firstPassSuccess: true },
      true,
    );
    postContextPackOutcome(
      vault,
      { createdAt: "2026-07-02T00:00:00.000Z", sampleId: "b", firstPassSuccess: true },
      true,
    );
    expect(listContextPackEvidence(vault).map((r) => r.payload["sample_id"])).toEqual(["b", "a"]);
    expect(listContextPackEvidence(vault, { sampleId: "a" })).toHaveLength(1);
  });
});

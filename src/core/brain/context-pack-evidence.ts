/**
 * Kernel-recomputed evidence beside the acting agent's claim
 * (provenance-at-the-boundary, unit I).
 *
 * The outcome ledger ({@link ./context-pack-outcome.ts}) is entirely
 * self-reported: the agent posts a sample id and its own counters, and
 * nothing on the read side can tell a row describing a real context pack
 * from a row describing one that never existed. This module is the other
 * half of that row - a SECOND continuity record, joined by the same
 * sample id, carrying evidence the kernel derives itself and the verdict
 * of comparing the agent's claim against it.
 *
 * ## What this is, stated exactly
 *
 * The evidence is the `context_receipt` the sample id names, read back
 * from the durable continuity log at post time. Its `final_text_hash` is
 * a SHA-256 the kernel computed over the assembled pack text when the
 * pack was built ({@link emitContextReceipt}); `item_count` and
 * `final_text_chars` are the measurements taken alongside it. The
 * posting call supplies a sample id and nothing else that enters those
 * values, so a claim can be checked against a record the claiming call
 * did not write.
 *
 * ## What this is NOT
 *
 * It is NOT an independent attestation, and no field, verdict or
 * docstring here says otherwise. Agent identity in this system is a
 * string from an environment variable, else a config key, else a
 * literal, with no token, key, signature or channel binding anywhere,
 * and this process wrote the receipt it now reads. A `verifier_id` would
 * be a second name chosen by the same process from the same config in
 * the same session, which is not a second actor. The honest claim is
 * narrow and is the whole claim: THESE ARE THE BYTES ON DISK, and the
 * agent's assertion either agrees with them or does not.
 *
 * ## Disagreement is recorded, never resolved
 *
 * A contradicted claim produces {@link CONTEXT_PACK_EVIDENCE_VERDICT}
 * `mismatch` with the drifted fields listed. The claim is not rejected
 * (the outcome row still lands, unaltered) and it is not silently
 * corrected to match the disk. A ledger that hides disagreement is worse
 * than no ledger.
 *
 * ## Absence is not inability
 *
 * A sample id with no receipt behind it is an ordinary, expected state -
 * the id may be a telemetry id or an opaque request hash. A continuity
 * log that could not be READ is a different answer, and the two carry
 * different {@link CONTEXT_PACK_EVIDENCE_UNRESOLVED} tokens so a reader
 * can never mistake one for the other.
 *
 * ## No second hashing path
 *
 * Per this wave's architecture amendment, the digest is the one the
 * receipt already carries. Nothing here hashes anything; the comparison
 * runs on `integrity/stamp.ts`'s token vocabulary, which is the shared
 * mechanism for "recorded at write time vs. observed now".
 *
 * Gated + fail-open, like every other writer on this ledger: with the
 * gate off no payload is built and no write happens, and a throwing
 * write never fails the operation being measured. Appends are the plain
 * unfsynced continuity appends every telemetry writer uses.
 */

import { compareStamps, type StampMismatch, type StampTokens } from "../integrity/stamp.ts";
import { emitGatedTelemetry } from "./continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import {
  CONTINUITY_AGENT_ID_KEY,
  CONTINUITY_SESSION_ID_KEY,
  type ContinuityPayload,
  type ContinuityRecord,
} from "./continuity/types.ts";
import { getContextReceipt } from "./context-receipts.ts";

/**
 * The evidence fields, in `integrity/stamp.ts`'s caller-owned naming.
 * Named once here and reused on both sides of every comparison so the
 * claim and the disk reading can never be spelled differently.
 */
export const CONTEXT_PACK_EVIDENCE_FIELD = Object.freeze({
  /** SHA-256 the kernel computed over the assembled pack text. */
  finalTextHash: "final_text_hash",
  /** How many artifacts the pack injected. */
  itemCount: "item_count",
  /** Codepoint length of the assembled pack text. */
  finalTextChars: "final_text_chars",
} as const);

/**
 * What the kernel read the evidence OFF. A registered token rather than
 * free text, so a reader can enumerate the surfaces that can back a
 * sample instead of parsing a sentence.
 */
export const CONTEXT_PACK_EVIDENCE_BASIS = Object.freeze({
  contextReceipt: "context_receipt",
} as const);

export type ContextPackEvidenceBasis =
  (typeof CONTEXT_PACK_EVIDENCE_BASIS)[keyof typeof CONTEXT_PACK_EVIDENCE_BASIS];

/**
 * Why no evidence could be obtained. The two members are deliberately
 * distinct: a sample with nothing behind it is a normal state, an
 * unreadable log is a fault, and collapsing them would report a broken
 * ledger as an empty one.
 */
export const CONTEXT_PACK_EVIDENCE_UNRESOLVED = Object.freeze({
  /** The log was read and holds no receipt with that id. */
  sampleAbsent: "sample_absent",
  /** The log could not be read at all, so nothing is known either way. */
  evidenceUnreadable: "evidence_unreadable",
} as const);

export type ContextPackEvidenceUnresolved =
  (typeof CONTEXT_PACK_EVIDENCE_UNRESOLVED)[keyof typeof CONTEXT_PACK_EVIDENCE_UNRESOLVED];

/** The four states a claim/evidence comparison can be in. Closed. */
export const CONTEXT_PACK_EVIDENCE_VERDICT = Object.freeze({
  /** Every field the agent asserted agrees with the disk. */
  match: "match",
  /** At least one asserted field disagrees. Recorded, never resolved. */
  mismatch: "mismatch",
  /** Evidence was obtained; the agent asserted nothing to compare. */
  unclaimed: "unclaimed",
  /** No evidence was obtained; see the unresolved reason token. */
  unresolved: "unresolved",
} as const);

export type ContextPackEvidenceVerdictToken =
  (typeof CONTEXT_PACK_EVIDENCE_VERDICT)[keyof typeof CONTEXT_PACK_EVIDENCE_VERDICT];

/**
 * What the acting agent asserts about the sample it is reporting on.
 * A closed set of fields - a caller cannot introduce a token name, so
 * the comparison can only ever run over evidence the kernel also has.
 * Every field is optional: an agent asserts what it knows and omits the
 * rest rather than inventing a value to fill the shape.
 */
export interface ContextPackEvidenceClaim {
  readonly finalTextHash?: string;
  readonly itemCount?: number;
  readonly finalTextChars?: number;
}

/** Evidence the kernel obtained for a sample, or the reason it did not. */
export type ContextPackEvidence =
  | {
      readonly resolved: true;
      readonly basis: ContextPackEvidenceBasis;
      readonly tokens: StampTokens;
    }
  | {
      readonly resolved: false;
      readonly reason: ContextPackEvidenceUnresolved;
    };

/** A verdict and the evidence behind it. Mismatches are empty unless `mismatch`. */
export interface ContextPackEvidenceJudgement {
  readonly verdict: ContextPackEvidenceVerdictToken;
  readonly mismatches: ReadonlyArray<StampMismatch>;
}

export interface ContextPackEvidenceInput {
  readonly createdAt?: string;
  readonly host?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  /**
   * The ACTING agent - the one posting the outcome. Self-asserted, like
   * every identity in this system; recorded as the claimant, never as a
   * verifier.
   */
  readonly agentId?: string;
  /** The sample id joining this record to its outcome row. */
  readonly sampleId: string;
  /** What the acting agent asserts about the sample, if anything. */
  readonly claim?: ContextPackEvidenceClaim;
}

export interface ContextPackEvidenceFilter {
  readonly host?: string;
  readonly sampleId?: string;
  readonly verdict?: ContextPackEvidenceVerdictToken;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

/**
 * Read the evidence for `sampleId` off disk.
 *
 * Total by construction: a store read that throws returns the
 * `evidenceUnreadable` token rather than propagating, because this runs
 * inside a telemetry emit that must not fail the operation it measures -
 * and the inability is NAMED in the return value, so no caller can
 * mistake it for "no evidence exists".
 */
export function resolveContextPackEvidence(vault: string, sampleId: string): ContextPackEvidence {
  let receipt: ContinuityRecord | null;
  try {
    receipt = getContextReceipt(vault, sampleId);
  } catch {
    return Object.freeze({
      resolved: false as const,
      reason: CONTEXT_PACK_EVIDENCE_UNRESOLVED.evidenceUnreadable,
    });
  }
  if (receipt === null) {
    return Object.freeze({
      resolved: false as const,
      reason: CONTEXT_PACK_EVIDENCE_UNRESOLVED.sampleAbsent,
    });
  }
  return Object.freeze({
    resolved: true as const,
    basis: CONTEXT_PACK_EVIDENCE_BASIS.contextReceipt,
    tokens: receiptEvidenceTokens(receipt.payload),
  });
}

/**
 * Compare the agent's claim against the evidence.
 *
 * Only the fields the claim ACTUALLY asserts are compared. Asking about
 * a field nobody claimed would report the agent's silence as a
 * disagreement, which is the opposite of what a stamp comparison means:
 * an unasserted field is unrecorded, and two unrecorded sides are not a
 * finding (`integrity/stamp.ts`).
 */
export function judgeContextPackEvidence(
  evidence: ContextPackEvidence,
  claim?: ContextPackEvidenceClaim,
): ContextPackEvidenceJudgement {
  return judgeClaimTokens(evidence, claimTokens(claim));
}

/**
 * The judgement over an already-canonicalised claim. Split out so the
 * writer below can put the same token map on the record AND judge it
 * without canonicalising twice - two canonicalisations of one claim is
 * exactly how a payload and its verdict drift apart.
 */
function judgeClaimTokens(
  evidence: ContextPackEvidence,
  claimed: StampTokens,
): ContextPackEvidenceJudgement {
  if (!evidence.resolved) return frozenJudgement(CONTEXT_PACK_EVIDENCE_VERDICT.unresolved, []);
  const fields = Object.keys(claimed);
  if (fields.length === 0) return frozenJudgement(CONTEXT_PACK_EVIDENCE_VERDICT.unclaimed, []);
  const observed: Record<string, string | null> = {};
  for (const field of fields) observed[field] = evidence.tokens[field] ?? null;
  const mismatches = compareStamps(claimed, Object.freeze(observed));
  return frozenJudgement(
    mismatches.length === 0
      ? CONTEXT_PACK_EVIDENCE_VERDICT.match
      : CONTEXT_PACK_EVIDENCE_VERDICT.mismatch,
    mismatches,
  );
}

/**
 * Append one `context_pack_evidence` record, gated and fail-open.
 *
 * `gate` doubles as the opt-in switch: with `false | null | undefined`
 * no payload is built and no write happens. A throwing build - a blank
 * sample id, a non-finite claimed count - is swallowed and reported as
 * `null`, so the evidence half can never fail the outcome half.
 */
export function recordContextPackEvidence<G>(
  vault: string,
  input: ContextPackEvidenceInput,
  gate: G | false | null | undefined,
): ContinuityRecord | null {
  return emitGatedTelemetry(gate, () => {
    const sampleId = requireSampleId(input.sampleId);
    const evidence = resolveContextPackEvidence(vault, sampleId);
    const claimed = claimTokens(input.claim);
    const judgement = judgeClaimTokens(evidence, claimed);
    const payload: Record<string, unknown> = {
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.sessionId !== undefined ? { [CONTINUITY_SESSION_ID_KEY]: input.sessionId } : {}),
      ...(input.turnId !== undefined ? { turn_id: input.turnId } : {}),
      ...(input.agentId !== undefined ? { [CONTINUITY_AGENT_ID_KEY]: input.agentId } : {}),
      sample_id: sampleId,
      verdict: judgement.verdict,
      // Omit-don't-invent on both sides: a field the receipt never
      // recorded, and a field the agent never asserted, are absent
      // rather than rendered as a null that reads like a measurement.
      ...(evidence.resolved
        ? { evidence_basis: evidence.basis, kernel_evidence: definedTokens(evidence.tokens) }
        : { unresolved_reason: evidence.reason }),
      ...(Object.keys(claimed).length > 0 ? { agent_claim: claimed } : {}),
      ...(judgement.mismatches.length > 0 ? { mismatches: judgement.mismatches } : {}),
    };
    return appendContinuityRecord(vault, {
      kind: "context_pack_evidence",
      createdAt: input.createdAt ?? new Date().toISOString(),
      sourceRefs: [],
      payload,
    });
  });
}

/** List `context_pack_evidence` rows newest-first, after applying filters. */
export function listContextPackEvidence(
  vault: string,
  filter: ContextPackEvidenceFilter = {},
): ReadonlyArray<ContinuityRecord> {
  let records = listContinuityRecords(vault, {
    kind: "context_pack_evidence",
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  }).filter((record) => matchesFilter(record, filter));
  records = records.toReversed();
  if (filter.limit !== undefined) records = records.slice(0, Math.max(0, Math.floor(filter.limit)));
  return Object.freeze(records);
}

/**
 * The evidence a `context_receipt` payload carries, in stamp-token form.
 * A field the receipt did not record reads `null` - unrecorded, per
 * `integrity/stamp.ts`, and distinct from a recorded empty string.
 */
function receiptEvidenceTokens(payload: ContinuityPayload): StampTokens {
  return Object.freeze({
    [CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash]: stringToken(
      payload[CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash],
    ),
    [CONTEXT_PACK_EVIDENCE_FIELD.itemCount]: countToken(
      payload[CONTEXT_PACK_EVIDENCE_FIELD.itemCount],
    ),
    [CONTEXT_PACK_EVIDENCE_FIELD.finalTextChars]: countToken(
      payload[CONTEXT_PACK_EVIDENCE_FIELD.finalTextChars],
    ),
  });
}

/**
 * The agent's claim in the same token form, through the same
 * canonicalisation - so a claimed count and a recorded count can never
 * disagree because one side stringified differently from the other.
 * Unasserted fields are absent, not null: the claim asserts what it
 * asserts and nothing more.
 */
function claimTokens(claim: ContextPackEvidenceClaim | undefined): StampTokens {
  if (claim === undefined) return Object.freeze({});
  const tokens: Record<string, string> = {};
  if (claim.finalTextHash !== undefined) {
    tokens[CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash] = requireClaimString(
      CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash,
      claim.finalTextHash,
    );
  }
  if (claim.itemCount !== undefined) {
    tokens[CONTEXT_PACK_EVIDENCE_FIELD.itemCount] = requireClaimCount(
      CONTEXT_PACK_EVIDENCE_FIELD.itemCount,
      claim.itemCount,
    );
  }
  if (claim.finalTextChars !== undefined) {
    tokens[CONTEXT_PACK_EVIDENCE_FIELD.finalTextChars] = requireClaimCount(
      CONTEXT_PACK_EVIDENCE_FIELD.finalTextChars,
      claim.finalTextChars,
    );
  }
  return Object.freeze(tokens);
}

/** Drop the unrecorded fields so the payload states only what disk holds. */
function definedTokens(tokens: StampTokens): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(tokens)) {
    if (value !== null) out[field] = value;
  }
  return Object.freeze(out);
}

function stringToken(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A recorded count becomes its canonical decimal string; anything else is unrecorded. */
function countToken(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function requireClaimString(field: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`context pack evidence: claimed ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireClaimCount(field: string, value: number): string {
  const token = countToken(value);
  if (token === null || value < 0) {
    throw new TypeError(`context pack evidence: claimed ${field} must be a finite number >= 0`);
  }
  return token;
}

function requireSampleId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TypeError("context pack evidence: sampleId must be a non-empty string");
  }
  return raw.trim();
}

function frozenJudgement(
  verdict: ContextPackEvidenceVerdictToken,
  mismatches: ReadonlyArray<StampMismatch>,
): ContextPackEvidenceJudgement {
  return Object.freeze({ verdict, mismatches: Object.freeze([...mismatches]) });
}

function matchesFilter(record: ContinuityRecord, filter: ContextPackEvidenceFilter): boolean {
  const payload = record.payload;
  if (filter.host !== undefined && payload["host"] !== filter.host) return false;
  if (filter.sampleId !== undefined && payload["sample_id"] !== filter.sampleId) return false;
  if (filter.verdict !== undefined && payload["verdict"] !== filter.verdict) return false;
  return true;
}

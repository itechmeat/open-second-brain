/**
 * The caller-executed decider step (recall-quality wave, t_6b943fc7
 * lane A): the one model round the iterative recall loop may spend.
 *
 * The kernel never awaits a model. When the deterministic rounds stop
 * with measurable coverage gaps remaining, the loop pauses and hands the
 * caller a needs-llm-step envelope (built on the shared
 * {@link NeedsLlmStep} spine) describing the remaining gaps and the
 * candidate pool; the caller answers with a payload whose evidence
 * selection binds the answer to the round's candidate pool and whose
 * follow-up sub-queries drive the round's pulls, and the commit phase
 * validates that answer before the loop advances - the exact two-phase
 * discipline `commitExtractedSignals` established for model-authored
 * payloads: a shape assert, then registered semantic checks, then the
 * context rules the payload alone cannot carry.
 *
 * Three context rules live here rather than in the response-check
 * registry because they read per-request state the registry's
 * payload-only contract cannot see:
 *   - the round token must be one minted for THIS query, round and pool:
 *     either the plan's registry-backed nonce mint (the stored pause
 *     digest must match the replayed state) or the deterministic
 *     fallback mint ({@link makeRoundToken});
 *   - the token must not have been spent already (single use - a nonce
 *     token is spent by its own plan call's commit; the deterministic
 *     fallback is spent per pool, the pre-nonce semantics);
 *   - every selected evidence id must exist in the round's pool.
 * Each refusal is named from {@link DeciderStepError} codes, so callers
 * route on `code`, never on prose.
 *
 * An accepted commit does not write the vault: it drives one further
 * retrieval round whose pulls come only from the payload's sub-queries
 * (see `pipeline/iterative-recall.ts`). A declined or absent commit
 * finalizes the loop honestly instead of blocking it.
 */

import {
  SUB_QUERY_GROUPS_MAX,
  planSubQueryGroups,
  significantTerms,
  type CoverageReport,
} from "./coverage.ts";
import { NEEDS_LLM_STEP, buildNeedsLlmStep, type NeedsLlmStep } from "../brain/llm-step.ts";
import { assertResponseShape, type ShapeDescriptor } from "../brain/response-shape.ts";
import {
  assertResponseCheck,
  registerResponseCheck,
  semanticViolation,
  SEMANTIC_VIOLATION_CODES,
  type SemanticViolation,
} from "../brain/response-checks.ts";
import { sha256Hex } from "../integrity/digest.ts";
import { randomBytes } from "node:crypto";

/** Surface name the envelope's payload is validated under. */
export const DECIDER_STEP_SURFACE = "iterative_recall_decider";
/** Step name the answering agent is answering. */
export const DECIDER_STEP_NAME = "iterative-recall-decider";
/**
 * No artifact is written by this lane; the spine's required destination
 * names the surface the answered payload returns to, which is the only
 * target a recall round has.
 */
export const DECIDER_STEP_RESUME_TARGET = "brain_search";

/**
 * Most sub-queries one decider payload may spend pulls on: the same
 * per-round pull budget the deterministic floor obeys
 * ({@link SUB_QUERY_GROUPS_MAX}).
 */
export const DECIDER_SUB_QUERIES_MAX = SUB_QUERY_GROUPS_MAX;
/** Longest one decider sub-query may be, so one payload cannot balloon a pull. */
export const DECIDER_SUB_QUERY_LENGTH_MAX = 200;

/** Longest hex prefix of the token digest kept; a token is opaque, not secret. */
const ROUND_TOKEN_DIGEST_CHARS = 24;
/** Token prefix, so a round token is recognizable in a payload log at a glance. */
const ROUND_TOKEN_PREFIX = "drt";

/**
 * Why a decider step or its commit was refused. The set is closed:
 * callers route on these codes, and a new refusal must name itself here.
 */
export const DECIDER_STEP_ERROR_CODES = [
  /** The pool has no measurable coverage gap for a model round to close. */
  "no_gaps",
  /** The pool has no candidates to select evidence from. */
  "empty_pool",
  /** The submitted token was not minted for this query, round and pool. */
  "token_mismatch",
  /** The submitted token was already spent; a round token is single use. */
  "token_used",
  /** A selected evidence id does not exist in the round's pool. */
  "unknown_evidence",
  /** More evidence ids than the round's pool holds candidates. */
  "evidence_over_pool",
] as const;

export type DeciderStepErrorCode = (typeof DECIDER_STEP_ERROR_CODES)[number];

/**
 * A decider step was refused. Carries the closed code so a caller routes
 * on fields, never on message prose.
 */
export class DeciderStepError extends Error {
  readonly code: DeciderStepErrorCode;

  constructor(code: DeciderStepErrorCode, message: string) {
    super(message);
    this.name = "DeciderStepError";
    this.code = code;
  }
}

/**
 * The round token. Two mints exist:
 *
 *   - the nonce mint ({@link nonceRoundToken} via a {@link buildDeciderStep}
 *     mint hook): the plan phase draws fresh randomness, registers the
 *     pause state under the token in the single-use registry
 *     (`pipeline/cache-slot.ts`), and hands the nonce token out. The token
 *     names THIS plan call, so a second plan for the same query mints a
 *     fresh, unspent token, and "spent" means "this plan call".
 *   - the deterministic mint ({@link makeRoundToken}): the digest of the
 *     query, the round number and the pool. It is the fallback a plan
 *     falls back to when the registry write fails (best-effort by
 *     contract - the loop still works when the cache table is
 *     unavailable), and it is what a commit re-derives when no registry
 *     row stands behind the submitted token.
 *
 * Either way the token is opaque to callers and never secret.
 */
export function makeRoundToken(
  query: string,
  round: number,
  poolIds: ReadonlyArray<number>,
): string {
  return `${ROUND_TOKEN_PREFIX}-${round}-${pauseStateDigest(query, round, poolIds).slice(0, ROUND_TOKEN_DIGEST_CHARS)}`;
}

/**
 * The pause-state digest a plan mint registers under its nonce token: the
 * same material the deterministic token digests, kept whole. A commit
 * recomputes it over the replayed state and the registry row must agree,
 * so a replay that landed on another round or pool is refused as
 * `token_mismatch` even though the token itself was minted honestly.
 */
export function pauseStateDigest(
  query: string,
  round: number,
  poolIds: ReadonlyArray<number>,
): string {
  const material = `${query}\u0000${round}\u0000${[...poolIds].toSorted((a, b) => a - b).join(",")}`;
  return sha256Hex(material);
}

/** Hex chars of fresh randomness in a nonce round token (96 bits). */
const ROUND_TOKEN_NONCE_HEX_CHARS = 24;

/** Assemble the nonce mint: round-stamped, opaque, registry-backed. */
export function nonceRoundToken(round: number, nonceHex: string): string {
  return `${ROUND_TOKEN_PREFIX}-${round}-${nonceHex}`;
}

/** Fresh nonce hex for one plan-phase mint. */
export function randomRoundNonce(): string {
  return randomBytes(ROUND_TOKEN_NONCE_HEX_CHARS / 2).toString("hex");
}

/** The pause the loop hands its caller: the envelope plus its token. */
export interface DeciderPause {
  /** The round a committed payload will run (the loop's next number). */
  readonly round: number;
  readonly token: string;
  readonly llmStep: NeedsLlmStep;
  /** The sorted candidate chunk ids the envelope names. */
  readonly poolIds: ReadonlyArray<number>;
}

export interface DeciderStepInput {
  /** Residual query text the gaps were measured against. */
  readonly query: string;
  /** The round a committed payload will run. */
  readonly round: number;
  /** The last coverage measured over the pool. */
  readonly coverage: CoverageReport;
  /** The pool's candidate chunk ids (any order; emitted sorted). */
  readonly poolIds: ReadonlyArray<number>;
  /**
   * Plan-phase mint hook: register the pause state in the single-use
   * registry and return the nonce token to hand out, or null when the
   * registry could not take the write. Null (and the hook's absence)
   * falls back to the deterministic token, so a plan never fails because
   * the registry table is unavailable - the fallback is best-effort by
   * contract and documented at the call site that supplies the hook.
   */
  readonly mintRoundToken?: (input: {
    readonly round: number;
    readonly pauseDigest: string;
  }) => string | null;
}

/**
 * Build the needs-llm-step envelope for the remaining gaps. Refuses with
 * `no_gaps` unless the coverage is MEASURABLE and below the completeness
 * threshold with rare terms still uncovered - the same fire gate the
 * deterministic floor reads, so the model is asked exactly when a
 * gap-proposal round could pay and never on a complete or unmeasurable
 * pool - and with `empty_pool` when there are no candidates to select
 * evidence from. Pure except for the optional mint hook, whose registry
 * write is the plan phase's own business; without a hook (or when it
 * returns null) the pause carries the deterministic fallback token.
 */
export function buildDeciderStep(input: DeciderStepInput): DeciderPause {
  if (!planSubQueryGroups(input.coverage, 1).fire) {
    throw new DeciderStepError(
      "no_gaps",
      `no decider step for query ${JSON.stringify(input.query)}: coverage has no measurable gap to close`,
    );
  }
  const poolIds = [...input.poolIds].toSorted((a, b) => a - b);
  if (poolIds.length === 0) {
    throw new DeciderStepError(
      "empty_pool",
      `no decider step for query ${JSON.stringify(input.query)}: the pool has no candidates`,
    );
  }
  const gaps = input.coverage.uncoveredRareTerms;
  const pauseDigest = pauseStateDigest(input.query, input.round, poolIds);
  const minted = input.mintRoundToken?.({ round: input.round, pauseDigest }) ?? null;
  const llmStep = buildNeedsLlmStep({
    step: DECIDER_STEP_NAME,
    prompt:
      `The recall pool for query ${JSON.stringify(input.query)} still misses rare query terms ` +
      `after ${input.round - 1} deterministic retrieval round(s): ${gaps.join(", ")}. ` +
      `Bind this answer to the round's candidate pool by selecting its evidence from the ` +
      `chunk ids [${poolIds.join(",")}] and propose 1 to ${DECIDER_SUB_QUERIES_MAX} follow-up ` +
      `sub-queries, each at most ` +
      `${DECIDER_SUB_QUERY_LENGTH_MAX} characters, aimed at exactly the missed terms. ` +
      "Return the payload only; an invalid payload refuses the round.",
    schema_hints: [
      'payload: { "evidence": [chunkId, ...], "subQueries": [subQuery, ...] }',
      `evidence: 1+ chunk ids chosen from [${poolIds.join(",")}] (binds the answer to this round's pool)`,
      `subQueries: 1 to ${DECIDER_SUB_QUERIES_MAX} strings, each at most ${DECIDER_SUB_QUERY_LENGTH_MAX} characters, unique`,
    ],
    target_path: DECIDER_STEP_RESUME_TARGET,
  });
  return Object.freeze({
    round: input.round,
    token: minted ?? makeRoundToken(input.query, input.round, poolIds),
    llmStep,
    poolIds: Object.freeze(poolIds),
  });
}

/** The payload shape: evidence ids and follow-up sub-queries, nothing else. */
const DECIDER_STEP_SHAPE: ShapeDescriptor = {
  type: "object",
  required: ["evidence", "subQueries"],
  additionalProperties: false,
  properties: {
    evidence: { type: "array", items: { type: "integer" } },
    subQueries: { type: "array", items: { type: "string", nonBlank: true } },
  },
};

/**
 * Cardinality, budget and uniqueness rules the descriptor language
 * cannot express, registered once at module scope in the shared
 * fail-closed registry: at least one piece of evidence and one
 * sub-query, at most {@link DECIDER_SUB_QUERIES_MAX} sub-queries, each
 * within {@link DECIDER_SUB_QUERY_LENGTH_MAX}, and no duplicates.
 */
registerResponseCheck(DECIDER_STEP_SURFACE, (payload) => {
  const violations: SemanticViolation[] = [];
  if (payload === null || typeof payload !== "object") return violations;
  const record = payload as { evidence?: unknown; subQueries?: unknown };
  const evidence = Array.isArray(record.evidence) ? record.evidence : null;
  const subQueries = Array.isArray(record.subQueries) ? record.subQueries : null;
  if (evidence !== null && evidence.length === 0) {
    violations.push(
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.cardinality,
        "$.evidence",
        "at least one evidence id must be selected",
      ),
    );
  }
  // Duplicate evidence ids, mirroring the sub-query duplicate rule: a
  // selection that names one chunk twice pins nothing extra and reads as
  // two votes the pool cannot honor. (The evidence count itself is capped
  // at the pool size at commit time, where the pool is known - the
  // payload-only registry cannot see it.)
  evidence?.forEach((id, index) => {
    if (typeof id !== "number") return;
    const firstDuplicate = evidence.indexOf(id);
    if (firstDuplicate !== index) {
      violations.push(
        semanticViolation(
          SEMANTIC_VIOLATION_CODES.crossItem,
          `$.evidence[${index}]`,
          `duplicate evidence id; first seen at index ${firstDuplicate}`,
        ),
      );
    }
  });
  if (subQueries === null) return violations;
  if (subQueries.length === 0) {
    violations.push(
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.cardinality,
        "$.subQueries",
        "at least one sub-query is required to drive the round",
      ),
    );
  }
  if (subQueries.length > DECIDER_SUB_QUERIES_MAX) {
    violations.push(
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.threshold,
        "$.subQueries",
        `at most ${DECIDER_SUB_QUERIES_MAX} sub-queries per round; got ${subQueries.length}`,
      ),
    );
  }
  subQueries.forEach((subQuery, index) => {
    if (typeof subQuery !== "string") return;
    if (subQuery.length > DECIDER_SUB_QUERY_LENGTH_MAX) {
      violations.push(
        semanticViolation(
          SEMANTIC_VIOLATION_CODES.threshold,
          `$.subQueries[${index}]`,
          `sub-query must be at most ${DECIDER_SUB_QUERY_LENGTH_MAX} characters; got ${subQuery.length}`,
        ),
      );
    }
    if (significantTerms(subQuery).length === 0) {
      violations.push(
        semanticViolation(
          SEMANTIC_VIOLATION_CODES.threshold,
          `$.subQueries[${index}]`,
          "sub-query carries no significant terms, so it can never drive a retrieval pull",
        ),
      );
    }
    const firstDuplicate = subQueries.indexOf(subQuery);
    if (firstDuplicate !== index) {
      violations.push(
        semanticViolation(
          SEMANTIC_VIOLATION_CODES.crossItem,
          `$.subQueries[${index}]`,
          `duplicate sub-query; first seen at index ${firstDuplicate}`,
        ),
      );
    }
  });
  return violations;
});

export interface DeciderCommitScope {
  /** Residual query text the token was minted over. */
  readonly query: string;
  /** The round the committed payload will run. */
  readonly round: number;
  /** The pool the token was minted over (any order). */
  readonly poolIds: ReadonlyArray<number>;
  /** Round tokens already spent; a token here refuses as `token_used`. */
  readonly usedTokens: ReadonlySet<string>;
  /**
   * The pause-state digest the registry stored when the plan phase minted
   * the submitted token, read by the caller from the token's registry row.
   * Present only for a nonce mint: the commit recomputes the digest over
   * the replayed state and refuses as `token_mismatch` unless the two
   * agree, so a replay that landed on another round or pool never runs.
   * Absent (deterministic fallback token, or no registry row) the token
   * validates by re-derivation alone.
   */
  readonly mintedPauseDigest?: string;
}

/**
 * A validated decider payload: the pool binding and the sub-queries the
 * next round spends its pulls on.
 */
export interface DeciderCommit {
  /**
   * Pool-validated ids that bind the commit to THIS round's state; the
   * committed round's pulls read `subQueries` only.
   */
  readonly evidenceIds: ReadonlyArray<number>;
  /** The sub-queries the committed round pulls. */
  readonly subQueries: ReadonlyArray<string>;
  /** The spent token, echoed so the caller can record its single use. */
  readonly token: string;
}

/**
 * Validate the caller's answer. Order is the commitExtractedSignals
 * discipline - structure first, then the registered semantic rules,
 * then the context rules - and nothing is returned until every gate
 * passes, so a refused payload never advances the loop.
 */
export function commitDeciderStep(
  token: string,
  payload: unknown,
  scope: DeciderCommitScope,
): DeciderCommit {
  assertResponseShape(DECIDER_STEP_SURFACE, DECIDER_STEP_SHAPE, payload);
  assertResponseCheck(DECIDER_STEP_SURFACE, payload);

  const deterministic = makeRoundToken(scope.query, scope.round, scope.poolIds);
  if (token !== deterministic) {
    // Not the fallback mint: the token must be a nonce mint whose
    // registry row stored exactly this state's pause digest. A digest
    // mismatch means the replayed commit reached a different round or
    // pool than the plan call that handed the token out - genuine
    // divergence, refused by name.
    if (scope.mintedPauseDigest !== pauseStateDigest(scope.query, scope.round, scope.poolIds)) {
      throw new DeciderStepError(
        "token_mismatch",
        `round token was not minted for query ${JSON.stringify(scope.query)} round ${scope.round}: got ${JSON.stringify(token)}, expected a ${ROUND_TOKEN_PREFIX}-prefixed token minted for this state`,
      );
    }
  }
  if (scope.usedTokens.has(token)) {
    throw new DeciderStepError(
      "token_used",
      `round token ${JSON.stringify(token)} was already spent; a round token is single use`,
    );
  }

  const { evidence, subQueries } = payload as {
    evidence: ReadonlyArray<number>;
    subQueries: ReadonlyArray<string>;
  };
  // The evidence budget is the pool itself: a selection longer than the
  // pool of candidates it must come from cannot be honest - every extra
  // id is either a duplicate in disguise or an id that can only miss.
  // (Duplicates per se are refused by the registered payload check; the
  // pool is per-request state only the context rules can see.)
  if (evidence.length > scope.poolIds.length) {
    throw new DeciderStepError(
      "evidence_over_pool",
      `evidence selects ${evidence.length} id(s) but the round ${scope.round} pool holds ${scope.poolIds.length} candidate(s)`,
    );
  }
  const pool = new Set(scope.poolIds);
  const unknown = evidence.filter((id) => !pool.has(id));
  if (unknown.length > 0) {
    throw new DeciderStepError(
      "unknown_evidence",
      `evidence ids not in the round ${scope.round} pool: ${unknown.join(", ")}`,
    );
  }
  return Object.freeze({
    evidenceIds: Object.freeze([...evidence]),
    subQueries: Object.freeze([...subQueries]),
    token,
  });
}

/** The `needs-llm-step` status literal, re-exported for the loop's callers. */
export { NEEDS_LLM_STEP };

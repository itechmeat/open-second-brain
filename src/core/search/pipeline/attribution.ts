/**
 * Result decoration for the final window: the typed relations each page
 * declares, plus the reasons that explain WHY a row surfaced - learned
 * weights, structured lanes, a canonical-entity hop, a second-pass retry,
 * or the relational arm.
 *
 * Every layer is a no-op when its feature did not fire, so the default
 * path returns the rows untouched.
 */

import { learnedWeightsReason } from "../feedback.ts";
import { addStructuredReasons } from "../structured-lanes.ts";
import type { RelationalReach } from "./relational-arm.ts";
import type { LearnedWeights } from "../feedback.ts";
import type { Store } from "../store.ts";
import type { BrainSearchResult, SearchOutcome, StructuredRecallQueryDocument } from "../types.ts";

export interface DecorationInput {
  readonly store: Store;
  readonly results: ReadonlyArray<BrainSearchResult>;
  readonly structured: StructuredRecallQueryDocument | undefined;
  /** Non-null only when learned weights actually moved this ranking. */
  readonly activeLearned: LearnedWeights | null;
  /** Chunks matched through a registry-added entity form. */
  readonly canonicalMatchByChunk: ReadonlyMap<number, number> | undefined;
  readonly canonicalSourceIds: ReadonlyArray<string>;
  readonly secondPass: SearchOutcome["secondPass"];
  readonly targetedChunkIds: ReadonlySet<number>;
  readonly relationalReach: ReadonlyMap<number, RelationalReach>;
}

export function decorateFinalResults(input: DecorationInput): ReadonlyArray<BrainSearchResult> {
  // Explainability: when learned weights affected this ranking, every
  // surfaced result says so (acceptance: "search explanations show
  // when learned weights affected a result").
  const learned = input.activeLearned;
  const filtered =
    learned !== null
      ? input.results.map((r) =>
          Object.freeze({
            ...r,
            reasons: Object.freeze([...r.reasons, learnedWeightsReason(learned)]),
          }),
        )
      : input.results;

  // Typed graph semantics (v3): surface the typed relations each
  // result page declares in its frontmatter. Computed here from the
  // links table, never stored on the result row. One batched query.
  const relByDoc = input.store.typedRelationsForDocuments(filtered.map((r) => r.documentId));
  const withRelations = filtered.map((r) => {
    const rels = relByDoc.get(r.documentId);
    return rels && rels.length > 0 ? { ...r, relations: Object.freeze(rels) } : r;
  });
  const withStructuredReasons = addStructuredReasons(withRelations, input.structured);
  // Canonical-entity attribution (Memory Integrity Suite): a hit whose
  // chunk matched a registry-added form explains the alias hop. Vaults
  // without a registry never reach this branch.
  const canonicalMatchByChunk = input.canonicalMatchByChunk;
  const withCanonicalReasons =
    canonicalMatchByChunk !== undefined
      ? withStructuredReasons.map((r) =>
          (canonicalMatchByChunk.get(r.chunkId) ?? 0) > 0
            ? Object.freeze({
                ...r,
                reasons: Object.freeze([
                  ...r.reasons,
                  `entity_canonical: ${input.canonicalSourceIds.join(", ")}`,
                ]),
              })
            : r,
        )
      : withStructuredReasons;
  // Two-pass attribution (t_ef92dfdc; targeted retry t_8eb5ca32): a
  // surfaced result of a retry says so - the operator can tell
  // recovered evidence from a first-pass hit. The broadened retry
  // replaced the whole pool, so every result is recovered; the
  // targeted retry only ADDED candidates, so only those (tracked in
  // `targetedChunkIds`) carry the reason - the first-pass hits they
  // merge with do not.
  const secondPass = input.secondPass;
  const withSecondPassReasons =
    secondPass === undefined
      ? withCanonicalReasons
      : withCanonicalReasons.map((r) => {
          if (secondPass.kind === "targeted" && !input.targetedChunkIds.has(r.chunkId)) return r;
          const reason =
            secondPass.kind === "targeted"
              ? "second_pass: targeted retry on uncovered rare terms"
              : "second_pass: or-broadened retry";
          return Object.freeze({ ...r, reasons: Object.freeze([...r.reasons, reason]) });
        });
  // Relational-arm attribution (t_09b7ccea): a node surfaced by the
  // typed-edge fan-out carries a reason naming the link types and hop
  // distance it was reached by. An empty reach map (arm off) is a no-op.
  if (input.relationalReach.size === 0) return withSecondPassReasons;
  return withSecondPassReasons.map((r) => {
    const reach = input.relationalReach.get(r.chunkId);
    if (reach === undefined) return r;
    const reason = `relational: via ${reach.via.join(", ")} (${reach.hops} hop${reach.hops === 1 ? "" : "s"})`;
    return Object.freeze({ ...r, reasons: Object.freeze([...r.reasons, reason]) });
  });
}

/**
 * Advisory decision-model verdicts on entity alias-merge candidates in
 * the doctor output (issue #213, Part 5, use `dedup`).
 *
 * The doctor check (`entity-checks.ts`) is synchronous and embeds
 * nothing, so it nominates `entity-alias-candidate` warnings from the
 * lexical layer. The asynchronous doctor surfaces (`o2b brain doctor`,
 * `brain_doctor`) hand their warnings to this pass, which re-derives the
 * same candidates, matches each warning to its candidate by the exact
 * message the check wrote, and asks whether the two names are the `same`
 * entity, `related` ones or `different` ones.
 *
 *   - `off` or no active config, or no alias candidate in the warnings:
 *     null, and the caller's output is unchanged.
 *   - `shadow`: sent and recorded, output unchanged.
 *   - `enforce`: each matched warning gains `decision_model`; a confident
 *     `different` is listed last with `decision_model_low_priority: true`.
 *
 * Never writes an entity file; the merge stays the operator's.
 */

import {
  advisoryDecisionConfig,
  advisoryUseActive,
  pageEgressFacts,
  type AdvisoryDecisionOptions,
} from "../../decision-model/advisory.ts";
import {
  orderByVerdicts,
  runPairVerdicts,
  type AnnotatedItem,
  type PairVerdict,
  type VerdictPairInput,
} from "../../decision-model/pair-verdict.ts";
import { DEDUP_QUESTIONS } from "../../decision-model/questions.ts";
import { buildEntityIndex } from "../entities/index-builder.ts";
import {
  entityLexicalAliasCandidates,
  resolveEntitySemanticDedupConfig,
  type EntityAliasCandidate,
} from "../entities/semantic-dedup.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../entities/status-scope.ts";
import type { BrainEntity } from "../entities/types.ts";
import { ENTITY_ALIAS_CANDIDATE_CODE, entityAliasCandidateMessage } from "./entity-checks.ts";

interface IssueLike {
  readonly code: string;
  readonly message: string;
}

function entitySide(entity: BrainEntity | undefined, name: string): VerdictPairInput["sideA"] {
  if (entity === undefined) return { text: "", visibility: null, privateRegions: null };
  const facts = pageEgressFacts(entity.path);
  return { text: name, visibility: facts.visibility, privateRegions: facts.privateRegions };
}

/**
 * Annotate the `entity-alias-candidate` entries of a doctor warning
 * list. Returns null when there is nothing to do (use off, no candidate);
 * otherwise every warning, in the order to show, with its verdict.
 */
export async function annotateEntityAliasIssues<T extends IssueLike>(
  vault: string,
  warnings: ReadonlyArray<T>,
  opts: AdvisoryDecisionOptions = {},
): Promise<ReadonlyArray<AnnotatedItem<T>> | null> {
  if (!warnings.some((w) => w.code === ENTITY_ALIAS_CANDIDATE_CODE)) return null;
  const cfg = advisoryDecisionConfig(vault, opts);
  if (!advisoryUseActive(cfg, "dedup")) return null;

  let byMessage: Map<string, EntityAliasCandidate>;
  let entities: Map<string, BrainEntity>;
  try {
    const dedupCfg = resolveEntitySemanticDedupConfig();
    byMessage = new Map(
      entityLexicalAliasCandidates(vault, { threshold: dedupCfg.lexicalThreshold }).map((c) => [
        entityAliasCandidateMessage(c),
        c,
      ]),
    );
    // Only records the canonical read scope admits may be sent; the
    // candidates come from that scope already.
    entities = new Map(
      buildEntityIndex(vault)
        .entities.filter((e) => entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical))
        .map((e) => [e.id, e]),
    );
  } catch {
    return null;
  }

  const matched: Array<{ index: number; pair: VerdictPairInput }> = [];
  warnings.forEach((warning, index) => {
    if (warning.code !== ENTITY_ALIAS_CANDIDATE_CODE) return;
    const c = byMessage.get(warning.message);
    if (c === undefined) return;
    matched.push({
      index,
      pair: {
        id: c.id,
        a: c.a,
        b: c.b,
        sideA: entitySide(entities.get(c.a), c.name_a),
        sideB: entitySide(entities.get(c.b), c.name_b),
      },
    });
  });
  if (matched.length === 0) return null;

  const run = await runPairVerdicts(
    matched.map((m) => m.pair),
    {
      use: "dedup",
      pairKind: "entity",
      options: DEDUP_QUESTIONS.options,
      clipChars: DEDUP_QUESTIONS.clipChars,
      question: DEDUP_QUESTIONS.entity,
    },
    {
      config: cfg,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    },
  );
  if (run.status === "off") return null;
  const verdicts: (PairVerdict | null)[] = warnings.map(() => null);
  matched.forEach((m, k) => {
    verdicts[m.index] = run.verdicts[k] ?? null;
  });
  return orderByVerdicts(warnings, verdicts, run.mode, DEDUP_QUESTIONS.lowPriority);
}

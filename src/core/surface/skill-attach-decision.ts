/**
 * Optional two-stage decision-model selection for `skills_attach`
 * (issue #213, Part 3).
 *
 * `buildSkillAttachment` stays the deterministic, synchronous BM25 path
 * and is what every caller gets while the `skills` use is `off` (the
 * default, and every configuration that is not active). This async
 * wrapper runs only when the use is `shadow` or `enforce`:
 *
 *   1. Shortlist: the same scorer and discriminating-term floor, cut at
 *      `SKILLS_SHORTLIST_MAX` instead of `maxSkills`.
 *   2. Stage 1, one request: the turn plus the shortlist masked as
 *      `S0..Sn` (name and one-line description, clipped). Questions:
 *      `pick` (choice over the shortlist plus `none`) and
 *      `needs_any_skill` (noul).
 *   3. Stage 2, one request, only when stage 1 is confident enough to act
 *      and enough of `decision_model_timeout_ms` remains: one noul per
 *      finalist (the top `min(maxSkills, 3)` by stage-1 probability) over
 *      its full description and SKILL.md body, clipped.
 *   4. Enforce: `needs_any_skill` below `SKILLS_NEEDS_ANY_MIN` offers
 *      nothing (`offer_id: null`); otherwise finalists at or above
 *      `SKILLS_FINAL_MIN`, by probability, capped at `maxSkills`, rendered
 *      with the existing renderer and char budget.
 *
 * Invariants:
 *   - the decision offer is always a subset or reorder of the BM25
 *     shortlist; an answer naming anything else is ignored, never offered;
 *   - the offer id is computed over what is actually offered, so the
 *     `skill_invoked` join works in both modes;
 *   - any degrade in either stage, an invalid answer, or a stage 1 that is
 *     not confident returns today's BM25 block (a partial decision is
 *     never applied);
 *   - `shadow` returns the BM25 block byte for byte and records both
 *     offered lists;
 *   - skills whose SKILL.md is private (visibility `private`), unreadable
 *     or carries private text are never sent, and so never offered in
 *     `enforce`; they are masked in the records.
 *
 * Nothing here writes to the vault except the gated accounting records.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { emitTokenImpact, TOKEN_COUNT_METHOD } from "../brain/token-impact.ts";
import { estimateTokens } from "../brain/text/tokenizer.ts";
import {
  decisionModelModeFor,
  type ResolvedDecisionModelConfig,
} from "../decision-model/config.ts";
import {
  decisionTokenImpactSource,
  type DecisionModelMode,
  type DecisionProvider,
  type DecisionResponse,
} from "../decision-model/contract.ts";
import {
  SKILLS_FINAL_MIN,
  SKILLS_NEEDS_ANY_MIN,
  SKILLS_QUESTIONS,
  SKILLS_SHORTLIST_MAX,
  SKILLS_STAGE1_CLIP_CHARS,
  SKILLS_STAGE2_CLIP_CHARS,
  SKILLS_STAGE2_MAX_FINALISTS,
  SKILLS_STAGE2_MIN_REMAINING_MS,
  SKILLS_TURN_CLIP_CHARS,
} from "../decision-model/questions.ts";
import { runDecision, type DecisionRunResult } from "../decision-model/run.ts";
import { buildCandidateState, mayLeaveMachine } from "../decision-model/state.ts";
import { pageVisibility } from "../graph/visibility.ts";
import { privateRegionTexts, stripPrivateRegions } from "../redactor.ts";
import { parseFrontmatterText } from "../vault.ts";
import {
  buildSkillAttachment,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_SKILLS,
  rankSkillCandidates,
  renderSkillAttachment,
  type BuildSkillAttachmentOptions,
  type SkillAttachItem,
  type SkillAttachment,
} from "./skill-attach.ts";
import type { SkillEntry } from "./skills.ts";

/** Stands in for a skill that may not leave the machine, in records. */
const WITHHELD_NAME = "(withheld)";

/** Attribution of `token_impact` samples written by this use. */
export const SKILLS_TOKEN_IMPACT_SOURCE = decisionTokenImpactSource("skills");

/** The optional `decision_model` field of a `skills_attach` result. */
export interface SkillDecisionInfo {
  readonly mode: Exclude<DecisionModelMode, "off">;
  /** True only in `enforce` when the decision offer was returned. */
  readonly applied: boolean;
  /** Degrade reason when a stage failed and the BM25 block was returned. */
  readonly degraded?: string;
  /** The answering model, when a reply arrived. */
  readonly model?: string;
}

export interface DecisionSkillAttachment extends SkillAttachment {
  /** Null when the `skills` use is off; the field is then omitted. */
  readonly decisionModel: SkillDecisionInfo | null;
}

/** What may be sent about one skill, read from its SKILL.md. */
interface SkillEgressText {
  /** Frontmatter description plus body, before clipping. */
  readonly fullText: string;
  /** Visibility tokens of the SKILL.md, or null when unreadable. */
  readonly visibility: ReadonlyArray<string> | null;
  /** `<private>` regions of the SKILL.md, or null when unreadable. */
  readonly privateRegions: ReadonlyArray<string> | null;
}

export interface DecisionSkillAttachmentOptions extends BuildSkillAttachmentOptions {
  readonly config: ResolvedDecisionModelConfig | null | undefined;
  /** Injected provider (tests); defaults to the configured adapter. */
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether the `token_impact` ledger is enabled. */
  readonly tokenImpact?: boolean;
}

function readSkillForEgress(skill: SkillEntry): SkillEgressText {
  try {
    const raw = readFileSync(skill.skillFile, "utf8");
    const [meta, body] = parseFrontmatterText(raw);
    return {
      fullText: `${skill.description}\n\n${body.trim()}`,
      visibility: pageVisibility(meta),
      privateRegions: privateRegionTexts(raw),
    };
  } catch {
    return { fullText: "", visibility: null, privateRegions: null };
  }
}

function clipChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

interface Stage1Context {
  /** `included[k]` is the shortlist index of mask `S<k>`. */
  readonly included: ReadonlyArray<number>;
  readonly withheld: ReadonlyArray<number>;
  readonly dropped: ReadonlyArray<number>;
}

interface Stage2Context {
  /** `included[k]` is the shortlist index of mask `F<k>`. */
  readonly included: ReadonlyArray<number>;
  readonly withheld: ReadonlyArray<number>;
  readonly dropped: ReadonlyArray<number>;
}

/** What the answers imply; computed once per stage and reused. */
type Plan =
  /** The decision is final: offer these shortlist indexes (may be empty). */
  | { readonly kind: "final"; readonly offered: ReadonlyArray<number> }
  /** Stage 1 is confident: judge these finalists in stage 2. */
  | { readonly kind: "stage2"; readonly finalists: ReadonlyArray<number> }
  /** Not applied: return the BM25 block (reason null when simply not confident). */
  | { readonly kind: "fallback"; readonly reason: string | null };

function validNumber(response: DecisionResponse, id: string): number | null {
  const a = response.answers[id];
  if (a === undefined || a.valid !== true || typeof a.value !== "number") return null;
  return Number.isFinite(a.value) && a.value >= 0 && a.value <= 1 ? a.value : null;
}

/**
 * Stage-1 answers to a plan. Only mask keys this request offered are read;
 * a reply naming any other key is not a valid pick.
 */
function planStage1(
  response: DecisionResponse,
  context: Stage1Context,
  maxSkills: number,
): { readonly plan: Plan; readonly needsAny: number | null } {
  const needsAny = validNumber(response, SKILLS_QUESTIONS.needsAnyId);
  if (needsAny === null) return { plan: { kind: "fallback", reason: "invalid_reply" }, needsAny };
  if (needsAny < SKILLS_NEEDS_ANY_MIN) return { plan: { kind: "final", offered: [] }, needsAny };
  const pick = response.answers[SKILLS_QUESTIONS.pickId];
  const keyToIndex = new Map<string, number>();
  context.included.forEach((shortlistIndex, k) => {
    keyToIndex.set(`${SKILLS_QUESTIONS.shortlistPrefix}${k}`, shortlistIndex);
  });
  if (
    pick === undefined ||
    pick.valid !== true ||
    typeof pick.value !== "string" ||
    (pick.value !== SKILLS_QUESTIONS.noneKey && !keyToIndex.has(pick.value))
  ) {
    return { plan: { kind: "fallback", reason: "invalid_reply" }, needsAny };
  }
  // A turn that needs a skill but where none of the shortlist fits is a
  // contradiction, not a confident answer: keep today's block.
  if (pick.value === SKILLS_QUESTIONS.noneKey) {
    return { plan: { kind: "fallback", reason: null }, needsAny };
  }
  const probabilities = pick.probabilities ?? { [pick.value]: 1 };
  const scored: Array<{ index: number; p: number }> = [];
  for (const [key, index] of keyToIndex) {
    const p = probabilities[key];
    if (typeof p === "number" && Number.isFinite(p) && p > 0) scored.push({ index, p });
  }
  if (!scored.some((s) => s.index === keyToIndex.get(pick.value as string))) {
    scored.push({ index: keyToIndex.get(pick.value)!, p: 1 });
  }
  scored.sort((a, b) => b.p - a.p || a.index - b.index);
  const finalists = scored
    .slice(0, Math.min(maxSkills, SKILLS_STAGE2_MAX_FINALISTS))
    .map((s) => s.index);
  return { plan: { kind: "stage2", finalists }, needsAny };
}

/** Stage-2 answers to the final offer (shortlist indexes, by probability). */
function planStage2(response: DecisionResponse, context: Stage2Context, maxSkills: number): Plan {
  const scored: Array<{ index: number; p: number }> = [];
  let valid = 0;
  context.included.forEach((shortlistIndex, k) => {
    const p = validNumber(response, SKILLS_QUESTIONS.appliesId(k));
    if (p === null) return;
    valid++;
    if (p >= SKILLS_FINAL_MIN) scored.push({ index: shortlistIndex, p });
  });
  // All or nothing: a finalist without a valid answer, or one dropped to
  // fit the state budget, was never judged, so no partial offer is made.
  if (valid !== context.included.length) return { kind: "fallback", reason: "invalid_reply" };
  if (context.dropped.length > 0) return { kind: "fallback", reason: "budget" };
  scored.sort((a, b) => b.p - a.p || a.index - b.index);
  return { kind: "final", offered: scored.slice(0, maxSkills).map((s) => s.index) };
}

/**
 * `skills_attach` with the optional decision-model selection. With the
 * `skills` use off this is exactly {@link buildSkillAttachment} and
 * `decisionModel` is null.
 */
export async function buildSkillAttachmentWithDecision(
  opts: DecisionSkillAttachmentOptions,
): Promise<DecisionSkillAttachment> {
  const baseline = buildSkillAttachment(opts);
  const cfg = opts.config;
  const configured = decisionModelModeFor(cfg, "skills");
  if (configured === "off" || cfg === null || cfg === undefined) {
    return { ...baseline, decisionModel: null };
  }
  const mode: Exclude<DecisionModelMode, "off"> = configured;
  const clock = Date.now;
  const deadline = clock() + cfg.timeoutMs;
  const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const shortlist = rankSkillCandidates(opts, SKILLS_SHORTLIST_MAX);
  const notApplied = (extra: Partial<SkillDecisionInfo> = {}): DecisionSkillAttachment => ({
    ...baseline,
    decisionModel: { mode, applied: false, ...extra },
  });
  if (shortlist.length === 0) return notApplied();

  const byName = new Map(opts.skills.map((s) => [s.name, s]));
  const egress = shortlist.map((item): SkillEgressText => {
    const skill = byName.get(item.name);
    return skill === undefined
      ? { fullText: "", visibility: null, privateRegions: null }
      : readSkillForEgress(skill);
  });
  // Names that may not appear in a record, known before any request so a
  // record written early (cost gate, budget) masks them too.
  const withheldNames = new Set<string>();
  shortlist.forEach((item, i) => {
    const e = egress[i]!;
    if (!mayLeaveMachine(e.visibility) || e.privateRegions === null) withheldNames.add(item.name);
  });
  const correlationId = randomUUID();
  const turn = clipChars(stripPrivateRegions(opts.query), SKILLS_TURN_CLIP_CHARS);
  const offeredNames = (items: ReadonlyArray<SkillAttachItem>): string[] =>
    items.map((i) => (withheldNames.has(i.name) ? WITHHELD_NAME : i.name));
  const decisionAttachment = (offered: ReadonlyArray<number>): SkillAttachment =>
    renderSkillAttachment(
      opts.query,
      offered.map((i) => shortlist[i]!),
      maxChars,
    );
  const recordBase = (stage: 1 | 2): Record<string, unknown> => ({
    stage,
    correlation_id: correlationId,
    shortlist_count: shortlist.length,
    max_skills: maxSkills,
    deterministic_offered: offeredNames(baseline.items),
    deterministic_offer_id: baseline.offerId,
  });
  const finalFields = (plan: Plan): Record<string, unknown> => {
    if (plan.kind === "stage2") return { final: false, finalist_count: plan.finalists.length };
    if (plan.kind === "fallback") {
      return {
        final: true,
        applied: false,
        offer_id: baseline.offerId,
        ...(plan.reason !== null ? { fallback: plan.reason } : { fallback: "not_confident" }),
      };
    }
    const decision = decisionAttachment(plan.offered);
    const applied = mode === "enforce";
    return {
      final: true,
      applied,
      decision_offered: offeredNames(decision.items),
      decision_offer_id: decision.offerId,
      offer_id: applied ? decision.offerId : baseline.offerId,
    };
  };

  // ----- stage 1 -----
  let stage1: { plan: Plan; needsAny: number | null } | undefined;
  const stage1Plan = (response: DecisionResponse, context: Stage1Context) => {
    if (stage1 !== undefined) return stage1;
    const computed = planStage1(response, context, maxSkills);
    stage1 =
      computed.plan.kind === "stage2" && deadline - clock() < SKILLS_STAGE2_MIN_REMAINING_MS
        ? { plan: { kind: "fallback", reason: "timeout" }, needsAny: computed.needsAny }
        : computed;
    return stage1;
  };
  const r1: DecisionRunResult<Stage1Context> = await runDecision<Stage1Context>(
    "skills",
    () => {
      const built = buildCandidateState({
        candidates: shortlist.map((item, i) => ({
          text: `${item.name} - ${item.description}`,
          visibility: egress[i]!.visibility,
          privateRegions: egress[i]!.privateRegions,
        })),
        prefix: SKILLS_QUESTIONS.shortlistPrefix,
        clipChars: SKILLS_STAGE1_CLIP_CHARS,
        maxStateTokens: cfg.maxStateTokens,
        frame: (texts) => ({ turn, skills: texts }),
      });
      if (built.kind === "empty") {
        for (const item of shortlist) withheldNames.add(item.name);
        return built;
      }
      if (built.kind !== "ok") return built;
      for (const i of built.withheld) withheldNames.add(shortlist[i]!.name);
      return {
        kind: "ok",
        state: built.state,
        candidateCount: built.included.length,
        context: { included: built.included, withheld: built.withheld, dropped: built.dropped },
      };
    },
    (built) => ({
      [SKILLS_QUESTIONS.pickId]: SKILLS_QUESTIONS.pick(
        built.context.included.map((_, k) => `${SKILLS_QUESTIONS.shortlistPrefix}${k}`),
      ),
      [SKILLS_QUESTIONS.needsAnyId]: SKILLS_QUESTIONS.needsAny(),
    }),
    {
      config: cfg,
      timeoutMs: cfg.timeoutMs,
      ...(cfg.vault !== null ? { secretsVault: cfg.vault } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      recordDetails: (response, context) => {
        const details = {
          ...recordBase(1),
          withheld_count: context?.withheld.length ?? 0,
          budget_dropped_count: context?.dropped.length ?? 0,
        };
        if (response === null || context === null) {
          return { ...details, final: true, applied: false, offer_id: baseline.offerId };
        }
        const { plan, needsAny } = stage1Plan(response, context);
        return {
          ...details,
          ...(needsAny !== null ? { needs_any_skill: needsAny } : {}),
          ...finalFields(plan),
        };
      },
    },
  );

  const finish = (result: DecisionSkillAttachment): DecisionSkillAttachment => {
    // A sample only when the host received something other than the BM25
    // block, as the other uses do: shadow and fallbacks change nothing.
    if (opts.tokenImpact === true && cfg.vault !== null && result.decisionModel?.applied === true) {
      emitTokenImpact(
        cfg.vault,
        {
          source: SKILLS_TOKEN_IMPACT_SOURCE,
          baselineTokens: estimateTokens(baseline.block),
          packedTokens: estimateTokens(result.block),
          method: TOKEN_COUNT_METHOD.heuristic,
        },
        true,
      );
    }
    return result;
  };

  if (r1.status === "off") return { ...baseline, decisionModel: null };
  if (r1.status === "empty") return finish(notApplied());
  if (r1.status === "degraded") return finish(notApplied({ degraded: r1.reason }));
  const model = r1.response.model;
  const { plan: p1 } = stage1Plan(r1.response, r1.context);
  const conclude = (plan: Plan, answeringModel: string): DecisionSkillAttachment => {
    if (plan.kind === "fallback") {
      return finish(
        notApplied({
          model: answeringModel,
          ...(plan.reason !== null ? { degraded: plan.reason } : {}),
        }),
      );
    }
    if (plan.kind !== "final" || mode !== "enforce") {
      return finish(notApplied({ model: answeringModel }));
    }
    const decision = decisionAttachment(plan.offered);
    return finish({
      ...decision,
      decisionModel: { mode, applied: true, model: answeringModel },
    });
  };
  if (p1.kind !== "stage2") return conclude(p1, model);

  // ----- stage 2 -----
  let stage2: Plan | undefined;
  const stage2Plan = (response: DecisionResponse, context: Stage2Context): Plan => {
    stage2 ??= planStage2(response, context, maxSkills);
    return stage2;
  };
  const finalists = p1.finalists;
  const needsAny = stage1?.needsAny ?? null;
  const r2 = await runDecision<Stage2Context>(
    "skills",
    () => {
      const built = buildCandidateState({
        candidates: finalists.map((i) => ({
          text: egress[i]!.fullText,
          visibility: egress[i]!.visibility,
          privateRegions: egress[i]!.privateRegions,
        })),
        prefix: SKILLS_QUESTIONS.finalistPrefix,
        clipChars: SKILLS_STAGE2_CLIP_CHARS,
        maxStateTokens: cfg.maxStateTokens,
        frame: (texts) => ({ turn, skills: texts }),
      });
      if (built.kind !== "ok") return built;
      return {
        kind: "ok",
        state: built.state,
        candidateCount: built.included.length,
        context: {
          included: built.included.map((k) => finalists[k]!),
          withheld: built.withheld,
          dropped: built.dropped,
        },
      };
    },
    (built) => {
      const questions: Record<string, ReturnType<typeof SKILLS_QUESTIONS.applies>> = {};
      for (let k = 0; k < built.context.included.length; k++) {
        questions[SKILLS_QUESTIONS.appliesId(k)] = SKILLS_QUESTIONS.applies(k);
      }
      return questions;
    },
    {
      config: cfg,
      timeoutMs: Math.max(1, deadline - clock()),
      ...(cfg.vault !== null ? { secretsVault: cfg.vault } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      recordDetails: (response, context) => {
        const details = {
          ...recordBase(2),
          finalist_count: finalists.length,
          withheld_count: context?.withheld.length ?? 0,
          budget_dropped_count: context?.dropped.length ?? 0,
          ...(needsAny !== null ? { needs_any_skill: needsAny } : {}),
        };
        if (response === null || context === null) {
          return { ...details, final: true, applied: false, offer_id: baseline.offerId };
        }
        return { ...details, ...finalFields(stage2Plan(response, context)) };
      },
    },
  );
  if (r2.status === "off") return { ...baseline, decisionModel: null };
  if (r2.status === "empty") return conclude({ kind: "fallback", reason: null }, model);
  if (r2.status === "degraded") return finish(notApplied({ model, degraded: r2.reason }));
  return conclude(stage2Plan(r2.response, r2.context), r2.response.model);
}

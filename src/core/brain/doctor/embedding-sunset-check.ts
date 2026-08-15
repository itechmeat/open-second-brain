/**
 * Warn before the embedding model is decommissioned, not after
 * (t_e7a226ce).
 *
 * The index stamps the embedding model into its ABI tokens, so changing
 * the model invalidates every stored vector and the only remedy is a full
 * re-embed of the corpus. That machinery fires AFTER the operator has
 * already changed the model, and by default only as a warning. This check
 * is the strictly earlier signal: it speaks while the config is still
 * correct and the index still valid, so a migration can be scheduled
 * rather than met.
 *
 * ## Why it lives in `o2b brain doctor`
 *
 * `o2b search check` owns the provider question and the 5/6 exit codes,
 * but it has no clock at all - reading it end to end there is no `Date`,
 * no `now`, no time parameter - so a date comparison there would need a
 * new seam. This doctor already carries `DoctorCheckContext.now`, injected
 * by `runDoctor` precisely so age-based lints can be pinned, plus the
 * severity ladder and the `uncertain` stream a check needs to say what it
 * could not establish. It is the first doctor check to resolve search
 * config; the `core/brain -> core/search` import edge already exists
 * (`runtime-notices.ts`).
 *
 * ## The three answers, and why two of them are not silence
 *
 * | verdict          | outcome                                            |
 * |------------------|----------------------------------------------------|
 * | announced, near  | warning, naming the model and the date             |
 * | announced, far   | nothing - the condition does not hold yet          |
 * | none_announced   | nothing - the survey looked and found nothing      |
 * | unsurveyed       | uncertain: NO statement was made about this model  |
 * | undetermined     | uncertain, naming which half could not be reached  |
 *
 * `unsurveyed` is deliberately not folded into `none_announced`.
 * `embedding_model` is a free string with zero validation and this tool's
 * own onboarding text recommends a preview model that no catalog here
 * carries, so off-survey is the NORMAL case - and reporting "no sunset
 * announced" for a model nobody looked up is the misleading silence this
 * release removes. It reaches the `uncertain` stream rather than the
 * warning stream because it is not a defect in the vault and it does not
 * move the exit code.
 *
 * ## What the message may not say
 *
 * It never names a vendor. The resolved provider is one of four TRANSPORT
 * kinds - `openai-compat` says nothing about whose endpoint it is - and
 * vendor identity exists only inside a free-form `embedding_base_url` that
 * nothing in this tree maps. A message naming one would be inferring it
 * from a URL.
 *
 * And the exit is not a config edit: no verb in this tool writes a config
 * key. The registered command is the curated catalog, following
 * `search-chunk-window-undeclared`, which points at
 * `o2b search provider presets` for exactly this reason - the operator's
 * next act is choosing a replacement model, and the catalog is what lists
 * the candidates.
 */

import { resolveSearchConfig } from "../../search/index.ts";
import { resolveEmbeddingSunsetDeclaration } from "../policy.ts";
import {
  classifyEmbeddingSunset,
  EMBEDDING_SUNSET,
  EMBEDDING_SUNSET_SOURCE,
  EMBEDDING_SUNSET_SURVEY,
  EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS,
  EMBEDDING_SUNSET_UNDETERMINED_REASON,
  type EmbeddingSunsetSurvey,
  type EmbeddingSunsetVerdict,
} from "../../search/embeddings/sunset.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../search/embeddings/signature.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** A decommission date is declared and is inside the warning window. */
export const EMBEDDING_MODEL_SUNSET_ANNOUNCED_CODE = "embedding-model-sunset-announced";

/** The configured model is outside the survey; no statement was made. */
export const EMBEDDING_MODEL_SUNSET_UNSURVEYED_CODE = "embedding-model-sunset-unsurveyed";

/** The check ran and could establish no verdict; the message says which half. */
export const EMBEDDING_MODEL_SUNSET_UNDETERMINED_CODE = "embedding-model-sunset-undetermined";

/**
 * How far ahead of a declared date the warning starts.
 *
 * A quarter, because the remedy is a full re-embed of the corpus and that
 * is a scheduling decision rather than a command an operator runs between
 * two other things: it costs provider budget, it takes as long as the
 * vault is large, and the replacement model has to be chosen and its
 * dimension settled first. Warning a year out would be noise; warning a
 * week out would be an emergency.
 */
export const EMBEDDING_SUNSET_WARNING_WINDOW_DAYS = 90;

/** The cost the warning is warning about, named once. */
const MIGRATION_COST =
  "changing the model invalidates every stored vector, so the migration is a full re-embed of " +
  "the corpus";

/**
 * The provenance clause every message carries.
 *
 * It states that the claim is about a MODEL STRING and rests on a survey
 * with a review date - which is the honest form for a fact hardcoded from
 * a published announcement, and the sentence that lets an operator judge
 * how much to trust it.
 */
function provenance(verdict: EmbeddingSunsetVerdict): string {
  if (verdict.source !== EMBEDDING_SUNSET_SOURCE.declaration) {
    return `this rests on a decommission survey last reviewed ${verdict.surveyed_at}, which records model strings and identifies nobody's endpoint`;
  }
  const base =
    "this is the date declared in embeddings.sunset_at in Brain/_brain.yaml, which outranks the survey compiled into this build";
  if (!verdict.overrode_survey) return base;
  // A silent override is how the wrong record survives, so both are named
  // and the operator decides which to correct.
  const held =
    verdict.survey_sunset_at === null
      ? "recorded no announcement for it"
      : `records ${verdict.survey_sunset_at}`;
  return `${base}. Note the disagreement: that survey, reviewed ${verdict.surveyed_at}, ${held} - one of the two is out of date`;
}

function announcedMessage(verdict: EmbeddingSunsetVerdict): string {
  const days = verdict.days_remaining ?? 0;
  const when =
    days < 0
      ? `passed ${Math.abs(days)} days ago`
      : `${days} days away, inside the ${EMBEDDING_SUNSET_WARNING_WINDOW_DAYS}-day window`;
  return (
    `the configured embedding model ${verdict.model} has an announced decommission date of ` +
    `${verdict.sunset_at}, ${when}. Plan the move now: ${MIGRATION_COST}. Note ${provenance(verdict)}`
  );
}

function undeterminedMessage(verdict: EmbeddingSunsetVerdict): string {
  switch (verdict.reason) {
    case EMBEDDING_SUNSET_UNDETERMINED_REASON.modelUnresolved:
      return (
        "semantic search is enabled but the configuration resolved no embedding model, so there " +
        `was nothing to check for an announced decommission. ${provenance(verdict)}`
      );
    case EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyStale:
      return (
        `the decommission survey covers ${verdict.model} and records no announcement, but it was ` +
        `reviewed ${verdict.surveyed_at}, more than ${EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS} days ` +
        "ago. A negative is a claim about the world and it expires, so this build will not report " +
        "it as a clean bill of health"
      );
    case EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyEntryMalformed:
      return (
        `the decommission survey entry for ${verdict.model} carries a date this build cannot ` +
        "parse, so no verdict was reached. That is a defect in the shipped table rather than in " +
        "this vault"
      );
    case null:
      // Unreachable: `undetermined` always carries a reason, and the
      // arm exists so a fourth reason fails to compile here rather than
      // producing an empty sentence.
      return `no verdict was reached for ${verdict.model}, and this build recorded no reason`;
  }
}

function unsurveyedMessage(verdict: EmbeddingSunsetVerdict): string {
  return (
    `the configured embedding model ${verdict.model} is outside this build's decommission survey ` +
    `(reviewed ${verdict.surveyed_at}), so NO sunset statement was made about it. That is not the ` +
    "same as no decommission having been announced - nobody here looked this model up. If it is " +
    `retired under you, ${MIGRATION_COST}`
  );
}

/**
 * Build the check against `survey`.
 *
 * A factory, following `makeStaleDependencyCheck`: the survey is data the
 * check reads rather than logic it owns, so injecting it makes every
 * verdict reachable from a test without editing the shipped table.
 */
export function makeEmbeddingSunsetCheck(
  survey: EmbeddingSunsetSurvey = EMBEDDING_SUNSET_SURVEY,
): DoctorCheck {
  return {
    failSoft: true,
    run(ctx: DoctorCheckContext, out: DoctorFindings): void {
      let semantic;
      try {
        semantic = resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath }).semantic;
      } catch (err) {
        pushUncertain(out.uncertain, {
          code: EMBEDDING_MODEL_SUNSET_UNDETERMINED_CODE,
          path: ctx.configPath ?? ctx.vault,
          message:
            "the search configuration could not be resolved, so the configured embedding model " +
            `could not be checked for an announced decommission: ${
              err instanceof Error ? err.message : String(err)
            }`,
        });
        return;
      }
      // No model is in use, so there is no decommission to be ahead of.
      // Not silence about a defect: the disabled state has its own
      // reported class (`semantic-capability-disabled`) with its own exit,
      // and repeating it here would meet an operator with two findings for
      // one condition.
      if (!semantic.enabled || semantic.provider === "disabled") return;

      // The local embedder ships inside this build and carries no model
      // string in the configuration, so it is named the way the index
      // names it rather than reported as unresolved.
      const model = semantic.provider === "local" ? LOCAL_EMBEDDING_MODEL : semantic.model;
      // The operator's layer, read straight off the context rather than
      // loaded here: `_brain.yaml` is already resolved once per pass, and
      // a second read could disagree with the one every other check saw.
      // A vault with no declaration yields `null`, which means "consult
      // the survey" and never "no shutdown exists".
      const declared = resolveEmbeddingSunsetDeclaration(ctx.config);
      const verdict = classifyEmbeddingSunset(
        model,
        ctx.now.getTime(),
        survey,
        declared ?? undefined,
      );

      switch (verdict.state) {
        case EMBEDDING_SUNSET.noneAnnounced:
          return;
        case EMBEDDING_SUNSET.announced:
          if ((verdict.days_remaining ?? 0) > EMBEDDING_SUNSET_WARNING_WINDOW_DAYS) return;
          out.issues.push({
            severity: "warning",
            code: EMBEDDING_MODEL_SUNSET_ANNOUNCED_CODE,
            path: ctx.configPath ?? ctx.vault,
            target: verdict.model ?? "",
            message: announcedMessage(verdict),
          } satisfies DoctorIssue);
          return;
        case EMBEDDING_SUNSET.unsurveyed:
          pushUncertain(out.uncertain, {
            code: EMBEDDING_MODEL_SUNSET_UNSURVEYED_CODE,
            path: ctx.configPath ?? ctx.vault,
            message: unsurveyedMessage(verdict),
          });
          return;
        case EMBEDDING_SUNSET.undetermined:
          pushUncertain(out.uncertain, {
            code: EMBEDDING_MODEL_SUNSET_UNDETERMINED_CODE,
            path: ctx.configPath ?? ctx.vault,
            message: undeterminedMessage(verdict),
          });
          return;
      }
    },
  };
}

/** The registered instance, reading the shipped survey. */
export const embeddingSunsetCheck: DoctorCheck = makeEmbeddingSunsetCheck();

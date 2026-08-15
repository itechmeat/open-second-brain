/**
 * Announced decommissions of embedding models (t_e7a226ce).
 *
 * Changing `embedding_model` invalidates every stored vector: the index
 * stamps the model into its ABI tokens and the only remedy is a full
 * re-embed of the corpus (`EMBEDDING_ABI_FIX_COMMAND`). That machinery
 * fires only AFTER the operator has already changed the model. This module
 * is the strictly earlier signal - it fires while the config is still
 * correct and the index still valid, so a migration can be scheduled
 * rather than performed under an index that has just stopped working.
 *
 * ## Where the dates come from, and why
 *
 * Four sources were available and three are refused:
 *
 *   - **A network registry.** Refused. This project takes no unrequested
 *     outbound call for a fact like this, and says so at every relevant
 *     site: the presets catalog is "No server, no network"; runtime
 *     notices are computed "deterministically - no network, no LLM, no DB
 *     open"; `search check`'s provider probe is the ONE outbound call that
 *     verb makes and has an opt-out for the air-gapped caller. A cached
 *     registry is also the same staleness as a static table with more
 *     machinery, and an unreachable one is a third state to design for.
 *   - **A field on `EmbeddingModelPreset`.** Refused. That catalog is a
 *     list of RECOMMENDATIONS - its first entry is
 *     `RECOMMENDED_EMBEDDING_MODEL` unconditionally and is defaulted into
 *     every new provider profile - and a curated list of recommendations
 *     that also carries obituaries is two catalogs in one file. Worse, the
 *     populations barely overlap: five of its six entries are open-weight
 *     checkpoints with no vendor able to announce anything, while the
 *     hosted, versioned models that actually get decommissioned live in
 *     the disjoint `EMBEDDING_PRICING` table.
 *   - **An operator-declared date** (a flat config scalar, or a field on a
 *     registry profile). Refused as the SOLE source, because neither can
 *     tell "the operator declared nothing" from "no shutdown exists" - one
 *     optional key carries both meanings, which is the exact defect this
 *     check exists to remove. A profile-borne date additionally cannot
 *     reach the configuration this tool's own onboarding recommends, which
 *     is a bare `embedding_base_url` + `embedding_model` pair with no
 *     profile at all.
 *
 * What ships is a SURVEY: a static table of models somebody actually
 * looked up, each entry carrying either a date or an explicit negative,
 * plus the date the survey as a whole was reviewed. That is the mechanism
 * this repository already uses for third-party facts - `inputWindowTokens`
 * is hardcoded from published specs with a per-entry source comment - and
 * it costs no network call.
 *
 * ## How the survey handles its own staleness
 *
 * The unfixable weakness of a static table is that it goes stale between
 * releases, and the honest response is asymmetric:
 *
 *   - A **negative** is a claim about the world and it EXPIRES. Past
 *     {@link EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS} from `reviewedAt`,
 *     `none_announced` degrades to `undetermined` with `survey_stale`
 *     rather than remaining a confident negative nobody re-checked.
 *   - A **positive** survives a stale survey. A vendor can move a date,
 *     but a shutdown that was announced was announced, and an operator who
 *     is told about it can verify it. The verdict carries `surveyed_at` so
 *     the message can say how old the claim is.
 *   - **Absence** from the survey is `unsurveyed` and is never
 *     `none_announced`. `embedding_model` is a free string with zero
 *     validation and this tool's own onboarding recommends a preview model
 *     that no catalog here carries, so off-survey is the NORMAL case. This
 *     is the same polarity `declaredInputWindowTokens` chose for an
 *     unlisted window and the opposite of `pricePerMillionTokens`, which
 *     may answer 0 for an unknown model only because its fallback makes a
 *     gate DECLINE to fire.
 *
 * ## What an entry may honestly claim
 *
 * A negative here is a claim about the MODEL, not about any endpoint
 * serving it. An open-weight checkpoint has no operator who could
 * decommission it - that is the fact the entry records - while the
 * third-party endpoint an operator points `embedding_base_url` at can
 * disappear tomorrow. That is a liveness question and `o2b search check`
 * already owns it with a live probe.
 *
 * Nothing in this module names a vendor. The resolved `provider` is one of
 * four TRANSPORT kinds (`openai-compat`, `zeroentropy`, `local`,
 * `disabled`); vendor identity exists only inside a free-form
 * `embedding_base_url` that nothing in the tree maps, so a message that
 * named one would be inferring it from a URL.
 *
 * Pure and injectable: the clock is a parameter and so is the survey, so
 * every state below is reachable from a test without moving a wall clock
 * or editing the shipped table.
 */

import { isValidIsoInstant, parseIsoUtc } from "../../brain/health/iso-time.ts";
import { EMBEDDING_MODEL_PRESETS } from "./presets.ts";
import { LOCAL_EMBEDDING_MODEL } from "./signature.ts";

// ----- Vocabularies ---------------------------------------------------------

/**
 * What this build can say about one model's decommission.
 *
 * `unsurveyed` and `none_announced` are separate members and that
 * separation is the unit: one says the survey looked and found no
 * announcement, the other says the survey never looked at this model.
 */
export const EMBEDDING_SUNSET = Object.freeze({
  /** The survey declares a decommission date for this model. */
  announced: "announced",
  /** The survey covers this model and records no announcement. */
  noneAnnounced: "none_announced",
  /** The model is outside the survey; no statement either way. */
  unsurveyed: "unsurveyed",
  /** No verdict was reached; {@link EmbeddingSunsetVerdict.reason} says why. */
  undetermined: "undetermined",
} as const);

/** Closed union over {@link EMBEDDING_SUNSET}. */
export type EmbeddingSunsetState = (typeof EMBEDDING_SUNSET)[keyof typeof EMBEDDING_SUNSET];

/** Membership list, ordered from most to least that can be said. */
export const EMBEDDING_SUNSET_STATES: ReadonlyArray<EmbeddingSunsetState> = Object.freeze([
  EMBEDDING_SUNSET.announced,
  EMBEDDING_SUNSET.noneAnnounced,
  EMBEDDING_SUNSET.unsurveyed,
  EMBEDDING_SUNSET.undetermined,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isEmbeddingSunsetState(value: unknown): value is EmbeddingSunsetState {
  return (
    typeof value === "string" && (EMBEDDING_SUNSET_STATES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Why no verdict was reached. A separate vocabulary so a guard cannot let
 * `survey_stale` be read back where a state belongs.
 */
export const EMBEDDING_SUNSET_UNDETERMINED_REASON = Object.freeze({
  /** No embedding model resolved from the configuration. */
  modelUnresolved: "model_unresolved",
  /** The survey's own review date is older than the horizon. */
  surveyStale: "survey_stale",
  /**
   * A survey entry carries a date this build cannot parse.
   *
   * Produced by the SHIPPED table going wrong, which is why it survives
   * while its declaration-side twin did not: the survey is data compiled
   * into the binary and injectable at the check's own factory
   * (`makeEmbeddingSunsetCheck`), so a release that mistypes a date has
   * to say so rather than report the model as un-announced. The
   * operator's declaration has no such gap - see
   * {@link classifyEmbeddingSunset}.
   */
  surveyEntryMalformed: "survey_entry_malformed",
} as const);

/** Closed union over {@link EMBEDDING_SUNSET_UNDETERMINED_REASON}. */
export type EmbeddingSunsetUndeterminedReason =
  (typeof EMBEDDING_SUNSET_UNDETERMINED_REASON)[keyof typeof EMBEDDING_SUNSET_UNDETERMINED_REASON];

/** Membership list for {@link EMBEDDING_SUNSET_UNDETERMINED_REASON}. */
export const EMBEDDING_SUNSET_UNDETERMINED_REASONS: ReadonlyArray<EmbeddingSunsetUndeterminedReason> =
  Object.freeze([
    EMBEDDING_SUNSET_UNDETERMINED_REASON.modelUnresolved,
    EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyStale,
    EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyEntryMalformed,
  ]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isEmbeddingSunsetUndeterminedReason(
  value: unknown,
): value is EmbeddingSunsetUndeterminedReason {
  return (
    typeof value === "string" &&
    (EMBEDDING_SUNSET_UNDETERMINED_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Which layer answered.
 *
 * A closed vocabulary rather than a boolean because there are three
 * answers, not two: the operator's declaration, this build's table, and
 * NEITHER - which is what `unsurveyed` and `undetermined` rest on. A
 * boolean would have made "came from the survey" and "came from nowhere"
 * the same value.
 */
export const EMBEDDING_SUNSET_SOURCE = Object.freeze({
  /** The operator declared this date in `Brain/_brain.yaml`. */
  declaration: "declaration",
  /** This build's shipped survey answered. */
  survey: "survey",
  /** Neither layer had anything to say about the model. */
  none: "none",
} as const);

/** Closed union over {@link EMBEDDING_SUNSET_SOURCE}. */
export type EmbeddingSunsetSource =
  (typeof EMBEDDING_SUNSET_SOURCE)[keyof typeof EMBEDDING_SUNSET_SOURCE];

/** Membership list, in precedence order. */
export const EMBEDDING_SUNSET_SOURCES: ReadonlyArray<EmbeddingSunsetSource> = Object.freeze([
  EMBEDDING_SUNSET_SOURCE.declaration,
  EMBEDDING_SUNSET_SOURCE.survey,
  EMBEDDING_SUNSET_SOURCE.none,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isEmbeddingSunsetSource(value: unknown): value is EmbeddingSunsetSource {
  return (
    typeof value === "string" && (EMBEDDING_SUNSET_SOURCES as ReadonlyArray<string>).includes(value)
  );
}

// ----- The survey -----------------------------------------------------------

/** One model somebody looked up, and what they found. */
export interface EmbeddingSunsetEntry {
  /** Exact model string, matched the way `findEmbeddingPreset` matches. */
  readonly model: string;
  /**
   * Announced decommission date (`YYYY-MM-DD` or a full ISO instant), or
   * `null` for an explicit surveyed NEGATIVE: this model was looked up and
   * no decommission had been announced as of the survey's review date.
   */
  readonly sunsetAt: string | null;
  /** Where the answer came from. Never empty - a claim owes its origin. */
  readonly source: string;
  /** Anything a reader needs beyond the date itself. */
  readonly note: string;
}

export interface EmbeddingSunsetSurvey {
  /** `YYYY-MM-DD` the whole table was last checked. Bounds every negative. */
  readonly reviewedAt: string;
  readonly entries: ReadonlyArray<EmbeddingSunsetEntry>;
}

/**
 * How long a NEGATIVE stays believable.
 *
 * A year, because that is the period over which "nobody has announced
 * anything" stops being a fact somebody established and becomes a fact
 * nobody re-checked. It bounds only the negatives: an announced date is
 * still reported from an older survey, with its age named.
 */
export const EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Justification shared by every open-weight row below. Stated once because
 * it is one argument, not six: nobody operates these checkpoints, so there
 * is no party with the authority to announce a decommission. The endpoint
 * an operator points at CAN disappear, which is a liveness question
 * `o2b search check` probes live and this table does not answer.
 */
const OPEN_CHECKPOINT_SOURCE =
  "open-weight checkpoint distributed under a public licence: there is no operator of a hosted " +
  "endpoint with the authority to decommission the model itself";

function openCheckpoint(model: string): EmbeddingSunsetEntry {
  return {
    model,
    sunsetAt: null,
    source: OPEN_CHECKPOINT_SOURCE,
    note: "the endpoint serving it can still be withdrawn; that is liveness, not a sunset",
  };
}

/** Where the OpenAI rows below were read from. Cited, not remembered. */
const OPENAI_DEPRECATIONS_URL = "https://developers.openai.com/api/docs/deprecations";

/**
 * The one embedding deprecation that page carries, and the only positive
 * this build can source.
 *
 * Announced 2023-07-06, shut down 2024-01-04, replacement
 * `text-embedding-3-small`. The date is in the PAST, which is not a
 * weakness of the entry - it is the arm that matters most. An operator
 * restoring an old configuration, or copying one out of a years-old
 * tutorial, is told the model is already gone instead of watching the
 * first index build fail against an endpoint that no longer answers.
 */
const OPENAI_FIRST_GENERATION_SHUTDOWN = "2024-01-04";

const OPENAI_FIRST_GENERATION_SOURCE =
  `OpenAI deprecations, announced 2023-07-06, shutdown ${OPENAI_FIRST_GENERATION_SHUTDOWN}, ` +
  `replacement text-embedding-3-small: ${OPENAI_DEPRECATIONS_URL}`;

/**
 * Every model named in that entry, verbatim. Listed rather than pattern
 * matched: `text-search-ada-doc-001` is shut down and
 * `text-embedding-ada-002` is not, so a prefix rule over "ada" would
 * report a live model as decommissioned.
 */
const OPENAI_FIRST_GENERATION_EMBEDDINGS: ReadonlyArray<string> = Object.freeze([
  "text-similarity-ada-001",
  "text-search-ada-doc-001",
  "text-search-ada-query-001",
  "code-search-ada-code-001",
  "code-search-ada-text-001",
  "text-similarity-babbage-001",
  "text-search-babbage-doc-001",
  "text-search-babbage-query-001",
  "code-search-babbage-code-001",
  "code-search-babbage-text-001",
  "text-similarity-curie-001",
  "text-search-curie-doc-001",
  "text-search-curie-query-001",
  "text-similarity-davinci-001",
  "text-search-davinci-doc-001",
  "text-search-davinci-query-001",
]);

/**
 * The hosted models this repository already names in `EMBEDDING_PRICING`.
 *
 * These are SOURCED negatives, not assumed ones: the deprecations page
 * carries exactly one embedding entry and none of these three appears in
 * it. That is a real reading of a real page, which is what separates a
 * negative worth recording from the silence this check exists to remove.
 */
const OPENAI_CURRENT_EMBEDDINGS: ReadonlyArray<string> = Object.freeze([
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
]);

/**
 * The shipped survey.
 *
 * Adding an entry is a one-line edit plus a bump of `reviewedAt`; every
 * row owes a `source` and a test enforces it.
 */
export const EMBEDDING_SUNSET_SURVEY: EmbeddingSunsetSurvey = Object.freeze({
  reviewedAt: "2026-08-15",
  entries: Object.freeze([
    ...OPENAI_FIRST_GENERATION_EMBEDDINGS.map((model) => ({
      model,
      sunsetAt: OPENAI_FIRST_GENERATION_SHUTDOWN,
      source: OPENAI_FIRST_GENERATION_SOURCE,
      note: "first-generation OpenAI embedding model; the endpoint stopped answering on the date",
    })),
    ...OPENAI_CURRENT_EMBEDDINGS.map((model) => ({
      model,
      sunsetAt: null,
      source: `not listed in any deprecation entry on ${OPENAI_DEPRECATIONS_URL} as of the review date`,
      note: "a hosted model, so this negative is the one on this table with a real expiry",
    })),
    {
      model: LOCAL_EMBEDDING_MODEL,
      sunsetAt: null,
      source: "this build ships the local embedder, so this project is the only party that could",
      note: "a hashing embedder with no service behind it; retiring it would be a release note",
    },
    ...EMBEDDING_MODEL_PRESETS.map((preset) => openCheckpoint(preset.model)),
  ]),
});

// ----- The classifier -------------------------------------------------------

/**
 * An operator's own record of an announcement they have read.
 *
 * It names its MODEL explicitly rather than meaning "whatever is
 * configured". A declaration that meant the latter would silently
 * re-target itself the next time `embedding_model` changed, asserting one
 * vendor's shutdown date about a different vendor's model - which is the
 * confidently-wrong output this whole unit exists to prevent.
 */
export interface EmbeddingSunsetDeclaration {
  readonly model: string;
  readonly sunsetAt: string;
}

export interface EmbeddingSunsetVerdict {
  readonly state: EmbeddingSunsetState;
  /** The model the verdict is about, or `null` when none resolved. */
  readonly model: string | null;
  /** The declared date, or `null` for every other state. */
  readonly sunset_at: string | null;
  /** Whole days until the date; negative once it has passed. */
  readonly days_remaining: number | null;
  /** Why no verdict was reached, or `null` when one was. */
  readonly reason: EmbeddingSunsetUndeterminedReason | null;
  /** The survey review date this verdict rests on. */
  readonly surveyed_at: string;
  /** Which layer answered. */
  readonly source: EmbeddingSunsetSource;
  /**
   * True when a declaration answered AND the survey held a different
   * answer for the same model. Distinguishes "the survey said nothing
   * about this model" from "the survey disagreed" - one of the two
   * records is then wrong, and hiding either is how a wrong date
   * survives.
   */
  readonly overrode_survey: boolean;
  /**
   * What the survey held for this model when a declaration overrode it: a
   * date, or `null` meaning the survey recorded no announcement. Only
   * meaningful alongside {@link overrode_survey}.
   */
  readonly survey_sunset_at: string | null;
}

function undetermined(
  model: string | null,
  reason: EmbeddingSunsetUndeterminedReason,
  surveyedAt: string,
): EmbeddingSunsetVerdict {
  return {
    state: EMBEDDING_SUNSET.undetermined,
    model,
    sunset_at: null,
    days_remaining: null,
    reason,
    surveyed_at: surveyedAt,
    source: EMBEDDING_SUNSET_SOURCE.none,
    overrode_survey: false,
    survey_sunset_at: null,
  };
}

/**
 * What the survey says about `model` at `nowMs`.
 *
 * Lookup is by exact model string with no family heuristic, for the reason
 * `declaredInputWindowTokens` gives: a lifecycle differs between
 * checkpoints of one family, so inferring a date from a shared prefix
 * would invent the value.
 *
 * Nothing here reads a global clock, and nothing here refuses a FUTURE
 * instant. The future-instant refusals elsewhere in this codebase
 * (`usableAuthoredAtSeconds`, the stale-dependency filter) discard a
 * declared time later than the reading clock; a sunset date is supposed to
 * be later than the reading clock, so only the injectable-clock half of
 * that idiom applies.
 */
export function classifyEmbeddingSunset(
  model: string | null,
  nowMs: number,
  survey: EmbeddingSunsetSurvey = EMBEDDING_SUNSET_SURVEY,
  declaration?: EmbeddingSunsetDeclaration,
): EmbeddingSunsetVerdict {
  const reviewedAt = survey.reviewedAt;
  if (model === null || model.trim() === "") {
    return undetermined(null, EMBEDDING_SUNSET_UNDETERMINED_REASON.modelUnresolved, reviewedAt);
  }
  const entry = survey.entries.find((e) => e.model === model) ?? null;

  // The operator's layer first. It exists BECAUSE a table baked into the
  // binary goes stale between releases, and whoever wrote it has just
  // read the announcement; the survey was frozen at release. A
  // declaration about some OTHER model is not about this one and does not
  // participate - see EmbeddingSunsetDeclaration for why it names its
  // model rather than meaning "whatever is configured".
  if (declaration !== undefined && declaration.model === model) {
    if (!isValidIsoInstant(declaration.sunsetAt)) {
      // Not a verdict, because no vault can reach this. `sunset_at` is
      // validated with this same predicate by `parseEmbeddingsBlock`,
      // which is the ONLY producer of `BrainConfig.embeddings` and throws
      // a `BrainConfigError` naming the key - so an operator who mistypes
      // the date is told at load time, long before any check runs. An
      // `undetermined/declaration_malformed` verdict here would be a
      // reported state with a four-sentence operator message and no input
      // that could produce it, which is the defect this release removes.
      // A caller that reaches this has skipped the parser, and that is a
      // programming error: it gets said rather than turned into a
      // fabricated instant.
      throw new TypeError(
        `classifyEmbeddingSunset: declared sunsetAt for ${model} is not an ISO-8601 instant ` +
          `(${declaration.sunsetAt}); declarations come from parseEmbeddingsBlock, which ` +
          "validates them",
      );
    }
    // A disagreement is carried, not erased: one of the two records is
    // wrong, and a silent override is how the wrong one survives.
    const disagrees = entry !== null && entry.sunsetAt !== declaration.sunsetAt;
    return {
      state: EMBEDDING_SUNSET.announced,
      model,
      sunset_at: declaration.sunsetAt,
      days_remaining: Math.floor((parseIsoUtc(declaration.sunsetAt) - nowMs) / MS_PER_DAY),
      reason: null,
      surveyed_at: reviewedAt,
      source: EMBEDDING_SUNSET_SOURCE.declaration,
      overrode_survey: disagrees,
      survey_sunset_at: disagrees ? entry.sunsetAt : null,
    };
  }

  if (entry === null) {
    return {
      state: EMBEDDING_SUNSET.unsurveyed,
      model,
      sunset_at: null,
      days_remaining: null,
      reason: null,
      surveyed_at: reviewedAt,
      source: EMBEDDING_SUNSET_SOURCE.none,
      overrode_survey: false,
      survey_sunset_at: null,
    };
  }
  if (entry.sunsetAt !== null) {
    if (!isValidIsoInstant(entry.sunsetAt)) {
      // Refused loudly rather than folded into "absent": a date this
      // build cannot read is a defect in the table, and reporting it as
      // "no announcement" would hide the one thing worth fixing.
      return undetermined(
        model,
        EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyEntryMalformed,
        reviewedAt,
      );
    }
    return {
      state: EMBEDDING_SUNSET.announced,
      model,
      sunset_at: entry.sunsetAt,
      days_remaining: Math.floor((parseIsoUtc(entry.sunsetAt) - nowMs) / MS_PER_DAY),
      reason: null,
      surveyed_at: reviewedAt,
      source: EMBEDDING_SUNSET_SOURCE.survey,
      overrode_survey: false,
      survey_sunset_at: null,
    };
  }
  // A surveyed NEGATIVE, and negatives expire.
  const reviewedMs = parseIsoUtc(reviewedAt);
  const staleAfter = reviewedMs + EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS * MS_PER_DAY;
  if (!Number.isFinite(reviewedMs) || nowMs > staleAfter) {
    return undetermined(model, EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyStale, reviewedAt);
  }
  return {
    state: EMBEDDING_SUNSET.noneAnnounced,
    model,
    sunset_at: null,
    days_remaining: null,
    reason: null,
    surveyed_at: reviewedAt,
    source: EMBEDDING_SUNSET_SOURCE.survey,
    overrode_survey: false,
    survey_sunset_at: null,
  };
}

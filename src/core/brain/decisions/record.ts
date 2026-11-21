/**
 * Decision-record note family (Belief lifecycle suite, Track B anchor,
 * t_ac03214d).
 *
 * A decision is the highest-value operator memory: the choice made, the
 * key assumption riding on it, a date to review whether it held, an
 * (initially empty) outcome that hindsight backfills, and an optional
 * pre-mortem ("how could this go wrong"). Each decision is a Markdown
 * page under `Brain/decisions/decision-<slug>.md`: operator-readable in
 * Obsidian, greppable, versionable - mirroring the `obligations.ts` and
 * `health/thesis.ts` page models.
 *
 * The `review_date` maps onto the existing obligations engine: capturing
 * a decision opens exactly one review obligation, idempotently (a second
 * attempt on the same review slug is a no-op, never a duplicate). Outcome
 * backfill is a logged mutation. Capturing a new decision can surface
 * historically similar decisions with their recorded outcomes via the
 * shared similarity machinery (`similarity.ts`) - deterministic,
 * language-agnostic token overlap, no model call.
 *
 * Import direction: this module imports from obligations / paths / log /
 * similarity / vault helpers, never the reverse.
 */

import { originFields, type RecordOrigin } from "../record-origin.ts";
import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { sanitiseTextField } from "../../redactor.ts";
import {
  claimedTitleSlot,
  locateTitledPage,
  titleSlug,
  type TitledPageLocation,
  type TitledPageLookup,
} from "../../vault.ts";
import { appendLogEvent } from "../log.ts";
import { addObligation, ObligationError, obligationSlotPlan } from "../obligations.ts";
import { decisionPath, decisionsDir, isValidSlug, validateIsoDate } from "../paths.ts";
import { BRAIN_DECISIONS_REL } from "../path-constants.ts";
import { jaccard, tokenise } from "../similarity.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND, type BrainCommitmentTier } from "../types.ts";
import { readCommitmentTier, validateCommitmentTier } from "../commitment.ts";
import {
  appendDecisionChangeReceipt,
  DECISION_CHANGE_REASON,
  RECEIPT_ABSENT_STATE,
  type AppendReceiptInput,
} from "./receipts.ts";
import {
  assertLaneWrite,
  lanePageExists,
  laneStems,
  listLaneFiles,
  parseLanePage,
  writeLaneText,
} from "../../store/lane-pages.ts";

// ----- Constants ------------------------------------------------------------

/** Frontmatter `type` discriminator carried by every decision note. */
export const DECISION_TYPE = "decision";
/** Cap on the short prose frontmatter fields (chosen/assumption/etc). */
const FIELD_MAX_LEN = 512;
/** Cap on the decision title. */
const TITLE_MAX_LEN = 200;
/**
 * Cadence stamped on the review obligation. A decision review is
 * effectively a one-shot check; `yearly` is the least-nagging recurring
 * cadence the obligations engine offers, so a completed-then-advanced
 * obligation does not re-fire for a year.
 */
export const DECISION_REVIEW_CADENCE = "yearly";
/** Default jaccard floor for {@link findSimilarDecisions}. */
export const DECISION_SIMILARITY_THRESHOLD = 0.2;
/** Prefix applied to the review-obligation title. */
const REVIEW_OBLIGATION_TITLE_PREFIX = "Review decision:";
/** Inclusive lower bound of a decision rating (B2). */
export const DECISION_RATING_MIN = 1;
/** Inclusive upper bound of a decision rating (B2). */
export const DECISION_RATING_MAX = 5;
/** Receipt before/after state prefix for the chosen option (B4 trail). */
const RECEIPT_CHOSEN_PREFIX = "chosen:";
/** Receipt before/after state prefix for the hindsight outcome (B4 trail). */
const RECEIPT_OUTCOME_PREFIX = "outcome:";
/** Receipt before/after state prefix for the quality rating (B4 trail). */
const RECEIPT_RATING_PREFIX = "rating:";
/** Receipt state token for an unset rating (B4 trail). */
const RECEIPT_RATING_UNSET = "none";

// ----- Errors ---------------------------------------------------------------

/** Every failure path in this module raises this typed error. */
export class DecisionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DecisionError";
  }
}

// ----- Shapes ---------------------------------------------------------------

export interface DecisionRecord {
  readonly slug: string;
  /** Filename basename without `.md`. Equals `decision-<slug>`. */
  readonly id: string;
  /** Frontmatter type discriminator; always {@link DECISION_TYPE}. */
  readonly type: typeof DECISION_TYPE;
  /** The decision question / statement (drives the slug). */
  readonly title: string;
  /** The option that was chosen. */
  readonly chosen: string;
  /** The key assumption the decision rides on. */
  readonly assumption: string;
  /** Review date (`YYYY-MM-DD`), or null when none was captured. */
  readonly reviewDate: string | null;
  /** Hindsight outcome; empty until {@link backfillOutcome} runs. */
  readonly outcome: string;
  /** Optional pre-mortem ("how could this go wrong"). */
  readonly premortem: string | null;
  readonly createdAt: string;
  readonly agent: string;
  /**
   * Quality self-assessment in [{@link DECISION_RATING_MIN},
   * {@link DECISION_RATING_MAX}] (B2). `null` when the decision is
   * unrated; an unrated decision omits the frontmatter key entirely so
   * its on-disk shape is byte-identical to a B1 decision.
   */
  readonly rating: number | null;
  /** Free-form justification for the rating (B2); empty when unrated. */
  readonly rationale: string;
  /**
   * Optional commitment tier (B3): `exploring | leaning | decided |
   * locked`. `null` when unset; round-trips through frontmatter, emitted
   * only when set so unset decisions stay byte-identical.
   */
  readonly commitment: BrainCommitmentTier | null;
  /** Free-form operator prose from the note body. */
  readonly notes: string;
  readonly path: string;
}

export interface RecordDecisionInput {
  readonly title: string;
  readonly chosen: string;
  readonly assumption: string;
  /** Review date (`YYYY-MM-DD`); opens exactly one review obligation. */
  readonly reviewDate: string;
  readonly premortem?: string;
  readonly notes?: string;
  /** Optional quality rating captured at record time (B2). */
  readonly rating?: number;
  /** Optional rationale for the rating (B2). */
  readonly rationale?: string;
  /** Optional commitment tier captured at record time (B3); validated on write. */
  readonly commitment?: BrainCommitmentTier;
  readonly agent: string;
  readonly now?: Date;
  readonly configPath?: string;
  /**
   * The project and session the decision was made in (`record-origin.ts`),
   * stamped into its log event so topic planning can group it.
   */
  readonly origin?: RecordOrigin;
  /**
   * The caller's reach ({@link DecisionReadOptions}). A page an older
   * release stored under the title's Latin-only slug that the caller may
   * not read is not this title's duplicate: the decision is recorded
   * under the title's own slug, as over an absent page. A page at that
   * slug is refused whoever may read it, because recording would replace
   * it.
   */
  readonly readable?: (rel: string) => boolean;
}

export interface RecordDecisionResult {
  readonly record: DecisionRecord;
  /** Slug of the opened review obligation. */
  readonly reviewObligationSlug: string;
  /** False when the review obligation already existed (idempotent). */
  readonly obligationCreated: boolean;
}

/**
 * The vault-relative paths the caller may read. A decision page it may
 * not read is answered exactly as an absent one: skipped by every list,
 * and refused by every single-slug read or write with the absent slug's
 * error, before anything is written. Absent, every page may be read.
 */
export interface DecisionReadOptions {
  readonly readable?: (rel: string) => boolean;
}

export interface BackfillOutcomeInput extends DecisionReadOptions {
  readonly slug: string;
  readonly outcome: string;
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

export interface UpdateRatingInput extends DecisionReadOptions {
  readonly slug: string;
  readonly rating: number;
  readonly rationale?: string;
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

export interface SimilarDecision {
  readonly slug: string;
  readonly id: string;
  readonly title: string;
  readonly chosen: string;
  readonly outcome: string;
  readonly jaccard: number;
}

export interface SimilarDecisionQuery {
  readonly title: string;
  readonly chosen?: string;
  /** Never return a decision with this slug (the one being captured). */
  readonly excludeSlug?: string;
}

export interface FindSimilarDecisionsOptions extends DecisionReadOptions {
  readonly threshold?: number;
  readonly limit?: number;
}

// ----- Field helpers --------------------------------------------------------

function requireField(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new DecisionError(`decision: ${label} is required`);
  }
  const cleaned = sanitiseTextField(value, {
    maxLen: label === "title" ? TITLE_MAX_LEN : FIELD_MAX_LEN,
    singleLine: true,
  }).trim();
  if (!cleaned) throw new DecisionError(`decision: ${label} is required`);
  return cleaned;
}

function optionalField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = sanitiseTextField(value, { maxLen: FIELD_MAX_LEN, singleLine: true }).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function requireReviewDate(value: string): string {
  try {
    return validateIsoDate(value);
  } catch {
    throw new DecisionError(`decision: review_date is not a valid calendar date: ${value}`);
  }
}

/**
 * Validate a rating: an integer in the inclusive
 * [{@link DECISION_RATING_MIN}, {@link DECISION_RATING_MAX}] band.
 */
function requireRating(value: number): number {
  if (!Number.isInteger(value) || value < DECISION_RATING_MIN || value > DECISION_RATING_MAX) {
    throw new DecisionError(
      `decision: rating must be an integer in [${DECISION_RATING_MIN}, ${DECISION_RATING_MAX}]`,
    );
  }
  return value;
}

/**
 * Parse a stored rating, tolerating a hand-edited value; null when
 * absent or invalid. The flat frontmatter parser returns scalars as
 * strings, so a numeric string (`"4"`) is accepted as well as a number.
 */
function parseRating(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return null;
  if (!Number.isInteger(n) || n < DECISION_RATING_MIN || n > DECISION_RATING_MAX) return null;
  return n;
}

// ----- Change receipts (B4) -------------------------------------------------

/**
 * Emit one decision-change receipt for a decision mutation. A mutation
 * whose before-state equals its after-state changed no belief, so it
 * emits nothing (an operator re-applying the same value is a no-op, in
 * the spirit of the receipt idempotency key). Fail-soft otherwise: the
 * decision note and its `decision-*` log event are authoritative, so an
 * accountability-log hiccup must never fail the mutation itself. This
 * mirrors the lifecycle supersede/tombstone receipt path.
 */
function emitDecisionChangeReceipt(vault: string, input: AppendReceiptInput): void {
  if (input.before === input.after) return;
  try {
    appendDecisionChangeReceipt(vault, input);
  } catch {
    // Receipt is best-effort accountability; the decision note and its
    // `decision-*` log event remain authoritative.
  }
}

// ----- (De)serialization ----------------------------------------------------

function render(record: Omit<DecisionRecord, "path">): string {
  const lines = [
    "---",
    `type: ${DECISION_TYPE}`,
    `id: ${record.id}`,
    `title: ${JSON.stringify(record.title)}`,
    `chosen: ${JSON.stringify(record.chosen)}`,
    `assumption: ${JSON.stringify(record.assumption)}`,
    `review_date: ${record.reviewDate ?? ""}`,
    `outcome: ${JSON.stringify(record.outcome)}`,
  ];
  if (record.premortem !== null) lines.push(`premortem: ${JSON.stringify(record.premortem)}`);
  // Rating fields are omitted entirely when unset so an unrated decision
  // is byte-identical to a B1-era note (additive-only surface).
  if (record.rating !== null) {
    lines.push(`rating: ${record.rating}`);
    lines.push(`rationale: ${JSON.stringify(record.rationale)}`);
  }
  // Commitment tier (B3): emitted only when set so an unset decision is
  // byte-identical to a pre-B3 note.
  if (record.commitment !== null) lines.push(`commitment: ${record.commitment}`);
  lines.push(`created_at: ${record.createdAt}`);
  lines.push(`agent: ${JSON.stringify(record.agent)}`);
  lines.push("---", "", record.notes, "");
  return lines.join("\n");
}

/**
 * The decision page a caller's title or listed slug names, at the caller's
 * reach ({@link locateTitledPage}). A listed slug names the page stored at
 * it. A title names only a page that stores exactly that title: at its
 * {@link titleSlug}, or at the Latin-only slug an older release gave it.
 * So a title that only keys like a stored one ("Ship the parser, to Ada"
 * beside "Ship the parser to Ada", or the same Cyrillic words in another
 * case) reaches nothing, and the refusal names the value's own slug. An
 * old slug the decision path refuses (`con`, a Windows device name) could
 * never hold a page and counts as absent. A page the caller may not read
 * is never parsed and answers like an absent one.
 */
export function locateDecision(
  vault: string,
  value: string,
  readable?: DecisionReadOptions["readable"],
): TitledPageLocation<DecisionRecord> {
  return locateTitledPage(value, decisionLookup(vault, readable));
}

function decisionLookup(
  vault: string,
  readable: DecisionReadOptions["readable"],
): TitledPageLookup<DecisionRecord> {
  return {
    read: (slug) => (isValidSlug(slug) ? parsePage(vault, slug, readable) : null),
    titleOf: (page) => page.title,
    stems: () => laneStems(vault, decisionsDir(vault), "decision-"),
  };
}

/** The slug {@link locateDecision} lands on: the page's, or the value's own when none matched. */
export function resolveDecisionSlug(
  vault: string,
  value: string,
  readable?: DecisionReadOptions["readable"],
): string {
  return locateDecision(vault, value, readable).slug;
}

/**
 * The page recording `title` would collide with: the page at its
 * {@link titleSlug}, whatever title it holds and whoever may read it
 * (recording would replace it), a page the caller may read that stores
 * this title under the Latin-only slug an older release gave it, or a
 * slug another decision the caller may read claims
 * ({@link claimedTitleSlot}: `title` is that decision's listed slug, or
 * its `titleSlug` is the exact title of a decision filed under its old
 * slug), so a lookup by title and by listed slug keep naming one record
 * each.
 */
export function takenDecisionSlug(
  vault: string,
  title: string,
  readable: DecisionReadOptions["readable"],
): string | null {
  const slug = titleSlug(title);
  if (lanePageExists(vault, decisionPath(vault, slug))) return slug;
  const located = locateDecision(vault, title, readable);
  if (located.page !== null) return located.slug;
  return claimedTitleSlot(title, decisionLookup(vault, readable));
}

function parsePage(
  vault: string,
  slug: string,
  readable: DecisionReadOptions["readable"],
): DecisionRecord | null {
  const path = decisionPath(vault, slug);
  if (!lanePageExists(vault, path)) return null;
  if (readable !== undefined && !readable(decisionRel(slug))) return null;
  const [meta, body] = parseLanePage(vault, path);
  if (meta["type"] !== DECISION_TYPE) return null;
  const reviewRaw = typeof meta["review_date"] === "string" ? meta["review_date"].trim() : "";
  let reviewDate: string | null = null;
  if (reviewRaw.length > 0) {
    try {
      reviewDate = validateIsoDate(reviewRaw);
    } catch {
      reviewDate = null;
    }
  }
  const premortemRaw = typeof meta["premortem"] === "string" ? meta["premortem"] : "";
  return Object.freeze({
    slug,
    id: `decision-${slug}`,
    type: DECISION_TYPE,
    title: typeof meta["title"] === "string" ? meta["title"] : slug,
    chosen: typeof meta["chosen"] === "string" ? meta["chosen"] : "",
    assumption: typeof meta["assumption"] === "string" ? meta["assumption"] : "",
    reviewDate,
    outcome: typeof meta["outcome"] === "string" ? meta["outcome"] : "",
    premortem: premortemRaw.length > 0 ? premortemRaw : null,
    createdAt: typeof meta["created_at"] === "string" ? meta["created_at"] : "",
    agent: typeof meta["agent"] === "string" ? meta["agent"] : "",
    rating: parseRating(meta["rating"]),
    rationale: typeof meta["rationale"] === "string" ? meta["rationale"] : "",
    commitment: readCommitmentTier(meta),
    notes: body.trim(),
    path,
  });
}

/** The vault-relative POSIX path of one decision page, as the reach predicate reads it. */
function decisionRel(slug: string): string {
  return `${BRAIN_DECISIONS_REL}/decision-${slug}.md`;
}

// ----- Review obligation ----------------------------------------------------

function reviewObligationTitle(decisionTitle: string): string {
  return `${REVIEW_OBLIGATION_TITLE_PREFIX} ${decisionTitle}`;
}

/**
 * Ensure the single review obligation for a decision exists, anchored at
 * `reviewDate`. Idempotent: the obligation that stores exactly the review
 * title (an older release's under its Latin-only slug, or one in an
 * identity-suffixed slot, included) is reused and `{ created: false }` is
 * returned. When another obligation holds the review title's slug (a
 * leftover of a removed decision whose title differs in case or
 * punctuation, a peer's, or a slot another obligation's exact title
 * claims), the review is opened in its identity-suffixed slot
 * ({@link obligationSlotPlan}): a record is never blocked by a leftover and
 * never attached to another obligation. One the caller may not read is not
 * reused (nor named).
 */
export function ensureReviewObligation(
  vault: string,
  input: {
    title: string;
    reviewDate: string;
    agent: string;
    now?: Date;
    readable?: DecisionReadOptions["readable"];
  },
): { slug: string; created: boolean } {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const obligationTitle = reviewObligationTitle(input.title);
  const plan = planReviewObligation(vault, input.title, input.readable);
  if (plan.existing) return { slug: plan.slug, created: false };
  const page = addObligation(vault, {
    title: obligationTitle,
    cadence: DECISION_REVIEW_CADENCE,
    agent: input.agent,
    anchor: input.reviewDate,
    slot: plan.slug,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.readable !== undefined ? { readable: input.readable } : {}),
  });
  return { slug: page.slug, created: true };
}

/**
 * Where the review obligation of a decision titled `title` goes
 * ({@link obligationSlotPlan}); refused only when every slot is held, which
 * is decided before the decision page is written.
 */
function planReviewObligation(
  vault: string,
  title: string,
  readable?: DecisionReadOptions["readable"],
): { readonly slug: string; readonly existing: boolean } {
  let plan: ReturnType<typeof obligationSlotPlan>;
  try {
    plan = obligationSlotPlan(vault, reviewObligationTitle(title), readable);
  } catch (err) {
    if (err instanceof ObligationError) {
      throw new DecisionError(`the review obligation of: ${title}: ${err.message}`);
    }
    throw err;
  }
  if (plan === null) {
    throw new DecisionError(
      `no free slot for the review obligation of: ${title} (remove a held review obligation first)`,
    );
  }
  return plan;
}

// ----- Capture --------------------------------------------------------------

/**
 * Capture a decision: write the `type: decision` note, open its review
 * obligation, and log a `decision-record` event. Refuses to clobber an
 * existing decision slug (an update is a distinct, later operation).
 */
export function recordDecision(vault: string, input: RecordDecisionInput): RecordDecisionResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const title = requireField(input.title, "title");
  const chosen = requireField(input.chosen, "chosen");
  const assumption = requireField(input.assumption, "assumption");
  const reviewDate = requireReviewDate(input.reviewDate);
  const premortem = optionalField(input.premortem);
  const rating = input.rating !== undefined ? requireRating(input.rating) : null;
  const rationale =
    rating !== null
      ? sanitiseTextField(input.rationale ?? "", { maxLen: FIELD_MAX_LEN, singleLine: true }).trim()
      : "";
  const commitment = validateCommitmentTier(input.commitment);
  const now = input.now ?? new Date();
  const slug = titleSlug(title);
  // The same title an older release stored under its Latin-only slug is
  // the same decision: refused as it was then, not recorded a second time.
  const existing = takenDecisionSlug(vault, title, input.readable);
  if (existing !== null) {
    throw new DecisionError(`decision already exists: ${existing} (backfill or remove it first)`);
  }
  // Decided before the page is written, so a refusal leaves no decision
  // without its review obligation.
  planReviewObligation(vault, title, input.readable);

  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);

  const record: Omit<DecisionRecord, "path"> = {
    slug,
    id: `decision-${slug}`,
    type: DECISION_TYPE,
    title,
    chosen,
    assumption,
    reviewDate,
    outcome: "",
    premortem,
    createdAt: isoSecond(now),
    agent,
    rating,
    rationale,
    commitment,
    notes: (input.notes ?? "").trim(),
  };

  const path = decisionPath(vault, slug);
  writeLaneText(vault, path, render(record));

  const review = ensureReviewObligation(vault, {
    title,
    reviewDate,
    agent,
    now,
    ...(input.readable !== undefined ? { readable: input.readable } : {}),
  });

  appendLogEvent(vault, {
    timestamp: isoSecond(now),
    eventType: BRAIN_LOG_EVENT_KIND.decisionRecord,
    body: {
      decision: `[[${record.id}]]`,
      title,
      chosen,
      review_date: reviewDate,
      obligation: review.created ? review.slug : `${review.slug} (existing)`,
      agent,
      ...originFields(input.origin),
    },
  });

  // B4 change trail: a decision's creation is a belief change with an
  // absent before-state (no prior belief existed), per the closed schema.
  emitDecisionChangeReceipt(vault, {
    subject: `[[${record.id}]]`,
    before: RECEIPT_ABSENT_STATE,
    after: `${RECEIPT_CHOSEN_PREFIX}${chosen}`,
    actor: agent,
    rationale: assumption,
    reasonCode: DECISION_CHANGE_REASON.record,
    ts: isoSecond(now),
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
  });

  return {
    record: Object.freeze({ ...record, path }),
    reviewObligationSlug: review.slug,
    obligationCreated: review.created,
  };
}

// ----- Outcome backfill -----------------------------------------------------

/**
 * Backfill the `outcome` of an existing decision (a logged mutation).
 * Preserves every other field and the body. Rejects an unknown slug or
 * an empty outcome with a typed error.
 */
export function backfillOutcome(vault: string, input: BackfillOutcomeInput): DecisionRecord {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const { slug, page: prior } = locateDecision(vault, input.slug, input.readable);
  if (prior === null) throw new DecisionError(`no decision: ${slug}`);
  const outcome = sanitiseTextField(input.outcome, {
    maxLen: FIELD_MAX_LEN,
    singleLine: true,
  }).trim();
  if (!outcome) throw new DecisionError("decision: outcome is required for backfill");
  const now = input.now ?? new Date();

  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);

  const { path: _path, ...rest } = prior;
  const next: Omit<DecisionRecord, "path"> = { ...rest, outcome };
  writeLaneText(vault, prior.path, render(next));

  appendLogEvent(vault, {
    timestamp: isoSecond(now),
    eventType: BRAIN_LOG_EVENT_KIND.decisionOutcome,
    body: {
      decision: `[[${prior.id}]]`,
      outcome,
      agent,
    },
  });

  // B4 change trail: backfilling the outcome moves the belief state from
  // the prior outcome (empty until the first backfill) to the new one.
  emitDecisionChangeReceipt(vault, {
    subject: `[[${prior.id}]]`,
    before: `${RECEIPT_OUTCOME_PREFIX}${prior.outcome}`,
    after: `${RECEIPT_OUTCOME_PREFIX}${outcome}`,
    actor: agent,
    reasonCode: DECISION_CHANGE_REASON.outcome,
    ts: isoSecond(now),
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
  });

  return Object.freeze({ ...next, path: prior.path });
}

// ----- Rating (B2) ----------------------------------------------------------

/**
 * Set or change the `rating` (and optional `rationale`) of an existing
 * decision (a logged mutation). Preserves every other field and the body.
 * Rejects an unknown slug or an out-of-range rating with a typed error.
 */
export function updateRating(vault: string, input: UpdateRatingInput): DecisionRecord {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const { slug, page: prior } = locateDecision(vault, input.slug, input.readable);
  if (prior === null) throw new DecisionError(`no decision: ${slug}`);
  const rating = requireRating(input.rating);
  const rationale =
    input.rationale !== undefined
      ? sanitiseTextField(input.rationale, { maxLen: FIELD_MAX_LEN, singleLine: true }).trim()
      : prior.rationale;
  const now = input.now ?? new Date();

  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);

  const { path: _path, ...rest } = prior;
  const next: Omit<DecisionRecord, "path"> = { ...rest, rating, rationale };
  writeLaneText(vault, prior.path, render(next));

  appendLogEvent(vault, {
    timestamp: isoSecond(now),
    eventType: BRAIN_LOG_EVENT_KIND.decisionRating,
    body: {
      decision: `[[${prior.id}]]`,
      rating: String(rating),
      ...(rationale ? { rationale } : {}),
      agent,
    },
  });

  // B4 change trail: rating is a belief-quality change; the before-state
  // is the prior rating (`none` when previously unrated).
  emitDecisionChangeReceipt(vault, {
    subject: `[[${prior.id}]]`,
    before: `${RECEIPT_RATING_PREFIX}${prior.rating ?? RECEIPT_RATING_UNSET}`,
    after: `${RECEIPT_RATING_PREFIX}${rating}`,
    actor: agent,
    ...(rationale ? { rationale } : {}),
    reasonCode: DECISION_CHANGE_REASON.rating,
    ts: isoSecond(now),
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
  });

  return Object.freeze({ ...next, path: prior.path });
}

/**
 * Every rated decision, sorted by descending rating (ties break on slug).
 * Unrated decisions are excluded - this is the rated-capture list surface,
 * separate from ordinary signal/preference recall.
 */
export function listRatedDecisions(
  vault: string,
  opts: DecisionReadOptions = {},
): DecisionRecord[] {
  return listDecisions(vault, opts)
    .filter((d) => d.rating !== null)
    .toSorted((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.slug.localeCompare(b.slug));
}

/**
 * Read a specific set of decisions side by side for comparison, in the
 * order requested. Unknown slugs are skipped (a comparison of what exists).
 */
export function compareDecisions(
  vault: string,
  slugs: ReadonlyArray<string>,
  opts: DecisionReadOptions = {},
): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const slug of slugs) {
    const { page } = locateDecision(vault, slug, opts.readable);
    if (page !== null) out.push(page);
  }
  return out;
}

// ----- Reads ----------------------------------------------------------------

/** One decision, or null. */
export function showDecision(
  vault: string,
  slug: string,
  opts: DecisionReadOptions = {},
): DecisionRecord | null {
  return locateDecision(vault, slug, opts.readable).page;
}

/** Every decision, sorted by slug. */
export function listDecisions(vault: string, opts: DecisionReadOptions = {}): DecisionRecord[] {
  const dir = decisionsDir(vault);
  if (!lanePageExists(vault, dir)) return [];
  const out: DecisionRecord[] = [];
  for (const name of listLaneFiles(vault, dir, "")) {
    if (!name.endsWith(".md") || !name.startsWith("decision-")) continue;
    const slug = name.replace(/^decision-/u, "").replace(/\.md$/u, "");
    const page = parsePage(vault, slug, opts.readable);
    if (page !== null) out.push(page);
  }
  return out.toSorted((a, b) => a.slug.localeCompare(b.slug));
}

// ----- Similar-decision lookup ----------------------------------------------

/**
 * Surface historically similar decisions with their recorded outcomes,
 * ranked by descending token-overlap (jaccard) of the query's
 * title+chosen against each stored decision's title+chosen. Deterministic
 * and language-agnostic (shared `tokenise`/`jaccard`, no stopword list,
 * no model). Ties break on slug for stable output.
 */
export function findSimilarDecisions(
  vault: string,
  query: SimilarDecisionQuery,
  opts: FindSimilarDecisionsOptions = {},
): SimilarDecision[] {
  const threshold = opts.threshold ?? DECISION_SIMILARITY_THRESHOLD;
  const queryTokens = tokenise(`${query.title} ${query.chosen ?? ""}`);
  if (queryTokens.size === 0) return [];
  const out: SimilarDecision[] = [];
  for (const decision of listDecisions(
    vault,
    opts.readable !== undefined ? { readable: opts.readable } : {},
  )) {
    if (query.excludeSlug !== undefined && decision.slug === query.excludeSlug) continue;
    const tokens = tokenise(`${decision.title} ${decision.chosen}`);
    const score = jaccard(queryTokens, tokens);
    if (score < threshold) continue;
    out.push({
      slug: decision.slug,
      id: decision.id,
      title: decision.title,
      chosen: decision.chosen,
      outcome: decision.outcome,
      jaccard: score,
    });
  }
  out.sort((a, b) => b.jaccard - a.jaccard || a.slug.localeCompare(b.slug));
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

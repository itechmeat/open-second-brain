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

import { existsSync, mkdirSync, readdirSync } from "node:fs";

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { sanitiseTextField } from "../../redactor.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatter, slugify } from "../../vault.ts";
import { appendLogEvent } from "../log.ts";
import { addObligation } from "../obligations.ts";
import { decisionPath, decisionsDir, obligationPath, validateIsoDate } from "../paths.ts";
import { jaccard, tokenise } from "../similarity.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";

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
  readonly agent: string;
  readonly now?: Date;
  readonly configPath?: string;
}

export interface RecordDecisionResult {
  readonly record: DecisionRecord;
  /** Slug of the opened review obligation. */
  readonly reviewObligationSlug: string;
  /** False when the review obligation already existed (idempotent). */
  readonly obligationCreated: boolean;
}

export interface BackfillOutcomeInput {
  readonly slug: string;
  readonly outcome: string;
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

export interface FindSimilarDecisionsOptions {
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
  lines.push(`created_at: ${record.createdAt}`);
  lines.push(`agent: ${JSON.stringify(record.agent)}`);
  lines.push("---", "", record.notes, "");
  return lines.join("\n");
}

function parsePage(vault: string, slug: string): DecisionRecord | null {
  const path = decisionPath(vault, slug);
  if (!existsSync(path)) return null;
  const [meta, body] = parseFrontmatter(path);
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
    notes: body.trim(),
    path,
  });
}

// ----- Review obligation ----------------------------------------------------

function reviewObligationTitle(decisionTitle: string): string {
  return `${REVIEW_OBLIGATION_TITLE_PREFIX} ${decisionTitle}`;
}

/**
 * Ensure the single review obligation for a decision exists, anchored at
 * `reviewDate`. Idempotent: if the obligation slug already exists, this
 * is a no-op returning `{ created: false }` rather than raising the
 * obligations engine's duplicate error.
 */
export function ensureReviewObligation(
  vault: string,
  input: { title: string; reviewDate: string; agent: string; now?: Date },
): { slug: string; created: boolean } {
  const obligationTitle = reviewObligationTitle(input.title);
  const slug = slugify(obligationTitle);
  if (existsSync(obligationPath(vault, slug))) {
    return { slug, created: false };
  }
  const page = addObligation(vault, {
    title: obligationTitle,
    cadence: DECISION_REVIEW_CADENCE,
    agent: input.agent,
    anchor: input.reviewDate,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { slug: page.slug, created: true };
}

// ----- Capture --------------------------------------------------------------

/**
 * Capture a decision: write the `type: decision` note, open its review
 * obligation, and log a `decision-record` event. Refuses to clobber an
 * existing decision slug (an update is a distinct, later operation).
 */
export function recordDecision(vault: string, input: RecordDecisionInput): RecordDecisionResult {
  const title = requireField(input.title, "title");
  const chosen = requireField(input.chosen, "chosen");
  const assumption = requireField(input.assumption, "assumption");
  const reviewDate = requireReviewDate(input.reviewDate);
  const premortem = optionalField(input.premortem);
  const now = input.now ?? new Date();
  const slug = slugify(title);

  if (existsSync(decisionPath(vault, slug))) {
    throw new DecisionError(`decision already exists: ${slug} (backfill or remove it first)`);
  }

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
    notes: (input.notes ?? "").trim(),
  };

  mkdirSync(decisionsDir(vault), { recursive: true });
  const path = decisionPath(vault, slug);
  atomicWriteFileSync(path, render(record));

  const review = ensureReviewObligation(vault, { title, reviewDate, agent, now });

  appendLogEvent(vault, {
    timestamp: isoSecond(now),
    eventType: BRAIN_LOG_EVENT_KIND.decisionRecord,
    body: {
      decision: `[[${record.id}]]`,
      chosen,
      review_date: reviewDate,
      obligation: review.created ? review.slug : `${review.slug} (existing)`,
      agent,
    },
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
  const slug = slugify(input.slug);
  const prior = parsePage(vault, slug);
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
  atomicWriteFileSync(prior.path, render(next));

  appendLogEvent(vault, {
    timestamp: isoSecond(now),
    eventType: BRAIN_LOG_EVENT_KIND.decisionOutcome,
    body: {
      decision: `[[${prior.id}]]`,
      outcome,
      agent,
    },
  });

  return Object.freeze({ ...next, path: prior.path });
}

// ----- Reads ----------------------------------------------------------------

/** One decision, or null. */
export function showDecision(vault: string, slug: string): DecisionRecord | null {
  return parsePage(vault, slugify(slug));
}

/** Every decision, sorted by slug. */
export function listDecisions(vault: string): DecisionRecord[] {
  const dir = decisionsDir(vault);
  if (!existsSync(dir)) return [];
  const out: DecisionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || !name.startsWith("decision-")) continue;
    const slug = name.replace(/^decision-/u, "").replace(/\.md$/u, "");
    const page = parsePage(vault, slug);
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
  for (const decision of listDecisions(vault)) {
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

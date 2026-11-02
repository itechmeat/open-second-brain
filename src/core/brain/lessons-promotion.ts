/**
 * Operator-approved lesson promotion (t_1e952e43).
 *
 * The promotion kernel the CLI verbs, the doctor check and the status
 * snapshot all consume. A lesson leaves the brain and enters the managed
 * lessons block of an agent rules file ONLY when the full qualification
 * conjunction holds:
 *
 *   - preference-derived (dead-end lessons never promote);
 *   - the preference is `confirmed` (not unconfirmed, not quarantine);
 *   - the confidence band is `high`;
 *   - the lesson tier is `preferred` in the current digest;
 *   - the preference's scope is an explicitly enabled promotion scope
 *     (`lessons.promotion.scopes`; absent-or-empty disables promotion);
 *   - an approval row is on record, decision `approved`, and FRESH: the
 *     approved content hash still matches the live preference text. The
 *     operator approves text, not an id - a drifted preference drops from
 *     the block until it is approved again.
 *
 * Every non-member carries exactly ONE named blocked reason from the
 * closed {@link LESSON_PROMOTION_BLOCKED} vocabulary, with a pinned
 * precedence (an operator denial dominates the report; intrinsic gates
 * are reported before the approval gates that sit downstream of them).
 *
 * The block body is a pure, deterministic render of the qualified set:
 * identical inputs produce identical bytes, no timestamp ever appears,
 * ordering is tier, then scope, then id. Every rendered lesson is
 * provably one line that cannot forge a managed-block marker: the
 * principle is whitespace-collapsed, and a scope or id carrying a line
 * break or a marker-shaped sequence REFUSES the render by name
 * ({@link LessonRenderError}) rather than being silently rewritten.
 * Idempotence lives in the shared
 * rules-block writer (`src/core/install/rules-block.ts`), which is the
 * ONLY writer for these files: this module never touches a rules file,
 * it only renders bodies and keeps the approval ledger.
 *
 * The approval ledger is machine state in the derived store
 * (`<vault>/.open-second-brain/lessons-approvals.json`), deliberately
 * outside `Brain/`: an agent must not read its own approval state as a
 * note surface. It is a state TABLE keyed by preference id (the latest
 * decision per id wins), not a history - the audit history is the
 * `lessons-approved` / `lessons-denied` / `lessons-promoted` log events.
 * It follows the house ledger discipline (`session-mining-ledger.ts`):
 * schema-versioned, fail-closed on any damage, written under the file
 * lock through the shared atomic writer, sorted-key serialization.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { discoverConfig, LESSONS_PROMOTION_SCOPES_ENV_KEY } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { RULES_BLOCK_ID, RULES_BLOCK_MARKERS, type RulesBlockId } from "../install/rules-block.ts";
import { computeContentHash } from "./content-hash.ts";
import { listDeadEnds } from "./dead-ends.ts";
import { LESSON_TIER, computeLessons, type LessonEntry, type LessonTier } from "./lessons.ts";
import { DERIVED_STORE_DIR } from "./path-constants.ts";
import { brainDirs, preferencePath } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import {
  LESSONS_CORROBORATION_MIN_DEFAULT,
  LESSONS_HALF_LIFE_DAYS_DEFAULT,
  LESSONS_LIMIT_DEFAULT,
  LESSONS_PROMOTION_SCOPES_CONFIG_KEY,
  resolveLessonsPromotionScopes,
  type LessonsPromotionScopesResolution,
} from "./policy/blocks/lessons.ts";
import { loadBrainConfig } from "./policy.ts";
import { acquireLockSyncWithRetry, ingestLockRemedy } from "./sync-lockfile.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainConfidence, type BrainPreference } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export { LESSONS_PROMOTION_SCOPES_CONFIG_KEY };
export {
  LESSONS_PROMOTION_SCOPES_ORIGIN,
  resolveLessonsPromotionScopes,
  type LessonsPromotionScopesOrigin,
  type LessonsPromotionScopesResolution,
} from "./policy/blocks/lessons.ts";

// ----- Promotion scope resolution (malformed values refuse by name) ---------

/**
 * A promotion scopes value that is PRESENT but malformed (the
 * bracket-shaped list syntax the flat config key cannot represent). The
 * policy block's resolver keeps its documented fallback (such a value
 * resolves disabled with origin `absent`); this kernel boundary refuses
 * instead, because an operator must be able to tell "configured wrong"
 * from "never configured" - promotion is consent-bearing, and a mistyped
 * key must not silently read as a decision to disable it.
 */
export class LessonsPromotionScopesMalformedError extends Error {
  constructor(
    message: string,
    public readonly source: "env" | "config",
    public readonly rawValue: string,
  ) {
    super(message);
    this.name = "LessonsPromotionScopesMalformedError";
  }
}

/**
 * Same shape test as the policy resolver's private `isBracketShapedList`;
 * the two must stay in step, and the pin is
 * `tests/core/brain/lessons-promotion.test.ts` (the strict refusal test
 * exercises both layers over one value).
 */
function isBracketShapedListValue(raw: string): boolean {
  return raw.startsWith("[") && raw.endsWith("]");
}

/**
 * Resolve the promotion scopes for promotion: the policy resolver's
 * answer, unless a present value is malformed - then a named refusal.
 * The environment twin is checked first (it wins precedence, so its
 * malformed value must not hide behind a valid config value either).
 */
export function resolvePromotionScopesStrict(
  configPath?: string,
): LessonsPromotionScopesResolution {
  const remedy =
    'set a comma-separated list (for example "backend, testing") or remove the key; ' +
    "promotion stays disabled until then";
  const env = process.env[LESSONS_PROMOTION_SCOPES_ENV_KEY]?.trim();
  if (env !== undefined && env !== "" && isBracketShapedListValue(env)) {
    throw new LessonsPromotionScopesMalformedError(
      `lessons.promotion.scopes is malformed: ${LESSONS_PROMOTION_SCOPES_ENV_KEY} is set to ` +
        `"${env}", a bracket-shaped list the flat config key cannot represent; ${remedy}`,
      "env",
      env,
    );
  }
  const raw = discoverConfig(configPath).data[LESSONS_PROMOTION_SCOPES_CONFIG_KEY]?.trim();
  if (raw !== undefined && raw !== "" && isBracketShapedListValue(raw)) {
    throw new LessonsPromotionScopesMalformedError(
      `lessons.promotion.scopes is malformed: the config value is "${raw}", a bracket-shaped ` +
        `list the flat config key cannot represent; ${remedy}`,
      "config",
      raw,
    );
  }
  return resolveLessonsPromotionScopes(configPath);
}

// ----- Promotion qualification ----------------------------------------------

/**
 * Why a lesson is NOT promotable. Closed vocabulary; every non-member of
 * the qualified set carries exactly one member as its reason.
 */
export const LESSON_PROMOTION_BLOCKED = Object.freeze({
  /** An operator deny row is on record for this id. */
  denied: "denied",
  /** The preference is unconfirmed or quarantined. */
  unconfirmed: "unconfirmed",
  /** No scope, or a scope outside the enabled promotion scopes. */
  scopeNotEnabled: "scope_not_enabled",
  /** The confidence band is below `high`. */
  lowConfidence: "low_confidence",
  /** No lesson entry yet, or its tier is below `preferred`. */
  tierNotPreferred: "tier_not_preferred",
  /** An approval is on record but its pinned content hash no longer matches. */
  staleApproval: "stale_approval",
  /** No approval row is on record for this id. */
  notApproved: "not_approved",
} as const);

/** Closed union over {@link LESSON_PROMOTION_BLOCKED}. */
export type LessonPromotionBlocked =
  (typeof LESSON_PROMOTION_BLOCKED)[keyof typeof LESSON_PROMOTION_BLOCKED];

/** The blocked reasons, in pinned precedence order (see below). */
export const LESSON_PROMOTION_BLOCKED_MEMBERS: ReadonlyArray<LessonPromotionBlocked> =
  Object.freeze(Object.values(LESSON_PROMOTION_BLOCKED));

/** True when `value` (read back off disk or wire) is a blocked reason. */
export function isLessonPromotionBlocked(value: unknown): value is LessonPromotionBlocked {
  return (
    typeof value === "string" &&
    (LESSON_PROMOTION_BLOCKED_MEMBERS as ReadonlyArray<string>).includes(value)
  );
}

/** One lesson qualified for promotion into the rules-file block. */
export interface LessonPromotionCandidate {
  readonly prefId: string;
  readonly principle: string;
  readonly scope: string;
  readonly tier: LessonTier;
  readonly confidence: BrainConfidence;
  /**
   * Hash of the LIVE preference text in the shared `content-hash.ts`
   * vocabulary - the value an approval row must pin to stay fresh.
   */
  readonly contentHash: string;
}

/** One non-member of the qualified set, with its single named reason. */
export interface BlockedLessonPromotion {
  readonly prefId: string;
  readonly reason: LessonPromotionBlocked;
}

export interface LessonPromotionCandidatesOptions {
  /** The enabled promotion scope names (resolved `lessons.promotion.scopes`). */
  readonly enabledScopes: ReadonlyArray<string>;
}

/**
 * The approval decision currently in force for one preference id: the
 * LAST row for that id in array order (the ledger is a state table; its
 * reader returns rows in id order, so a caller passing `undefined` for a
 * missing id resolves to `undefined` here).
 */
export function currentApprovalFor(
  approvals: ReadonlyArray<LessonApprovalRow>,
  prefId: string,
): LessonApprovalRow | null {
  let found: LessonApprovalRow | null = null;
  for (const row of approvals) {
    if (row.prefId === prefId) found = row;
  }
  return found;
}

/**
 * Classify every input preference into promotable lessons and
 * blocked-with-one-reason rows. Pure: reads nothing, writes nothing; the
 * caller resolves the enabled scopes (with the vault) and reads the
 * ledger. Blocked reasons follow the pinned precedence:
 *
 *   1. `denied`      - the operator's explicit will dominates the report;
 *   2. `unconfirmed` - intrinsic gate, cheapest and first in the ladder;
 *   3. `scope_not_enabled` - promotion must stay inside enabled scopes;
 *   4. `low_confidence`    - band below `high`;
 *   5. `tier_not_preferred` - the digest has not earned the tier;
 *   6. `stale_approval`    - approved once, but the text moved;
 *   7. `not_approved`      - no operator decision yet.
 */
export function lessonPromotionCandidates(
  preferences: ReadonlyArray<BrainPreference>,
  lessons: ReadonlyArray<LessonEntry>,
  approvals: ReadonlyArray<LessonApprovalRow>,
  opts: LessonPromotionCandidatesOptions,
): {
  readonly promotable: ReadonlyArray<LessonPromotionCandidate>;
  readonly blocked: ReadonlyArray<BlockedLessonPromotion>;
} {
  const lessonByPrefId = new Map<string, LessonEntry>();
  for (const entry of lessons) {
    if (entry.kind !== "preference") continue;
    lessonByPrefId.set(entry.id, entry);
  }

  const promotable: LessonPromotionCandidate[] = [];
  const blocked: BlockedLessonPromotion[] = [];

  for (const pref of preferences) {
    const reason = blockedReasonFor(
      pref,
      lessonByPrefId.get(pref.id),
      approvals,
      opts.enabledScopes,
    );
    if (reason === null) {
      promotable.push({
        prefId: pref.id,
        principle: pref.principle,
        scope: (pref.scope ?? "").trim(),
        tier: lessonByPrefId.get(pref.id)?.tier ?? LESSON_TIER.preferred,
        confidence: pref.confidence,
        contentHash: computeContentHash(pref.principle, pref.scope),
      });
    } else {
      blocked.push({ prefId: pref.id, reason });
    }
  }

  return { promotable, blocked };
}

/** The single pinned blocked reason for `pref`, or null when qualified. */
function blockedReasonFor(
  pref: BrainPreference,
  lesson: LessonEntry | undefined,
  approvals: ReadonlyArray<LessonApprovalRow>,
  enabledScopes: ReadonlyArray<string>,
): LessonPromotionBlocked | null {
  const approval = currentApprovalFor(approvals, pref.id);
  if (approval !== null && approval.decision === "denied") {
    return LESSON_PROMOTION_BLOCKED.denied;
  }
  if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) {
    return LESSON_PROMOTION_BLOCKED.unconfirmed;
  }
  const scope = (pref.scope ?? "").trim();
  if (scope === "" || !enabledScopes.includes(scope)) {
    return LESSON_PROMOTION_BLOCKED.scopeNotEnabled;
  }
  if (pref.confidence !== "high") {
    return LESSON_PROMOTION_BLOCKED.lowConfidence;
  }
  if (lesson === undefined || lesson.tier !== LESSON_TIER.preferred) {
    return LESSON_PROMOTION_BLOCKED.tierNotPreferred;
  }
  if (approval === null) {
    return LESSON_PROMOTION_BLOCKED.notApproved;
  }
  const liveHash = computeContentHash(pref.principle, pref.scope);
  if (approval.blockId !== RULES_BLOCK_ID.lessons || approval.approvedContentHash !== liveHash) {
    return LESSON_PROMOTION_BLOCKED.staleApproval;
  }
  return null;
}

// ----- Block body render -----------------------------------------------------

/**
 * The render order's tier rank: `preferred` first, then the tiers a
 * future producer could contribute, then the negative classes. Every
 * promotable lesson is `preferred` today, so this is stability for the
 * day the qualification changes, not a live ordering.
 */
function lessonTierRank(tier: LessonTier): number {
  return tier === LESSON_TIER.preferred ? 0 : tier === LESSON_TIER.tentative ? 1 : 2;
}

export interface RenderLessonsBlockBodyOptions {
  /**
   * Maximum lessons rendered. The caller resolves the bound from the
   * `lessons.limit` config (the digest bound promotion inherits); the
   * render enforces it here so a caller that resolves it cannot forget
   * to apply it. A positive integer is required - any other value is a
   * named refusal, never a silent clamp.
   */
  readonly limit?: number;
}

/** Which rendered field a {@link LessonRenderError} refused. */
export type LessonRenderField = "prefId" | "scope";

/**
 * One lesson cannot be rendered as one managed-block line: its scope or
 * id carries a line break or a marker-shaped sequence that could forge a
 * lessons or usage marker inside the fence. The render refuses the
 * lesson by name instead of silently rewriting the text - the operator
 * fixes the preference and approves again.
 */
export class LessonRenderError extends Error {
  constructor(
    message: string,
    public readonly prefId: string,
    public readonly field: LessonRenderField,
  ) {
    super(message);
    this.name = "LessonRenderError";
  }
}

/** Every marker string a rendered lesson line must never carry. */
const LESSON_LINE_FORBIDDEN_MARKERS: ReadonlyArray<string> = Object.freeze(
  Object.values(RULES_BLOCK_MARKERS).flatMap((pair) => [pair.begin, pair.end]),
);

/**
 * Refuse a candidate whose scope or id could break the one-line-per-
 * lesson invariant: a line break can forge a whole-line marker, and a
 * marker-shaped sequence anywhere in the scope is refused on sight (the
 * discipline is "provably cannot be a marker line", not "happens not to
 * be one"). The principle is NOT validated here - it is whitespace-
 * collapsed below, which cannot form a marker line.
 */
function assertRenderableLine(candidate: LessonPromotionCandidate): void {
  const scopeProblem = /\r|\n/.test(candidate.scope)
    ? "it carries a line break"
    : LESSON_LINE_FORBIDDEN_MARKERS.some((marker) => candidate.scope.includes(marker))
      ? "it carries a managed-block marker string"
      : null;
  if (scopeProblem !== null) {
    throw new LessonRenderError(
      `renderLessonsBlockBody refuses ${candidate.prefId}: the scope is not one renderable ` +
        "managed-block line - a scope that could forge a lessons or usage marker must never " +
        `enter the fence (${scopeProblem}); fix the preference's scope to a single-line value ` +
        "and approve again",
      candidate.prefId,
      "scope",
    );
  }
  const idProblem = /\s/.test(candidate.prefId)
    ? "it carries whitespace"
    : candidate.prefId.includes("`")
      ? "it carries a backtick"
      : null;
  if (idProblem !== null) {
    throw new LessonRenderError(
      `renderLessonsBlockBody refuses ${candidate.prefId}: the id is not one renderable ` +
        `managed-block line (${idProblem}, which would break the one-line-per-lesson shape ` +
        "and the id parser); fix the preference id and approve again",
      candidate.prefId,
      "prefId",
    );
  }
}

/** What a render produced: the body and the lessons its limit cut. */
export interface RenderedLessonsBlock {
  readonly body: string;
  /**
   * The qualified lessons that fell past the limit cut, in render order.
   * A cap that truncates silently would park a just-approved lesson
   * outside the block with no named report anywhere; callers surface
   * this list by name in their results.
   */
  readonly droppedIds: ReadonlyArray<string>;
}

/**
 * Render the body WITH its cap drops named: the same bytes
 * {@link renderLessonsBlockBody} produces, plus the ids the limit cut.
 */
export function renderLessonsBlockWithDrops(
  promotable: ReadonlyArray<LessonPromotionCandidate>,
  opts: RenderLessonsBlockBodyOptions = {},
): RenderedLessonsBlock {
  if (promotable.length === 0) {
    throw new Error(
      "renderLessonsBlockBody: nothing to render - an empty qualified set must REMOVE the " +
        "block through removeRulesBlock, not write an empty fence",
    );
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    throw new RangeError(
      `renderLessonsBlockBody: limit must be a positive integer, got ${String(opts.limit)}`,
    );
  }
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;

  const ordered = promotable.toSorted((a, b) => {
    const tierDelta = lessonTierRank(a.tier) - lessonTierRank(b.tier);
    if (tierDelta !== 0) return tierDelta;
    const scopeDelta = a.scope.localeCompare(b.scope);
    if (scopeDelta !== 0) return scopeDelta;
    return a.prefId.localeCompare(b.prefId);
  });

  const head = ordered.slice(0, limit);
  for (const candidate of head) assertRenderableLine(candidate);

  const out: string[] = [
    "Operator-approved lessons, promoted from the vault's confirmed preferences",
    "(scope-gated, hash-pinned approvals). Managed by Open Second Brain:",
    "do not hand-edit - refresh with `o2b brain lessons refresh-blocks`.",
    "",
  ];
  for (const candidate of head) {
    const principle = candidate.principle.replace(/\s+/g, " ").trim();
    out.push(`- \`${candidate.prefId}\` (scope: ${candidate.scope}) — ${principle}`);
  }
  return {
    body: out.join("\n") + "\n",
    droppedIds: ordered.slice(limit).map((candidate) => candidate.prefId),
  };
}

/**
 * Render the body that goes between the lessons markers in a rules file.
 * Deterministic: identical inputs produce identical bytes; ordering is
 * tier, then scope, then id; no timestamp ever appears (a stamped body
 * would defeat the byte-idempotent write). One line per lesson; principle
 * text is whitespace-collapsed so the one-line-per-lesson invariant holds,
 * and a scope or id that could forge a marker line is a named refusal
 * ({@link LessonRenderError}), never a silent rewrite.
 *
 * An EMPTY qualified set is a named refusal, not an empty fence: removal
 * of a whole block - markers included - is the shared writer's
 * `removeRulesBlock`, and a caller holding no promotable lessons must
 * call that instead.
 */
export function renderLessonsBlockBody(
  promotable: ReadonlyArray<LessonPromotionCandidate>,
  opts: RenderLessonsBlockBodyOptions = {},
): string {
  return renderLessonsBlockWithDrops(promotable, opts).body;
}

/**
 * The block bound a caller renders under: the `lessons.limit` config, the
 * same knob that bounds the digest the promotable set derives from.
 * A config that cannot be read resolves the shared default - config
 * errors are doctor's surface, and this is a bound, not a veto.
 */
export function lessonsBlockLimit(vault: string): number {
  try {
    const cfg = loadBrainConfig(vault);
    return cfg.lessons?.limit ?? LESSONS_LIMIT_DEFAULT;
  } catch {
    return LESSONS_LIMIT_DEFAULT;
  }
}

// ----- Approvals ledger --------------------------------------------------------

/** Only ledger schema this build understands. Anything else is refused. */
export const LESSONS_APPROVALS_SCHEMA_VERSION = 1 as const;

/** Basename of the approvals ledger inside the derived store. */
export const LESSONS_APPROVALS_FILE = "lessons-approvals.json";

/** Absolute path of the approvals ledger for a vault. */
export function lessonsApprovalsPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, LESSONS_APPROVALS_FILE);
}

/**
 * How the operator consented, in the shared consent vocabulary the
 * install ladder and the protect lane record. The lessons verbs are
 * operator-only, so a ledger row always carries one of these two.
 */
export const LESSON_DECISION_BY = Object.freeze({
  yesFlag: "yes-flag",
  interactiveYes: "interactive-yes",
} as const);
export type LessonDecisionBy = (typeof LESSON_DECISION_BY)[keyof typeof LESSON_DECISION_BY];

/** One approval state row: the decision currently in force for one id. */
export interface LessonApprovalRow {
  readonly prefId: string;
  readonly decision: "approved" | "denied";
  /** When the operator decided, ISO-8601. */
  readonly decidedAt: string;
  /** How the operator consented, from {@link LESSON_DECISION_BY}. */
  readonly decidedBy: LessonDecisionBy;
  /**
   * Hash the decision pinned, in the shared `content-hash.ts` vocabulary.
   * For an approval this is the text the operator saw; freshness is the
   * match of this hash against the live preference text.
   */
  readonly approvedContentHash: string;
  /** The rules files the decision covers (basenames). Empty on a denial. */
  readonly targets: ReadonlyArray<string>;
  /** The rules block the approval is for; always the lessons block today. */
  readonly blockId: RulesBlockId;
  /** When the block last received this lesson's content, or null. */
  readonly lastPromotedAt: string | null;
}

/** Shape of the ledger on disk: one row per decided preference id. */
interface LessonsApprovalsFileShape {
  readonly schema_version: typeof LESSONS_APPROVALS_SCHEMA_VERSION;
  readonly rows: ReadonlyArray<LessonApprovalRow>;
}

/** The remedy every file-level refusal names, in the mining-ledger style. */
const CORRUPT_LEDGER_REMEDY =
  "; to recover, move the file aside or delete it - every approval is then lifted " +
  "and every lesson needs approving again, which is the fail-closed direction";

/**
 * Read the approval ledger. A missing file is an empty ledger (nothing is
 * approved, nothing is denied). ANY damage - corrupt JSON, an unknown
 * schema version, a container that is not an object, a damaged row - is a
 * hard named refusal: a silently dropped approval would block a lesson
 * the operator approved, and a silently dropped denial would re-open one
 * they refused, so no partial read is honest here. Never reads `Brain/`:
 * the ledger lives in the derived store and stays there.
 */
export function readLessonApprovals(vault: string): ReadonlyArray<LessonApprovalRow> {
  const path = lessonsApprovalsPath(vault);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`lessons approvals ledger is corrupted JSON: ${path}${CORRUPT_LEDGER_REMEDY}`, {
      cause: err,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`lessons approvals ledger is not an object: ${path}${CORRUPT_LEDGER_REMEDY}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== LESSONS_APPROVALS_SCHEMA_VERSION) {
    throw new Error(
      `lessons approvals ledger schema_version ${String(obj["schema_version"])} not supported ` +
        `(expected ${LESSONS_APPROVALS_SCHEMA_VERSION}): ${path}${CORRUPT_LEDGER_REMEDY}`,
    );
  }
  const raw = obj["rows"];
  if (!Array.isArray(raw)) {
    throw new Error(
      `lessons approvals ledger rows is not an array: ${path}${CORRUPT_LEDGER_REMEDY}`,
    );
  }
  const rows: LessonApprovalRow[] = [];
  for (const entry of raw) {
    rows.push(readRow(entry, path));
  }
  return rows.toSorted((a, b) => a.prefId.localeCompare(b.prefId));
}

/** One row, or a named refusal when the shape is not one this build reads. */
function readRow(value: unknown, path: string): LessonApprovalRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`lessons approvals ledger holds a row that is not an object: ${path}`);
  }
  const row = value as Record<string, unknown>;
  const prefId = row["prefId"];
  const decision = row["decision"];
  const decidedAt = row["decidedAt"];
  const decidedBy = row["decidedBy"];
  const approvedContentHash = row["approvedContentHash"];
  const targets = row["targets"];
  const blockId = row["blockId"];
  const lastPromotedAt = row["lastPromotedAt"];
  if (typeof prefId !== "string" || prefId.length === 0) {
    throw new Error(`lessons approvals ledger holds a row without a prefId: ${path}`);
  }
  if (decision !== "approved" && decision !== "denied") {
    throw new Error(
      `lessons approvals ledger row ${prefId} carries decision ${String(decision)}: ${path}`,
    );
  }
  if (typeof decidedAt !== "string" || decidedAt.length === 0) {
    throw new Error(`lessons approvals ledger row ${prefId} carries no decidedAt: ${path}`);
  }
  if (decidedBy !== LESSON_DECISION_BY.yesFlag && decidedBy !== LESSON_DECISION_BY.interactiveYes) {
    throw new Error(
      `lessons approvals ledger row ${prefId} carries decidedBy ${String(decidedBy)}: ${path}`,
    );
  }
  if (typeof approvedContentHash !== "string" || approvedContentHash.length === 0) {
    throw new Error(`lessons approvals ledger row ${prefId} carries no approved hash: ${path}`);
  }
  if (!Array.isArray(targets) || targets.some((t) => typeof t !== "string" || t.length === 0)) {
    throw new Error(`lessons approvals ledger row ${prefId} carries malformed targets: ${path}`);
  }
  if (blockId !== RULES_BLOCK_ID.usage && blockId !== RULES_BLOCK_ID.lessons) {
    throw new Error(
      `lessons approvals ledger row ${prefId} carries blockId ${String(blockId)}: ${path}`,
    );
  }
  if (lastPromotedAt !== null && typeof lastPromotedAt !== "string") {
    throw new Error(
      `lessons approvals ledger row ${prefId} carries malformed lastPromotedAt: ${path}`,
    );
  }
  return {
    prefId,
    decision,
    decidedAt,
    decidedBy,
    approvedContentHash,
    targets: Object.freeze(targets as ReadonlyArray<string>),
    blockId,
    lastPromotedAt,
  };
}

/** Canonical ledger bytes: rows sorted by pref id, two-space JSON, trailing newline. */
function serializeLedger(rows: ReadonlyArray<LessonApprovalRow>): string {
  const sorted = rows.toSorted((a, b) => a.prefId.localeCompare(b.prefId));
  const shape: LessonsApprovalsFileShape = {
    schema_version: LESSONS_APPROVALS_SCHEMA_VERSION,
    rows: sorted,
  };
  return JSON.stringify(shape, null, 2) + "\n";
}

/**
 * Record (or supersede) one approval decision: the row keyed by `prefId`
 * is replaced, so the ledger stays the state table of decisions currently
 * in force. The read, merge and write are one critical section under the
 * same file lock every other Brain read-modify-write takes; the write is
 * atomic and a byte-identical no-op leaves the file untouched.
 */
export function recordLessonApproval(vault: string, row: LessonApprovalRow): void {
  assertVaultIdentityForWrite(vault);
  validateRow(row);
  const path = lessonsApprovalsPath(vault);
  const handle = acquireLockSyncWithRetry(path, undefined, { remedy: ingestLockRemedy });
  try {
    const existing = readLessonApprovals(vault).filter((r) => r.prefId !== row.prefId);
    const next = serializeLedger([...existing, row]);
    if (existsSync(path) && readFileSync(path, "utf8") === next) return;
    atomicWriteFileSync(path, next);
  } finally {
    handle.release();
  }
}

/**
 * Stamp the moment the managed block last received a lesson's content.
 * Only an approved row can be promoted; a missing or denied row is a
 * named refusal - stamping a denial would dress suppression up as
 * delivery.
 */
export function markLessonPromoted(vault: string, prefId: string, promotedAt: Date): void {
  assertVaultIdentityForWrite(vault);
  const path = lessonsApprovalsPath(vault);
  const handle = acquireLockSyncWithRetry(path, undefined, { remedy: ingestLockRemedy });
  try {
    const rows = readLessonApprovals(vault);
    const row = rows.find((r) => r.prefId === prefId);
    if (row === undefined) {
      throw new Error(`markLessonPromoted: no approval row on record for ${prefId}`);
    }
    if (row.decision !== "approved") {
      throw new Error(
        `markLessonPromoted: ${prefId} holds a ${row.decision} decision and cannot be stamped promoted`,
      );
    }
    const next = serializeLedger(
      rows.map((r) => (r.prefId === prefId ? { ...r, lastPromotedAt: isoSecond(promotedAt) } : r)),
    );
    if (existsSync(path) && readFileSync(path, "utf8") === next) return;
    atomicWriteFileSync(path, next);
  } finally {
    handle.release();
  }
}

/** Validate a row at the write boundary, so a half-formed row never lands. */
function validateRow(row: LessonApprovalRow): void {
  if (typeof row.prefId !== "string" || row.prefId.length === 0) {
    throw new Error("recordLessonApproval: row carries no prefId");
  }
  if (row.decision !== "approved" && row.decision !== "denied") {
    throw new Error(`recordLessonApproval: ${row.prefId} carries decision ${String(row.decision)}`);
  }
  if (
    row.decidedBy !== LESSON_DECISION_BY.yesFlag &&
    row.decidedBy !== LESSON_DECISION_BY.interactiveYes
  ) {
    throw new Error(
      `recordLessonApproval: ${row.prefId} carries decidedBy ${String(row.decidedBy)}`,
    );
  }
  if (typeof row.decidedAt !== "string" || Number.isNaN(Date.parse(row.decidedAt))) {
    throw new Error(`recordLessonApproval: ${row.prefId} carries a non-ISO decidedAt`);
  }
  if (typeof row.approvedContentHash !== "string" || row.approvedContentHash.length === 0) {
    throw new Error(`recordLessonApproval: ${row.prefId} carries no approved content hash`);
  }
  if (!Array.isArray(row.targets) || row.targets.some((t) => typeof t !== "string" || t === "")) {
    throw new Error(`recordLessonApproval: ${row.prefId} carries malformed targets`);
  }
  if (row.blockId !== RULES_BLOCK_ID.usage && row.blockId !== RULES_BLOCK_ID.lessons) {
    throw new Error(`recordLessonApproval: ${row.prefId} carries blockId ${String(row.blockId)}`);
  }
  if (row.lastPromotedAt !== null && typeof row.lastPromotedAt !== "string") {
    throw new Error(`recordLessonApproval: ${row.prefId} carries a malformed lastPromotedAt`);
  }
}

// ----- Vault-side inputs -----------------------------------------------------

/** Everything one promotion pass reads from the vault, gathered once. */
export interface LessonsPromotionInputs {
  /** Every parseable active preference under `Brain/preferences/`. */
  readonly preferences: ReadonlyArray<BrainPreference>;
  /** The signed, recency-scored digest entries the tiers come from. */
  readonly lessons: ReadonlyArray<LessonEntry>;
  /** The resolved promotion scopes (a count of zero disables promotion). */
  readonly scopes: LessonsPromotionScopesResolution;
}

export interface GatherLessonsPromotionInputsOptions {
  /** Wall clock for the recency decay. Defaults to `new Date()`. */
  readonly now?: Date;
  /** The `o2b` config file the scopes resolve against; null for default discovery. */
  readonly configPath?: string | null;
}

/**
 * Gather the promotion inputs from one vault: the active preferences
 * (corrupted files are omitted; doctor is the surface for them, exactly
 * as the lessons digest reads), the dead ends, and the digest computed
 * fresh at `opts.now` under the configured `lessons:` tuning. The digest
 * is COMPUTED, not read off `Brain/lessons.md`: qualification and the
 * doctor must grade what a refresh would render now, not what the last
 * dream pass sealed. Config that cannot be read resolves the shared
 * defaults - a config error is doctor's finding, never a promotion veto.
 */
export function gatherLessonsPromotionInputs(
  vault: string,
  opts: GatherLessonsPromotionInputsOptions = {},
): LessonsPromotionInputs {
  const preferences = readActivePreferencesForPromotion(vault);
  const deadEnds = listDeadEnds(vault).entries;

  let halfLifeDays = LESSONS_HALF_LIFE_DAYS_DEFAULT;
  let corroborationMin = LESSONS_CORROBORATION_MIN_DEFAULT;
  let limit = LESSONS_LIMIT_DEFAULT;
  try {
    const cfg = loadBrainConfig(vault);
    if (cfg.lessons) {
      halfLifeDays = cfg.lessons.half_life_days ?? halfLifeDays;
      corroborationMin = cfg.lessons.corroboration_min ?? corroborationMin;
      limit = cfg.lessons.limit ?? limit;
    }
  } catch {
    // intentional fallback - config error is doctor's job to surface
  }

  const lessons = computeLessons(vault, preferences, deadEnds, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    halfLifeDays,
    corroborationMin,
    limit,
  });
  // The strict resolution: a present-but-malformed scopes value refuses
  // by name here (see resolvePromotionScopesStrict) rather than reading
  // as an unset key. Callers surface the refusal; the doctor's per-file
  // catches fold it into their named warnings.
  const scopes = resolvePromotionScopesStrict(opts.configPath ?? undefined);
  return { preferences, lessons, scopes };
}

/** The active preferences, parsed; a corrupted file is omitted, not fatal. */
function readActivePreferencesForPromotion(vault: string): BrainPreference[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return [];
  const out: BrainPreference[] = [];
  for (const name of readdirSync(dirs.preferences)) {
    if (!name.endsWith(".md")) continue;
    try {
      out.push(parsePreference(join(dirs.preferences, name)));
    } catch {
      // Corrupted frontmatter - doctor flags it; promotion reads the rest.
    }
  }
  return out;
}

// ----- Managed-block plan and status counts (C3) ------------------------------

/**
 * What one managed lessons block would look like if a refresh ran now:
 * the canonical body, the lessons it would carry, and the lessons whose
 * approvals went stale for this file. The one derivation the verbs, the
 * doctor check and the tests all consume, so "what a refresh would
 * render" can never disagree between the surfaces that ask.
 */
export interface LessonsBlockPlan {
  /** The rules file the plan is for (a basename from the fixed list). */
  readonly file: string;
  /**
   * The canonical body, or null when no qualified lesson's approval
   * covers this file - the caller removes the block (never renders an
   * empty fence).
   */
  readonly body: string | null;
  /** The pref ids the canonical body carries, in render order. */
  readonly qualifiedIds: ReadonlyArray<string>;
  /** Approved ids whose pinned hash no longer matches, for this file. */
  readonly staleIds: ReadonlyArray<string>;
  /**
   * Qualified ids that fell past the `lessons.limit` cut of the render,
   * in render order: the cap's shortfall, named so no lesson can leave
   * the block silently (empty under the shipped wiring, where the digest
   * and the block read the same bound).
   */
  readonly droppedIds: ReadonlyArray<string>;
}

export interface PlanLessonsBlockOptions {
  /** The o2b config file scopes resolve against; null for discovery. */
  readonly configPath?: string | null;
  /** Wall clock for the recency decay; defaults to now. */
  readonly now?: Date;
}

/**
 * Derive the plan for one managed block: qualification over the vault's
 * live inputs, the approvals covering this file, and the same render the
 * verbs write. Read-only; throws only when the approvals ledger is
 * damaged (fail-closed, the reader's contract).
 */
export function planLessonsBlock(
  vault: string,
  file: string,
  opts: PlanLessonsBlockOptions = {},
): LessonsBlockPlan {
  const ledger = readLessonApprovals(vault);
  const inputs = gatherLessonsPromotionInputs(vault, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  const { promotable, blocked } = lessonPromotionCandidates(
    inputs.preferences,
    inputs.lessons,
    ledger,
    { enabledScopes: inputs.scopes.scopes },
  );
  const covers = (id: string): boolean => {
    const row = currentApprovalFor(ledger, id);
    return row !== null && row.decision === "approved" && row.targets.includes(file);
  };
  const qualified = promotable.filter((candidate) => covers(candidate.prefId));
  const staleIds = blocked
    .filter((entry) => entry.reason === LESSON_PROMOTION_BLOCKED.staleApproval)
    .map((entry) => entry.prefId)
    .filter((id) => covers(id));
  const render =
    qualified.length === 0
      ? null
      : renderLessonsBlockWithDrops(qualified, { limit: lessonsBlockLimit(vault) });
  return {
    file,
    body: render === null ? null : render.body,
    qualifiedIds: qualified.map((candidate) => candidate.prefId),
    staleIds,
    droppedIds: render === null ? [] : render.droppedIds,
  };
}

/**
 * The pref ids a rendered block body carries, in render order. The
 * parser lives beside the render so the one-line-per-lesson format
 * couples only within this module; a line that is not a lesson entry
 * yields nothing.
 */
export function lessonIdsInBlockBody(body: string): ReadonlyArray<string> {
  const ids: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^- `([^`]+)` /.exec(line);
    if (match !== null) ids.push(match[1] as string);
  }
  return ids;
}

/** Approval counts for the status snapshot: the ledger plus staleness. */
export interface LessonApprovalCounts {
  readonly approved: number;
  readonly denied: number;
  /** Approvals whose pinned hash no longer matches the live text. */
  readonly stale: number;
}

/**
 * Count the approval decisions currently in force: approved, denied, and
 * how many of the approved rows went STALE - the pinned hash no longer
 * matches the live preference text, or the preference cannot be read at
 * all (a missing or damaged preference cannot be promoted, so its
 * approval holds nothing fresh). Reads only.
 */
export function lessonApprovalCounts(vault: string): LessonApprovalCounts {
  const ledger = readLessonApprovals(vault);
  let approved = 0;
  let denied = 0;
  let stale = 0;
  for (const row of ledger) {
    if (row.decision === "denied") {
      denied += 1;
      continue;
    }
    approved += 1;
    try {
      const pref = parsePreference(preferencePath(vault, row.prefId.replace(/^pref-/, "")));
      if (computeContentHash(pref.principle, pref.scope) !== row.approvedContentHash) stale += 1;
    } catch {
      stale += 1;
    }
  }
  return { approved, denied, stale };
}

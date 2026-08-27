/**
 * Skill drafts from mature vault pages
 * (salience-lifecycle-enrichment, unit 4, t_abaec26b).
 *
 * `skill-proposals.ts` mines continuity TELEMETRY: what the agent did,
 * repeatedly, in a shape a detector recognises. It has never read a vault
 * page. So the material an operator has already written down, verified and
 * reused - the pages that are the most obvious skill candidates in the
 * vault - was the one input the proposal queue could not see.
 *
 * This module is that input, gated three ways before a model is ever
 * asked for anything:
 *
 *   1. The CHEAP filter is the page-meta trio, the only three fields that
 *      apply to arbitrary user pages: `tier` must be `core` (operator
 *      intent), the lifecycle must not be stale (freshness), and
 *      `_confidence` must be `high`. Each is a separate dimension and each
 *      rejection is reported by name - a gate that answered "no candidates"
 *      would be indistinguishable from a vault nobody has tagged.
 *   2. The EVIDENCE floor is observed reuse. A page can be tagged core,
 *      fresh and high-confidence and still be something nobody has ever
 *      pulled back out; `observedReuseRates` is the only signal that says
 *      the material was actually USED, so it is the one that decides.
 *   3. The NEGATIVE signal is skill coverage. A page an installed skill
 *      already covers must not be drafted again: the second copy would
 *      shadow or be shadowed by the first, and `discoverSkills` would
 *      report a collision an operator never asked for.
 *
 * Drafting itself is envelope-mediated, and each ADMITTED page gets its
 * own: one page, one skill, one prompt carrying that page's content. The
 * returned draft is validated structurally ({@link SKILL_PAGE_DRAFT_SHAPE})
 * and semantically (the name has to be a legal directory name, which no
 * descriptor can say) and then STAGED as a pending proposal inside the
 * vault. Nothing reaches the skills root until a human accepts.
 */

import { existsSync, readFileSync } from "node:fs";
import { posix, relative } from "node:path";

import { resolveSkillsDir } from "../config.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { discoverSkills, skillRoots } from "../surface/skills.ts";
import { EXCLUDED_DIRS, listVaultPages, slugify } from "../vault.ts";
import { buildNeedsLlmStep, type NeedsLlmStep } from "./llm-step.ts";
import { observedReuseRates } from "./observed-use.ts";
import {
  ageDaysFromIso,
  isStale,
  readLifecycle,
  type PageLifecycle,
} from "./page-meta/lifecycle.ts";
import { readConfidence, type PageConfidence } from "./page-meta/confidence.ts";
import { PAGE_TIER, readTier, type PageTier } from "./page-meta/tier.ts";
import { BRAIN_ROOT_REL } from "./paths.ts";
import {
  assertResponseCheck,
  registerResponseCheck,
  SEMANTIC_VIOLATION_CODES,
  semanticViolation,
  type SemanticViolation,
} from "./response-checks.ts";
import {
  assertResponseShape,
  SHAPE_ROOT_PATH,
  SKILL_PAGE_DRAFT_SHAPE,
  SKILL_PAGE_DRAFT_SURFACE,
} from "./response-shape.ts";
import {
  draftMaturePageSkillProposal,
  SKILL_NAME_RE,
  type DeclaredSkillProposalResult,
} from "./skill-proposals.ts";
import { BRAIN_CONFIDENCE } from "./types.ts";
import { MAINTENANCE_LANE_REACH } from "../graph/transport-reach.ts";

/** Lowest tier a page may carry and still be a skill candidate. */
export const MATURE_PAGE_TIER: PageTier = PAGE_TIER.core;

/** Lowest confidence a page may carry and still be a skill candidate. */
export const MATURE_PAGE_CONFIDENCE: PageConfidence = BRAIN_CONFIDENCE.high;

/**
 * Age past which a `stable` or `draft` page counts as stale. The page-meta
 * default is reused rather than re-picked: a page this module calls stale
 * and `o2b brain stale` calls fresh would be two answers to one question.
 */
export const MATURE_PAGE_STALE_DAYS = 180;

/**
 * Lowest observed-reuse score a page may carry. `observedReuseRates`
 * scores `(used - contradicted) / total` in [0, 1], so this floor demands
 * that a clear majority of the times the page was surfaced, it was used.
 */
export const MATURE_PAGE_REUSE_FLOOR = 0.5;

/** The needs-llm-step step name for a deferred skill draft. */
export const SKILL_PAGE_DRAFT_STEP = "skill-page-draft";

/** Per-page content budget in the prompt, so one long page cannot dominate. */
const PROMPT_PAGE_TEXT_MAX = 8000;

/**
 * Why a page is not a candidate. Closed, and one reason per page: the
 * FIRST gate that rejected it, in the order the gates run, so a reader
 * fixes the cheapest problem first.
 */
export const SKILL_PAGE_SKIP_REASON = Object.freeze({
  /** `tier` is below `core`. */
  tier: "tier_below_core",
  /** The lifecycle is stale for the page's age. */
  lifecycle: "lifecycle_stale",
  /** `_confidence` is below `high`. */
  confidence: "confidence_below_high",
  /** Nothing has reused the page often enough to evidence it. */
  reuse: "reuse_below_floor",
  /** An installed skill already covers the page. */
  covered: "covered_by_installed_skill",
} as const);

export type SkillPageSkipReason =
  (typeof SKILL_PAGE_SKIP_REASON)[keyof typeof SKILL_PAGE_SKIP_REASON];

/** A skill-page draft could not proceed, and the reason is in the message. */
export class SkillPageDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPageDraftError";
  }
}

/** One page admitted for drafting, with the evidence that admitted it. */
export interface SkillPageCandidate {
  /** Vault-relative POSIX path - the identity every surface here uses. */
  readonly path: string;
  readonly title: string;
  readonly tier: PageTier;
  readonly lifecycle: PageLifecycle;
  readonly confidence: PageConfidence;
  /** Observed-reuse score in [0, 1]; at or above {@link MATURE_PAGE_REUSE_FLOOR}. */
  readonly reuseScore: number;
  /** How many observed-use verdicts the score was folded from. */
  readonly reuseObservations: number;
  readonly llmStep: NeedsLlmStep;
}

/** One page the gate turned down, named. */
export interface SkillPageSkip {
  readonly path: string;
  readonly title: string;
  readonly reason: SkillPageSkipReason;
  /** The measured value behind the reason, so the report is actionable. */
  readonly detail: string;
}

export interface SkillPageDraftPlan {
  readonly generatedAt: string;
  /** User pages walked, before any gate. */
  readonly pagesScanned: number;
  readonly admitted: ReadonlyArray<SkillPageCandidate>;
  readonly skipped: ReadonlyArray<SkillPageSkip>;
}

export interface PlanSkillPageDraftsOptions {
  readonly now: Date;
  /** Repo skills root, when the caller has one; used for coverage only. */
  readonly repoRoot?: string | null;
  /** Skills directory override; defaults to the configured `skills_dir`. */
  readonly skillsDir?: string | null;
}

export interface CommitSkillPageDraftOptions {
  readonly now: Date;
}

// ----- The semantic rule the descriptor language cannot express -------------
//
// The descriptor language has no pattern key and deliberately stays that
// way, so the `name` charset rule is a semantic check. The pattern itself
// is `SKILL_NAME_RE`, declared in `skill-proposals.ts` and imported here:
// the accept path re-applies it at materialize time, and one pattern in
// two spellings would let the two ends disagree about what a skill
// directory may be called.

/** Longest legal skill name; a directory name, not a sentence. */
const SKILL_NAME_MAX_LEN = 64;

registerResponseCheck(SKILL_PAGE_DRAFT_SURFACE, (payload) => {
  const violations: SemanticViolation[] = [];
  if (typeof payload !== "object" || payload === null) return violations;
  const name = (payload as { name?: unknown }).name;
  if (typeof name !== "string") return violations;
  const path = `${SHAPE_ROOT_PATH}.name`;
  if (!SKILL_NAME_RE.test(name)) {
    violations.push(
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.crossItem,
        path,
        `must be a skill directory name - lowercase letters, digits and single hyphens; got ${JSON.stringify(name)}`,
      ),
    );
  }
  if (name.length > SKILL_NAME_MAX_LEN) {
    violations.push(
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.threshold,
        path,
        `must be at most ${SKILL_NAME_MAX_LEN} characters; got ${name.length}`,
      ),
    );
  }
  return violations;
});

// ----- Phase one: which pages deserve a draft -------------------------------

/**
 * Walk the vault's user pages and decide which of them a skill should be
 * drafted from. Read-only; writes nothing and calls no model.
 *
 * The `Brain/` tree is excluded for the same reason `heal-run.ts` excludes
 * it: it is agent-owned bookkeeping, not the operator's knowledge, and the
 * page-meta trio is a statement about the latter.
 */
export function planSkillPageDrafts(
  vault: string,
  opts: PlanSkillPageDraftsOptions,
): SkillPageDraftPlan {
  const brainDir = BRAIN_ROOT_REL.split("/")[0] ?? "Brain";
  const pages = listVaultPages(vault, {
    skipDirs: [...EXCLUDED_DIRS, brainDir],
    reach: MAINTENANCE_LANE_REACH,
  });
  const reuse = observedReuseRates(vault);
  const covered = installedSkillNames(vault, opts);

  const admitted: SkillPageCandidate[] = [];
  const skipped: SkillPageSkip[] = [];

  for (const page of pages) {
    const rel = toPosixRel(vault, page.path);
    const title = page.title;
    const skip = (reason: SkillPageSkipReason, detail: string): void => {
      skipped.push(Object.freeze({ path: rel, title, reason, detail }));
    };

    const tier = readTier(page.metadata);
    if (tier !== MATURE_PAGE_TIER) {
      skip(SKILL_PAGE_SKIP_REASON.tier, `tier is '${tier}', not '${MATURE_PAGE_TIER}'`);
      continue;
    }
    const lifecycle = readLifecycle(page.metadata);
    const ageDays = ageDaysFromIso(pageInstant(page.metadata), opts.now);
    if (isStale(lifecycle, ageDays, MATURE_PAGE_STALE_DAYS)) {
      skip(
        SKILL_PAGE_SKIP_REASON.lifecycle,
        `lifecycle '${lifecycle}' is stale at ${Math.floor(ageDays)} day(s), past ${MATURE_PAGE_STALE_DAYS}`,
      );
      continue;
    }
    const confidence = readConfidence(page.metadata);
    if (confidence !== MATURE_PAGE_CONFIDENCE) {
      skip(
        SKILL_PAGE_SKIP_REASON.confidence,
        `confidence is '${confidence}', not '${MATURE_PAGE_CONFIDENCE}'`,
      );
      continue;
    }
    // The reuse ledger keys artifacts by whatever path the recorder had, so
    // both forms are consulted rather than assuming one.
    const observed = reuse.get(rel) ?? reuse.get(page.path);
    const score = observed?.score ?? 0;
    if (score < MATURE_PAGE_REUSE_FLOOR) {
      skip(
        SKILL_PAGE_SKIP_REASON.reuse,
        `observed reuse ${score.toFixed(2)} is below ${MATURE_PAGE_REUSE_FLOOR}` +
          ` over ${observed?.total ?? 0} observation(s)`,
      );
      continue;
    }
    const name = slugify(title);
    if (covered.has(name)) {
      skip(
        SKILL_PAGE_SKIP_REASON.covered,
        `an installed skill named '${name}' already covers this page`,
      );
      continue;
    }
    admitted.push(
      Object.freeze({
        path: rel,
        title,
        tier,
        lifecycle,
        confidence,
        reuseScore: score,
        reuseObservations: observed?.total ?? 0,
        llmStep: buildDraftStep(rel, title, name, readPageBody(page.path)),
      }),
    );
  }

  return Object.freeze({
    generatedAt: opts.now.toISOString(),
    pagesScanned: pages.length,
    admitted: Object.freeze(admitted),
    skipped: Object.freeze(skipped),
  });
}

/**
 * The envelope for one admitted page. The page's own content rides in the
 * prompt: the caller is writing a skill FROM this page, and a prompt that
 * merely named the file would invite it to write from memory instead.
 */
function buildDraftStep(
  rel: string,
  title: string,
  suggestedName: string,
  body: string,
): NeedsLlmStep {
  return buildNeedsLlmStep({
    step: SKILL_PAGE_DRAFT_STEP,
    prompt:
      `Write an Agent Skill from the vault page '${title}' (${rel}). The skill must teach an ` +
      "agent to do what the page describes, in imperative steps, without restating the page's " +
      `background. Suggested name: '${suggestedName}'.\n\n` +
      body.slice(0, PROMPT_PAGE_TEXT_MAX),
    schema_hints: [
      'payload: { "name", "description", "triggers": [...], "body" }',
      "name: skill directory name - lowercase letters, digits and single hyphens",
      "description: one line naming when an agent should reach for this skill",
      "triggers: keywords a matcher scores the skill on; at least one, each non-empty",
      "body: the SKILL.md body, imperative and self-contained",
    ],
    target_path: `${BRAIN_ROOT_REL}/skill-proposals/pending`,
  });
}

// ----- Phase two: what the caller drafted -----------------------------------

/**
 * Validate a returned draft and STAGE it as a pending proposal.
 *
 * The page path is validated against the vault before anything else -
 * confined to it, then required to exist: a draft citing a page that is
 * not there has no provenance, one citing a path outside the vault has
 * provenance this surface cannot vouch for, and a proposal whose only
 * evidence is a broken wikilink is worse than no proposal.
 */
export function commitSkillPageDraft(
  vault: string,
  pagePath: string,
  payload: unknown,
  opts: CommitSkillPageDraftOptions,
): DeclaredSkillProposalResult {
  const rel = pagePath.trim();
  if (rel.length === 0) {
    throw new SkillPageDraftError("a skill page draft needs the page it was drafted from");
  }
  // Confinement before existence: `rel` is caller-supplied, and a path
  // climbing out of the vault with `..` (or through a symlinked directory
  // inside it) could otherwise be confirmed to exist and then cited as
  // this proposal's provenance. The refusal is by name, like every other
  // one on this surface.
  let abs: string;
  try {
    abs = ensureInsideVault(posix.join(vault, rel), vault);
  } catch (err) {
    throw new SkillPageDraftError(
      `page path is not inside the vault: ${rel} (${(err as Error).message})`,
    );
  }
  if (!existsSync(abs)) {
    throw new SkillPageDraftError(`no such vault page: ${rel}`);
  }
  // Structure first, then the rules a descriptor cannot state. Nothing is
  // staged until both pass.
  assertResponseShape(SKILL_PAGE_DRAFT_SURFACE, SKILL_PAGE_DRAFT_SHAPE, payload);
  assertResponseCheck(SKILL_PAGE_DRAFT_SURFACE, payload);

  const draft = payload as {
    name: string;
    description: string;
    triggers: ReadonlyArray<string>;
    body: string;
  };
  return draftMaturePageSkillProposal(vault, {
    name: draft.name,
    description: draft.description,
    triggers: draft.triggers,
    body: draft.body,
    sourceRefs: [`[[${rel}]]`],
    now: opts.now,
  });
}

// ----- Internals ------------------------------------------------------------

/** Names of every skill installed on any root this vault can see. */
function installedSkillNames(vault: string, opts: PlanSkillPageDraftsOptions): ReadonlySet<string> {
  const skillsDir = opts.skillsDir ?? resolveSkillsDir();
  const roots = skillRoots({
    vault,
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    ...(skillsDir ? { skillsDir } : {}),
  });
  return new Set(discoverSkills(roots).map((skill) => slugify(skill.name)));
}

/**
 * The instant a page's age is measured from. `last_evidence_at` wins when
 * present - a page re-evidenced last week is not stale because it was
 * created two years ago - and `created_at` is the fallback.
 */
function pageInstant(meta: Readonly<Record<string, unknown>>): string | null {
  for (const key of ["last_evidence_at", "created_at"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Page body without its frontmatter block, for the prompt. */
function readPageBody(abs: string): string {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    // A page the walk listed and the read cannot open is a real fault, not
    // an empty page: drafting from silence would produce a plausible skill
    // grounded in nothing.
    throw new SkillPageDraftError(
      `could not read candidate page ${abs}: ${(err as Error).message ?? String(err)}`,
    );
  }
  if (!text.startsWith("---\n")) return text.trim();
  const end = text.indexOf("\n---", 4);
  return end < 0 ? text.trim() : text.slice(end + "\n---".length).trim();
}

function toPosixRel(vault: string, abs: string): string {
  return relative(vault, abs).split(/[\\/]/).join(posix.sep);
}

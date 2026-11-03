import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { parseFrontmatter, slugify, writeFrontmatterAtomic } from "../vault.ts";
import { resolveSkillsDir } from "../config.ts";
import { SKILL_FILE_NAME } from "../surface/skills.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { sha256Hex } from "../integrity/digest.ts";
import { verifySkillProposalCandidate } from "./skill-proposal-verifier.ts";
import { rebuildProceduralHints } from "./procedural-hints.ts";
import { rebuildProceduralGraph } from "./procedural-graph.ts";
import type { RewriteGradeRecordPayload } from "./skill-rewrite.ts";
import {
  isSkillRewriteVerdict,
  parseSkillRewriteSpec,
  skillRewriteSpecHash,
  verifyRewriteTake,
  SKILL_REWRITE_METRIC,
  SKILL_REWRITE_VERDICT,
  type SkillRewriteSpec,
  type SkillRewriteVerdict,
} from "./skill-rewrite-spec.ts";
import {
  parseSkillBenchmarkTasks,
  SKILL_BENCHMARK_SPEC_FILE,
  skillBenchmarkRelPath,
} from "./skill-rewrite-tasks.ts";
import {
  listProceduralMemory,
  proceduralEntryId,
  proceduralSuccessRate,
  reconcileProceduralMemory,
} from "./procedural-memory.ts";
import { requireNextStep } from "./next-step.ts";
import {
  clearSkillAcceptJournal,
  listSkillAcceptJournals,
  readSkillAcceptJournals,
  removeSkillAcceptJournalFile,
  writeSkillAcceptJournal,
  type SkillAcceptJournalEntry,
} from "./skill-accept-journal.ts";
import { acquireLockSync, type LockHandle } from "./sync-lockfile.ts";
import {
  BRAIN_SKILL_PROPOSALS_REL,
  procedurePath,
  proposalWatermarkPath,
  SHA256_HEX_RE,
  skillAcceptJournalPath,
  skillAcceptPriorContentPath,
  skillBenchmarkSpecPath,
  skillBenchmarkTasksPath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
  skillProposalRejectedPath,
} from "./paths.ts";
import { JSONL_LEDGER_EXT, resolveAppendShardId, shardedFileName } from "./ledger-shards.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import {
  appendContinuityRecord,
  listContinuityRecords,
  type ContinuityRecord,
} from "./continuity/store.ts";
import type { ContinuityPayload } from "./continuity/types.ts";

/**
 * Pattern kind stamped on a proposal an author DECLARED through an
 * `@osb skill` marker rather than one the miner inferred from
 * continuity records.
 *
 * It is deliberately outside the verifier gate. That gate
 * (`skill-proposal-verifier.ts`) scores a MINED candidate against its own
 * supporting records - at least `VERIFIER_MIN_EVIDENCE` (3) distinct
 * records structurally supporting the pattern, plus a confidence floor -
 * so a thin or padded inference never reaches a human. A declaration has
 * exactly one piece of evidence, the declaration itself, and claims no
 * statistical confidence, so running the same gate over it would reject
 * every marker and make the feature a silent no-op. The review gate that
 * does apply is the human one: a declared proposal lands in `pending` and
 * is promoted only by `acceptSkillProposal`.
 */
export const DECLARED_MARKER_PATTERN_KIND = "declared_marker";

/**
 * Pattern kind stamped on a proposal drafted from a MATURE VAULT PAGE
 * (salience-lifecycle-enrichment, unit 4) rather than from continuity
 * telemetry or an author's marker.
 *
 * It sits outside the mining verifier for the same reason
 * {@link DECLARED_MARKER_PATTERN_KIND} does, and for one more of its own.
 * The verifier scores a candidate against the continuity records that
 * produced it; a page candidate has no such records - its evidence is the
 * page-meta trio plus the observed reuse of the page itself, gated in
 * `skill-page-drafts.ts` before a draft is ever requested. Running a
 * record-counting gate over it would reject every page and make the
 * feature a silent no-op.
 *
 * This is also the one pattern kind whose acceptance writes OUTSIDE the
 * vault: it materializes a `SKILL.md` under the configured skills root
 * instead of a procedure page. Everything before accept stays in
 * `Brain/skill-proposals/pending/`.
 */
export const MATURE_PAGE_PATTERN_KIND = "mature_page";

/**
 * Pattern kind stamped on a proposal a benchmark-gated rewrite staged
 * (agent-presence, Lane A) after the candidate won the selection gate
 * and passed the held-out check.
 *
 * Like the declared and mature-page kinds it sits outside the mining
 * verifier: its evidence is the preregistered benchmark receipt - the
 * frozen spec hash and the three scores the gate decided on, carried in
 * the frontmatter - not a continuity pattern, so a record-counting gate
 * over it would reject every rewrite and make the lane a silent no-op.
 * The gates that DO apply are the mechanical ones upstream of staging
 * (the task-set receipt, the dev selection margin, the single held-out
 * check) and the human one downstream: nothing lands on an incumbent
 * skill until `acceptSkillProposal`.
 *
 * This is the one pattern kind whose acceptance OVERWRITES: it
 * materializes a `SKILL.md` over the incumbent, so the accept journal
 * captures the prior bytes first ({@link SkillAcceptJournalEntry.priorContentPath})
 * and the rollback restores content, not just existence.
 */
export const SCORED_REWRITE_PATTERN_KIND = "scored_rewrite";

export type SkillProposalPatternKind =
  | "repeated_action"
  | "structural_similarity"
  | "co_occurrence"
  | "temporal_routine"
  | typeof DECLARED_MARKER_PATTERN_KIND
  | typeof MATURE_PAGE_PATTERN_KIND
  | typeof SCORED_REWRITE_PATTERN_KIND;

/** The three phases a proposal file can live in, most terminal first. */
const PROPOSAL_PHASES = ["accepted", "rejected", "pending"] as const;

export type SkillProposalPhase = (typeof PROPOSAL_PHASES)[number];

export interface SkillProposalLearnOptions {
  readonly now?: Date;
  readonly minSupport?: number;
}

export interface SkillProposalLearnResult {
  readonly watermarkFrom: string | null;
  readonly watermarkTo: string | null;
  readonly scanned: number;
  readonly created: ReadonlyArray<string>;
  readonly suppressed: ReadonlyArray<string>;
  /** Candidates whose support merged into an existing same-name proposal. */
  readonly merged: ReadonlyArray<string>;
  /** Candidates the verifier gate rejected before the pending queue. */
  readonly verifierRejected: ReadonlyArray<string>;
}

export interface SkillProposalReviewResult {
  readonly id: string;
  readonly slug: string;
  readonly status: "accepted" | "rejected";
  readonly proposalPath: string;
  /** Set when acceptance materialized a procedure inside the vault. */
  readonly procedurePath?: string;
  /**
   * Set when acceptance materialized a `SKILL.md` under the skills root -
   * the one artifact this module writes outside the vault, and only on an
   * explicit accept. The two keys are separate rather than one
   * `materializedPath` so a caller reads WHICH kind of artifact landed
   * without re-deriving it from the proposal's pattern kind.
   */
  readonly skillPath?: string;
}

/**
 * Execution contract supplied at acceptance (no-dead-ends, Unit I). Each
 * field is a list of structural steps; an absent field writes no key, so a
 * contract-free acceptance is byte-identical to the pre-contract output.
 */
export interface SkillContractInput {
  readonly prerequisites?: ReadonlyArray<string>;
  readonly rollback?: ReadonlyArray<string>;
  readonly sideEffects?: ReadonlyArray<string>;
  readonly verification?: ReadonlyArray<string>;
}

export interface SkillProposalAcceptOptions {
  readonly now?: Date;
  readonly note?: string;
  readonly contract?: SkillContractInput;
  /**
   * Where a `mature_page` proposal materializes its `SKILL.md`. Absent
   * resolves the configured `skills_dir`, falling back to the vault's own
   * `Brain/skills`. Every other pattern kind ignores it - they materialize
   * a procedure INSIDE the vault and never touch this tree.
   */
  readonly skillsRoot?: string;
}

/** Contract field name -> frontmatter key, in the order they are written. */
const SKILL_CONTRACT_FIELDS = Object.freeze([
  ["prerequisites", "prerequisites"],
  ["rollback", "rollback"],
  ["sideEffects", "side_effects"],
  ["verification", "verification"],
] as const);

/** What a resolved journal did to the sequence it was guarding. */
export type SkillAcceptRecoveryAction = "rolled_back" | "completed";

export interface SkillAcceptRecovery {
  readonly slug: string;
  readonly action: SkillAcceptRecoveryAction;
}

/**
 * How a proposal's self-reported support compares with the independently
 * recorded procedural outcome ledger.
 *
 * `unrecorded` is NOT "no failures": it is the absence of evidence either
 * way, which is why {@link SkillProposalEvidence.recordedSuccessRate} is
 * null rather than zero in that state. Failures, successes and silence stay
 * three distinct answers; `mixed` is the honest fourth.
 */
export type SkillEvidenceOutcomeState = "unrecorded" | "successful" | "failing" | "mixed";

export interface SkillProposalEvidence {
  readonly slug: string;
  readonly id: string;
  readonly phase: SkillProposalPhase;
  /** Support the proposal claims from its own pattern match - self-reported. */
  readonly claimedEvidenceCount: number;
  readonly claimedConfidence: number;
  /** Ledger join key, derived from the slug with no lookup. */
  readonly proceduralEntryId: string;
  /** False when the procedure has no procedural-memory entry at all. */
  readonly proceduralEntryPresent: boolean;
  /** Host-recorded outcomes; null when there is no entry to read them from. */
  readonly recordedSuccesses: number | null;
  readonly recordedFailures: number | null;
  /** null whenever nothing was recorded - never 0, which reads as total failure. */
  readonly recordedSuccessRate: number | null;
  readonly outcomeState: SkillEvidenceOutcomeState;
}

interface ProposalCandidate {
  readonly patternKind: SkillProposalPatternKind;
  readonly key: string;
  readonly confidence: number;
  /** Bounded evidence sample kept for the proposal note, slug, and hash. */
  readonly records: ReadonlyArray<ContinuityRecord>;
  /**
   * Full supporting record set the candidate cleared detection with. Carried
   * apart from the capped `records` so the verifier gate sees the true support
   * count (a minSupport above the sample cap must not reject a passing draft).
   */
  readonly supportingRecords: ReadonlyArray<ContinuityRecord>;
  readonly suggestedTitle: string;
}

interface WatermarkState {
  readonly lastCreatedAt: string | null;
  readonly lastId: string | null;
}

const DEFAULT_MIN_SUPPORT = 3;
const DEFAULT_PROCEDURAL_ROOTS = ["Brain/procedures", "skills"] as const;

/** Version stamped on a freshly-drafted skill; increments on evolution. */
const SKILL_PROPOSAL_INITIAL_VERSION = 1;

/** Slug budget: how much of the pattern key survives, and the hash suffix length. */
const PROPOSAL_SLUG_KEY_MAX_LEN = 40;
const PROPOSAL_SLUG_HASH_LEN = 8;

/**
 * Heading that separates the reviewable skill body from the pattern and
 * evidence sections. `renderAcceptedProcedureBody` splits on it, so both
 * the writer and the reader must name it from here.
 */
const SUGGESTED_BODY_HEADING = "## Suggested skill body";

/** Lock basename guarding the accept sequence, inside the proposals root. */
const ACCEPT_LOCK_NAME = "accept";

/** Shard stem of the verifier-rejection JSONL ledger inside the proposals root. */
const VERIFIER_REJECTION_LEDGER_STEM = "verifier-rejections";

export function learnSkillProposals(
  vault: string,
  opts: SkillProposalLearnOptions = {},
): SkillProposalLearnResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const now = opts.now ?? new Date();
  const minSupport = Math.max(2, opts.minSupport ?? DEFAULT_MIN_SUPPORT);

  const watermark = readWatermark(vault);
  const records = listContinuityRecords(vault)
    .filter((record) => {
      if (watermark.lastCreatedAt === null) return true;
      if (record.createdAt > watermark.lastCreatedAt) return true;
      if (record.createdAt < watermark.lastCreatedAt) return false;
      if (watermark.lastId === null) return true;
      return record.id > watermark.lastId;
    })
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );

  if (records.length === 0) {
    return {
      watermarkFrom: watermark.lastCreatedAt,
      watermarkTo: watermark.lastCreatedAt,
      scanned: 0,
      created: Object.freeze([]),
      suppressed: Object.freeze([]),
      merged: Object.freeze([]),
      verifierRejected: Object.freeze([]),
    };
  }

  const candidates = detectCandidates(records, minSupport);
  const created: string[] = [];
  const suppressed: string[] = [];
  const merged: string[] = [];
  const verifierRejected: string[] = [];
  const watermarkTo = records[records.length - 1]!.createdAt;

  for (const candidate of candidates) {
    const payloadHash = candidateHash(candidate);
    const slug = proposalSlug(candidate, payloadHash);
    const proposalId = `prop-${slug}`;
    const nameKey = candidateNameKey(candidate);
    const newRefs = candidateSourceRefs(candidate);

    // Verifier gate: a draft reaches pending only after passing structural and
    // evidence-count checks against its OWN supporting records.
    const verdict = verifySkillProposalCandidate(
      {
        patternKind: candidate.patternKind,
        key: candidate.key,
        confidence: candidate.confidence,
        evidence: candidate.supportingRecords.map((record) => ({
          id: record.id,
          supportsPattern: recordSupportsCandidate(candidate, record),
        })),
      },
      { minEvidence: minSupport },
    );
    if (!verdict.accepted) {
      appendVerifierRejection(vault, {
        id: proposalId,
        name_key: nameKey,
        reason: verdict.reason,
        at: now.toISOString(),
      });
      verifierRejected.push(proposalId);
      continue;
    }

    // Same-name merge: an accepted collision evolves the skill (version bump);
    // a pending collision accumulates support. Neither forks a new draft.
    const acceptedMatch = findProposalByNameKey(vault, "accepted", nameKey);
    if (acceptedMatch !== null) {
      evolveAcceptedProposal(vault, acceptedMatch, candidate, newRefs, now, watermarkTo);
      merged.push(acceptedMatch.id);
      continue;
    }
    const pendingMatch = findProposalByNameKey(vault, "pending", nameKey);
    if (pendingMatch !== null) {
      mergePendingProposal(vault, pendingMatch, candidate, newRefs, now, watermarkTo);
      merged.push(pendingMatch.id);
      continue;
    }
    if (findProposalByNameKey(vault, "rejected", nameKey) !== null) {
      // A human rejected this name; do not resurface it as a fresh draft.
      suppressed.push(proposalId);
      continue;
    }

    const pendingPath = skillProposalPendingPath(vault, slug);
    const acceptedPath = skillProposalAcceptedPath(vault, slug);
    const rejectedPath = skillProposalRejectedPath(vault, slug);
    if (existsSync(pendingPath) || existsSync(acceptedPath) || existsSync(rejectedPath)) {
      suppressed.push(proposalId);
      continue;
    }

    writeFrontmatterAtomic(
      pendingPath,
      {
        schema_version: 1,
        kind: "brain-skill-proposal",
        id: proposalId,
        slug,
        status: "pending",
        pattern_kind: candidate.patternKind,
        name_key: nameKey,
        version: SKILL_PROPOSAL_INITIAL_VERSION,
        confidence: candidate.confidence.toFixed(3),
        payload_hash: payloadHash,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        watermark_from: watermark.lastCreatedAt ?? "",
        watermark_to: watermarkTo,
        evidence_count: String(candidate.records.length),
        source_refs: newRefs,
      },
      renderProposalBody(candidate),
      {
        overwrite: false,
        existsErrorKind: "skill proposal",
        vaultForRelativePath: vault,
      },
    );
    created.push(proposalId);
  }

  const watermarkRecord = records[records.length - 1]!;
  writeWatermark(vault, {
    lastCreatedAt: watermarkTo,
    lastId: watermarkRecord.id,
  });
  const graph = rebuildProceduralGraph(vault);
  rebuildProceduralHints(vault, { graph });

  return {
    watermarkFrom: watermark.lastCreatedAt,
    watermarkTo,
    scanned: records.length,
    created: Object.freeze(created),
    suppressed: Object.freeze(suppressed),
    merged: Object.freeze(merged),
    verifierRejected: Object.freeze(verifierRejected),
  };
}

export function listPendingSkillProposals(vault: string): ReadonlyArray<{
  id: string;
  slug: string;
  status: string;
  patternKind: string;
}> {
  const dir = ensureInsideVault(join(vault, BRAIN_SKILL_PROPOSALS_REL, "pending"), vault);
  if (!existsSync(dir)) return Object.freeze([]);

  const out: Array<{
    id: string;
    slug: string;
    status: string;
    patternKind: string;
  }> = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = ensureInsideVault(join(dir, name), vault);
    const [fm] = parseFrontmatter(path);
    if (fm["kind"] !== "brain-skill-proposal") continue;
    if (typeof fm["id"] !== "string") continue;
    out.push({
      id: fm["id"],
      slug: typeof fm["slug"] === "string" ? fm["slug"] : fm["id"].replace(/^prop-/, ""),
      status: typeof fm["status"] === "string" ? fm["status"] : "pending",
      patternKind: typeof fm["pattern_kind"] === "string" ? fm["pattern_kind"] : "unknown",
    });
  }
  return Object.freeze(out);
}

/** A declared skill proposal was rejected before anything was written. */
export class DeclaredSkillProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclaredSkillProposalError";
  }
}

export interface DeclaredSkillProposalInput {
  /** Human-facing skill name; its slug is the proposal's identity key. */
  readonly name: string;
  /** What the skill does, carried verbatim into the reviewable body. */
  readonly body: string;
  /** Where the declaration was found, as wikilinks. */
  readonly sourceRefs: ReadonlyArray<string>;
  readonly now?: Date;
}

/**
 * What a declaration did, by name.
 *
 *   - `created`   - a new pending draft was written.
 *   - `deduped`   - an equivalent draft is already PENDING review, so the
 *                   declaration resolved to it and nothing was written.
 *   - `suppressed`- the queue declined: the name is already reviewed
 *                   (accepted or rejected), or a file already occupies the
 *                   slug. Nothing was written and the declared body was
 *                   NOT stored anywhere.
 *
 * The three are distinct because the caller's next move differs: a
 * `deduped` declaration is safely consumed - the same skill is already
 * queued for a human - while a `suppressed` one has nowhere its content
 * survives, so consuming its marker would destroy the only copy.
 */
export type DeclaredSkillProposalOutcome = "created" | "deduped" | "suppressed";

interface DeclaredSkillProposalResultBase {
  readonly id: string;
  readonly slug: string;
  /** The proposal file this declaration created or resolved to. */
  readonly path: string;
}

export type DeclaredSkillProposalResult = DeclaredSkillProposalResultBase &
  (
    | { readonly outcome: "created" | "deduped" }
    /** `reason` is required here: a decline the caller cannot explain is a silent drop. */
    | { readonly outcome: "suppressed"; readonly reason: string }
  );

/**
 * Draft a PENDING proposal from an author's `@osb skill` declaration.
 *
 * The write lands in `pending` and nowhere else: acceptance stays the
 * human step, exactly as it is for a mined proposal. See
 * {@link DECLARED_MARKER_PATTERN_KIND} for why the mining verifier is not
 * in this path. No `confidence` key is written either - a declaration
 * makes no statistical claim, and `resolveSkillProposalEvidence` already
 * reads an absent claim as zero self-reported support.
 *
 * One name, one proposal: see {@link DeclaredSkillProposalOutcome} for
 * what happens when the name is taken.
 */
export function draftDeclaredSkillProposal(
  vault: string,
  input: DeclaredSkillProposalInput,
): DeclaredSkillProposalResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const planned = planDeclaredSkillProposal(vault, input);
  if ("declined" in planned) return planned.declined;
  const plan = planned.plan;

  const now = (input.now ?? new Date()).toISOString();
  const sourceRefs = [...input.sourceRefs];

  writeFrontmatterAtomic(
    plan.path,
    {
      schema_version: 1,
      kind: "brain-skill-proposal",
      id: plan.id,
      slug: plan.slug,
      status: "pending",
      pattern_kind: DECLARED_MARKER_PATTERN_KIND,
      name_key: plan.nameKey,
      version: SKILL_PROPOSAL_INITIAL_VERSION,
      payload_hash: plan.payloadHash,
      created_at: now,
      updated_at: now,
      evidence_count: String(sourceRefs.length),
      source_refs: sourceRefs,
    },
    renderProposalDocument({
      title: plan.name,
      patternKind: DECLARED_MARKER_PATTERN_KIND,
      key: plan.key,
      suggestedBody: plan.body.split("\n"),
      evidence: sourceRefs.map((ref) => `- declared in ${ref}`),
    }),
    {
      overwrite: false,
      existsErrorKind: "skill proposal",
      vaultForRelativePath: vault,
    },
  );

  return { id: plan.id, slug: plan.slug, path: plan.path, outcome: "created" };
}

/**
 * Frontmatter keys carrying the SKILL.md contract a `mature_page`
 * proposal will materialize on accept. Declared here because the writer
 * below and the materializer in {@link acceptSkillProposal} are the only
 * two readers, and a second spelling of any of them would produce a
 * SKILL.md missing the field a reviewer approved.
 */
const SKILL_DRAFT_NAME_KEY = "skill_name";
const SKILL_DRAFT_DESCRIPTION_KEY = "skill_description";
const SKILL_DRAFT_TRIGGERS_KEY = "skill_triggers";

/**
 * Frontmatter keys of a MATERIALIZED `SKILL.md` - the incumbent spelling
 * the accept materializer writes and every later reader of that file
 * (the rewrite incumbent reader among them) must use. Declared beside the
 * draft keys because this exact split - proposal-only `skill_*` spellings
 * versus the incumbent's own - is what a mixed-up reader and writer pair
 * would corrupt.
 */
const SKILL_DESCRIPTION_KEY = "description";
const SKILL_TRIGGERS_KEY = "triggers";

/**
 * Scored-contract keys a `scored_rewrite` proposal carries beside the
 * SKILL.md draft fields: which skill it rewrites, the spec hash the gate
 * verified against, the three rates the gate decided on, and the sha-256
 * of the staged document itself (the candidate binding - see
 * {@link SKILL_CANDIDATE_SHA_KEY}). The writer and the accept-time
 * validation are the only readers, so a second spelling would put an
 * unreviewable claim on a working skill.
 */
const SKILL_REWRITES_SKILL_KEY = "rewrites_skill";
const SKILL_SPEC_HASH_KEY = "spec_hash";
const SKILL_BASELINE_SCORE_KEY = "baseline_score";
const SKILL_CANDIDATE_SCORE_KEY = "candidate_score";
const SKILL_HELDOUT_SCORE_KEY = "heldout_score";

/**
 * The candidate binding a `scored_rewrite` proposal stamps at staging:
 * the sha-256 of the proposal document's body as written, whose
 * `Suggested skill body` section IS the candidate the gate promoted.
 * The accept-time gate recomputes it over the pending file's current
 * bytes (so a post-staging edit is refused by name) and requires the
 * matched promote grade record to carry the same value (so an older
 * round's promote over a different candidate cannot bless this one).
 * A digest is not content: it binds the candidate without carrying it.
 */
const SKILL_CANDIDATE_SHA_KEY = "candidate_sha256";

/** The fixed three-decimal spelling a gate rate carries in frontmatter. */
function formatRewriteScore(score: number): string {
  return score.toFixed(3);
}

/**
 * A skill's `name` becomes a DIRECTORY under the skills root, so it is
 * not free text. Declared here rather than beside the drafting check in
 * `skill-page-drafts.ts` because BOTH ends need it and this module is the
 * one they can share: the draft-time semantic check imports it from here,
 * and {@link readSkillDraft} re-applies it at materialize time.
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One drafted skill, as the calling agent returned it for a mature page. */
export interface MaturePageSkillProposalInput {
  /** Skill directory name; validated as such before it reaches here. */
  readonly name: string;
  /** One-line description, carried verbatim into the SKILL.md frontmatter. */
  readonly description: string;
  /** Trigger keywords, carried verbatim into the SKILL.md frontmatter. */
  readonly triggers: ReadonlyArray<string>;
  /** The SKILL.md body. */
  readonly body: string;
  /** Where the draft came from, as wikilinks - the mature page itself. */
  readonly sourceRefs: ReadonlyArray<string>;
  readonly now?: Date;
}

/**
 * Stage a PENDING proposal drafted from a mature vault page.
 *
 * The write lands in `pending` and nowhere else. That is the whole point
 * of the two-step: the skills root may sit OUTSIDE the vault, and nothing
 * automatic may write there - only {@link acceptSkillProposal}, on an
 * explicit human accept, through the write-ahead journal.
 *
 * Identity, dedup and sticky rejection are the declared path's, unchanged:
 * one name, one proposal, and a name a human already rejected is
 * suppressed rather than resurfaced.
 */
export function draftMaturePageSkillProposal(
  vault: string,
  input: MaturePageSkillProposalInput,
): DeclaredSkillProposalResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const planned = planDeclaredSkillProposal(
    vault,
    { name: input.name, body: input.body, sourceRefs: input.sourceRefs },
    MATURE_PAGE_PATTERN_KIND,
  );
  if ("declined" in planned) return planned.declined;
  const plan = planned.plan;

  const now = (input.now ?? new Date()).toISOString();
  const sourceRefs = [...input.sourceRefs];
  const triggers = input.triggers.map((t) => t.trim()).filter((t) => t.length > 0);

  writeFrontmatterAtomic(
    plan.path,
    {
      schema_version: 1,
      kind: "brain-skill-proposal",
      id: plan.id,
      slug: plan.slug,
      status: "pending",
      pattern_kind: MATURE_PAGE_PATTERN_KIND,
      name_key: plan.nameKey,
      version: SKILL_PROPOSAL_INITIAL_VERSION,
      payload_hash: plan.payloadHash,
      created_at: now,
      updated_at: now,
      evidence_count: String(sourceRefs.length),
      [SKILL_DRAFT_NAME_KEY]: plan.name,
      [SKILL_DRAFT_DESCRIPTION_KEY]: input.description.trim(),
      [SKILL_DRAFT_TRIGGERS_KEY]: triggers,
      source_refs: sourceRefs,
    },
    renderProposalDocument({
      title: plan.name,
      patternKind: MATURE_PAGE_PATTERN_KIND,
      key: plan.key,
      suggestedBody: plan.body.split("\n"),
      evidence: sourceRefs.map((ref) => `- drafted from ${ref}`),
    }),
    {
      overwrite: false,
      existsErrorKind: "skill proposal",
      vaultForRelativePath: vault,
    },
  );

  return { id: plan.id, slug: plan.slug, path: plan.path, outcome: "created" };
}

/** One rewritten skill draft, as a won gate round submits it for staging. */
export interface ScoredRewriteSkillDraft {
  /** Skill directory name; validated as such before anything is written. */
  readonly name: string;
  /** One-line description, carried verbatim into the SKILL.md frontmatter. */
  readonly description: string;
  /** Trigger keywords, carried verbatim into the SKILL.md frontmatter. */
  readonly triggers: ReadonlyArray<string>;
  /** The candidate SKILL.md body the gate round scored. */
  readonly body: string;
}

export interface ScoredRewriteProposalInput {
  /** The candidate the selection and held-out gates just promoted. */
  readonly skill: ScoredRewriteSkillDraft;
  /** The preregistration this round verified against (`verifyRewriteTake`). */
  readonly spec: SkillRewriteSpec;
  /** The spec hash stamped on the proposal, the grade record and the accept. */
  readonly specHash: string;
  readonly baselineScore: number;
  readonly candidateScore: number;
  readonly heldoutScore: number;
  /**
   * The incumbent SKILL.md's current `version`. The staged proposal carries
   * one more, so the accept-time materialize lands the bumped version the
   * evolve precedent expects - the version is decided at the gate, not at
   * the accept, because the receipt that pinned it is the gate's.
   */
  readonly incumbentVersion: number;
  readonly now?: Date;
}

/**
 * What staging a scored rewrite produced. A `created` outcome carries the
 * candidate binding (`documentSha256`) the staged proposal was stamped
 * with: the gate round hands it to the grade record it appends next, so
 * the promote record and the pending proposal name the same bytes.
 */
export type ScoredRewriteStagingResult = DeclaredSkillProposalResultBase &
  (
    | { readonly outcome: "created"; readonly documentSha256: string }
    | { readonly outcome: "deduped" }
    /** `reason` is required here: a decline the caller cannot explain is a silent drop. */
    | { readonly outcome: "suppressed"; readonly reason: string }
  );

/**
 * Stage a PENDING proposal from a benchmark-gated rewrite round that WON
 * (agent-presence, Lane A).
 *
 * The write lands in `pending` and nowhere else, exactly like every other
 * producer in this module: the skills root may sit outside the vault, and
 * nothing automatic writes there - only {@link acceptSkillProposal}, on an
 * explicit human accept, through the write-ahead journal. Because a
 * `scored_rewrite` accept OVERWRITES an incumbent SKILL.md, the accept
 * captures the incumbent bytes first ({@link SkillAcceptJournalEntry.priorContentPath})
 * and its rollback restores content, not just existence.
 *
 * Identity is the declared path's, with one extension: the payload hash
 * mixes in the spec hash and the three scores, so re-running the same
 * gate on a changed receipt or a different result is a DIFFERENT proposal
 * (a fresh reviewable artifact), while an identical re-stage dedupes to
 * the one already pending. A sticky human rejection of the name still
 * suppresses the whole family.
 *
 * The scores are written as fixed three-decimal strings: they are the
 * frozen claims of a completed gate run, and a human reviewing the pending
 * file reads them against the grade record, never recomputes them.
 *
 * The staged document is stamped with its own sha-256
 * ({@link SKILL_CANDIDATE_SHA_KEY}) and the digest is returned beside the
 * usual fields: the accept-time gate recomputes it over the pending bytes
 * and requires the promote grade record to carry the same value, which is
 * what stops an older round's promote from blessing a different candidate
 * (review round-2, M1 residual R1).
 */
export function stageScoredRewriteProposal(
  vault: string,
  input: ScoredRewriteProposalInput,
): ScoredRewriteStagingResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const name = input.skill.name.trim();
  if (!name) {
    throw new DeclaredSkillProposalError("scored rewrite proposal requires a skill name");
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new DeclaredSkillProposalError(
      `scored rewrite proposal '${name}' is not a skill directory name ` +
        "(lowercase letters, digits and single hyphens)",
    );
  }
  const body = input.skill.body.trim();
  if (!body) {
    throw new DeclaredSkillProposalError(`scored rewrite proposal '${name}' has no candidate body`);
  }
  const description = input.skill.description.trim();
  if (!description) {
    throw new DeclaredSkillProposalError(`scored rewrite proposal '${name}' has no description`);
  }
  if (typeof input.specHash !== "string" || input.specHash.length === 0) {
    // The receipt location is named because the fix is re-reading it, not
    // re-typing it: the hash must be the one `skillRewriteSpecHash` stamped.
    throw new DeclaredSkillProposalError(
      `scored rewrite proposal '${name}' requires the spec hash of the frozen receipt at ` +
        skillBenchmarkRelPath(name, SKILL_BENCHMARK_SPEC_FILE),
    );
  }
  for (const [label, score] of [
    ["baseline", input.baselineScore],
    ["candidate", input.candidateScore],
    ["held-out", input.heldoutScore],
  ] as const) {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new DeclaredSkillProposalError(
        `scored rewrite proposal '${name}' has a ${label} score that is not a number in [0, 1]: ` +
          JSON.stringify(score),
      );
    }
  }
  if (
    typeof input.incumbentVersion !== "number" ||
    !Number.isInteger(input.incumbentVersion) ||
    input.incumbentVersion < 1
  ) {
    throw new DeclaredSkillProposalError(
      `scored rewrite proposal '${name}' has an incumbent version that is not a positive integer: ` +
        JSON.stringify(input.incumbentVersion),
    );
  }

  const salt = JSON.stringify({
    specHash: input.specHash,
    baseline: input.baselineScore,
    candidate: input.candidateScore,
    heldout: input.heldoutScore,
  });
  const planned = planDeclaredSkillProposal(
    vault,
    { name, body, sourceRefs: [] },
    SCORED_REWRITE_PATTERN_KIND,
    { payloadSalt: salt },
  );
  if ("declined" in planned) {
    const declined = planned.declined;
    // A re-stage declines only as a suppressed family or as a dedupe (an
    // identical pending copy already there). The explicit reconstruction
    // keeps the returned shape honest: a "created" decline would mean a
    // freshly planned proposal was never written, which no caller could
    // act on, so it refuses instead of wearing a borrowed shape.
    if (declined.outcome === "suppressed") return declined;
    if (declined.outcome !== "deduped") {
      throw new DeclaredSkillProposalError(
        `scored rewrite proposal '${name}' could not be staged: the planner declined a ` +
          "freshly planned proposal",
      );
    }
    return { id: declined.id, slug: declined.slug, path: declined.path, outcome: "deduped" };
  }
  const plan = planned.plan;

  const now = (input.now ?? new Date()).toISOString();
  const triggers = input.skill.triggers.map((t) => t.trim()).filter((t) => t.length > 0);
  const fmt = formatRewriteScore;

  // The candidate binding is computed over the EXACT document body this
  // call writes: the parse round-trip (`formatFrontmatter` out,
  // `parseFrontmatter` back) is byte-exact for this shape, so the accept
  // gate can recompute the same digest over the pending file and refuse
  // any post-staging edit. The document's Suggested skill body section is
  // the candidate verbatim, so this binds the grade history to the
  // candidate bytes without carrying them.
  const document = renderProposalDocument({
    title: plan.name,
    patternKind: SCORED_REWRITE_PATTERN_KIND,
    key: plan.key,
    suggestedBody: body.split("\n"),
    evidence: [
      `- spec ${input.specHash} (seed ${input.spec.seed}, ${input.spec.splitRule})`,
      `- baseline ${fmt(input.baselineScore)} / candidate ${fmt(input.candidateScore)} / ` +
        `held-out ${fmt(input.heldoutScore)}`,
    ],
  });
  const documentSha256 = sha256Hex(document);

  writeFrontmatterAtomic(
    plan.path,
    {
      schema_version: 1,
      kind: "brain-skill-proposal",
      id: plan.id,
      slug: plan.slug,
      status: "pending",
      pattern_kind: SCORED_REWRITE_PATTERN_KIND,
      name_key: plan.nameKey,
      version: input.incumbentVersion + 1,
      payload_hash: plan.payloadHash,
      created_at: now,
      updated_at: now,
      evidence_count: "2",
      [SKILL_DRAFT_NAME_KEY]: plan.name,
      [SKILL_DRAFT_DESCRIPTION_KEY]: description,
      [SKILL_DRAFT_TRIGGERS_KEY]: triggers,
      [SKILL_REWRITES_SKILL_KEY]: plan.name,
      [SKILL_SPEC_HASH_KEY]: input.specHash,
      [SKILL_BASELINE_SCORE_KEY]: fmt(input.baselineScore),
      [SKILL_CANDIDATE_SCORE_KEY]: fmt(input.candidateScore),
      [SKILL_HELDOUT_SCORE_KEY]: fmt(input.heldoutScore),
      [SKILL_CANDIDATE_SHA_KEY]: documentSha256,
    },
    document,
    {
      overwrite: false,
      existsErrorKind: "skill proposal",
      vaultForRelativePath: vault,
    },
  );

  return { id: plan.id, slug: plan.slug, path: plan.path, outcome: "created", documentSha256 };
}

/**
 * What {@link draftDeclaredSkillProposal} would do, without writing.
 *
 * Same validation, same identity derivation, same decline reasons - the
 * two share {@link planDeclaredSkillProposal}, so a preview cannot report
 * an outcome the writer would not reach. Used by `scan-inline --dry-run`,
 * which must count and report what a real run would do while touching
 * nothing.
 */
export function previewDeclaredSkillProposal(
  vault: string,
  input: DeclaredSkillProposalInput,
): DeclaredSkillProposalResult {
  const planned = planDeclaredSkillProposal(vault, input);
  if ("declined" in planned) return planned.declined;
  const plan = planned.plan;
  return { id: plan.id, slug: plan.slug, path: plan.path, outcome: "created" };
}

/** Everything a declared draft needs, once the queue has agreed to take it. */
interface DeclaredSkillProposalPlan {
  readonly id: string;
  readonly slug: string;
  readonly path: string;
  readonly name: string;
  readonly body: string;
  readonly key: string;
  readonly nameKey: string;
  readonly payloadHash: string;
}

/**
 * Decide what a declaration does before anything is written: a plan to
 * draft, or the outcome the queue declined with.
 *
 * Both guards below refuse by name rather than letting the exclusive
 * write throw an untyped `EEXIST` later - the same two guards the mined
 * path carries in `learnSkillProposals`, in the same order.
 */
function planDeclaredSkillProposal(
  vault: string,
  input: DeclaredSkillProposalInput,
  patternKind: SkillProposalPatternKind = DECLARED_MARKER_PATTERN_KIND,
  opts: { readonly payloadSalt?: string } = {},
):
  | { readonly plan: DeclaredSkillProposalPlan }
  | { readonly declined: DeclaredSkillProposalResult } {
  const name = input.name.trim();
  if (!name) throw new DeclaredSkillProposalError("declared skill proposal requires a name");
  const body = input.body.trim();
  if (!body) throw new DeclaredSkillProposalError(`declared skill proposal '${name}' has no body`);

  const key = slugify(name);
  const nameKey = nameKeyFor(patternKind, key);
  // The payload hash is computed BEFORE the phase loop because a scored
  // rewrite's ACCEPTED-phase suppression key needs it: an accepted rewrite
  // must not pin the skill against the next changed candidate the gate's
  // iterative mode stages, so acceptance suppresses on the complete
  // payload identity (skill, body and salt) instead of the name alone.
  // The pending and rejected phases keep the family match - one pending
  // overwrite per skill at a time (two accepted drafts would stamp the
  // same version over one SKILL.md and the second would silently drop the
  // first) and an operator reject is sticky for the whole rewrite family,
  // per the design. The family match also covers pending and rejected
  // proposals staged before the payload key existed; a same-payload
  // re-stage against a LEGACY accepted proposal is still caught by the
  // slug-occupancy guard below, because an identical payload derives the
  // identical slug. The salt joins the hashed payload ONLY when a
  // producer supplies one, so the declared and mature-page hashes stay
  // byte-identical to the pre-rewrite spellings.
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify(
        opts.payloadSalt !== undefined
          ? { patternKind, key, body, salt: opts.payloadSalt }
          : { patternKind, key, body },
      ),
      "utf8",
    )
    .digest("hex");
  const rewritePayloadKey = `${nameKey}:${payloadHash}`;
  const isScoredRewrite = patternKind === SCORED_REWRITE_PATTERN_KIND;
  for (const phase of PROPOSAL_PHASES) {
    const existing = findProposalByNameKey(
      vault,
      phase,
      isScoredRewrite && phase === "accepted" ? rewritePayloadKey : nameKey,
      isScoredRewrite && phase !== "accepted",
    );
    if (existing === null) continue;
    const found = { id: existing.id, slug: existing.slug, path: existing.path };
    if (phase === "pending") return { declined: { ...found, outcome: "deduped" } };
    return {
      declined: {
        ...found,
        outcome: "suppressed",
        reason:
          `a skill proposal named '${name}' is already ${phase} (${existing.id}); ` +
          "this declaration was not drafted and its body was not stored",
      },
    };
  }

  const slug = composeProposalSlug(patternKind, key, payloadHash);
  const id = `prop-${slug}`;

  for (const phase of PROPOSAL_PHASES) {
    const occupied = proposalPhasePath(vault, phase, slug);
    if (!existsSync(occupied)) continue;
    return {
      declined: {
        id,
        slug,
        path: occupied,
        outcome: "suppressed",
        reason:
          `a skill proposal file already occupies slug '${slug}' under ${phase}/; ` +
          "this declaration was not drafted and its body was not stored",
      },
    };
  }

  return {
    plan: {
      id,
      slug,
      path: skillProposalPendingPath(vault, slug),
      name,
      body,
      key,
      nameKey: isScoredRewrite ? rewritePayloadKey : nameKey,
      payloadHash,
    },
  };
}

/**
 * Accept a pending proposal: archive it, materialize its procedure, drop
 * the pending copy, reproject.
 *
 * The four steps are one compensating transaction. Every step is preceded
 * by a write-ahead journal stamp (see `skill-accept-journal.ts`), so a
 * CRASH - which no `catch` can compensate - is resolved by the next accept
 * or by {@link recoverSkillProposalAccepts}; a thrown error is compensated
 * inline through the same resolver. Removing the pending copy is the
 * commit point: before it the sequence rolls back to the pending draft,
 * after it the sequence rolls forward to rebuilt projections.
 *
 * The whole sequence runs under one vault-wide accept lock. That lock is
 * what makes the sweep of OTHER slugs' journals safe: no second accept can
 * be mid-sequence while this one resolves what it finds.
 */
export function acceptSkillProposal(
  vault: string,
  slug: string,
  opts: SkillProposalAcceptOptions = {},
): SkillProposalReviewResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // Validated before anything touches disk: a malformed contract must not
  // half-accept a proposal.
  const contract = contractFrontmatter(opts.contract);
  const now = (opts.now ?? new Date()).toISOString();

  const lock = acquireAcceptLock(vault);
  try {
    resolveOutstandingAccepts(vault);

    const pendingPath = skillProposalPendingPath(vault, slug);
    if (!existsSync(pendingPath)) {
      throw new Error(`pending skill proposal not found: ${slug}`);
    }

    const [fm, body] = parseFrontmatter(pendingPath);
    if (fm["kind"] !== "brain-skill-proposal") {
      throw new Error(`invalid skill proposal file: ${pendingPath}`);
    }
    // A scored rewrite is the one pattern kind whose acceptance OVERWRITES
    // an incumbent: its scored contract is validated before the journal is
    // stamped, so a corrupted draft cannot half-accept.
    const isRewrite = fm["pattern_kind"] === SCORED_REWRITE_PATTERN_KIND;
    if (isRewrite) validateScoredRewriteContract(fm);
    const id = typeof fm["id"] === "string" ? fm["id"] : `prop-${slug}`;
    const version = parseVersion(fm["version"]);
    const acceptedPath = skillProposalAcceptedPath(vault, slug);
    // Which tree the materialize step writes into is decided by the
    // proposal's pattern kind, once, here - so the journal, the write and
    // the returned result all name the same file.
    const skillDraft = readSkillDraft(fm);
    // The rest of the gate is re-verified against the CURRENT vault state
    // before the journal is stamped (review security M1): field presence
    // and score ranges alone never overwrite an incumbent skill. A forged
    // or stale scored_rewrite is refused here by name, with nothing
    // written and the draft left pending for the operator.
    if (isRewrite && skillDraft !== null) {
      verifyScoredRewriteGate(vault, fm, skillDraft.name, body);
    }
    const materializedPath =
      skillDraft === null
        ? procedurePath(vault, slug)
        : join(resolveSkillsRoot(vault, opts.skillsRoot), skillDraft.name, SKILL_FILE_NAME);

    let journal: SkillAcceptJournalEntry = {
      slug,
      id,
      phase: "archive",
      startedAt: now,
      // Captured up front so a rollback never deletes a file this
      // sequence did not create.
      acceptedExisted: existsSync(acceptedPath),
      materializedExisted: existsSync(materializedPath),
      materializedPath,
    };
    writeSkillAcceptJournal(vault, journal);

    try {
      writeFrontmatterAtomic(
        acceptedPath,
        {
          ...fm,
          status: "accepted",
          version,
          reviewed_at: now,
          updated_at: now,
          ...(opts.note ? { review_note: opts.note } : {}),
          ...contract,
        },
        body,
        {
          overwrite: false,
          existsErrorKind: "accepted skill proposal",
          vaultForRelativePath: vault,
        },
      );

      // Rewrite overwrite discipline: while the incumbent still exists,
      // capture its bytes vault-side and stamp the journal with the copy's
      // path BEFORE the overwrite - so a crash after the overwrite rolls
      // back to the incumbent BODY, not just to its existence. The capture
      // precedes the stamp deliberately: a crash in between leaves an
      // orphan copy and an overwrite that never happened, which the next
      // pass clears; the reverse order would leave a journal promising a
      // copy that is not there.
      if (isRewrite && journal.materializedExisted) {
        const priorPath = skillAcceptPriorContentPath(vault, slug);
        mkdirSync(dirname(priorPath), { recursive: true });
        atomicWriteFileSync(priorPath, readFileSync(materializedPath, "utf8"));
        journal = { ...journal, priorContentPath: priorPath };
      }

      journal = { ...journal, phase: "materialize" };
      writeSkillAcceptJournal(vault, journal);
      if (skillDraft === null) {
        writeFrontmatterAtomic(
          materializedPath,
          {
            schema_version: 1,
            kind: "brain-procedure",
            id: `proc-${slug}`,
            slug,
            source_proposal: id,
            version,
            created_at: now,
            updated_at: now,
            status: "active",
            ...contract,
          },
          renderAcceptedProcedureBody(id, body),
          {
            overwrite: false,
            existsErrorKind: "procedure",
            vaultForRelativePath: vault,
          },
        );
      } else {
        // The skills root may live outside the vault, so this write passes
        // no `vaultForRelativePath` - the confinement check that key drives
        // would refuse the very path the operator configured. The path is
        // still not free-form: `skillDraft.name` was validated as a skill
        // directory name before the proposal was staged, and the root comes
        // from config, never from the payload.
        //
        // A scored_rewrite is the ONE overwrite in this module: it replaces
        // an incumbent SKILL.md, and only after the journal captured the
        // incumbent bytes above. Every other producer here is still
        // exclusive-create.
        mkdirSync(dirname(materializedPath), { recursive: true });
        writeFrontmatterAtomic(
          materializedPath,
          {
            name: skillDraft.name,
            [SKILL_DESCRIPTION_KEY]: skillDraft.description,
            ...(skillDraft.triggers.length > 0
              ? { [SKILL_TRIGGERS_KEY]: skillDraft.triggers }
              : {}),
            source_proposal: id,
            version,
            created_at: now,
            updated_at: now,
            ...contract,
          },
          renderAcceptedSkillBody(id, skillDraft.name, body),
          { overwrite: isRewrite, existsErrorKind: "skill" },
        );
      }

      journal = { ...journal, phase: "commit" };
      writeSkillAcceptJournal(vault, journal);
      unlinkSync(pendingPath);
      rebuildProceduralProjections(vault);
    } catch (error) {
      compensateSkillAccept(vault, journal, error);
    }

    clearSkillAcceptJournal(vault, slug);
    return {
      id,
      slug,
      status: "accepted",
      proposalPath: acceptedPath,
      ...(skillDraft === null
        ? { procedurePath: materializedPath }
        : { skillPath: materializedPath }),
    };
  } finally {
    lock.release();
  }
}

/**
 * Resolve every accept sequence a previous run abandoned. Returns what was
 * done per slug; an empty array means there was nothing outstanding.
 *
 * This is the operator surface for a journal a crash left behind, reached
 * through `o2b brain skill-proposals recover`. It refuses, by name, on the
 * two states it must not paper over: a held lock
 * ({@link SkillAcceptLockedError}) and an unreadable marker
 * (`SkillAcceptJournalUnreadableError`).
 */
export function recoverSkillProposalAccepts(vault: string): ReadonlyArray<SkillAcceptRecovery> {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const lock = acquireAcceptLock(vault);
  try {
    return Object.freeze(resolveOutstandingAccepts(vault));
  } finally {
    lock.release();
  }
}

/**
 * Delete every accept-journal marker that cannot be parsed, returning the
 * paths removed in the order they were found.
 *
 * This is the ONE mechanical exit in this pair, and it is deliberately not
 * automatic: it runs when an operator asks for it, never inside an accept.
 * What it gives up is stated rather than hidden - an unreadable marker
 * names no phase, so the sequence it marked cannot be rolled back or
 * forward, and removing it unblocks accepting without claiming that
 * sequence was resolved. The marker's own contents are the only thing lost;
 * every artifact the sequence may have written is still on disk, where
 * `o2b brain doctor` reports duplicates and orphans.
 */
export function discardUnreadableSkillAcceptJournals(vault: string): ReadonlyArray<string> {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const lock = acquireAcceptLock(vault);
  try {
    const discarded = readSkillAcceptJournals(vault).unreadable.map((entry) => entry.path);
    for (const path of discarded) removeSkillAcceptJournalFile(vault, path);
    return Object.freeze(discarded);
  } finally {
    lock.release();
  }
}

/** Registry code for the refusal a held accept lock produces. */
export const SKILL_ACCEPT_LOCKED_CODE = "skill-accept-locked";

/**
 * Resolved at module scope so a registry that lost the entry fails at
 * import rather than inside the refusal it is meant to explain.
 */
const LOCKED_EXIT = requireNextStep(SKILL_ACCEPT_LOCKED_CODE).nextCommand;

/**
 * The accept lock was already held.
 *
 * Deliberately NOT a breaker. The lock primitive is a single-attempt
 * exclusive create, so no timeout distinguishes a crashed writer from a
 * live one, and removing a live writer's lock corrupts what it protects -
 * the same reason `applier-capability.ts` refuses `stale-lock`. What
 * changes here is that the refusal names the exact file to judge and the
 * command that lists every lock under the Brain tree, instead of leaving
 * an `ELOCKED` errno for the operator to trace back to a path.
 */
export class SkillAcceptLockedError extends Error {
  readonly path: string;
  constructor(path: string, options?: { readonly cause?: unknown }) {
    super(
      `skill-proposal accept is locked by ${path}; every accept is refused while it is held. ` +
        "Nothing breaks it automatically - a live writer cannot be told from a crashed one - " +
        `so confirm no process owns it, then remove that file by hand: ${LOCKED_EXIT}`,
      options,
    );
    this.name = "SkillAcceptLockedError";
    this.path = path;
  }
}

/** Path of the lock guarding the accept sequence and the journal sweep. */
export function skillAcceptLockPath(vault: string): string {
  return `${acceptLockTarget(vault)}.lock`;
}

/**
 * Take the accept lock, mapping the primitive's `ELOCKED` errno onto the
 * named refusal. One wrapper for all three entry points, so an operator
 * meets the same message whichever one they reached.
 */
function acquireAcceptLock(vault: string): LockHandle {
  try {
    return acquireLockSync(acceptLockTarget(vault));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new SkillAcceptLockedError(skillAcceptLockPath(vault), { cause: error });
    }
    throw error;
  }
}

/** Lock target guarding the accept sequence and the journal sweep. */
function acceptLockTarget(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_SKILL_PROPOSALS_REL, ACCEPT_LOCK_NAME), vault);
}

/** Caller must already hold {@link acceptLockTarget}. */
function resolveOutstandingAccepts(vault: string): SkillAcceptRecovery[] {
  return listSkillAcceptJournals(vault).map((journal) => ({
    slug: journal.slug,
    action: resolveSkillAccept(vault, journal),
  }));
}

/**
 * Roll one journaled sequence back or forward.
 *
 * The pending copy is the commit witness: the sequence removes it only
 * once both writes have landed, so its presence means nothing was
 * committed and the draft must survive untouched.
 */
function resolveSkillAccept(
  vault: string,
  journal: SkillAcceptJournalEntry,
): SkillAcceptRecoveryAction {
  const committed =
    journal.phase === "commit" && !existsSync(skillProposalPendingPath(vault, journal.slug));

  if (!committed) {
    if (!journal.acceptedExisted) {
      rmSync(skillProposalAcceptedPath(vault, journal.slug), { force: true });
    }
    if (!journal.materializedExisted) {
      // The recorded path, never a re-derived one: a `mature_page` accept
      // materializes under the skills root, which the slug does not name.
      const target = journal.materializedPath ?? procedurePath(vault, journal.slug);
      rmSync(target, { force: true });
      // A skill directory this sequence created is now empty; leaving it
      // would make `discoverSkills` report a root with a nameless hole in
      // it. `rmdirSync` refuses a non-empty directory, which is exactly the
      // guard wanted - a pre-existing sibling file keeps the directory.
      if (target !== procedurePath(vault, journal.slug)) {
        try {
          rmdirSync(dirname(target));
        } catch {
          // Non-empty or already gone; either way nothing more to undo.
        }
      }
    } else if (journal.priorContentPath !== undefined) {
      // The incumbent EXISTED and a scored rewrite may have replaced its
      // bytes mid-sequence: restore the captured incumbent body. This is
      // the one rollback in the module that restores CONTENT, not just
      // existence - a rewrite that could only be undone by deleting the
      // incumbent would be worse than the crash it recovers from.
      restorePriorSkillContent(vault, journal);
    }
    clearSkillAcceptJournal(vault, journal.slug);
    return "rolled_back";
  }

  rebuildProceduralProjections(vault);
  clearSkillAcceptJournal(vault, journal.slug);
  return "completed";
}

/**
 * Restore an incumbent SKILL.md's bytes from the journal's prior-content
 * copy. Caller must already hold the accept lock and know
 * `journal.priorContentPath` is set.
 *
 * A missing or unreadable copy is NOT papered over: the rollback would
 * otherwise silently leave the CANDIDATE body on an incumbent's path,
 * which is the one outcome worse than the crash being recovered from.
 * Throwing keeps the journal on disk (the resolver's callers retain it),
 * so the operator decides with the copy gone - the same named refusal
 * posture as an unreadable journal marker.
 */
function restorePriorSkillContent(vault: string, journal: SkillAcceptJournalEntry): void {
  const priorPath = journal.priorContentPath;
  if (priorPath === undefined) return;
  // The copy is a vault artifact the accept sequence wrote; a path that
  // escapes the vault is a hand-edited journal, not a recovery input.
  const source = ensureInsideVault(priorPath, vault);
  let prior: string;
  try {
    prior = readFileSync(source, "utf8");
  } catch (error) {
    throw new Error(
      `skill proposal accept rollback for '${journal.slug}' cannot restore the incumbent body: ` +
        `the prior-content copy is missing or unreadable (${errorMessage(error)}); ` +
        `journal retained for recovery: ${skillAcceptJournalPath(vault, journal.slug)}`,
      { cause: error },
    );
  }
  const target = journal.materializedPath;
  if (target === undefined) {
    throw new Error(
      `skill proposal accept rollback for '${journal.slug}' cannot restore the incumbent body: ` +
        `the journal records no materialized path; journal retained for recovery: ` +
        skillAcceptJournalPath(vault, journal.slug),
    );
  }
  // The target is a journal-supplied string, read from the same
  // agent-writable file as the source above, so it gets the same distrust
  // (review security M4): a restore may only land inside the vault or the
  // skills root the materialize step itself resolves. A hand-edited
  // journal is not a recovery input.
  const skillsRoot = resolveSkillsRoot(vault, undefined);
  if (!isLexicallyInside(target, vault) && !isLexicallyInside(target, skillsRoot)) {
    throw new Error(
      `skill proposal accept rollback for '${journal.slug}' refuses the journal's materialized ` +
        `path ${target}: a restore target must resolve inside the vault or the skills root ` +
        `(${skillsRoot}); a hand-edited journal is not a recovery input. ` +
        `Journal retained for recovery: ${skillAcceptJournalPath(vault, journal.slug)}`,
    );
  }
  // The restore rides the shared atomic writer: an interrupted rollback
  // leaves either the incumbent or the candidate, never a hybrid.
  atomicWriteFileSync(target, prior);
}

/**
 * Lexical containment of `target` inside `root`, resolved the way
 * `ensureInsideVault` resolves before it checks. The rollback validation
 * is a pure path predicate - the target usually exists (it holds the
 * candidate bytes), but the guard must not depend on that - and the
 * symlink sweep is intentionally not repeated here: the accept that wrote
 * the journal already refused symlinked skills roots, and the restore
 * rides the rename-based atomic writer, which replaces a swapped-in link
 * rather than following it.
 */
function isLexicallyInside(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root) + sep;
  return resolvedTarget.startsWith(resolvedRoot);
}

/**
 * Inline compensation for a THROWN step. Always rethrows: either the
 * original error once the sequence has been resolved, or - when the
 * resolution itself fails - a named error saying the journal was retained
 * so a later recovery pass can finish the job.
 */
function compensateSkillAccept(
  vault: string,
  journal: SkillAcceptJournalEntry,
  error: unknown,
): never {
  let repairFailure: unknown = null;
  try {
    resolveSkillAccept(vault, journal);
  } catch (repairError) {
    repairFailure = repairError;
  }
  if (repairFailure !== null) {
    // The step failure stays the `cause`; the repair failure is named in
    // the message, and the journal on disk keeps the sequence recoverable.
    throw new Error(
      `skill proposal accept failed and could not be resolved (${errorMessage(repairFailure)}); ` +
        `journal retained for recovery: ${skillAcceptJournalPath(vault, journal.slug)}`,
      { cause: error },
    );
  }
  throw error;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Rebuild the three projections derived from the procedure tree. */
function rebuildProceduralProjections(vault: string): void {
  reconcileProceduralMemory(vault, {
    roots: DEFAULT_PROCEDURAL_ROOTS.map((root) => join(vault, root)),
  });
  const graph = rebuildProceduralGraph(vault);
  rebuildProceduralHints(vault, { graph });
}

/**
 * Frontmatter fragment for the execution contract. An absent or empty
 * field writes no key; a field holding a blank or non-string entry is a
 * caller error and is refused by name rather than quietly dropped.
 */
function contractFrontmatter(
  contract: SkillContractInput | undefined,
): Record<string, ReadonlyArray<string>> {
  if (!contract) return {};
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [field, key] of SKILL_CONTRACT_FIELDS) {
    const values = contract[field];
    if (values === undefined || values.length === 0) continue;
    out[key] = values.map((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`skill contract field '${field}' must not contain an empty entry`);
      }
      return value.trim();
    });
  }
  return out;
}

/**
 * Resolve a proposal's SELF-REPORTED support against the independently
 * recorded procedural outcome ledger.
 *
 * `evidence_count` and `confidence` come from the proposal's own pattern
 * match, so on their own they corroborate nothing. The ledger written by
 * `recordProceduralOutcome` is host-supplied and never inferred, and it is
 * joined here by the entry id derived from the procedure path the accept
 * path already causes to exist - no lookup table, no second registry.
 */
export function resolveSkillProposalEvidence(vault: string, slug: string): SkillProposalEvidence {
  const found = findReviewedProposal(vault, slug);
  const fm = found.fm;
  const entryId = proceduralEntryId(vaultRelative(vault, procedurePath(vault, slug)));
  const entry = listProceduralMemory(vault).find((candidate) => candidate.id === entryId) ?? null;

  return Object.freeze({
    slug,
    id: typeof fm["id"] === "string" ? fm["id"] : `prop-${slug}`,
    phase: found.phase,
    claimedEvidenceCount: Number.parseInt(String(fm["evidence_count"] ?? "0"), 10) || 0,
    claimedConfidence: Number.parseFloat(String(fm["confidence"] ?? "0")) || 0,
    proceduralEntryId: entryId,
    proceduralEntryPresent: entry !== null,
    recordedSuccesses: entry?.successCount ?? null,
    recordedFailures: entry?.failureCount ?? null,
    recordedSuccessRate: entry === null ? null : proceduralSuccessRate(entry),
    outcomeState: outcomeState(entry?.successCount ?? 0, entry?.failureCount ?? 0),
  });
}

export interface SkillRewriteGradeRecordInput {
  /** The assembled gate-run payload from `buildRewriteGradeRecord`. */
  readonly payload: RewriteGradeRecordPayload;
  readonly now?: Date;
}

/**
 * Append one `skill_rewrite_eval_grade` continuity record for a completed
 * gate run (agent-presence, Lane A).
 *
 * This is the ONLY thing a failed gate round writes: a `hold` or a short
 * `not_enough_evidence` stages nothing - the pending-proposal tree is
 * untouched - so an operator can audit why a rewrite did not land by
 * reading the record alone.
 *
 * The payload is REBUILT field by field from a validated input, never
 * spread: the record carries identifiers, numbers, booleans and check ids
 * with the spec hash, and anything else in the caller's object - task
 * text, transcript text, an extra diagnostic blob - is dropped by
 * construction rather than filtered after the fact. A malformed field is
 * a named error, because a grade record with a junk rate in it is worse
 * than no record: it is the evidence a human accept reads.
 */
export function recordSkillRewriteGrade(
  vault: string,
  input: SkillRewriteGradeRecordInput,
): ContinuityRecord {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const payload = validateRewriteGradePayload(input.payload);
  return appendContinuityRecord(vault, {
    kind: "skill_rewrite_eval_grade",
    createdAt: (input.now ?? new Date()).toISOString(),
    payload,
  });
}

/** One rebuilt per-task grade row: ids and check verdicts only. */
function rebuildGradeTaskRow(
  row: unknown,
  arm: string,
): {
  readonly task_id: string;
  readonly passed: boolean;
  readonly failed_checks: ReadonlyArray<string>;
} {
  const raw = (row ?? {}) as Record<string, unknown>;
  const taskId = raw["task_id"];
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error(`skill rewrite grade record has a ${arm} row without a task id`);
  }
  const passed = raw["passed"];
  if (typeof passed !== "boolean") {
    throw new Error(
      `skill rewrite grade record has a ${arm} row for '${taskId}' without a boolean 'passed'`,
    );
  }
  const failedChecks = raw["failed_checks"];
  if (
    !Array.isArray(failedChecks) ||
    failedChecks.some((check) => typeof check !== "string" || check.trim().length === 0)
  ) {
    throw new Error(
      `skill rewrite grade record has a ${arm} row for '${taskId}' whose failed checks are not check-id strings`,
    );
  }
  return { task_id: taskId, passed, failed_checks: [...failedChecks] };
}

function validateRewriteGradePayload(payload: RewriteGradeRecordPayload): ContinuityPayload {
  if (typeof payload.skill !== "string" || !SKILL_NAME_RE.test(payload.skill)) {
    throw new Error(
      `skill rewrite grade record has a skill name that is not a skill directory name: ` +
        JSON.stringify(payload.skill ?? null),
    );
  }
  for (const field of ["spec_hash", "tasks_hash", "split_rule"] as const) {
    const value = payload[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`skill rewrite grade record is missing '${field}'`);
    }
  }
  if (payload.metric !== SKILL_REWRITE_METRIC) {
    throw new Error(
      `skill rewrite grade record has a metric other than '${SKILL_REWRITE_METRIC}': ` +
        JSON.stringify(payload.metric ?? null),
    );
  }
  if (typeof payload.seed !== "number" || !Number.isInteger(payload.seed) || payload.seed < 0) {
    throw new Error(
      `skill rewrite grade record has a seed that is not a non-negative integer: ` +
        JSON.stringify(payload.seed ?? null),
    );
  }
  if (!isSkillRewriteVerdict(payload.verdict)) {
    throw new Error(
      `skill rewrite grade record has an unknown verdict: ${JSON.stringify(payload.verdict ?? null)}`,
    );
  }
  for (const field of ["baseline_rate", "candidate_rate"] as const) {
    const rate = payload[field];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error(
        `skill rewrite grade record has a '${field}' that is not a number in [0, 1]: ` +
          JSON.stringify(rate ?? null),
      );
    }
  }
  if (!Array.isArray(payload.dev) || !Array.isArray(payload.held_out)) {
    throw new Error("skill rewrite grade record is missing its dev or held-out task rows");
  }
  // The candidate binding (review round-2, M1 residual R1): present only
  // on the record a final promote wrote beside its staged proposal - hold
  // rounds stage nothing and bind nothing. The accept-time grade match
  // requires it, so a promote record without one can never satisfy an
  // accept (fail-closed), and a malformed value refuses here at write
  // time rather than failing a match later.
  const candidateSha = payload.candidate_sha256;
  if (
    candidateSha !== undefined &&
    (typeof candidateSha !== "string" || !SHA256_HEX_RE.test(candidateSha))
  ) {
    throw new Error(
      `skill rewrite grade record has a 'candidate_sha256' that is not a sha-256 hex digest: ` +
        JSON.stringify(candidateSha),
    );
  }
  return Object.freeze({
    skill: payload.skill,
    spec_hash: payload.spec_hash,
    tasks_hash: payload.tasks_hash,
    metric: payload.metric,
    seed: payload.seed,
    split_rule: payload.split_rule,
    verdict: payload.verdict,
    baseline_rate: payload.baseline_rate,
    candidate_rate: payload.candidate_rate,
    dev: Object.freeze(payload.dev.map((row) => rebuildGradeTaskRow(row, "dev"))),
    held_out: Object.freeze(payload.held_out.map((row) => rebuildGradeTaskRow(row, "held-out"))),
    ...(candidateSha !== undefined ? { candidate_sha256: candidateSha } : {}),
  });
}

export interface RewriteIncumbent {
  readonly body: string;
  readonly version: number;
  readonly path: string;
  /** Present when the incumbent frontmatter carries a usable description. */
  readonly description?: string;
  /** Present when the incumbent frontmatter carries usable triggers. */
  readonly triggers?: ReadonlyArray<string>;
}

/**
 * Read an incumbent SKILL.md as a rewrite round's baseline: its body (the
 * baseline round's prompt text) and its `version` (what the staged
 * proposal bumps).
 *
 * A rewrite gates the CANDIDATE against the INCUMBENT, so a skill with no
 * incumbent is not a rewrite target and is refused by name rather than
 * gated against nothing. This is the CLI and MCP face of the same
 * resolution `acceptSkillProposal` uses, so the surfaces cannot disagree
 * about where the incumbent lives.
 */
export function readRewriteIncumbent(
  vault: string,
  skillName: string,
  opts: { readonly skillsRoot?: string } = {},
): RewriteIncumbent {
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new DeclaredSkillProposalError(
      `rewrite incumbent requires a skill directory name ` +
        `(lowercase letters, digits and single hyphens): ${JSON.stringify(skillName)}`,
    );
  }
  const path = join(resolveSkillsRoot(vault, opts.skillsRoot), skillName, SKILL_FILE_NAME);
  if (!existsSync(path)) {
    throw new DeclaredSkillProposalError(
      `no incumbent SKILL.md for '${skillName}' at ${path}; a rewrite gates a candidate ` +
        "against an existing skill, not a fresh one",
    );
  }
  const [fm, body] = parseFrontmatter(path);
  // Unlike the proposal paths, there is no default here: the incumbent's
  // version is what the staged proposal bumps, and inventing one would
  // silently rewrite a skill's history. A corrupted incumbent is refused.
  const versionRaw = fm["version"];
  const version =
    typeof versionRaw === "number"
      ? versionRaw
      : typeof versionRaw === "string"
        ? Number.parseInt(versionRaw, 10)
        : Number.NaN;
  if (!Number.isInteger(version) || version < 1) {
    throw new DeclaredSkillProposalError(
      `the incumbent SKILL.md for '${skillName}' has no usable version frontmatter at ${path}`,
    );
  }
  // The incumbent's OWN frontmatter keys, not the proposal-only draft
  // spellings (`skill_description`/`skill_triggers` exist on staged
  // proposals; a materialized SKILL.md carries `description`/`triggers`,
  // the same keys the accept materializer writes below). Reading the draft
  // keys made every real incumbent read as undescribed, so the staged
  // rewrite wore the placeholder description and an empty trigger list,
  // and the accept overwrote the incumbent's identity with them.
  const description = fm[SKILL_DESCRIPTION_KEY];
  const triggersRaw = fm[SKILL_TRIGGERS_KEY];
  const triggers = Array.isArray(triggersRaw)
    ? triggersRaw.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : typeof triggersRaw === "string" && triggersRaw.trim().length > 0
      ? [triggersRaw.trim()]
      : [];
  return {
    body,
    version,
    path,
    ...(typeof description === "string" && description.trim().length > 0
      ? { description: description.trim() }
      : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
  };
}

// ----- the rewrite status read (agent-presence, Lane A) -------------------------

/** The frozen receipt as the read-only surfaces report it. */
export interface SkillRewriteStatusReceipt {
  readonly schema_version: string;
  readonly tasks_hash: string;
  readonly spec_hash: string;
  readonly seed: number;
  readonly split_rule: string;
  readonly dev_task_ids: ReadonlyArray<string>;
  readonly heldout_task_ids: ReadonlyArray<string>;
  readonly required_margin: number;
  readonly min_dev_tasks: number;
  /** Whether the CURRENT task set still matches the receipt's frozen hash. */
  readonly take_verifies: boolean;
  readonly take_reason: string | null;
}

/** One completed gate run, as the read-only surfaces report it. */
export interface SkillRewriteStatusGrade {
  readonly created_at: string;
  readonly verdict: SkillRewriteVerdict;
  readonly baseline_rate: number;
  readonly candidate_rate: number;
  readonly spec_hash: string;
}

export interface SkillRewriteStatus {
  readonly skill: string;
  /** Null when the skill has no benchmark yet - a named empty, not an error. */
  readonly receipt: SkillRewriteStatusReceipt | null;
  /** Completed gate runs for this skill, oldest first, capped at the last 10. */
  readonly grades: ReadonlyArray<SkillRewriteStatusGrade>;
  /**
   * Grade rows for this skill that failed the writer's own payload
   * validation - external corruption only, since the writer rebuilds
   * every field. They are dropped from `grades` (never rendered as a
   * verdict) and counted here; doctor and the continuity reader are the
   * surfaces that name the cause.
   */
  readonly unreadable_grades: number;
  /** The slug of a staged-but-unaccepted scored_rewrite proposal, if any. */
  readonly pending_rewrite_slug: string | null;
}

export const SKILL_REWRITE_STATUS_GRADE_CAP = 10;

/**
 * Read one skill's rewrite lane status: the verified receipt, the grade
 * ledger's rows for this skill, and whether a rewrite proposal is sitting
 * in pending awaiting a human accept.
 *
 * READ-ONLY, and deliberately terse: identifiers, hashes and rates - the
 * same discipline as the grade record itself. The per-task check rows stay
 * in the ledger where the accept review reads them; a status surface that
 * dumped every task row on every call would be a bounded-output refusal
 * waiting to happen, and would add nothing a human accept needs.
 */
export function readSkillRewriteStatus(vault: string, skillName: string): SkillRewriteStatus {
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new DeclaredSkillProposalError(
      `skill rewrite status requires a skill directory name ` +
        `(lowercase letters, digits and single hyphens): ${JSON.stringify(skillName)}`,
    );
  }

  let receipt: SkillRewriteStatusReceipt | null = null;
  const tasksPath = skillBenchmarkTasksPath(vault, skillName);
  const specPath = skillBenchmarkSpecPath(vault, skillName);
  if (existsSync(tasksPath) && existsSync(specPath)) {
    const tasks = parseSkillBenchmarkTasks(JSON.parse(readFileSync(tasksPath, "utf8")), tasksPath);
    const spec = parseSkillRewriteSpec(JSON.parse(readFileSync(specPath, "utf8")), specPath);
    const take = verifyRewriteTake(spec, tasks);
    receipt = {
      schema_version: spec.schemaVersion,
      tasks_hash: spec.tasksHash,
      spec_hash: skillRewriteSpecHash(spec),
      seed: spec.seed,
      split_rule: spec.splitRule,
      dev_task_ids: spec.devTaskIds,
      heldout_task_ids: spec.heldoutTaskIds,
      required_margin: spec.requiredMargin,
      min_dev_tasks: spec.minDevTasks,
      take_verifies: take.ok,
      take_reason: take.reason,
    };
  }

  // Every row the status renders is re-validated with the writer's own
  // boundary (validateRewriteGradePayload): the writer rebuilds each
  // payload field by field, so a row that fails here is external
  // corruption, and coercing it to a plausible verdict with zeroed rates
  // would render corrupted grade history as ordinary gate output on the
  // exact surface a human consults before accepting a rewrite. Such a
  // row is dropped from `grades` and counted in `unreadable_grades`
  // instead; the validator's cause text stays on the operator surfaces.
  const gradeRows = listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" }).filter(
    (record) => (record.payload as Record<string, unknown>)["skill"] === skillName,
  );
  const grades: SkillRewriteStatusGrade[] = [];
  let unreadableGrades = 0;
  for (const record of gradeRows) {
    try {
      // The validator's frozen return is the rebuilt payload; the cast
      // only re-attaches the field types its own checks just proved.
      const payload = validateRewriteGradePayload(
        record.payload as unknown as RewriteGradeRecordPayload,
      ) as unknown as RewriteGradeRecordPayload;
      grades.push({
        created_at: record.createdAt,
        verdict: payload.verdict,
        baseline_rate: payload.baseline_rate,
        candidate_rate: payload.candidate_rate,
        spec_hash: payload.spec_hash,
      });
    } catch {
      unreadableGrades += 1;
    }
  }
  const cappedGrades = grades.slice(-SKILL_REWRITE_STATUS_GRADE_CAP);

  // The pending match reads the proposal's own `rewrites_skill` key: the
  // name key would do, but the frontmatter claim is what the reviewer saw.
  let pendingSlug: string | null = null;
  for (const proposal of listPendingSkillProposals(vault)) {
    if (proposal.patternKind !== SCORED_REWRITE_PATTERN_KIND) continue;
    const [fm] = parseFrontmatter(skillProposalPendingPath(vault, proposal.slug));
    if (fm[SKILL_REWRITES_SKILL_KEY] === skillName) {
      pendingSlug = proposal.slug;
      break;
    }
  }

  return {
    skill: skillName,
    receipt,
    grades: cappedGrades,
    unreadable_grades: unreadableGrades,
    pending_rewrite_slug: pendingSlug,
  };
}

function outcomeState(successes: number, failures: number): SkillEvidenceOutcomeState {
  if (successes === 0 && failures === 0) return "unrecorded";
  if (successes > 0 && failures > 0) return "mixed";
  return failures > 0 ? "failing" : "successful";
}

/** Where a proposal with `slug` lives while it is in `phase`. */
function proposalPhasePath(vault: string, phase: SkillProposalPhase, slug: string): string {
  switch (phase) {
    case "accepted":
      return skillProposalAcceptedPath(vault, slug);
    case "rejected":
      return skillProposalRejectedPath(vault, slug);
    case "pending":
      return skillProposalPendingPath(vault, slug);
  }
}

/** Locate a proposal in whichever phase holds it, terminal phases first. */
function findReviewedProposal(
  vault: string,
  slug: string,
): { phase: SkillProposalPhase; fm: Record<string, unknown> } {
  for (const phase of PROPOSAL_PHASES) {
    const path = proposalPhasePath(vault, phase, slug);
    if (!existsSync(path)) continue;
    const [fm] = parseFrontmatter(path);
    return { phase, fm: fm as Record<string, unknown> };
  }
  throw new Error(`skill proposal not found in any phase: ${slug}`);
}

function vaultRelative(vault: string, absolute: string): string {
  return relative(vault, absolute).replaceAll("\\", "/");
}

export function rejectSkillProposal(
  vault: string,
  slug: string,
  opts: { now?: Date; note: string },
): SkillProposalReviewResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (!opts.note.trim()) {
    throw new Error("rejecting skill proposal requires a non-empty note");
  }

  const now = (opts.now ?? new Date()).toISOString();
  const pendingPath = skillProposalPendingPath(vault, slug);
  if (!existsSync(pendingPath)) {
    throw new Error(`pending skill proposal not found: ${slug}`);
  }

  const [fm, body] = parseFrontmatter(pendingPath);
  if (fm["kind"] !== "brain-skill-proposal") {
    throw new Error(`invalid skill proposal file: ${pendingPath}`);
  }
  const id = typeof fm["id"] === "string" ? fm["id"] : `prop-${slug}`;
  const rejectedPath = skillProposalRejectedPath(vault, slug);

  writeFrontmatterAtomic(
    rejectedPath,
    {
      ...fm,
      status: "rejected",
      reviewed_at: now,
      updated_at: now,
      review_note: opts.note,
    },
    body,
    {
      overwrite: false,
      existsErrorKind: "rejected skill proposal",
      vaultForRelativePath: vault,
    },
  );

  unlinkSync(pendingPath);
  rebuildProceduralProjections(vault);
  return { id, slug, status: "rejected", proposalPath: rejectedPath };
}

function readWatermark(vault: string): WatermarkState {
  const path = watermarkPath(vault);
  if (!existsSync(path)) return { lastCreatedAt: null, lastId: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      lastCreatedAt: typeof parsed["lastCreatedAt"] === "string" ? parsed["lastCreatedAt"] : null,
      lastId: typeof parsed["lastId"] === "string" ? parsed["lastId"] : null,
    };
  } catch {
    return { lastCreatedAt: null, lastId: null };
  }
}

function writeWatermark(vault: string, state: WatermarkState): void {
  const path = proposalWatermarkPath(vault);
  const root = ensureInsideVault(dirname(path), vault);
  mkdirSync(root, { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  atomicWriteFileSync(path, `${payload}\n`);
}

function watermarkPath(vault: string): string {
  return proposalWatermarkPath(vault);
}

/** Stable name identity of a candidate, independent of the specific records. */
function candidateNameKey(candidate: ProposalCandidate): string {
  return nameKeyFor(candidate.patternKind, candidate.key);
}

/** The stored `name_key`, shared by the mined and the declared paths. */
function nameKeyFor(patternKind: SkillProposalPatternKind, key: string): string {
  return `${patternKind}:${key}`;
}

/** Source references a candidate contributes (record ids plus their source ids). */
function candidateSourceRefs(candidate: ProposalCandidate): string[] {
  return candidate.records.flatMap((record) => [
    record.id,
    ...record.sourceRefs.map((src) => src.id),
  ]);
}

/** True when `record` structurally supports the candidate's pattern. */
function recordSupportsCandidate(candidate: ProposalCandidate, record: ContinuityRecord): boolean {
  switch (candidate.patternKind) {
    case "repeated_action":
      return actionToken(record) === candidate.key;
    case "structural_similarity":
      return shapeSignature(record) === candidate.key;
    case "co_occurrence": {
      const [left, right] = candidate.key.split(" -> ");
      const token = actionToken(record);
      return token !== null && (token === left || token === right);
    }
    case "temporal_routine": {
      const [action, hour] = candidate.key.split("@");
      return actionToken(record) === action && isoHour(record.createdAt) === hour;
    }
    default:
      return false;
  }
}

/** Parse a stored version scalar, defaulting to the initial version. */
function parseVersion(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : SKILL_PROPOSAL_INITIAL_VERSION;
}

/** Merge two source-ref lists, preserving order and dropping duplicates. */
function mergeSourceRefs(previous: unknown, next: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  if (Array.isArray(previous)) for (const ref of previous) push(ref);
  for (const ref of next) push(ref);
  return out;
}

interface FoundProposal {
  readonly path: string;
  readonly slug: string;
  readonly id: string;
  readonly fm: Record<string, unknown>;
  readonly body: string;
}

/**
 * Find the first proposal in `phase` whose stored name key matches.
 *
 * `familyPrefix` widens the match to the key's family: the stored key
 * equals `nameKey` or carries it as the prefix before a `:` separator,
 * which is the shape a scored rewrite's payload-scoped key
 * (`<family>:<payload hash>`) shares with its bare family key. The
 * rejected phase needs the family match - an operator reject is sticky
 * for the skill name, not for one payload.
 */
function findProposalByNameKey(
  vault: string,
  phase: SkillProposalPhase,
  nameKey: string,
  familyPrefix = false,
): FoundProposal | null {
  const dir = ensureInsideVault(join(vault, BRAIN_SKILL_PROPOSALS_REL, phase), vault);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = ensureInsideVault(join(dir, name), vault);
    const [fm, body] = parseFrontmatter(path);
    if (fm["kind"] !== "brain-skill-proposal") continue;
    const stored = fm["name_key"];
    const matches =
      stored === nameKey ||
      (familyPrefix === true && typeof stored === "string" && stored.startsWith(`${nameKey}:`));
    if (!matches) continue;
    const slug =
      typeof fm["slug"] === "string" ? fm["slug"] : name.replace(/^prop-/, "").replace(/\.md$/, "");
    const id = typeof fm["id"] === "string" ? fm["id"] : `prop-${slug}`;
    return { path, slug, id, fm: fm as Record<string, unknown>, body };
  }
  return null;
}

/** Count of distinct records that structurally support the candidate. */
function supportingCount(candidate: ProposalCandidate): number {
  return new Set(
    candidate.records
      .filter((record) => recordSupportsCandidate(candidate, record))
      .map((r) => r.id),
  ).size;
}

/** Merge a candidate's support into an existing pending draft (no fork). */
function mergePendingProposal(
  vault: string,
  match: FoundProposal,
  candidate: ProposalCandidate,
  newRefs: ReadonlyArray<string>,
  now: Date,
  watermarkTo: string,
): void {
  const priorEvidence = Number.parseInt(String(match.fm["evidence_count"] ?? "0"), 10) || 0;
  const priorConfidence = Number.parseFloat(String(match.fm["confidence"] ?? "0")) || 0;
  writeFrontmatterAtomic(
    match.path,
    {
      ...match.fm,
      confidence: Math.max(priorConfidence, candidate.confidence).toFixed(3),
      evidence_count: String(priorEvidence + supportingCount(candidate)),
      source_refs: mergeSourceRefs(match.fm["source_refs"], newRefs),
      updated_at: now.toISOString(),
      watermark_to: watermarkTo,
    },
    match.body,
    { overwrite: true, vaultForRelativePath: vault },
  );
}

/** Evolve an accepted skill: merge support and increment its version. */
function evolveAcceptedProposal(
  vault: string,
  match: FoundProposal,
  candidate: ProposalCandidate,
  newRefs: ReadonlyArray<string>,
  now: Date,
  watermarkTo: string,
): void {
  const priorEvidence = Number.parseInt(String(match.fm["evidence_count"] ?? "0"), 10) || 0;
  const nextVersion = parseVersion(match.fm["version"]) + 1;
  writeFrontmatterAtomic(
    match.path,
    {
      ...match.fm,
      version: nextVersion,
      evidence_count: String(priorEvidence + supportingCount(candidate)),
      source_refs: mergeSourceRefs(match.fm["source_refs"], newRefs),
      updated_at: now.toISOString(),
      watermark_to: watermarkTo,
    },
    match.body,
    { overwrite: true, vaultForRelativePath: vault },
  );

  const procPath = procedurePath(vault, match.slug);
  if (existsSync(procPath)) {
    const [procFm, procBody] = parseFrontmatter(procPath);
    writeFrontmatterAtomic(
      procPath,
      { ...procFm, version: nextVersion, updated_at: now.toISOString() },
      procBody,
      { overwrite: true, vaultForRelativePath: vault },
    );
  }
}

/**
 * The verifier-rejection ledger file THIS device appends to:
 * `verifier-rejections[.<deviceId>].jsonl` (t_774dea61). The empty device
 * id yields the legacy un-sharded name.
 */
export function verifierRejectionLedgerPath(vault: string): string {
  return ensureInsideVault(
    join(
      vault,
      BRAIN_SKILL_PROPOSALS_REL,
      shardedFileName(VERIFIER_REJECTION_LEDGER_STEM, resolveAppendShardId(), JSONL_LEDGER_EXT),
    ),
    vault,
  );
}

/** Append one verifier-rejection record to the JSONL ledger. */
function appendVerifierRejection(
  vault: string,
  entry: { id: string; name_key: string; reason: string; at: string },
): void {
  const path = verifierRejectionLedgerPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

function detectCandidates(
  records: ReadonlyArray<ContinuityRecord>,
  minSupport: number,
): ProposalCandidate[] {
  const out: ProposalCandidate[] = [];

  const actionMap = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    const action = actionToken(record);
    if (!action) continue;
    const bucket = actionMap.get(action) ?? [];
    bucket.push(record);
    actionMap.set(action, bucket);
  }
  for (const [action, bucket] of actionMap) {
    if (bucket.length < minSupport) continue;
    out.push({
      patternKind: "repeated_action",
      key: action,
      confidence: confidence(bucket.length, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      supportingRecords: Object.freeze([...bucket]),
      suggestedTitle: `Repeated action: ${action}`,
    });
  }

  const shapeMap = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    const shape = shapeSignature(record);
    if (!shape) continue;
    const bucket = shapeMap.get(shape) ?? [];
    bucket.push(record);
    shapeMap.set(shape, bucket);
  }
  for (const [shape, bucket] of shapeMap) {
    if (bucket.length < minSupport) continue;
    out.push({
      patternKind: "structural_similarity",
      key: shape,
      confidence: confidence(bucket.length, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      supportingRecords: Object.freeze([...bucket]),
      suggestedTitle: `Structural routine: ${shape}`,
    });
  }

  const pairMap = new Map<string, ContinuityRecord[]>();
  for (let i = 1; i < records.length; i++) {
    const left = actionToken(records[i - 1]!);
    const right = actionToken(records[i]!);
    if (!left || !right || left === right) continue;
    const pair = `${left} -> ${right}`;
    const bucket = pairMap.get(pair) ?? [];
    bucket.push(records[i - 1]!, records[i]!);
    pairMap.set(pair, bucket);
  }
  for (const [pair, bucket] of pairMap) {
    const support = Math.floor(bucket.length / 2);
    if (support < minSupport) continue;
    out.push({
      patternKind: "co_occurrence",
      key: pair,
      confidence: confidence(support, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      supportingRecords: Object.freeze([...bucket]),
      suggestedTitle: `Co-occurrence flow: ${pair}`,
    });
  }

  const temporalMap = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    const action = actionToken(record);
    if (!action) continue;
    const hour = isoHour(record.createdAt);
    if (hour === null) continue;
    const key = `${action}@${hour}`;
    const bucket = temporalMap.get(key) ?? [];
    bucket.push(record);
    temporalMap.set(key, bucket);
  }
  for (const [key, bucket] of temporalMap) {
    const daySet = new Set(bucket.map((record) => record.createdAt.slice(0, 10)));
    if (daySet.size < minSupport) continue;
    out.push({
      patternKind: "temporal_routine",
      key,
      confidence: confidence(daySet.size, minSupport),
      records: Object.freeze(bucket.slice(0, 6)),
      supportingRecords: Object.freeze([...bucket]),
      suggestedTitle: `Temporal routine: ${key}`,
    });
  }

  return out.toSorted(
    (left, right) =>
      left.patternKind.localeCompare(right.patternKind) || left.key.localeCompare(right.key),
  );
}

function actionToken(record: ContinuityRecord): string | null {
  const payload = record.payload as Record<string, unknown>;
  for (const field of ["action", "command", "tool", "verb", "event"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

function shapeSignature(record: ContinuityRecord): string | null {
  const keys = Object.keys(record.payload).toSorted();
  if (keys.length === 0) return null;
  return `${record.kind}:${keys.join(",")}`;
}

function isoHour(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return String(date.getUTCHours()).padStart(2, "0");
}

function confidence(support: number, minSupport: number): number {
  const raw = Math.min(0.99, 0.55 + (support - minSupport) * 0.1);
  return Math.max(0.55, Math.round(raw * 1000) / 1000);
}

/**
 * The one proposal document shape, whether the pattern was mined or
 * declared. Section order and headings are a contract with
 * `renderAcceptedProcedureBody`, so both producers go through here.
 */
function renderProposalDocument(input: {
  readonly title: string;
  readonly patternKind: SkillProposalPatternKind;
  readonly key: string;
  readonly suggestedBody: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
}): string {
  return [
    `# ${input.title}`,
    "",
    "## Pattern",
    `- kind: ${input.patternKind}`,
    `- key: ${input.key}`,
    "",
    SUGGESTED_BODY_HEADING,
    ...input.suggestedBody,
    "",
    "## Evidence",
    ...input.evidence,
  ].join("\n");
}

function renderProposalBody(candidate: ProposalCandidate): string {
  return renderProposalDocument({
    title: candidate.suggestedTitle,
    patternKind: candidate.patternKind,
    key: candidate.key,
    suggestedBody: [
      `When pattern \`${candidate.key}\` appears, follow the observed repeatable workflow.`,
      "Capture inputs first, execute steps in stable order, and emit audit-friendly outputs.",
    ],
    evidence: candidate.records.map((record) => {
      const snippet = evidenceSnippet(record);
      return `- ${record.createdAt} :: ${record.kind} :: ${record.id}${snippet ? ` :: ${snippet}` : ""}`;
    }),
  });
}

function evidenceSnippet(record: ContinuityRecord): string {
  const payload = record.payload as Record<string, unknown>;
  for (const field of ["query", "summary", "note", "text"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 120);
    }
  }
  return "";
}

function proposalSlug(candidate: ProposalCandidate, payloadHash: string): string {
  return composeProposalSlug(candidate.patternKind, slugify(candidate.key), payloadHash);
}

function composeProposalSlug(
  patternKind: SkillProposalPatternKind,
  keySlug: string,
  payloadHash: string,
): string {
  return `${patternKind}-${keySlug.slice(0, PROPOSAL_SLUG_KEY_MAX_LEN)}-${payloadHash.slice(0, PROPOSAL_SLUG_HASH_LEN)}`;
}

function candidateHash(candidate: ProposalCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        patternKind: candidate.patternKind,
        key: candidate.key,
        records: candidate.records.map((record) => record.id),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * The SKILL.md contract a `mature_page` or `scored_rewrite` proposal
 * carries, or null when the proposal is not one - which is how the accept
 * path chooses its materializer. A proposal stamped with either skill
 * kind but missing a required field is a corrupted draft, not a
 * procedure: it is refused by name rather than materialized into the
 * wrong tree.
 *
 * The name's charset is re-checked here even though the draft paths
 * already refused anything else. This is the one write in the accept
 * sequence that passes no `vaultForRelativePath` - the skills root may
 * legitimately sit outside the vault - so the confinement check every
 * other write leans on is absent, and the only thing standing between a
 * hand-edited `skill_name` in a pending proposal's frontmatter and a
 * `join()` into an arbitrary directory is this test.
 */
function readSkillDraft(
  fm: Readonly<Record<string, unknown>>,
): { name: string; description: string; triggers: string[] } | null {
  if (
    fm["pattern_kind"] !== MATURE_PAGE_PATTERN_KIND &&
    fm["pattern_kind"] !== SCORED_REWRITE_PATTERN_KIND
  ) {
    return null;
  }
  const name = fm[SKILL_DRAFT_NAME_KEY];
  const description = fm[SKILL_DRAFT_DESCRIPTION_KEY];
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`skill proposal is missing '${SKILL_DRAFT_NAME_KEY}'`);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error(`skill proposal is missing '${SKILL_DRAFT_DESCRIPTION_KEY}'`);
  }
  const trimmedName = name.trim();
  if (!SKILL_NAME_RE.test(trimmedName)) {
    throw new Error(
      `skill proposal '${SKILL_DRAFT_NAME_KEY}' is not a skill directory name ` +
        `(lowercase letters, digits and single hyphens): ${JSON.stringify(trimmedName)}`,
    );
  }
  const raw = fm[SKILL_DRAFT_TRIGGERS_KEY];
  const triggers = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : typeof raw === "string" && raw.trim().length > 0
      ? [raw.trim()]
      : [];
  return { name: trimmedName, description: description.trim(), triggers };
}

/**
 * The scored contract a `scored_rewrite` proposal must carry at accept:
 * which skill it rewrites, the spec hash it was gated against, and the
 * three rates the gate decided on. Validated BEFORE the accept journal is
 * stamped - a pending file missing any field is a corrupted draft, and
 * the human accept must refuse it by name rather than overwrite an
 * incumbent skill on an unverifiable claim.
 *
 * The rewrite claim and the materialize target must also name the SAME
 * skill (review security M1d): staging writes both from one name, so a
 * pending file where they diverge is hand-edited, and the divergence would
 * aim the one overwrite in this module at a directory the receipt never
 * mentioned.
 */
function validateScoredRewriteContract(fm: Readonly<Record<string, unknown>>): void {
  const rewrites = fm[SKILL_REWRITES_SKILL_KEY];
  if (typeof rewrites !== "string" || rewrites.trim().length === 0) {
    throw new Error(`scored rewrite proposal is missing '${SKILL_REWRITES_SKILL_KEY}'`);
  }
  const specHash = fm[SKILL_SPEC_HASH_KEY];
  if (typeof specHash !== "string" || specHash.trim().length === 0) {
    throw new Error(`scored rewrite proposal is missing '${SKILL_SPEC_HASH_KEY}'`);
  }
  const candidateSha = fm[SKILL_CANDIDATE_SHA_KEY];
  if (typeof candidateSha !== "string" || !SHA256_HEX_RE.test(candidateSha)) {
    throw new Error(
      `scored rewrite proposal is missing or malformed '${SKILL_CANDIDATE_SHA_KEY}'; the ` +
        "candidate binding is what stops an older promote from blessing a different " +
        "candidate, so a proposal without it predates the binding and its gate round " +
        "must be re-run before this skill can be accepted",
    );
  }
  const draftName = fm[SKILL_DRAFT_NAME_KEY];
  if (rewrites !== draftName) {
    throw new Error(
      `scored rewrite proposal claims to rewrite '${String(rewrites)}' but its ` +
        `'${SKILL_DRAFT_NAME_KEY}' materializes '${String(draftName)}'; ` +
        "the two must name the same skill",
    );
  }
  for (const key of [
    SKILL_BASELINE_SCORE_KEY,
    SKILL_CANDIDATE_SCORE_KEY,
    SKILL_HELDOUT_SCORE_KEY,
  ]) {
    const value = fm[key];
    const score = typeof value === "string" ? Number(value) : value;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(
        `scored rewrite proposal has a '${key}' that is not a number in [0, 1]: ` +
          JSON.stringify(value ?? null),
      );
    }
  }
}

/**
 * How closely a grade record's rate must sit to the proposal's
 * three-decimal score for the two to be the same rate: the staged proposal
 * carries the rate rounded to three places, so anything within half of the
 * last written digit is the same number.
 */
const SCORE_MATCH_TOLERANCE = 0.0005 + Number.EPSILON;

/**
 * Re-verify a `scored_rewrite` proposal's gate claims against the CURRENT
 * vault state at accept (review security M1).
 *
 * `validateScoredRewriteContract` proves the proposal's six fields exist
 * and are shaped right; a hand-forged pending file passes that trivially.
 * This is the part that cannot be forged into existence by editing one
 * file, because it re-reads the vault:
 *
 *   1. the benchmark receipt on disk must still hash to the proposal's
 *      `spec_hash` - a swapped task set or an edited spec invalidates the
 *      proposal instead of quietly re-scoping its claim - and the take
 *      must still verify against the live task set;
 *   2. the pending document must still be the bytes staging stamped: the
 *      recomputed sha-256 of the proposal body must equal the frontmatter
 *      `candidate_sha256`, so a candidate body swapped in after staging
 *      (the pending file is agent-writable) is refused by name;
 *   3. the grade history must hold the gate's final promote for THIS
 *      proposal: a `skill_rewrite_eval_grade` record with verdict
 *      `promote`, the same spec hash and skill, a candidate rate that
 *      matches the proposal's candidate score, AND the same
 *      `candidate_sha256` binding. Rates collide - a historical promote
 *      over a different candidate at the same rate must not bless this
 *      one (review round-2, M1 residual R1) - but a document digest can
 *      only match the round that promoted these exact bytes. No promote
 *      record with this binding, no accept.
 *
 * Every refusal fires BEFORE the accept journal is stamped, so a refused
 * accept writes nothing: the incumbent is untouched and the draft stays
 * pending for the operator to judge. The residual is stated rather than
 * hidden: an agent that can also forge the benchmark documents and the
 * grade store can forge these inputs too - the MCP accept refusal is the
 * boundary that removes this path from the agent's reach entirely.
 */
function verifyScoredRewriteGate(
  vault: string,
  fm: Readonly<Record<string, unknown>>,
  skillName: string,
  proposalBody: string,
): void {
  const specHash = String(fm[SKILL_SPEC_HASH_KEY]);
  const tasksPath = skillBenchmarkTasksPath(vault, skillName);
  const specPath = skillBenchmarkSpecPath(vault, skillName);
  let spec: SkillRewriteSpec;
  let tasks: ReturnType<typeof parseSkillBenchmarkTasks>;
  try {
    tasks = parseSkillBenchmarkTasks(JSON.parse(readFileSync(tasksPath, "utf8")), tasksPath);
    spec = parseSkillRewriteSpec(JSON.parse(readFileSync(specPath, "utf8")), specPath);
  } catch (error) {
    throw new Error(
      `scored rewrite gate for '${skillName}': the benchmark documents cannot be read to ` +
        `re-verify the proposal's receipt against ${skillBenchmarkRelPath(skillName, "")} ` +
        `(${errorMessage(error)}); the accept is refused`,
      { cause: error },
    );
  }
  const liveHash = skillRewriteSpecHash(spec);
  if (liveHash !== specHash) {
    throw new Error(
      `scored rewrite gate for '${skillName}': the proposal's spec hash ${specHash} does not ` +
        `match the benchmark receipt on disk (${liveHash}); a swapped task set or an edited ` +
        "spec invalidates the proposal, so the accept is refused",
    );
  }
  const take = verifyRewriteTake(spec, tasks);
  if (!take.ok) {
    throw new Error(
      `scored rewrite gate for '${skillName}': the benchmark take no longer verifies ` +
        `(${take.reason ?? "receipt mismatch"}); the accept is refused`,
    );
  }
  // The candidate binding, recomputed over the pending file's CURRENT
  // bytes: `parseFrontmatter` trims, and `formatFrontmatter` round-trips
  // this document shape byte-exactly, so an unedited proposal recomputes
  // the value staging stamped, and any post-staging edit - a swapped
  // candidate body above all - breaks it.
  const liveCandidateSha = sha256Hex(proposalBody);
  const stagedCandidateSha = fm[SKILL_CANDIDATE_SHA_KEY];
  if (stagedCandidateSha !== liveCandidateSha) {
    throw new Error(
      `scored rewrite gate for '${skillName}': the proposal's '${SKILL_CANDIDATE_SHA_KEY}' ` +
        `(${String(stagedCandidateSha)}) does not match the pending document's bytes ` +
        `(${liveCandidateSha}); the document was edited after staging, so the accept is ` +
        "refused and the operator should re-run the gate round",
    );
  }
  const candidateScore = Number(fm[SKILL_CANDIDATE_SCORE_KEY]);
  const hasPromote = listContinuityRecords(vault, { kind: "skill_rewrite_eval_grade" }).some(
    (record) => {
      const payload = record.payload as Record<string, unknown>;
      return (
        payload["skill"] === skillName &&
        payload["spec_hash"] === specHash &&
        payload["verdict"] === SKILL_REWRITE_VERDICT.promote &&
        typeof payload["candidate_rate"] === "number" &&
        Math.abs(payload["candidate_rate"] - candidateScore) <= SCORE_MATCH_TOLERANCE &&
        // The binding: a promote record from an earlier round over a
        // DIFFERENT candidate body with the same rate satisfies every
        // check above - rates collide, document digests do not.
        payload[SKILL_CANDIDATE_SHA_KEY] === liveCandidateSha
      );
    },
  );
  if (!hasPromote) {
    throw new Error(
      `scored rewrite gate for '${skillName}': no skill_rewrite_eval_grade record with verdict ` +
        `'${SKILL_REWRITE_VERDICT.promote}' matches this proposal's spec hash ${specHash}, ` +
        `candidate rate ${candidateScore} and candidate_sha256 ${liveCandidateSha}; the gate's ` +
        "final promote is missing from the grade history - or it was earned over a different " +
        "candidate - so the accept is refused",
    );
  }
}

/**
 * The pattern kind of the pending proposal at `slug`, or null when no
 * readable pending file is there. Read by the MCP surface so it can
 * refuse `scored_rewrite` accepts at the boundary the design names -
 * MCP proposes, the operator accepts - without re-deriving the proposal
 * paths or re-parsing frontmatter spelling rules outside this module.
 */
export function pendingSkillProposalPatternKind(vault: string, slug: string): string | null {
  const pendingPath = skillProposalPendingPath(vault, slug);
  if (!existsSync(pendingPath)) return null;
  const [fm] = parseFrontmatter(pendingPath);
  return typeof fm["pattern_kind"] === "string" ? fm["pattern_kind"] : null;
}

/**
 * Where an accepted `mature_page` skill is materialized: the caller's
 * override, else the configured `skills_dir`, else the vault's own
 * `Brain/skills`. `skillRoots()` is not used here because it filters to
 * roots that already EXIST, and the first accepted skill is exactly the
 * case where the root does not.
 */
function resolveSkillsRoot(vault: string, override: string | undefined): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  return resolveSkillsDir() ?? join(vault, "Brain", "skills");
}

function renderAcceptedSkillBody(proposalId: string, name: string, proposalBody: string): string {
  const idx = proposalBody.indexOf(SUGGESTED_BODY_HEADING);
  const suggested =
    idx >= 0 ? proposalBody.slice(idx + SUGGESTED_BODY_HEADING.length).trim() : proposalBody.trim();
  return [
    `# ${name}`,
    "",
    `Accepted from proposal: [[${proposalId}]]`,
    "",
    suggested || "No suggested body was captured.",
  ].join("\n");
}

function renderAcceptedProcedureBody(proposalId: string, proposalBody: string): string {
  const idx = proposalBody.indexOf(SUGGESTED_BODY_HEADING);
  const suggested =
    idx >= 0 ? proposalBody.slice(idx + SUGGESTED_BODY_HEADING.length).trim() : proposalBody.trim();
  return [
    "# Procedure",
    "",
    `Accepted from proposal: [[${proposalId}]]`,
    "",
    suggested || "No suggested body was captured.",
  ].join("\n");
}

export function skillProposalSlugFromPath(path: string): string | null {
  const name = basename(path);
  if (!name.startsWith("prop-") || !name.endsWith(".md")) return null;
  return name.slice("prop-".length, -".md".length);
}

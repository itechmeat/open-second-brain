/**
 * Dependency-ordered remediation planner + executor (F5).
 *
 * `planRemediation` turns findings into a deterministically-ordered
 * repair plan. Each step is classified `auto-safe` - a deterministic,
 * lossless, reversible repair that needs no human judgment - or
 * `needs-review`. `applyRemediation` mutates nothing under `dryRun`,
 * applies only auto-safe steps otherwise, and refuses past `stepCap`.
 *
 * The brain doctor stays non-mutating: this module is the only writer,
 * and it is invoked through an explicit opt-in path. The single
 * auto-safe action in this release is a content-hash re-stamp - the
 * stored `_content_hash` is bookkeeping derived from the authoritative
 * (principle, scope), so re-deriving it touches one frontmatter field
 * and preserves every byte of body content. Conservative by design:
 * contradictions, stale claims, and concept gaps are always
 * needs-review (better to under-fix than auto-mutate something needing
 * judgment).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { computeContentHash, verifyContentHash } from "../content-hash.ts";
import { brainDirs, preferencePath } from "../paths.ts";
import { parsePreference } from "../preference.ts";
import { acquireLockSync } from "../sync-lockfile.ts";

export type RemediationClass = "auto-safe" | "needs-review";

export interface RemediationStep {
  /** Finding code this step addresses. */
  readonly code: string;
  /** Machine action discriminant (`restamp-content-hash` | `review`). */
  readonly action: string;
  /** Repair target - a preference slug, id pair, or concept term. */
  readonly target: string;
  readonly classification: RemediationClass;
  /** Human-readable note for the plan preview. */
  readonly detail: string;
}

export interface RemediationPlan {
  readonly steps: ReadonlyArray<RemediationStep>;
  readonly stepCap: number;
}

export interface RemediationFindings {
  /** Confirmed preferences (slug stems) whose `_content_hash` drifted. */
  readonly driftedSlugs: ReadonlyArray<string>;
  readonly contradictions: ReadonlyArray<{ aId: string; bId: string }>;
  readonly staleClaims: ReadonlyArray<{ id: string }>;
  readonly conceptGaps: ReadonlyArray<{ term: string }>;
}

export interface PlanRemediationOptions {
  /** Maximum number of auto-safe steps `applyRemediation` will apply. */
  readonly stepCap: number;
}

export interface ApplyRemediationOptions {
  /** When true, compute the outcome but make no writes. */
  readonly dryRun: boolean;
}

export interface RemediationOutcome {
  readonly applied: ReadonlyArray<RemediationStep>;
  readonly skipped: ReadonlyArray<RemediationStep>;
  readonly dryRun: boolean;
}

// Fixed dependency order: bookkeeping repairs first, then semantic
// review steps. Pinned explicitly so the plan is identical on every
// Syncthing peer.
const CODE_ORDER: ReadonlyMap<string, number> = new Map([
  ["content-hash-drift", 0],
  ["contradictory-preferences", 1],
  ["stale-claim", 2],
  ["concept-gap", 3],
]);

/**
 * Scan `Brain/preferences/` for confirmed preferences whose stored
 * `_content_hash` no longer matches their live (principle, scope) -
 * the auto-safe re-stamp targets. Returns slug stems (no `pref-`
 * prefix), sorted for determinism. Files that fail to parse are
 * skipped (their schema errors surface through the doctor).
 */
export function collectDriftedSlugs(vault: string): string[] {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || !name.startsWith("pref-")) continue;
    try {
      const pref = parsePreference(join(dir, name));
      const check = verifyContentHash({
        principle: pref.principle,
        scope: pref.scope,
        content_hash: pref.content_hash,
      });
      if (!check.ok) out.push(pref.id.replace(/^pref-/, ""));
    } catch {
      // schema error - reported by the doctor
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function planRemediation(
  findings: RemediationFindings,
  opts: PlanRemediationOptions,
): RemediationPlan {
  const steps: RemediationStep[] = [];

  for (const slug of findings.driftedSlugs) {
    steps.push({
      code: "content-hash-drift",
      action: "restamp-content-hash",
      target: slug,
      classification: "auto-safe",
      detail: `re-stamp _content_hash for pref-${slug} from its current content`,
    });
  }
  for (const c of findings.contradictions) {
    steps.push({
      code: "contradictory-preferences",
      action: "review",
      target: `${c.aId}|${c.bId}`,
      classification: "needs-review",
      detail: `reconcile or retire one of [[${c.aId}]] / [[${c.bId}]]`,
    });
  }
  for (const s of findings.staleClaims) {
    steps.push({
      code: "stale-claim",
      action: "review",
      target: s.id,
      classification: "needs-review",
      detail: `re-confirm or retire [[${s.id}]]`,
    });
  }
  for (const g of findings.conceptGaps) {
    steps.push({
      code: "concept-gap",
      action: "review",
      target: g.term,
      classification: "needs-review",
      detail: `capture a dedicated preference for '${g.term}'`,
    });
  }

  steps.sort(
    (a, b) =>
      (CODE_ORDER.get(a.code) ?? 99) - (CODE_ORDER.get(b.code) ?? 99) ||
      a.target.localeCompare(b.target),
  );
  return { steps, stepCap: opts.stepCap };
}

/**
 * Re-stamp a preference's `_content_hash` to match its authoritative
 * (principle, scope). The file is round-tripped through
 * `parseFrontmatter` -> `writeFrontmatterAtomic`, preserving field
 * order and body verbatim; only the `_content_hash` value is rewritten.
 * In-scope files are confirmed preferences that previously carried a
 * txn-written (canonical) hash, so re-serialisation is a no-op for
 * every other field. The write goes through the same `.lock` file the
 * txn uses, so it is serialised against concurrent preference writes.
 * It deliberately bypasses the txn (and so does not bump `_revision`
 * or record edit-history): a hash re-stamp is bookkeeping, not a
 * content change.
 *
 * Returns true when a write happened, false when the file is gone, the
 * hash was already correct, or the lock could not be acquired.
 */
function restampContentHash(vault: string, slug: string): boolean {
  const path = preferencePath(vault, slug);
  if (!existsSync(path)) return false;
  let handle: ReturnType<typeof acquireLockSync>;
  try {
    handle = acquireLockSync(path);
  } catch {
    return false; // contended - leave for a later run
  }
  try {
    const pref = parsePreference(path);
    const correct = computeContentHash(pref.principle, pref.scope);
    if (pref.content_hash === correct) return false;
    const [meta, body] = parseFrontmatter(path);
    meta["_content_hash"] = correct;
    writeFrontmatterAtomic(path, meta, body, { overwrite: true });
    return true;
  } finally {
    handle.release();
  }
}

export function applyRemediation(
  vault: string,
  plan: RemediationPlan,
  opts: ApplyRemediationOptions,
): RemediationOutcome {
  const applied: RemediationStep[] = [];
  const skipped: RemediationStep[] = [];
  let budget = plan.stepCap;

  for (const step of plan.steps) {
    if (step.classification !== "auto-safe" || budget <= 0) {
      skipped.push(step);
      continue;
    }
    if (opts.dryRun) {
      applied.push(step);
      budget--;
      continue;
    }
    const didWrite =
      step.action === "restamp-content-hash"
        ? restampContentHash(vault, step.target)
        : false;
    if (didWrite) {
      applied.push(step);
      budget--;
    } else {
      skipped.push(step);
    }
  }

  return { applied, skipped, dryRun: opts.dryRun };
}

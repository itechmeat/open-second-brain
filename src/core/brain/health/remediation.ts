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

import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ensureInsideVault, vaultRelative } from "../../path-safety.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { computeContentHash, verifyContentHash } from "../content-hash.ts";
import { brainDirs, preferencePath } from "../paths.ts";
import { parsePreference } from "../preference.ts";
import { acquireLockSync } from "../sync-lockfile.ts";
import { BRAIN_PREFERENCE_STATUS } from "../types.ts";

export type RemediationClass = "auto-safe" | "needs-review";

/** Canonical hardened modes: owner-only for files and directories. */
const FILE_TARGET_MODE = 0o600;
const DIR_TARGET_MODE = 0o700;
/** Group + other permission bits. Any set = "wider than owner-only". */
const NON_OWNER_MODE_MASK = 0o077;

export interface WidePermissionFinding {
  /** Vault-relative POSIX path of the over-permissioned entry. */
  readonly path: string;
  readonly isDir: boolean;
  /** Current permission bits (`mode & 0o777`). */
  readonly mode: number;
}

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
  /**
   * Brain/ entries whose POSIX mode is wider than owner-only (D2). Optional
   * so existing callers stay valid; absent is treated as an empty list.
   */
  readonly widePermissions?: ReadonlyArray<WidePermissionFinding>;
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
  ["wide-permissions", 0],
  ["content-hash-drift", 1],
  ["contradictory-preferences", 2],
  ["stale-claim", 3],
  ["concept-gap", 4],
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
      // Only confirmed preferences carry a txn-stamped hash; a legacy
      // or unconfirmed pref without one is not a drift target (and
      // verifyContentHash is neutral on absent hashes anyway).
      if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
      if (!pref.content_hash) continue;
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
  return out.toSorted((a, b) => a.localeCompare(b));
}

export interface CollectWidePermissionsOptions {
  /** Injectable platform for testing; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Injectable logger for the Windows skip line; defaults to stderr. */
  readonly log?: (message: string) => void;
}

/**
 * Scan `Brain/` for files/dirs whose POSIX mode exposes group/other
 * permissions - the `harden-permissions` targets. Symlinks are skipped
 * (a chmod would touch the link target, not the link).
 *
 * On Windows the walk is skipped entirely: POSIX file modes are not
 * meaningful there. Per the no-silent-fallback rule this skip is logged
 * with an explicit reason rather than returning an empty list quietly.
 *
 * Returns findings sorted by path for deterministic plans. Already-tight
 * entries (owner-only) produce no finding, which is what makes the
 * migration idempotent across runs.
 */
export function collectWidePermissions(
  vault: string,
  opts: CollectWidePermissionsOptions = {},
): WidePermissionFinding[] {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    const log = opts.log ?? ((m: string): void => void process.stderr.write(`${m}\n`));
    log("harden-permissions: skipped on win32 (POSIX file modes are not meaningful)");
    return [];
  }
  const root = brainDirs(vault).brain;
  if (!existsSync(root)) return [];
  const out: WidePermissionFinding[] = [];
  const visit = (abs: string): void => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    // Never chmod through a symlink (it would retarget the link's target).
    if (st.isSymbolicLink()) return;
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) return;
    const mode = st.mode & 0o777;
    if ((mode & NON_OWNER_MODE_MASK) !== 0) {
      out.push({ path: vaultRelative(abs, vault), isDir, mode });
    }
    if (isDir) {
      let names: string[];
      try {
        names = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of names) visit(join(abs, name));
    }
  };
  visit(root);
  return out.toSorted((a, b) => a.path.localeCompare(b.path));
}

export function planRemediation(
  findings: RemediationFindings,
  opts: PlanRemediationOptions,
): RemediationPlan {
  const steps: RemediationStep[] = [];

  for (const perm of findings.widePermissions ?? []) {
    steps.push({
      code: "wide-permissions",
      action: "harden-permissions",
      target: perm.path,
      classification: "auto-safe",
      detail:
        `chmod ${perm.isDir ? "0700" : "0600"} ${perm.path} ` +
        `(currently ${perm.mode.toString(8).padStart(3, "0")})`,
    });
  }

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
    // Defence in depth: only re-stamp confirmed preferences that
    // already carry a hash, so a direct call cannot stamp a hash onto a
    // legacy/unconfirmed record outside the drift path.
    if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) return false;
    if (!pref.content_hash) return false;
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

/**
 * Chmod a Brain/ entry to owner-only (`0o600` file, `0o700` dir). The
 * path is re-validated through `ensureInsideVault` and re-stat'd so the
 * canonical mode is derived at apply time, keeping the operation
 * idempotent (an already-tight entry writes nothing). Returns true when
 * a chmod happened, false when the entry is gone, a symlink, or already
 * owner-only.
 */
function hardenPermissions(vault: string, relPath: string): boolean {
  let abs: string;
  try {
    abs = ensureInsideVault(join(vault, relPath), vault);
  } catch {
    return false; // path escapes the vault - never touch it
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) return false;
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) return false;
  if ((st.mode & NON_OWNER_MODE_MASK) === 0) return false; // already hardened
  chmodSync(abs, isDir ? DIR_TARGET_MODE : FILE_TARGET_MODE);
  return true;
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
    let didWrite = false;
    if (step.action === "restamp-content-hash") {
      didWrite = restampContentHash(vault, step.target);
    } else if (step.action === "harden-permissions") {
      didWrite = hardenPermissions(vault, step.target);
    }
    if (didWrite) {
      applied.push(step);
      budget--;
    } else {
      skipped.push(step);
    }
  }

  return { applied, skipped, dryRun: opts.dryRun };
}

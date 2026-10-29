/**
 * The doctor's git tracked-state row (t_206562ae, task B3).
 *
 * The gitignore guard seeded at brain init keeps derived runtime state
 * out of git FROM now on, but an operator who ran an earlier init (or
 * added the store by hand before the guard existed) may already have
 * committed it. Tracking is the one condition a `.gitignore` line cannot
 * repair, so it is measured directly and graded error.
 *
 * Two git facts, two commands, never `git status`:
 *
 *   - TRACKING is measured with `git ls-files -z -- .open-second-brain`,
 *     run vault-bounded. In a linked worktree `git status` omits ignored
 *     files, so only ls-files answers "is this in the index" - the same
 *     discipline `vault-dirty.ts` documents for its own gate.
 *   - IGNORING is measured with `git check-ignore -q` exit discipline:
 *     0 = ignored, 1 = not ignored, any other exit (or a git that cannot
 *     run at all) is a refusal to say, and the row stays silent.
 *
 * Fail-soft throughout: a vault that is not a worktree, a vault whose
 * store directory is absent, and a git that cannot answer are all
 * silence - the doctor never throws on the state of the operator's
 * VCS, and never edits anything. Findings:
 *
 *   - any tracked path under the store → severity error, naming
 *     `git rm -r --cached <path>` per path (capped) plus the exact
 *     missing ignore line;
 *   - present, untracked, unignored → severity warning, the only signal
 *     a vault whose init ran before the guard (or without git) gets.
 *
 * The code resolves through `DIAGNOSTIC_SIGNALS` to `o2b brain init`:
 * the seeder is idempotent and merge-safe, so the ignore half of the
 * remediation is one command (the untracking is git's, named in the
 * finding because no verb performs it).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DERIVED_STORE_DIR } from "../path-constants.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** Derived brain state git is already carrying. */
export const GIT_TRACKED_DERIVED_STATE_CODE = "git-tracked-derived-state";

/** How many tracked paths one finding names before it counts the rest. */
const NAMED_PATH_LIMIT = 5;

/** The exact `.gitignore` line the seeded guard block carries. */
export const GITIGNORE_GUARD_IGNORE_LINE = `/${DERIVED_STORE_DIR}/`;

/** Git listings are bounded like every git read in the tree. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** The derived-store pathspec every listing is bounded by. */
const STORE_PATHSPEC = DERIVED_STORE_DIR;

/** True when `vault` sits inside a git worktree; false when git cannot say. */
function isInsideWorktree(vault: string): boolean {
  try {
    const inside = execFileSync("git", ["-C", vault, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_GIT_OUTPUT,
    }).trim();
    return inside === "true";
  } catch {
    return false;
  }
}

/**
 * Every path under the derived store git carries in its index,
 * vault-relative with git's own forward slashes. `null` when git cannot
 * answer - which is silence here, never a guess.
 */
function trackedStorePaths(vault: string): ReadonlyArray<string> | null {
  try {
    const out = execFileSync("git", ["-C", vault, "ls-files", "-z", "--", STORE_PATHSPEC], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return out.split("\0").filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

/**
 * `check-ignore -q` exit discipline (the `vault-dirty.ts` posture):
 * 0 = ignored, 1 = not ignored, anything else = refuse to say (`null`).
 */
function isIgnored(vault: string, path: string): boolean | null {
  try {
    execFileSync("git", ["-C", vault, "check-ignore", "-q", "--", path], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (err) {
    const status = (err as NodeJS.ErrnoException & { status?: number | null }).status;
    return status === 1 ? false : null;
  }
}

/** What git can measure about the derived store's git state. */
export interface DerivedStoreGitState {
  /** Store paths in the git index, vault-relative. */
  readonly tracked: ReadonlyArray<string>;
  /** Whether the store directory is covered by an ignore rule. */
  readonly ignored: boolean;
}

/**
 * Measure the store's git state, or `null` when the row must stay
 * silent: store directory absent, not a worktree, or a git that cannot
 * answer any of its questions.
 */
export function probeDerivedStoreGitState(vault: string): DerivedStoreGitState | null {
  if (!existsSync(join(vault, DERIVED_STORE_DIR))) return null;
  if (!isInsideWorktree(vault)) return null;
  const tracked = trackedStorePaths(vault);
  if (tracked === null) return null;
  const ignored = isIgnored(vault, STORE_PATHSPEC);
  if (ignored === null) return null;
  return { tracked, ignored };
}

function trackedMessage(tracked: ReadonlyArray<string>): string {
  const named = tracked.slice(0, NAMED_PATH_LIMIT).map((p) => `git rm -r --cached ${p}`);
  const remainder = tracked.length - named.length;
  return (
    `${tracked.length} path(s) under ${DERIVED_STORE_DIR}/ are tracked by git: derived runtime ` +
    "state (search database, checkpoints, ledgers, locks, secrets ciphertext) is in history and " +
    `every commit carries its churn. Untrack with ${named.join(", ")}` +
    `${remainder > 0 ? `, and ${remainder} more` : ""}; add the exact line ` +
    `${GITIGNORE_GUARD_IGNORE_LINE} to .gitignore at the vault root (o2b brain init seeds it ` +
    "idempotently); this check never edits anything"
  );
}

function unignoredMessage(): string {
  return (
    `the derived store ${DERIVED_STORE_DIR}/ is present but not git-ignored: the next ` +
    `\`git add -A\` commits the search database, checkpoints, ledgers and secrets ciphertext. ` +
    `Add the exact line ${GITIGNORE_GUARD_IGNORE_LINE} to .gitignore at the vault root ` +
    "(o2b brain init seeds it idempotently)"
  );
}

/** The git tracked-state row: fail-soft, read-only, silent when it cannot know. */
export const gitTrackedStateCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const state = probeDerivedStoreGitState(ctx.vault);
    if (state === null) return;

    // Tracking dominates: an ignore line beside tracked paths changes
    // nothing about the history already committed.
    if (state.tracked.length > 0) {
      out.issues.push({
        severity: "error",
        code: GIT_TRACKED_DERIVED_STATE_CODE,
        path: ctx.vault,
        message: trackedMessage(state.tracked),
      } satisfies DoctorIssue);
      return;
    }
    if (!state.ignored) {
      out.issues.push({
        severity: "warning",
        code: GIT_TRACKED_DERIVED_STATE_CODE,
        path: ctx.vault,
        message: unignoredMessage(),
      } satisfies DoctorIssue);
    }
  },
};

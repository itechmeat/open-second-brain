/**
 * A path one of the doctor's own sweeps could not read.
 *
 * The sweeps that walk the store by hand each used to swallow a failed
 * read in a bare `catch` and return. That produces no findings, and no
 * findings is what every surface renders as a clean bill of health - so
 * the operator was told the vault was fine exactly where the doctor had
 * been unable to look. This module is the one place that answer is
 * replaced: the read still fails soft, and the branch is named in the
 * `uncertain` stream instead of vanishing.
 *
 * One distinction is drawn here rather than at each call site, because
 * getting it wrong in either direction is a defect. A path that is
 * ABSENT was never a subtree to sweep - the common case is a vault whose
 * optional directory has not been created, and it stays as quiet as it
 * always was. Every other failure - a permission denial, a file standing
 * where a directory was expected, an I/O error - is a subtree that
 * exists and was not read, which is precisely what uncertainty means.
 *
 * That reading of `ENOENT` holds only where absence was POSSIBLE, which
 * is why every read here declares where its path came from. At a sweep's
 * own root, absence is the ordinary case. A path the walk DISCOVERED
 * existed a moment earlier, when its parent listed it, so an `ENOENT` on
 * it is a race - something removed the entry under the walk - and a
 * subtree that was skipped like any other.
 *
 * The code is `vault-walk-entry-skipped` from the closed
 * {@link DEGRADATION_CODE} vocabulary, which already names this exact
 * condition for the shared vault walker. It is SPELLED here rather than
 * referenced through the constant so the doctor's exit census can read
 * the doctor's own code population out of its source; the two cannot
 * drift, because {@link degradationNotice} takes the closed union and a
 * spelling the vocabulary does not hold fails the build.
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";

import { degradationNotice, type DegradationNotice } from "../../integrity/degradation.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorUncertainEntry } from "./report.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** See the module docblock: spelled, and pinned to the vocabulary by its type. */
const VAULT_WALK_ENTRY_SKIPPED_CODE = "vault-walk-entry-skipped";

/**
 * What a sweep reports under, and what it consequently cannot claim.
 *
 * `consequence` is written by the sweep because only the sweep knows
 * which question went unanswered: the operator reads it directly under
 * `[UNSURE]`, and "a directory could not be read" on its own does not
 * say what was therefore left unverified.
 */
export interface SweptPath {
  /** Subsystem name recorded on the notice, e.g. `brain.doctor.symlinkEscape`. */
  readonly site: string;
  /** What this sweep can no longer claim, as one clause. */
  readonly consequence: string;
  /** The doctor's uncertainty stream for the running pass. */
  readonly uncertain: DoctorUncertainEntry[];
}

/**
 * Where the path a read failed on came from, which is what decides
 * whether `ENOENT` means "nothing was ever here" or "it went away under
 * the walk". See the module docblock.
 */
export const SWEEP_ORIGIN = Object.freeze({
  root: "root",
  discovered: "discovered",
} as const);

export type SweepOrigin = (typeof SWEEP_ORIGIN)[keyof typeof SWEEP_ORIGIN];

/** `errno` values meaning nothing is there - not a failure to verify. */
const ABSENT_ERRNO: ReadonlySet<string> = new Set(["ENOENT"]);

/**
 * List `dir`, or report why it could not be listed and return `null`.
 * The caller's control flow is unchanged: `null` means "skip this
 * subtree", exactly as the bare `catch { return; }` it replaces did.
 */
export function readSweptDir(dir: string, swept: SweptPath, origin: SweepOrigin): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return reportSweptFailure(dir, "directory listing failed", err, swept, origin);
  }
}

/** Read `path` as UTF-8, or report why it could not be read. */
export function readSweptFile(path: string, swept: SweptPath, origin: SweepOrigin): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return reportSweptFailure(path, "file read failed", err, swept, origin);
  }
}

/**
 * Report a read this module did not itself perform - a listing behind a
 * shared helper, a discovery pass that throws its own error - under the
 * same code and the same absent/failed split. `action` names what was
 * attempted; the errno text and the sweep's consequence are appended.
 *
 * Always returns `null` so a caller can `return reportSweptFailure(...)`
 * from the branch that skips the subtree.
 */
export function reportSweptFailure(
  path: string,
  action: string,
  err: unknown,
  swept: SweptPath,
  origin: SweepOrigin,
): null {
  if (origin === SWEEP_ORIGIN.root && isAbsent(err)) return null;
  reportSweptSkip(path, `${action}: ${describe(err)}`, swept);
  return null;
}

/**
 * Report a path the sweep declined to read for a reason that is not an
 * error - an entry that is neither a regular file nor a directory, so
 * neither branch of the walk consumes it. Skipping it silently is the
 * same false clean bill of health as swallowing a failed read.
 *
 * Returns the composed sentence, for the one caller that must carry the
 * same statement on a warning as well; the walks ignore it.
 */
export function reportSweptSkip(path: string, detail: string, swept: SweptPath): string {
  const notice = degradationNotice({
    code: VAULT_WALK_ENTRY_SKIPPED_CODE,
    site: swept.site,
    path,
    detail,
  });
  return pushUncertain(
    swept.uncertain,
    {
      code: notice.code,
      ...(notice.path !== undefined ? { path: notice.path } : {}),
      message: notice.detail,
    },
    swept.consequence,
  );
}

/**
 * The same condition as a reportable issue, for a path whose failure
 * stops a whole pass rather than one subtree. Built here so the code is
 * written down once, beside the vocabulary member it is pinned to.
 */
export function sweptPathWarning(path: string, message: string): DoctorIssue {
  return { severity: "warning", code: VAULT_WALK_ENTRY_SKIPPED_CODE, path, message };
}

/**
 * Fold notices a shared walker collected into the same stream, under the
 * same consequence. Used where the sweep does not perform the read
 * itself and the walker reports through the degradation channel.
 */
export function forwardSweepNotices(
  notices: ReadonlyArray<DegradationNotice>,
  swept: SweptPath,
): void {
  for (const notice of notices) {
    pushUncertain(
      swept.uncertain,
      {
        code: notice.code,
        ...(notice.path !== undefined ? { path: notice.path } : {}),
        message: notice.detail,
      },
      swept.consequence,
    );
  }
}

/**
 * Why a path could not be reached, or `null` when the failure means it
 * is not there at all.
 *
 * The same split {@link readSweptDir} applies, exposed for the one
 * caller that must act on the answer rather than report it: the pass
 * entry point, which reports an ABSENT Brain layer as an un-initialized
 * vault and must never say that about one it merely could not read.
 */
export function sweptFailureReason(err: unknown): string | null {
  return isAbsent(err) ? null : describe(err);
}

/**
 * The path an `errno` failure names, or `fallback` when it names none.
 * A shared builder reports the exact directory it stumbled on inside the
 * error, and that is a better answer than the root the caller handed it.
 */
export function sweptFailurePath(err: unknown, fallback: string): string {
  if (typeof err !== "object" || err === null) return fallback;
  const path = (err as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : fallback;
}

function isAbsent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && ABSENT_ERRNO.has(code);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

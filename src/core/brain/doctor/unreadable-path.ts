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
 * The code is `vault-walk-entry-skipped` from the closed
 * {@link DEGRADATION_CODE} vocabulary, which already names this exact
 * condition for the shared vault walker. Minting a doctor-local code
 * would give one condition two spellings that can disagree.
 */

import { readdirSync, readFileSync, type Dirent } from "node:fs";

import {
  DEGRADATION_CODE,
  degradationNotice,
  type DegradationNotice,
} from "../../integrity/degradation.ts";
import type { DoctorUncertainEntry } from "./report.ts";

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
 * Between the read error and what it cost. A semicolon rather than a
 * full stop because the consequence is a clause about the same failure,
 * and the operator reads the pair as one `[UNSURE]` line.
 */
const CONSEQUENCE_SEP = "; ";

/** `errno` values meaning nothing is there - not a failure to verify. */
const ABSENT_ERRNO: ReadonlySet<string> = new Set(["ENOENT"]);

/**
 * List `dir`, or report why it could not be listed and return `null`.
 * The caller's control flow is unchanged: `null` means "skip this
 * subtree", exactly as the bare `catch { return; }` it replaces did.
 */
export function readSweptDir(dir: string, swept: SweptPath): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return report(dir, `directory listing failed: ${describe(err)}`, err, swept);
  }
}

/** Read `path` as UTF-8, or report why it could not be read. */
export function readSweptFile(path: string, swept: SweptPath): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return report(path, `file read failed: ${describe(err)}`, err, swept);
  }
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
    swept.uncertain.push({
      code: notice.code,
      ...(notice.path !== undefined ? { path: notice.path } : {}),
      message: `${notice.detail}${CONSEQUENCE_SEP}${swept.consequence}`,
    });
  }
}

function report(path: string, detail: string, err: unknown, swept: SweptPath): null {
  if (isAbsent(err)) return null;
  const notice = degradationNotice({
    code: DEGRADATION_CODE.vaultWalkEntrySkipped,
    site: swept.site,
    path,
    detail: `${detail}${CONSEQUENCE_SEP}${swept.consequence}`,
  });
  swept.uncertain.push({
    code: notice.code,
    ...(notice.path !== undefined ? { path: notice.path } : {}),
    message: notice.detail,
  });
  return null;
}

function isAbsent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && ABSENT_ERRNO.has(code);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

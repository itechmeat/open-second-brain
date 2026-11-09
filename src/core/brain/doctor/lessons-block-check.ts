/**
 * The lessons-block doctor check (t_1e952e43, task C3).
 *
 * A failSoft, read-only check over the MANAGED lessons blocks of the
 * agent rules files - managed meaning an approval row names the file,
 * because consent lives in the ledger and the doctor does not invent it.
 * One finding per candidate file, graded against the same derivation a
 * refresh would render now (`planLessonsBlock`), so what the doctor
 * says and what the next write would do cannot disagree:
 *
 *   - `lessons-block-stale-lessons` - the block still carries a lesson
 *     whose approval went stale (the approved text moved); the refresh
 *     drops it until the operator approves again;
 *   - `lessons-block-drifted` - the block is behind the canonical body
 *     (a new lesson qualified, or it holds content nothing qualifies
 *     for any more);
 *   - `lessons-block-absent` - approvals name the file but no block
 *     exists; creation is approve's write, so the remedy names approve,
 *     never refresh;
 *   - a current block is silent.
 *
 * The per-file grade is a four-state vocabulary shared with the writer's
 * own drift states plus the named `stale-lessons` extension - registered
 * in the verdict-vocabulary census with the code that introduced it.
 *
 * The check never mutates a byte and never throws: a damaged approvals
 * ledger folds into one warning naming the file and the recovery, and a
 * per-file surprise folds into that file's warning.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import {
  LESSONS_APPROVALS_FILE,
  lessonIdsInBlockBody,
  lessonsApprovalsPath,
  planLessonsBlock,
  readLessonApprovals,
  type LessonApprovalRow,
  type LessonsBlockPlan,
} from "../lessons-promotion.ts";
import { RULES_BLOCK_ID, RulesBlockError, readRulesBlock } from "../../install/rules-block.ts";

/** How a managed lessons block grades, in the census-registered vocabulary. */
export const LESSONS_BLOCK_STATE = Object.freeze({
  /** Approvals name the file but no file, or no block pair, exists. */
  absent: "absent",
  /** The pair exists and carries exactly what a refresh would render. */
  current: "current",
  /** The pair exists but diverges from the canonical body. */
  drifted: "drifted",
  /** The pair still carries a lesson whose approval went stale. */
  staleLessons: "stale-lessons",
} as const);

export type LessonsBlockState = (typeof LESSONS_BLOCK_STATE)[keyof typeof LESSONS_BLOCK_STATE];
export const LESSONS_BLOCK_STATES: ReadonlyArray<LessonsBlockState> = Object.freeze(
  Object.values(LESSONS_BLOCK_STATE),
);

/** True when `value` (read back off disk or wire) is a block state. */
export function isLessonsBlockState(value: unknown): value is LessonsBlockState {
  return (
    typeof value === "string" && (LESSONS_BLOCK_STATES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The finding codes this check emits, one constant each so every `code:`
 * site stays a bare named code readable by the doctor-exit census.
 */
export const LESSONS_BLOCK_ABSENT_CODE = "lessons-block-absent";
export const LESSONS_BLOCK_DRIFTED_CODE = "lessons-block-drifted";
export const LESSONS_BLOCK_STALE_LESSONS_CODE = "lessons-block-stale-lessons";
export const LESSONS_LEDGER_UNREADABLE_CODE = "lessons-approvals-unreadable";

/** The refresh command the drifted and stale findings both name. */
export const LESSONS_REFRESH_COMMAND = "o2b brain lessons refresh-blocks --apply --yes";

/**
 * The agent-instruction files a lessons block may be managed in: the
 * fixed-list guard for the target strings the approvals ledger carries.
 * Ledger rows are machine state in the derived store, so a target string
 * is validated against this list BEFORE any path is derived from it - an
 * off-list target (a traversal, a planted path) never reaches
 * `join(vault, target)` and is skipped, not graded. The list is restated
 * here because a static import of `AGENT_INSTRUCTION_FILES` from the
 * write-back contract would close the doctor import cycle (see the
 * candidate-universe comment in {@link lessonsBlockStates});
 * `tests/core/brain/doctor/lessons-block-check.test.ts` pins this copy
 * to the contract list, so the two cannot drift silently.
 */
export const LESSONS_BLOCK_MANAGED_FILES: ReadonlyArray<string> = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
]);

export interface LessonsBlockStateRow {
  /** The rules file graded (a basename from the fixed list). */
  readonly file: string;
  readonly state: LessonsBlockState;
  /** Lessons the block still carries whose approvals went stale. */
  readonly staleIds: ReadonlyArray<string>;
  /** Lessons a refresh would render into this file now. */
  readonly qualifiedIds: ReadonlyArray<string>;
}

interface Grade {
  readonly state: LessonsBlockState;
  readonly staleIds: ReadonlyArray<string>;
  readonly qualifiedIds: ReadonlyArray<string>;
  readonly detail: string | null;
}

/** True when two block bodies are the same text modulo fence padding. */
function sameBody(a: string, b: string | null): boolean {
  if (b === null) return false;
  const strip = (text: string): string => text.replace(/\s+$/, "");
  return strip(a) === strip(b);
}

/**
 * Grade one candidate file against its approvals and the live vault.
 * Throws only what readRulesBlock throws (symlink, unreadable, broken
 * marker pair) - callers fold that into a per-file warning.
 */

/** The consent-derived candidate files, first-seen over the sorted ledger. */
function candidateFiles(ledger: ReadonlyArray<LessonApprovalRow>): ReadonlyArray<string> {
  const files: string[] = [];
  for (const row of ledger) {
    if (row.decision !== "approved") continue;
    for (const target of row.targets) {
      // The fixed-list guard: a ledger-supplied target off the known
      // instruction-file list is never turned into a path.
      if (!LESSONS_BLOCK_MANAGED_FILES.includes(target)) continue;
      if (!files.includes(target)) files.push(target);
    }
  }
  return files;
}

function gradeFile(
  vault: string,
  file: string,
  ledger: ReadonlyArray<LessonApprovalRow>,
  now: Date,
  configPath?: string,
): Grade | null {
  // Defense in depth beside candidateFiles: any caller handing this
  // grader a ledger-supplied string gets the same fixed-list guard
  // before the join below.
  if (!LESSONS_BLOCK_MANAGED_FILES.includes(file)) return null;
  const covered = ledger.some((row) => row.decision === "approved" && row.targets.includes(file));
  if (!covered) return null;
  const path = join(vault, file);
  if (!existsSync(path)) {
    return { state: LESSONS_BLOCK_STATE.absent, staleIds: [], qualifiedIds: [], detail: null };
  }
  let extracted: string | null;
  try {
    extracted = readRulesBlock(path, RULES_BLOCK_ID.lessons);
  } catch (err) {
    if (err instanceof RulesBlockError) {
      return {
        state: LESSONS_BLOCK_STATE.drifted,
        staleIds: [],
        qualifiedIds: [],
        detail: err.message,
      };
    }
    throw err;
  }
  if (extracted === null) {
    return { state: LESSONS_BLOCK_STATE.absent, staleIds: [], qualifiedIds: [], detail: null };
  }
  // The plan resolves against the config the CALLER selected - the
  // doctor run's `configPath` - not against whatever file discovery
  // would find: two configs with different `lessons.promotion.scopes`
  // qualify different lessons, and grading the block against the wrong
  // list reported drifted or stale for a block the selected config
  // renders current. No path given, the planner keeps its own default.
  const plan: LessonsBlockPlan = planLessonsBlock(vault, file, {
    now,
    ...(configPath !== undefined ? { configPath } : {}),
  });
  const staleIds = lessonIdsInBlockBody(extracted).filter((id) => plan.staleIds.includes(id));
  if (staleIds.length > 0) {
    return {
      state: LESSONS_BLOCK_STATE.staleLessons,
      staleIds,
      qualifiedIds: plan.qualifiedIds,
      detail: null,
    };
  }
  if (!sameBody(extracted, plan.body)) {
    return {
      state: LESSONS_BLOCK_STATE.drifted,
      staleIds: [],
      qualifiedIds: plan.qualifiedIds,
      detail: null,
    };
  }
  return {
    state: LESSONS_BLOCK_STATE.current,
    staleIds: [],
    qualifiedIds: plan.qualifiedIds,
    detail: null,
  };
}

/**
 * The per-file readiness rows for the managed lessons blocks: one row
 * per file an approved decision names, in the fixed file order. A
 * damaged ledger answers with no rows - the check is the surface that
 * names the damage.
 */
export function lessonsBlockStates(
  vault: string,
  opts: { readonly now?: Date; readonly configPath?: string } = {},
): ReadonlyArray<LessonsBlockStateRow> {
  let ledger: ReadonlyArray<LessonApprovalRow>;
  try {
    ledger = readLessonApprovals(vault);
  } catch {
    return [];
  }
  const now = opts.now ?? new Date();
  const rows: LessonsBlockStateRow[] = [];
  // The candidate universe is CONSENT-DERIVED: the files the approved
  // decisions name, first-seen over the pref-id-sorted ledger, so the row
  // order is deterministic without importing the write-back contract's
  // audited list - doctor.ts already sits inside that module's import
  // cycle (write-binding -> attributes -> diagnostics -> doctor), and a
  // static import from this check would close a loop the import-cycle
  // census forbids. A rules file carrying a lessons pair with NO
  // recorded decision is not managed state and stays out of scope here;
  // the writer's own consent records are the source of truth.
  const candidates: string[] = [];
  for (const row of ledger) {
    if (row.decision !== "approved") continue;
    for (const target of row.targets) {
      if (!candidates.includes(target)) candidates.push(target);
    }
  }
  for (const file of candidates) {
    try {
      const grade = gradeFile(vault, file, ledger, now, opts.configPath);
      if (grade !== null) {
        rows.push({
          file,
          state: grade.state,
          staleIds: grade.staleIds,
          qualifiedIds: grade.qualifiedIds,
        });
      }
    } catch {
      // A per-file surprise stays out of the readiness rows; the check
      // below is the surface that names it as a warning.
    }
  }
  return rows;
}

export const lessonsBlockCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    let ledger: ReadonlyArray<LessonApprovalRow>;
    try {
      ledger = readLessonApprovals(ctx.vault);
    } catch (err) {
      out.issues.push({
        severity: "warning",
        code: LESSONS_LEDGER_UNREADABLE_CODE,
        // Where the ledger lives: the vault, or the device-local state once switched.
        path: lessonsApprovalsPath(ctx.vault),
        message:
          `the lessons approvals ledger ${LESSONS_APPROVALS_FILE} could not be read: ` +
          `${(err as Error).message} - no lesson can be approved, denied or refreshed while the ` +
          "ledger is unreadable; move the file aside or delete it to start clean, which lifts " +
          "every approval (the fail-closed direction)",
      });
      return;
    }
    for (const file of candidateFiles(ledger)) {
      let grade: Grade | null;
      try {
        grade = gradeFile(ctx.vault, file, ledger, ctx.now, ctx.configPath);
      } catch (err) {
        out.issues.push({
          severity: "warning",
          code: LESSONS_BLOCK_DRIFTED_CODE,
          path: file,
          message: `the managed lessons block of ${file} could not be graded: ${(err as Error).message}`,
        });
        continue;
      }
      if (grade === null || grade.state === LESSONS_BLOCK_STATE.current) continue;
      if (grade.state === LESSONS_BLOCK_STATE.absent) {
        const qualified =
          grade.qualifiedIds.length > 0 ? ` (qualified now: ${grade.qualifiedIds.join(", ")})` : "";
        out.issues.push({
          severity: "warning",
          code: LESSONS_BLOCK_ABSENT_CODE,
          path: file,
          message:
            `${file} is named by an approved lesson but carries no managed lessons block` +
            `${qualified} - creation is approve's write: ` +
            `o2b brain lessons approve <pref-id> --apply --yes --target ${file}`,
        });
        continue;
      }
      if (grade.state === LESSONS_BLOCK_STATE.staleLessons) {
        out.issues.push({
          severity: "warning",
          code: LESSONS_BLOCK_STALE_LESSONS_CODE,
          path: file,
          message:
            `the lessons block of ${file} still carries stale lesson(s) ${grade.staleIds.join(", ")} ` +
            " - the approved text moved, so a refresh drops them until the operator approves " +
            `again: ${LESSONS_REFRESH_COMMAND}`,
        });
        continue;
      }
      out.issues.push({
        severity: "warning",
        code: LESSONS_BLOCK_DRIFTED_CODE,
        path: file,
        message:
          `the lessons block of ${file} diverges from what a refresh would render` +
          (grade.detail !== null ? ` (${grade.detail})` : "") +
          (grade.qualifiedIds.length > 0
            ? `; qualified now: ${grade.qualifiedIds.join(", ")}`
            : "") +
          `: ${LESSONS_REFRESH_COMMAND}` +
          " (pass --force if the block was hand-edited)",
      });
    }
  },
};

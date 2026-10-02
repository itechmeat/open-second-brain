/**
 * The doctor's uncertainty stream, as a stream rather than as an array
 * every check appends to.
 *
 * Several checks walk overlapping trees, so one unreadable directory is
 * observed by four of them - the symlink walk, the removed-tool scan,
 * the basename sweep and the frontmatter probe all descend through
 * `Brain/`. Appended raw, that is four entries carrying the same code
 * and the same path, differing only in the clause each sweep writes
 * about what it could therefore not claim. On a vault synced with
 * preserved ownership - a shape this project designs for - the operator
 * reads four identical lines per affected subtree, and the same array
 * reaches the MCP payload with nothing bounding it.
 *
 * Two rules, both applied here rather than at any call site:
 *
 *   - ONE entry per (code, path). The pair identifies the observation;
 *     the clauses are four readings of it, and they are MERGED onto the
 *     one entry. Keeping only one of them - the first, or the longest -
 *     would drop the questions the other sweeps left unanswered, which
 *     is the entire content of an uncertainty finding.
 *   - A CAP per code, following the removed-tool scan's convention. Per
 *     code rather than over the whole stream, so a tree the walk cannot
 *     enter cannot crowd out the lineage, marker and lock findings -
 *     the ones an operator cannot rediscover by looking at the
 *     filesystem.
 */

import type { DoctorUncertainEntry } from "./report.ts";

/**
 * Hard cap per code, matching `REMOVED_TOOL_MAX_WARNINGS`: past fifty
 * instances of one condition the operator is reading the same sentence,
 * and the remaining budget is better spent on the other conditions.
 */
export const UNCERTAIN_MAX_PER_CODE = 50;

/**
 * Between the observation and what it cost, and between two such costs.
 * A semicolon rather than a full stop because every clause is about the
 * same failure, and the operator reads them as one `[UNSURE]` line.
 */
export const CLAUSE_SEP = "; ";

/**
 * Record one uncertainty about (code, path), and return the message the
 * stream now holds for it.
 *
 * `clause` is what the reporting sweep can no longer claim. Omitted -
 * the probes that forward a notice whose detail is already complete -
 * the entry stands on its own detail. A clause the entry already
 * carries is not repeated: two sweeps can share one consequence.
 */
export function pushUncertain(
  uncertain: DoctorUncertainEntry[],
  entry: DoctorUncertainEntry,
  clause?: string,
): string {
  const at = uncertain.findIndex((e) => e.code === entry.code && e.path === entry.path);
  if (at < 0) {
    const message = clause === undefined ? entry.message : `${entry.message}${CLAUSE_SEP}${clause}`;
    if (countFor(uncertain, entry.code) >= UNCERTAIN_MAX_PER_CODE) return message;
    uncertain.push({ ...entry, message });
    return message;
  }
  const held = uncertain[at]!;
  if (clause === undefined || held.message.includes(clause)) return held.message;
  const message = `${held.message}${CLAUSE_SEP}${clause}`;
  uncertain[at] = { ...held, message };
  return message;
}

/** Whether one entry may enter a stream at all. */
export type UncertainAdmission = (entry: DoctorUncertainEntry) => boolean;

/**
 * An uncertainty stream that admits only the entries `admit` passes.
 *
 * The per-code cap is counted over what the stream holds, so an entry
 * the reader may not see has to be turned away at the door: dropped only
 * after the cap was spent, fifty withheld entries would crowd out the
 * readable ones, and the number left would say how many were withheld.
 * Every sink - {@link pushUncertain} and a check's own `push` - reaches
 * the stream through `push`, so the one override covers them all.
 */
class AdmittingUncertainStream extends Array<DoctorUncertainEntry> {
  /** Derived arrays (`map`, `filter`) are plain ones, with no admission of their own. */
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  readonly #admit: UncertainAdmission;

  constructor(admit: UncertainAdmission) {
    super();
    this.#admit = admit;
  }

  override push(...entries: DoctorUncertainEntry[]): number {
    return super.push(...entries.filter(this.#admit));
  }
}

/**
 * A fresh stream: a plain array when nothing is withheld, so an
 * unfiltered pass is unchanged, otherwise one that admits only what
 * `admit` passes.
 */
export function uncertainStream(admit?: UncertainAdmission): DoctorUncertainEntry[] {
  return admit === undefined ? [] : new AdmittingUncertainStream(admit);
}

function countFor(uncertain: ReadonlyArray<DoctorUncertainEntry>, code: string): number {
  let n = 0;
  for (const entry of uncertain) if (entry.code === code) n += 1;
  return n;
}

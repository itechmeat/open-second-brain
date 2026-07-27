/**
 * The shape every doctor check shares.
 *
 * The checks have nothing to do with one another - a malformed
 * timestamp and an escaping symlink are unrelated conditions - so what
 * holds the pass together is this contract rather than any shared logic:
 * each check reads the one context the pass built and writes findings
 * into the two streams the report is partitioned from. A new check joins
 * the pass by being added to the registry array in `doctor.ts`.
 */

import type { BrainConfig, DoctorIssue } from "../types.ts";
import type { LogRecord, PreferenceRecord } from "./records.ts";
import type { DoctorUncertainEntry } from "./report.ts";

/**
 * Everything the checks read, resolved once per pass.
 *
 * The two record snapshots and the basename universe are built up-front
 * rather than per check: several checks walk the same directories, and
 * re-parsing them once per lint is what this context exists to prevent.
 */
export interface DoctorCheckContext {
  readonly vault: string;
  /** Wall clock for the age-based lints, so tests can pin it. */
  readonly now: Date;
  /** Resolved `_brain.yaml`, or absent when it could not be loaded. */
  readonly config: BrainConfig | undefined;
  /** Search-index path for index-backed checks; absent skips them. */
  readonly dbPath: string | undefined;
  /** Every valid wikilink target inside `Brain/`, keyed by basename. */
  readonly knownBasenames: ReadonlySet<string>;
  /**
   * Frontmatter ids to the files that declare them. The record checks
   * fill it as they walk and the duplicate-id check reads it once they
   * are done, which is why it is the one mutable member here - the
   * ordering that makes it work is the registry's ordering.
   */
  readonly idIndex: Map<string, string[]>;
  readonly preferences: ReadonlyArray<PreferenceRecord>;
  readonly logs: ReadonlyArray<LogRecord>;
}

/**
 * The two streams a check writes into. `issues` is partitioned by
 * severity into the report's warnings and errors; `uncertain` carries
 * sub-operations the doctor attempted but cannot claim it verified.
 */
export interface DoctorFindings {
  readonly issues: DoctorIssue[];
  readonly uncertain: DoctorUncertainEntry[];
}

export interface DoctorCheck {
  /**
   * True when a throw from `run` is swallowed by the pass, so one
   * broken scan cannot mask the findings of every check after it.
   *
   * False for the checks over the store's structural core - the config,
   * the record frontmatter, the id index, the logs, the backlinks. A
   * failure there does not leave the report incomplete, it leaves it
   * wrong, so the throw propagates out of `runDoctor` instead.
   */
  readonly failSoft: boolean;
  run(ctx: DoctorCheckContext, out: DoctorFindings): void;
}

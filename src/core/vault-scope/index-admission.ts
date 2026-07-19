/**
 * Index-admission predicate (seam 2, t_b0c9d0a3).
 *
 * The single decision point for what enters the search index, consulted at
 * the walker/indexer touch point. It DEFAULTS TO ADMIT: only artifacts the
 * lane explicitly owns are excluded, so no existing non-lane content ever
 * leaves the index (regression-tested).
 *
 * Owned by the exact-state lane (t_b0c9d0a3): the overwrite-only lane at
 * `Brain/state/` is operational state read directly, never surfaced through
 * FTS/vector/graph recall, so it must not be indexed. Consulted by
 * scope-aware indexing (t_37c05a34) for its own admission concerns.
 *
 * `relPath` must be a vault-relative POSIX path (the form the walker already
 * canonicalises). The predicate is pure and does no I/O.
 */

import { BRAIN_STATE_REL } from "../brain/paths.ts";

export interface AdmissionVerdict {
  /** True when the path may enter the search index. */
  readonly admit: boolean;
  /** Machine-readable exclusion reason, present only when `admit` is false. */
  readonly reason?: string;
}

const ADMIT: AdmissionVerdict = Object.freeze({ admit: true });

/**
 * Is `relPath` inside the given lane root, treating the root as a path
 * boundary? `Brain/state` and `Brain/state/x.md` are inside; `Brain/stateful`
 * and `Brain/state-notes.md` are NOT (they merely share a name prefix).
 */
function isUnder(relPath: string, root: string): boolean {
  return relPath === root || relPath.startsWith(`${root}/`);
}

/** Decide whether a vault-relative POSIX path may be admitted to the index. */
export function admitToIndex(relPath: string): AdmissionVerdict {
  if (isUnder(relPath, BRAIN_STATE_REL)) {
    return Object.freeze({ admit: false, reason: "exact-state-lane" });
  }
  return ADMIT;
}

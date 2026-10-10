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

import { BRAIN_PENDING_REL, BRAIN_PAYLOADS_REL, BRAIN_STATE_REL } from "../brain/paths.ts";
import { pathCovers } from "./defaults.ts";

export interface AdmissionVerdict {
  /** True when the path may enter the search index. */
  readonly admit: boolean;
  /** Machine-readable exclusion reason, present only when `admit` is false. */
  readonly reason?: string;
}

const ADMIT: AdmissionVerdict = Object.freeze({ admit: true });

/**
 * Decide whether a vault-relative POSIX path may be admitted to the index.
 *
 * Lane membership is the shared {@link pathCovers} question, treating the
 * lane root as a path boundary: `Brain/state` and `Brain/state/x.md` are
 * inside; `Brain/stateful` and `Brain/state-notes.md` are NOT (they merely
 * share a name prefix). `BRAIN_STATE_REL` is built with `posix.join`, so it
 * already satisfies the canonical-prefix precondition.
 */
export function admitToIndex(relPath: string): AdmissionVerdict {
  if (pathCovers(BRAIN_STATE_REL, relPath)) {
    return Object.freeze({ admit: false, reason: "exact-state-lane" });
  }
  // The payload registry's store holds the raw blobs session import
  // externalized precisely so recall would see a placeholder instead;
  // indexing the store would put the blobs straight back. Its files are
  // `.txt` today, which the `.md` walkers skip anyway - this makes the
  // exclusion a stated rule rather than an accident of the extension.
  if (pathCovers(BRAIN_PAYLOADS_REL, relPath)) {
    return Object.freeze({ admit: false, reason: "payload-store" });
  }
  // The write-approval review lane: a document staged into `Brain/pending/`
  // is exactly the content no operator has admitted yet, so recall must not
  // surface it (write-side trust, Task 5). Before this exclusion a staged
  // signal or note rode the index straight back into `brain_search` and
  // recall-inject, which silently undid the gate - staging is a change of
  // directory, and this is the directory the change has to close. The
  // boundary is the shared `pathCovers` question: `Brain/pending` and
  // `Brain/pending/x.md` are inside, `Brain/pendingfoo/x.md` merely shares
  // the name prefix and stays ordinary indexed content.
  if (pathCovers(BRAIN_PENDING_REL, relPath)) {
    return Object.freeze({ admit: false, reason: "review-pending" });
  }
  return ADMIT;
}

/**
 * The authority order of the kept standing and the two refusals of a lane
 * write (change `tool-lane-write-keeps-standing`), apart from the rule in
 * `lane-standing.ts` that reads the store with them.
 *
 * A leaf: it imports nothing of the lane page store (`lane-pages.ts`,
 * `lane-entry-store.ts`, `lane-dual-moves.ts`, `lane-reach-guard.ts`,
 * `lane-standing.ts`), so the record builders below `lane-standing.ts`
 * take the authority comparison from here without closing an import
 * cycle through the read-back, which reads the fold and the reach guard.
 * `lane-standing.ts` re-exports everything here.
 */

import { AUTHORITIES, type Authority } from "./constants.ts";

/**
 * The stronger of two authorities: the one with the lower index in
 * `AUTHORITIES` (`human` before `agent` before `model`). An absent one
 * gives way to the other.
 */
export function strongerAuthority(a: Authority, b?: Authority | null): Authority;
export function strongerAuthority(a?: Authority | null, b?: Authority | null): Authority | null;
export function strongerAuthority(a?: Authority | null, b?: Authority | null): Authority | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return AUTHORITIES.indexOf(b) < AUTHORITIES.indexOf(a) ? b : a;
}

/** Why a write computed from a base was refused. */
export type LaneEntryChangedReason = "changed" | "removed" | "incomplete";

/**
 * A read-modify-write of a lane entry refused before anything was written:
 * the store no longer holds the version the writer read (`changed`), a
 * removal holds it now (`removed`), or it could not be read whole, at the
 * read or since (`incomplete`). `path` is the entry's path below `Brain/`.
 */
export class LaneEntryChangedError extends Error {
  readonly path: string;
  readonly reason: LaneEntryChangedReason;

  constructor(path: string, reason: LaneEntryChangedReason) {
    super(
      reason === "changed"
        ? `${path} changed since it was read; nothing was written; read it again`
        : reason === "removed"
          ? `${path} was removed since it was read; nothing was written; read it again`
          : "the lane store could not be read in full; nothing was written; " +
            "run `o2b brain doctor` to see what it is missing, then run this again",
    );
    this.name = "LaneEntryChangedError";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * A lane write the store did not apply: the entry at `path` (below
 * `Brain/`) is held by another record, a version or a removal (`removed`),
 * written at authority `heldBy`.
 */
export class LaneWriteNotAppliedError extends Error {
  readonly path: string;
  readonly heldBy: Authority | null;
  readonly removed: boolean;

  constructor(path: string, heldBy: Authority | null, removed: boolean) {
    super(
      heldBy === null
        ? `${path} was not changed: the store holds no record of it`
        : `${path} was not changed: the store keeps ${removed ? "a removal" : "a version"} ` +
            `written at authority ${heldBy}`,
    );
    this.name = "LaneWriteNotAppliedError";
    this.path = path;
    this.heldBy = heldBy;
    this.removed = removed;
  }
}

/**
 * A lane write whose record was appended and whose read-back could not be
 * made: the fold read back failed or may miss a record, or it holds no
 * record of the key at all. The write was made; whether it holds is not
 * known, so the caller reads the entry before it repeats the call.
 */
export class LaneWriteUnverifiedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `${path} was written and could not be verified: read the entry before repeating the call`,
    );
    this.name = "LaneWriteUnverifiedError";
    this.path = path;
  }
}

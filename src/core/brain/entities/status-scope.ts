/**
 * The one place that decides which entity statuses a read may see.
 *
 * Before this module the `active` filter was re-implemented at every caller
 * and eight callers applied none at all, so adding a third status value would
 * have read as "not archived, therefore visible" at almost every read path in
 * the tree - a quarantine nothing filters on, which is a no-op wearing a
 * feature's name. The filter is one predicate now, and
 * `tests/core/brain/entities/entity-read-census.test.ts` fails the build when
 * a new entity read path bypasses it.
 *
 * Two scopes, because read paths ask two different questions:
 *
 *   - `canonical` - may this record HOLD the identity a lookup resolves to?
 *     Only `active` does. An archived name is retired; a quarantined name was
 *     never vouched for. This is the scope the identity index and every
 *     name/alias resolution use.
 *   - `readable` - may a surface show this record, or reason over it at all?
 *     `active` and `archived` may; `quarantine` may not. This is the scope an
 *     unfiltered listing, a guard, or an anchoring pass uses.
 *
 * `quarantine` is admitted by NEITHER. That is the entire content of the
 * value: a record that entered under untrusted provenance stays out of every
 * ordinary read until an operator releases it (`entity archive --restore`).
 * Reaching it at all takes an explicit status ask.
 *
 * Structural only. The decision reads a controlled-vocabulary token and never
 * note prose, so there is no natural-language word list here or downstream.
 */

import { BRAIN_ENTITY_STATUS, type BrainEntityStatus } from "./types.ts";

/** The question a read path is asking. See the module docblock. */
export const ENTITY_STATUS_SCOPE = {
  canonical: "canonical",
  readable: "readable",
} as const;

export type EntityStatusScope = (typeof ENTITY_STATUS_SCOPE)[keyof typeof ENTITY_STATUS_SCOPE];

/**
 * Which scopes admit each status. Keyed by {@link BrainEntityStatus}, so a
 * new member of the vocabulary cannot be added in `types.ts` without failing
 * the type check here until someone decides what may see it - the decision is
 * never made by omission.
 */
const SCOPES_ADMITTING: Readonly<Record<BrainEntityStatus, ReadonlyArray<EntityStatusScope>>> =
  Object.freeze({
    [BRAIN_ENTITY_STATUS.active]: Object.freeze([
      ENTITY_STATUS_SCOPE.canonical,
      ENTITY_STATUS_SCOPE.readable,
    ]),
    [BRAIN_ENTITY_STATUS.archived]: Object.freeze([ENTITY_STATUS_SCOPE.readable]),
    [BRAIN_ENTITY_STATUS.quarantine]: Object.freeze([]),
  });

/**
 * Lookup keyed by the raw string. The entity-shaped slices the guards
 * consume (`atomic-facts`, `truth/contamination`, `truth/merge-guard`) carry
 * `status: string` rather than the narrowed type, so the predicate has to
 * answer for a value that never parsed - and a `Map` answers it without an
 * `as` cast that would let an unparsed value pretend to be vocabulary.
 */
const SCOPES_BY_STATUS: ReadonlyMap<string, ReadonlyArray<EntityStatusScope>> = new Map(
  Object.entries(SCOPES_ADMITTING),
);

/**
 * May a read at `scope` see a record carrying `status`?
 *
 * A status outside the vocabulary is admitted by no scope. That is the only
 * answer that cannot leak an unrecognised record into a surface, and it is
 * different from "the record is absent": the record exists, the caller was
 * simply not entitled to it at this scope.
 */
export function entityStatusInScope(status: string, scope: EntityStatusScope): boolean {
  return SCOPES_BY_STATUS.get(status)?.includes(scope) ?? false;
}

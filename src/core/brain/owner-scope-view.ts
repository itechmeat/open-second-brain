/**
 * What one caller may see, asked once per response
 * (a-label-is-not-a-boundary, U3).
 *
 * `isOwnerVisible` (`src/core/graph/agent-scope.ts`) is the vault's only
 * ownership rule and `isPathOwnerVisible`
 * (`src/core/search/result-filters.ts`) is the only place that rule meets
 * the filesystem. Neither is a second registry and nothing here becomes
 * one: this module is the ADAPTER the report-shaped surfaces needed, and
 * it exists because those surfaces hold an artifact id or a
 * vault-relative path rather than a ranked search result.
 *
 * The defect it closes is enumerated in
 * `docs/brainstorm/a-label-is-not-a-boundary/recon/owner-scope-isolation.md`
 * section C6: fourteen tools classified as metadata returned another
 * owner's artifact ids, paths, titles and body prose under
 * `integrity.owner_scope_delivery: fail`, because each one aggregated its
 * rows itself and none of them asked the rule.
 *
 * ## Two conventions this module inherits rather than invents
 *
 * FAIL CLOSED. A page whose file cannot be read has an unknowable owner
 * and is hidden, exactly as `isPathOwnerVisible` decides it — an
 * ownership claim that cannot be read is not an absence of one.
 *
 * IDENTICAL TO ABSENT. A withheld row is dropped, and nothing counts it.
 * `preferences-collect.ts` states the reason: under `fail` a count would
 * tell one agent that another agent's private memories exist, which is
 * the existence leak the search side already avoids. So no surface using
 * this view reports how many rows it withheld, and a caller cannot tell a
 * filtered report from a report over a vault that never held the rows.
 *
 * ## Cost when nobody opted in
 *
 * `scope === null` — the only state a vault with the gate off can reach —
 * short-circuits every predicate to `true` before any file is touched.
 * A vault that never enabled owner-scope delivery pays one comparison per
 * call and reads nothing.
 *
 * ## `warn` is INERT on every surface that uses this view
 *
 * Said plainly because the write side says the opposite about itself and
 * the two were being read as one promise. `resolveOwnerScopeDelivery`
 * returns `enforcedScope: null` under `warn`, so
 * {@link gatedOwnerScopeView} hands back the no-op view and nothing is
 * withheld — and the IDENTICAL TO ABSENT convention above forbids
 * reporting a withheld count, so nothing is reported either. Under
 * `warn` these surfaces are therefore byte-identical to `off`: they
 * neither withhold nor observe.
 *
 * Where `warn` IS observable is the WRITE side. `warn` stamps `owner:`
 * exactly as `fail` does (`preference.ts`), so an operator who sets it
 * can read the ownership that has accumulated straight off the
 * preference files and see the population `fail` would start
 * withholding, BEFORE turning `fail` on. That is the whole of what
 * `warn` does today. A per-response "this is what `fail` would have
 * withheld" field on these fifteen surfaces would be the other half, and
 * it is deliberately not claimed here until it exists.
 */

import { isPathOwnerVisible } from "../search/result-filters.ts";
import {
  UNFILTERED_ARTIFACT_REFS,
  artifactRefView,
  type ArtifactRef,
  type ArtifactRefView,
} from "./artifact-ref-view.ts";
import { resolveOwnerScopeDelivery } from "./preferences-collect.ts";

/**
 * A reference a report row carries. The reference grammar - paths, bare
 * ids, wikilink brackets - is shared with every other rule asked this
 * way; see {@link ArtifactRef}.
 */
export type OwnerScopeRef = ArtifactRef;

/** The ownership decision, bound to one vault and one scope. */
export interface OwnerScopeView extends ArtifactRefView {
  /** The enforced scope, or `null` when no ownership filtering applies. */
  readonly scope: string | null;
}

/**
 * Bind the ownership rule to one vault and one scope.
 *
 * `scope === null` returns the shared no-op view, so a caller that
 * threads this through unconditionally costs nothing on a vault that
 * never opted in.
 */
export function ownerScopeView(vault: string, scope: string | null): OwnerScopeView {
  if (scope === null) return Object.freeze({ scope: null, ...UNFILTERED_ARTIFACT_REFS });
  return Object.freeze({
    scope,
    ...artifactRefView(vault, (rel, cache) => isPathOwnerVisible(vault, rel, scope, cache)),
  });
}

/**
 * The view a surface that takes no `agent_scope` argument must use.
 *
 * These surfaces cannot be told which owner is asking, so the scope is
 * the server-resolved identity and it applies only under
 * `integrity.owner_scope_delivery: fail` — the same gate, read through
 * the same resolver, as every preference-delivery surface. Under `off`
 * and `warn` `enforcedScope` is `null` and the view hides nothing, which
 * is what keeps a vault that never opted in byte-identical.
 */
export function gatedOwnerScopeView(vault: string, agentName: string | undefined): OwnerScopeView {
  return ownerScopeView(vault, resolveOwnerScopeDelivery(vault, agentName).enforcedScope);
}

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
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

import { isPathOwnerVisible, type FrontmatterCache } from "../search/result-filters.ts";
import { brainDirs } from "./paths.ts";
import { resolveOwnerScopeDelivery } from "./preferences-collect.ts";

/** The `.md` extension every Brain artifact id resolves through. */
const MARKDOWN_EXT = ".md";

/**
 * A reference a report row carries: either a vault-relative path
 * (`Brain/preferences/pref-x.md`, `notes/y.md`) or a bare Brain artifact
 * id (`pref-x`, `ret-y`, `sig-2026-05-01-z`).
 *
 * `null` / `undefined` / empty are accepted and read as "this row names
 * nothing here", which is visible: a row with no subject cannot disclose
 * one.
 */
export type OwnerScopeRef = string | null | undefined;

/** The visibility decision, bound to one vault and one scope. */
export interface OwnerScopeView {
  /** The enforced scope, or `null` when no ownership filtering applies. */
  readonly scope: string | null;
  /** May the caller see the artifact or page this reference names? */
  readonly visible: (ref: OwnerScopeRef) => boolean;
  /**
   * May the caller see a row that names ALL of these? One hidden
   * reference hides the row: a row survives only when every artifact it
   * would disclose is one the caller may already see.
   */
  readonly row: (...refs: ReadonlyArray<OwnerScopeRef>) => boolean;
  /** Drop the rows whose references are not all visible. */
  readonly keep: <T>(
    rows: ReadonlyArray<T>,
    refsOf: (row: T) => ReadonlyArray<OwnerScopeRef>,
  ) => ReadonlyArray<T>;
}

/** A view that hides nothing, allocated once. */
const UNFILTERED: OwnerScopeView = Object.freeze({
  scope: null,
  visible: () => true,
  row: () => true,
  keep: <T>(rows: ReadonlyArray<T>) => rows,
});

/**
 * Resolve a bare Brain artifact id to its vault-relative path, or `null`
 * when no artifact of that id is on disk.
 *
 * The four directories are the ones that hold owner-taggable artifacts:
 * `preferences` and `retired` carry `owner:` through the preference
 * writer, and `inbox` / `processed` carry whatever an operator wrote into
 * a signal's frontmatter. `log` is deliberately absent — a log shard is
 * named by date, is shared by construction, and has no owner to read.
 */
function artifactPath(vault: string, id: string): string | null {
  const dirs = brainDirs(vault);
  for (const dir of [dirs.preferences, dirs.retired, dirs.inbox, dirs.processed]) {
    const abs = join(dir, `${id}${MARKDOWN_EXT}`);
    if (existsSync(abs)) return abs.slice(vault.length + 1);
  }
  return null;
}

/**
 * Bind the ownership rule to one vault and one scope.
 *
 * `scope === null` returns the shared no-op view, so a caller that
 * threads this through unconditionally costs nothing on a vault that
 * never opted in.
 */
export function ownerScopeView(vault: string, scope: string | null): OwnerScopeView {
  if (scope === null) return UNFILTERED;
  // One frontmatter read per (vault, path) for the whole response, the
  // same sharing `search()` gives its filter stages.
  const cache: FrontmatterCache = new Map();
  const visible = (ref: OwnerScopeRef): boolean => {
    if (ref === null || ref === undefined || ref.length === 0) return true;
    // A reference that names a path is resolved as one; anything else is
    // a Brain artifact id, and an id with no artifact on disk names
    // nothing that could be owned.
    const rel = ref.endsWith(MARKDOWN_EXT) ? ref : artifactPath(vault, ref);
    if (rel === null) return true;
    return isPathOwnerVisible(vault, rel, scope, cache);
  };
  const row = (...refs: ReadonlyArray<OwnerScopeRef>): boolean => refs.every(visible);
  return Object.freeze({
    scope,
    visible,
    row,
    keep: <T>(rows: ReadonlyArray<T>, refsOf: (r: T) => ReadonlyArray<OwnerScopeRef>) =>
      rows.filter((r) => refsOf(r).every(visible)),
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

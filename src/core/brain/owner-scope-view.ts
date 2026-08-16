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

import { join } from "node:path";
import { existsSync } from "node:fs";

import { isPathOwnerVisible, type FrontmatterCache } from "../search/result-filters.ts";
import { BRAIN_SOURCES_REL, brainDirs } from "./paths.ts";
import { resolveOwnerScopeDelivery } from "./preferences-collect.ts";
import { ANCHORED_WIKILINK_RE } from "./wikilink.ts";

/** The `.md` extension every Brain artifact id resolves through. */
const MARKDOWN_EXT = ".md";

/**
 * A reference a report row carries: either a vault-relative path
 * (`Brain/preferences/pref-x.md`, `notes/y.md`) or a bare Brain artifact
 * id (`pref-x`, `ret-y`, `sig-2026-05-01-z`), optionally spelled as a
 * wikilink (`[[pref-x]]`, `[[notes/y.md]]`).
 *
 * `null` / `undefined` / empty are accepted and read as "this row names
 * nothing here", which is visible: a row with no subject cannot disclose
 * one.
 */
export type OwnerScopeRef = string | null | undefined;

/**
 * Strip the wikilink brackets a report row may have kept around its
 * reference, leaving the target verbatim.
 *
 * The brackets are SYNTAX, not part of the reference: a retirement's
 * `retired_by`, a dream transition's `link` and an evidence row's
 * `artifact` all carry `[[…]]` straight out of frontmatter or a log
 * body, and `[[Brain/preferences/pref-x.md]]` names exactly the page
 * `Brain/preferences/pref-x.md`. Before this, such a reference matched
 * neither branch below and the row failed OPEN.
 *
 * Deliberately NOT {@link parseWikilinkRich}: that normaliser collapses
 * folder segments and drops `.md`, which turns a path-shaped link into a
 * bare basename that resolves to no artifact - the same fail-open by a
 * longer route. Only the brackets come off; the anchor / alias
 * decoration inside them is handled by the id-resolution step, which
 * simply finds no file and treats the row as naming nothing.
 */
function unbracket(ref: string): string {
  const match = ANCHORED_WIKILINK_RE.exec(ref.trim());
  return match === null ? ref : match[1]!.trim();
}

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
 * ## Why the directory list is the whole boundary
 *
 * `visible()` reads an id that resolves to no file as "this row names
 * nothing that could be owned" and lets the row through. That reading is
 * true only for ids this function would have FOUND had the artifact
 * existed - so every directory omitted here is a directory whose pages
 * are silently unownable, and the module's fail-closed promise turns
 * into a fail-open one for exactly those pages. The list is therefore
 * every `Brain/` directory holding id-addressable Markdown:
 *
 *   - `preferences` / `retired` carry `owner:` through the preference
 *     writer;
 *   - `inbox` / `processed` / `pending` carry whatever an operator or an
 *     importer wrote into a signal's frontmatter;
 *   - `sources` (`src-<slug>.md`) and `entities` are owner-taggable the
 *     same way, and `brain_search_by_source` already filters the first
 *     of them by owner on the search side - so an id-shaped reference to
 *     one reaching THIS view and passing was the two halves disagreeing.
 *
 * `log` is deliberately absent - a log shard is named by date, is shared
 * by construction, and has no owner to read. `bases` holds `.base` view
 * definitions rather than Markdown pages, and `snapshots` holds dated
 * copies addressed by path rather than by id.
 */
function artifactPath(vault: string, id: string): string | null {
  const dirs = brainDirs(vault);
  for (const dir of [
    dirs.preferences,
    dirs.retired,
    dirs.inbox,
    dirs.processed,
    dirs.pending,
    join(vault, BRAIN_SOURCES_REL),
    dirs.entities,
  ]) {
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
    // nothing that could be owned - see {@link artifactPath} for why
    // that reading is only true while its directory list is complete.
    const bare = unbracket(ref);
    if (bare.length === 0) return true;
    const rel = bare.endsWith(MARKDOWN_EXT) ? bare : artifactPath(vault, bare);
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

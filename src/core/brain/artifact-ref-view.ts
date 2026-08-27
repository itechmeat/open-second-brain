/**
 * What one caller may see, over the REFERENCES a report row carries
 * rather than over a ranked search result.
 *
 * Extracted from `./owner-scope-view.ts` when a second rule - the
 * transport-reach visibility boundary - needed the same adapter. The
 * ownership rule and the visibility rule are different questions with
 * different answers, but the plumbing between "a row names `[[pref-x]]`"
 * and "here is the vault-relative path of `pref-x`" is one piece of
 * machinery, and a second copy of it would be a second place for a
 * directory to go missing.
 *
 * Neither this module nor its bindings is a registry: each one delegates
 * the per-PATH decision to the single place that rule meets the
 * filesystem (`isPathOwnerVisible` / `isPathReadableAtReach`, both in
 * `src/core/search/result-filters.ts`), so a report-shaped surface and a
 * ranked one cannot drift on what "hidden" means - including the
 * unreadable-file verdict, which an empty frontmatter map cannot express.
 *
 * ## Two conventions every binding inherits
 *
 * FAIL CLOSED, in whichever direction its rule fails closed. A page whose
 * file cannot be read has an unknowable answer, and an unreadable claim
 * is not the absence of one.
 *
 * IDENTICAL TO ABSENT. A withheld row is dropped and nothing counts it: a
 * count would tell the caller that a row it may not see exists, which is
 * the existence leak the search side already avoids. So no surface using
 * one of these views reports how many rows it withheld.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

import type { FrontmatterCache } from "../search/result-filters.ts";
import { BRAIN_SOURCES_REL, brainDirs } from "./paths.ts";
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
export type ArtifactRef = string | null | undefined;

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
 * Deliberately NOT `parseWikilinkRich`: that normaliser collapses folder
 * segments and drops `.md`, which turns a path-shaped link into a bare
 * basename that resolves to no artifact - the same fail-open by a longer
 * route. Only the brackets come off; the anchor / alias decoration inside
 * them is handled by the id-resolution step, which simply finds no file
 * and treats the row as naming nothing.
 */
function unbracket(ref: string): string {
  const match = ANCHORED_WIKILINK_RE.exec(ref.trim());
  return match === null ? ref : match[1]!.trim();
}

/** One rule, bound to one vault, asked over references. */
export interface ArtifactRefView {
  /**
   * True when this view cannot hide anything, so a caller may skip the
   * work of asking it.
   *
   * It exists for the surfaces whose filtered form is not byte-identical
   * to their unfiltered one - a rendered log day is split on its event
   * headings and rejoined - and that must stay verbatim when no rule is
   * live. Read as "is there anything to ask", never as "is the caller
   * entitled": the decision is always {@link ArtifactRefView.visible}.
   */
  readonly filtersNothing: boolean;
  /** May the caller see the artifact or page this reference names? */
  readonly visible: (ref: ArtifactRef) => boolean;
  /**
   * May the caller see a row that names ALL of these? One hidden
   * reference hides the row: a row survives only when every artifact it
   * would disclose is one the caller may already see.
   */
  readonly row: (...refs: ReadonlyArray<ArtifactRef>) => boolean;
  /** Drop the rows whose references are not all visible. */
  readonly keep: <T>(
    rows: ReadonlyArray<T>,
    refsOf: (row: T) => ReadonlyArray<ArtifactRef>,
  ) => ReadonlyArray<T>;
}

/** A view that hides nothing, allocated once. */
export const UNFILTERED_ARTIFACT_REFS: ArtifactRefView = Object.freeze({
  filtersNothing: true,
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
 * nothing that could be hidden" and lets the row through. That reading is
 * true only for ids this function would have FOUND had the artifact
 * existed - so every directory omitted here is a directory whose pages
 * are silently unclassifiable, and every binding's fail-closed promise
 * turns into a fail-open one for exactly those pages. The list is
 * therefore every `Brain/` directory holding id-addressable Markdown:
 *
 *   - `preferences` / `retired` carry `owner:` through the preference
 *     writer, and carry `visibility:` wherever an operator wrote one;
 *   - `inbox` / `processed` / `pending` carry whatever an operator or an
 *     importer wrote into a signal's frontmatter;
 *   - `sources` (`src-<slug>.md`) and `entities` are taggable the same
 *     way, and `brain_search_by_source` already filters the first of them
 *     on the search side - so an id-shaped reference to one reaching a
 *     view here and passing was the two halves disagreeing.
 *
 * `log` is deliberately absent - a log shard is named by date, is shared
 * by construction, and carries no per-page claim to read. `bases` holds
 * `.base` view definitions rather than Markdown pages, and `snapshots`
 * holds dated copies addressed by path rather than by id.
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
 * Bind one per-path rule to one vault, as a reference-shaped view.
 *
 * `pathVisible` is handed the shared per-response frontmatter cache, the
 * same sharing `search()` gives its filter stages, so a response that
 * names the same artifact from several rows parses it once.
 */
export function artifactRefView(
  vault: string,
  pathVisible: (rel: string, cache: FrontmatterCache) => boolean,
): ArtifactRefView {
  const cache: FrontmatterCache = new Map();
  const visible = (ref: ArtifactRef): boolean => {
    if (ref === null || ref === undefined || ref.length === 0) return true;
    // A reference that names a path is resolved as one; anything else is
    // a Brain artifact id, and an id with no artifact on disk names
    // nothing that could be hidden - see {@link artifactPath} for why
    // that reading is only true while its directory list is complete.
    const bare = unbracket(ref);
    if (bare.length === 0) return true;
    const rel = bare.endsWith(MARKDOWN_EXT) ? bare : artifactPath(vault, bare);
    if (rel === null) return true;
    return pathVisible(rel, cache);
  };
  return Object.freeze({
    filtersNothing: false,
    visible,
    row: (...refs: ReadonlyArray<ArtifactRef>) => refs.every(visible),
    keep: <T>(rows: ReadonlyArray<T>, refsOf: (r: T) => ReadonlyArray<ArtifactRef>) =>
      rows.filter((r) => refsOf(r).every(visible)),
  });
}

/**
 * One view that keeps a reference only when every constituent does.
 *
 * The rules are ANDed rather than folded: they are independent questions
 * with independent answers, and which one dropped a row is not
 * observable, because none of them reports a count.
 */
export function everyArtifactRefView(...views: ReadonlyArray<ArtifactRefView>): ArtifactRefView {
  const live = views.filter((v) => !v.filtersNothing);
  if (live.length === 0) return UNFILTERED_ARTIFACT_REFS;
  const visible = (ref: ArtifactRef): boolean => live.every((v) => v.visible(ref));
  return Object.freeze({
    filtersNothing: false,
    visible,
    row: (...refs: ReadonlyArray<ArtifactRef>) => refs.every(visible),
    keep: <T>(rows: ReadonlyArray<T>, refsOf: (r: T) => ReadonlyArray<ArtifactRef>) =>
      rows.filter((r) => refsOf(r).every(visible)),
  });
}

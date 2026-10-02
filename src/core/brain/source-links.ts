/**
 * Shared readers for the sources a Brain page cites.
 *
 * One implementation for every consumer that has to answer "which sources
 * does this page rest on": the delete-by-source cleanup (`source-cleanup.ts`)
 * and the capture-scope hygiene detector. Two readers would drift - a page
 * the cleanup counts as derived from a source and the detector counts as
 * citing nothing is exactly the kind of disagreement neither could explain.
 *
 * Structural only: frontmatter list members and wikilink targets. No prose
 * is interpreted.
 */

import type { FrontmatterMap } from "../types.ts";

/** Heading of the canonical provenance section (`provenance.ts`). */
const SOURCES_HEADING_RE = /^##\s+Sources\s*$/;

/** Any Markdown ATX heading: the line that ends a section. */
const ANY_HEADING_RE = /^#{1,6}\s/;

/** Every `[[ … ]]` wikilink on a line, captured whole. */
const WIKILINK_RE = /\[\[[^\]]+\]\]/g;

/** Line separator for LF and CRLF bodies alike. */
const LINE_SPLIT_RE = /\r?\n/;

/** The string members of a frontmatter list field; anything else reads as empty. */
export function stringArrayField(meta: FrontmatterMap, key: string): ReadonlyArray<string> {
  const value = meta[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Strip a single enclosing `[[ … ]]` and any `|alias` / `#heading` tail. */
export function wikilinkTarget(raw: string): string {
  const m = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(raw.trim());
  return m ? m[1]!.trim() : raw.trim();
}

/**
 * The wikilink targets listed under the page's `## Sources` heading, in
 * order, read up to the next heading of any level. Targets go through
 * {@link wikilinkTarget}, the same rule the cleanup applies to a frontmatter
 * `source` link. A body without the section cites nothing here.
 */
export function sourcesSectionTargets(body: string): ReadonlyArray<string> {
  const targets: string[] = [];
  let inSection = false;
  for (const line of body.split(LINE_SPLIT_RE)) {
    if (SOURCES_HEADING_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (ANY_HEADING_RE.test(line)) break;
    for (const match of line.matchAll(WIKILINK_RE)) targets.push(wikilinkTarget(match[0]));
  }
  return targets;
}

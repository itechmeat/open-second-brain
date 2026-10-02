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

/**
 * Opening or closing CommonMark code fence: up to three spaces of indent,
 * three or more backticks or tildes. Same rule as the block resolver
 * (`distill/block-resolve.ts`), copied rather than imported so this reader
 * does not depend on the distill module.
 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** True when `line` closes a fence opened by `opener`: same character, at least as long, nothing after it. */
function closesFence(line: string, opener: string): boolean {
  const m = FENCE_RE.exec(line);
  return (
    m !== null &&
    m[1]![0] === opener[0] &&
    m[1]!.length >= opener.length &&
    m[2]!.trim().length === 0
  );
}

/**
 * Which lines sit inside a fenced code block, fence lines included. Only a
 * closed fence is a fence: an opener with no closing line before the end of
 * the body is plain text, as are the lines after it, so caller text that
 * opens a fence and never closes it cannot hide the structure that follows.
 * Two linear passes at most: the single pass that pairs fences, then the
 * unmarking of the one span that can be left open.
 */
function fencedLineMask(lines: ReadonlyArray<string>): boolean[] {
  const mask = Array.from({ length: lines.length }, () => false);
  let fence: string | null = null;
  let openedAt = 0;
  for (const [i, line] of lines.entries()) {
    if (fence !== null) {
      mask[i] = true;
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = FENCE_RE.exec(line);
    if (opened !== null) {
      fence = opened[1]!;
      openedAt = i;
      mask[i] = true;
    }
  }
  if (fence !== null) mask.fill(false, openedAt);
  return mask;
}

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
 * The wikilink targets listed under the page's LAST `## Sources` heading,
 * in order, read up to the next heading of any level. Targets go through
 * {@link wikilinkTarget}, the same rule the cleanup applies to a frontmatter
 * `source` link. A body without the section cites nothing here.
 *
 * Lines inside fenced code blocks are content, not structure: a heading or
 * link there neither opens, ends nor feeds the section. A fence that never
 * closes is not a fence (see {@link fencedLineMask}). The last section
 * wins because the writer renders the provenance section after everything
 * else on the page, so an earlier `## Sources` line (quoted or planted in
 * caller text) never stands in for it.
 */
export function sourcesSectionTargets(body: string): ReadonlyArray<string> {
  let targets: string[] = [];
  let inSection = false;
  const lines = body.split(LINE_SPLIT_RE);
  const fenced = fencedLineMask(lines);
  for (const [i, line] of lines.entries()) {
    if (fenced[i]) continue;
    if (SOURCES_HEADING_RE.test(line)) {
      inSection = true;
      targets = [];
      continue;
    }
    if (!inSection) continue;
    if (ANY_HEADING_RE.test(line)) {
      inSection = false;
      continue;
    }
    for (const match of line.matchAll(WIKILINK_RE)) targets.push(wikilinkTarget(match[0]));
  }
  return targets;
}

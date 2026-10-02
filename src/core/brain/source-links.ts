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
 * link there neither opens, ends nor feeds the section. The last section
 * wins because the writer renders the provenance section after everything
 * else on the page, so an earlier `## Sources` line (quoted or planted in
 * caller text) never stands in for it.
 */
export function sourcesSectionTargets(body: string): ReadonlyArray<string> {
  let targets: string[] = [];
  let inSection = false;
  let fence: string | null = null;
  for (const line of body.split(LINE_SPLIT_RE)) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = FENCE_RE.exec(line);
    if (opened !== null) {
      fence = opened[1]!;
      continue;
    }
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

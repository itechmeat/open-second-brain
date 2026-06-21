/**
 * Extract wikilinks, markdown links, and tags from a chunk of Markdown.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §5 (links
 * table). Returns the link rows that `store.replaceLinks` expects, but
 * leaves the source-chunk binding to the indexer (it knows which
 * chunk produced the content).
 *
 * Code fences and inline-code spans are stripped before extraction so
 * a code sample mentioning `[[foo]]` or `#hash` does not become a real
 * link. This is best-effort: nested fenced fences are rare and we err
 * on the side of stripping too much rather than capturing junk links.
 *
 * Reference-style links (CommonMark) are also resolved: a first pass
 * collects `[label]: target` definitions, then full (`[text][label]`),
 * collapsed (`[text][]`), and shortcut (`[text]`) references are matched
 * against them and emitted as `markdown_link` rows — the same shape and
 * `isUrl`/`isMailto`/anchor-strip filtering the inline form uses. Like
 * inline links, resolution is scoped to the content passed in (a single
 * chunk): a definition and a reference that land in different chunks are
 * not cross-resolved, mirroring the existing per-chunk extraction unit.
 */

import { WIKILINK_ALIAS_RE } from "../brain/wikilink.ts";

export type LinkType = "wikilink" | "markdown_link" | "tag";

export interface ExtractedLink {
  readonly targetPath: string | null;
  readonly linkText: string | null;
  readonly linkType: LinkType;
}

const CODE_FENCE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)[^\n]*|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
// Negative lookbehind so `![alt](url)` image embeds are NOT captured as
// markdown_link. CodeRabbit caught this regression on PR #15.
const MD_LINK_RE = /(?<!!)\[([^\]\n]*)\]\(([^)\n\s]+)(?:\s+"[^"\n]*")?\)/g;
// Obsidian-style tag: #word where word starts with a letter/_ and may contain
// letters, digits, dashes, underscores, and '/' for hierarchy.
const TAG_RE = /(^|[^\w/])#([A-Za-z_][\w\-/]*)/g;
// Reference-link definition: `[label]: target` with up to 3 leading spaces
// (4+ would be an indented code block in CommonMark). The target is a bare
// token or an `<...>` form; an optional title (quoted or parenthesised)
// follows. Only single-line definitions are recognised — the rare
// title-on-next-line form is treated as no title.
const REF_DEF_RE =
  /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm;
// Reference usage. Matches `[text]`, `[text][]`, and `[text][label]`. The
// leading `!` is captured (not a lookbehind) so a `![text][label]` image embed
// is consumed as one unit and skipped, rather than leaving its `[label]` to be
// re-read as a shortcut reference. The link text / label may not contain
// unescaped brackets or newlines.
const REF_LINK_RE = /(!?)\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g;

function stripCode(text: string): string {
  let out = text.replace(CODE_FENCE_RE, "\n");
  out = out.replace(INLINE_CODE_RE, " ");
  return out;
}

function isUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function isMailto(target: string): boolean {
  return target.toLowerCase().startsWith("mailto:");
}

// Shared target normalisation for inline and reference-style markdown links:
// reject external URLs / mailto, strip the optional `#anchor` fragment, and
// return the bare path — or null when nothing link-worthy remains.
function resolveMarkdownTarget(rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (target === "" || isUrl(target) || isMailto(target)) return null;
  const hashIdx = target.indexOf("#");
  const path = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  return path === "" ? null : path;
}

// CommonMark reference labels are case-insensitive and collapse internal
// whitespace runs to a single space after trimming.
function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupe(links: ExtractedLink[]): ExtractedLink[] {
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  for (const l of links) {
    const key = `${l.linkType}|${l.targetPath ?? ""}|${l.linkText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Resolve CommonMark reference-style links against their definitions and
 * append the resolved `markdown_link` rows to `out`. Operates on
 * already-code-stripped content.
 *
 * Two passes: first collect every `[label]: target` definition (the
 * definition lines are then blanked so their own `[label]` does not read
 * as a shortcut reference), then scan for full / collapsed / shortcut
 * references. Shortcut `[text]` references are only emitted when `text`
 * resolves to a known definition — that gate is what keeps ordinary
 * bracketed prose from becoming spurious edges.
 */
function extractReferenceLinks(cleaned: string, out: ExtractedLink[]): void {
  const defs = new Map<string, string>();
  for (const m of cleaned.matchAll(REF_DEF_RE)) {
    const label = normaliseLabel(m[1] ?? "");
    const rawTarget = m[2] ?? m[3] ?? "";
    if (label === "" || rawTarget === "") continue;
    // First definition wins, matching CommonMark.
    if (!defs.has(label)) defs.set(label, rawTarget);
  }
  if (defs.size === 0) return;

  // Blank out definition lines so the `[label]` in `[label]: target` is not
  // re-read as a shortcut reference below.
  const body = cleaned.replace(REF_DEF_RE, "");

  for (const m of body.matchAll(REF_LINK_RE)) {
    if (m[1] === "!") continue; // image embed — consumed but not an edge
    const text = (m[2] ?? "").trim();
    const second = m[3];
    let label: string;
    let linkText: string;
    if (second === undefined) {
      // Shortcut reference `[text]`. Skip if the next char makes this an
      // inline link `[text](…)` or a definition `[text]:` instead.
      const after = body[m.index + m[0].length];
      if (after === "(" || after === ":") continue;
      label = text;
      linkText = text;
    } else if (second.trim() === "") {
      // Collapsed reference `[text][]`: the text doubles as the label.
      label = text;
      linkText = text;
    } else {
      // Full reference `[text][label]`.
      label = second;
      linkText = text;
    }
    const rawTarget = defs.get(normaliseLabel(label));
    if (rawTarget === undefined) continue;
    const path = resolveMarkdownTarget(rawTarget);
    if (path === null) continue;
    out.push({
      targetPath: path,
      linkText: linkText || null,
      linkType: "markdown_link",
    });
  }
}

export function extractLinks(content: string): ExtractedLink[] {
  const cleaned = stripCode(content);
  const out: ExtractedLink[] = [];

  for (const m of cleaned.matchAll(WIKILINK_ALIAS_RE)) {
    const target = (m[1] ?? "").trim();
    const alt = m[2] ? m[2].trim() : null;
    if (target === "") continue;
    out.push({
      targetPath: target,
      linkText: alt,
      linkType: "wikilink",
    });
  }

  for (const m of cleaned.matchAll(MD_LINK_RE)) {
    const text = (m[1] ?? "").trim();
    const path = resolveMarkdownTarget(m[2] ?? "");
    if (path === null) continue;
    out.push({
      targetPath: path,
      linkText: text || null,
      linkType: "markdown_link",
    });
  }

  extractReferenceLinks(cleaned, out);

  for (const m of cleaned.matchAll(TAG_RE)) {
    const tag = (m[2] ?? "").trim();
    if (tag === "") continue;
    out.push({
      targetPath: null,
      linkText: tag,
      linkType: "tag",
    });
  }

  return dedupe(out);
}

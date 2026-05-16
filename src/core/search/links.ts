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
 */

export type LinkType = "wikilink" | "markdown_link" | "tag";

export interface ExtractedLink {
  readonly targetPath: string | null;
  readonly linkText: string | null;
  readonly linkType: LinkType;
}

const CODE_FENCE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)[^\n]*|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const WIKILINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+))?\]\]/g;
// Negative lookbehind so `![alt](url)` image embeds are NOT captured as
// markdown_link. CodeRabbit caught this regression on PR #15.
const MD_LINK_RE = /(?<!!)\[([^\]\n]*)\]\(([^)\n\s]+)(?:\s+"[^"\n]*")?\)/g;
// Obsidian-style tag: #word where word starts with a letter/_ and may contain
// letters, digits, dashes, underscores, and '/' for hierarchy.
const TAG_RE = /(^|[^\w\/])#([A-Za-z_][\w\-/]*)/g;

function stripCode(text: string): string {
  let out = text.replace(CODE_FENCE_RE, "\n");
  out = out.replace(INLINE_CODE_RE, " ");
  return out;
}

function isUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.\-]*:/i.test(target) || target.startsWith("//");
}

function isMailto(target: string): boolean {
  return target.toLowerCase().startsWith("mailto:");
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

export function extractLinks(content: string): ExtractedLink[] {
  const cleaned = stripCode(content);
  const out: ExtractedLink[] = [];

  for (const m of cleaned.matchAll(WIKILINK_RE)) {
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
    const target = (m[2] ?? "").trim();
    if (target === "" || isUrl(target) || isMailto(target)) continue;
    // Strip the optional `#anchor` fragment for path matching.
    const hashIdx = target.indexOf("#");
    const path = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
    if (path === "") continue;
    out.push({
      targetPath: path,
      linkText: text || null,
      linkType: "markdown_link",
    });
  }

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

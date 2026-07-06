/**
 * Wikilink output format kernel (Workspace Insight Suite, t_5f31b5f1).
 *
 * Three explicit modes for the TARGET side of a wikilink when Open
 * Second Brain generates or normalizes notes:
 *
 *   - `preserve` (default) - links stay exactly as typed; the
 *     normalizer is the identity function.
 *   - `full` - the target is rewritten to the full vault-relative key
 *     path (`[[Brain/notes/alpha]]`).
 *   - `short` - the target is rewritten to the shortest path suffix
 *     that is unambiguous across the known pages (`[[alpha]]`, or
 *     `[[deep/beta]]` when two pages share a basename).
 *
 * Pure functions: the caller supplies the known-page list (vault-
 * relative paths without the `.md` extension). Resolution is
 * conservative - a target that does not resolve to exactly ONE known
 * page (unknown or ambiguous) is left untouched and reported, never
 * guessed. Decorations (heading anchor, block anchor, alias) and code
 * blocks are preserved verbatim; media embeds are never rewritten.
 */

export type WikiLinkFormat = "preserve" | "full" | "short";

export const WIKI_LINK_FORMATS: ReadonlyArray<WikiLinkFormat> = Object.freeze([
  "preserve",
  "full",
  "short",
]);

export function isWikiLinkFormat(value: string): value is WikiLinkFormat {
  return (WIKI_LINK_FORMATS as ReadonlyArray<string>).includes(value);
}

/** Mirrors the masks used by the link-graph parser, broadened for the
 * rewrite path: backtick fences of any length (3+), tilde fences, and
 * inline code spans all stay verbatim. */
import { RICH_WIKILINK_RE } from "../wikilink.ts";

const CODE_BLOCK_RE = /(`{3,}|~{3,})[\s\S]*?\1|`[^`]+`/g;

export interface NormalizeResult {
  readonly content: string;
  /** Number of links whose target side was rewritten. */
  readonly changed: number;
  /** Target sides that matched more than one known page (left as typed). */
  readonly ambiguous: ReadonlyArray<string>;
}

function stripMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -".md".length) : path;
}

/**
 * `/`-aligned-suffix index over the known pages: every trailing-segment
 * suffix of every page maps to the (stripped) pages that carry it, in
 * `knownPaths` order. A target side `t` resolves to exactly the pages
 * where `page === t || page.endsWith("/" + t)` — precisely the bucket
 * `bySuffix.get(t)`, so per-link resolution drops from an O(pages) scan
 * (plus a fresh pages-sized array per link in the old
 * {@link shortestUniqueSuffix}) to a single Map lookup.
 */
type SuffixIndex = ReadonlyMap<string, ReadonlyArray<string>>;

/**
 * Built once per run and memoized on the `knownPaths` array identity:
 * `links normalize` walks the vault once and passes the same array to
 * every {@link normalizeWikilinks} call, so the index is built one time
 * and reused across all files instead of O(files × links) rebuilds.
 */
const SUFFIX_INDEX_MEMO = new WeakMap<ReadonlyArray<string>, SuffixIndex>();

function suffixIndex(knownPaths: ReadonlyArray<string>): SuffixIndex {
  const cached = SUFFIX_INDEX_MEMO.get(knownPaths);
  if (cached) return cached;
  const bySuffix = new Map<string, string[]>();
  for (const raw of knownPaths) {
    const page = stripMd(raw);
    const segments = page.split("/");
    // Each `take` is a distinct-length key, so a page is inserted at
    // most once per suffix (matching the old scan's single push).
    for (let take = 1; take <= segments.length; take += 1) {
      const key = segments.slice(segments.length - take).join("/");
      const list = bySuffix.get(key);
      if (list) list.push(page);
      else bySuffix.set(key, [page]);
    }
  }
  SUFFIX_INDEX_MEMO.set(knownPaths, bySuffix);
  return bySuffix;
}

/**
 * The shortest trailing-segment suffix of `path` that no other known
 * page shares. `Brain/notes/alpha` with no sibling `alpha` yields
 * `alpha`; two pages ending in `beta` yield `deep/beta` /
 * `archive/beta`.
 */
export function shortestUniqueSuffix(path: string, knownPaths: ReadonlyArray<string>): string {
  const index = suffixIndex(knownPaths);
  const segments = path.split("/");
  for (let take = 1; take <= segments.length; take += 1) {
    const suffix = segments.slice(segments.length - take).join("/");
    // `path`'s own bucket entry is always present; a clash is any OTHER
    // page sharing the suffix — identical to the old
    // `others.filter(p => p !== path).some(...)`.
    const bucket = index.get(suffix);
    const clash = bucket !== undefined && bucket.some((p) => p !== path);
    if (!clash) return suffix;
  }
  return path;
}

/**
 * Resolve a target side to the unique known page it names: an exact
 * path match or a `/`-aligned suffix match. Returns the full page
 * path, "ambiguous", or null when nothing matches.
 */
function resolveTarget(
  targetSide: string,
  knownPaths: ReadonlyArray<string>,
): string | "ambiguous" | null {
  const target = stripMd(targetSide.trim());
  if (target === "") return null;
  const matches = suffixIndex(knownPaths).get(target);
  if (matches === undefined) return null;
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return "ambiguous";
  return null;
}

interface BodyRewrite {
  readonly body: string;
  readonly changed: boolean;
  readonly ambiguous: string | null;
}

function rewriteBody(
  body: string,
  mode: WikiLinkFormat,
  knownPaths: ReadonlyArray<string>,
): BodyRewrite {
  if (mode === "preserve") return { body, changed: false, ambiguous: null };

  // Split decorations off verbatim: pipe binds tighter than hash in
  // the Obsidian grammar, so locate the alias first.
  const pipeIdx = body.indexOf("|");
  const aliasPart = pipeIdx >= 0 ? body.slice(pipeIdx) : "";
  const beforeAlias = pipeIdx >= 0 ? body.slice(0, pipeIdx) : body;
  const hashIdx = beforeAlias.indexOf("#");
  const anchorPart = hashIdx >= 0 ? beforeAlias.slice(hashIdx) : "";
  const targetSide = hashIdx >= 0 ? beforeAlias.slice(0, hashIdx) : beforeAlias;

  const resolved = resolveTarget(targetSide, knownPaths);
  if (resolved === null) return { body, changed: false, ambiguous: null };
  if (resolved === "ambiguous") {
    return { body, changed: false, ambiguous: targetSide.trim() };
  }
  const formatted = mode === "full" ? resolved : shortestUniqueSuffix(resolved, knownPaths);
  if (formatted === targetSide.trim()) return { body, changed: false, ambiguous: null };
  return { body: `${formatted}${anchorPart}${aliasPart}`, changed: true, ambiguous: null };
}

/** Format a single bracket body (no surrounding `[[ ]]`). */
export function formatWikilinkBody(
  body: string,
  mode: WikiLinkFormat,
  knownPaths: ReadonlyArray<string>,
): string {
  return rewriteBody(body, mode, knownPaths).body;
}

/**
 * Rewrite every wikilink in a Markdown document to the requested
 * format, skipping fenced/inline code spans and media embeds
 * (`![[...]]`).
 */
export function normalizeWikilinks(
  content: string,
  mode: WikiLinkFormat,
  knownPaths: ReadonlyArray<string>,
): NormalizeResult {
  if (mode === "preserve") {
    return Object.freeze({ content, changed: 0, ambiguous: Object.freeze([]) });
  }
  let changed = 0;
  const ambiguous = new Set<string>();

  const transformSegment = (segment: string): string =>
    segment.replace(RICH_WIKILINK_RE, (match: string, body: string, offset: number) => {
      // Media embeds (`![[...]]`) are renders, not references.
      if (offset > 0 && segment[offset - 1] === "!") return match;
      const rewrite = rewriteBody(body, mode, knownPaths);
      if (rewrite.ambiguous !== null) ambiguous.add(rewrite.ambiguous);
      if (!rewrite.changed) return match;
      changed += 1;
      return `[[${rewrite.body}]]`;
    });

  let out = "";
  let last = 0;
  for (const m of content.matchAll(CODE_BLOCK_RE)) {
    out += transformSegment(content.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  out += transformSegment(content.slice(last));

  return Object.freeze({
    content: out,
    changed,
    ambiguous: Object.freeze([...ambiguous].toSorted()),
  });
}

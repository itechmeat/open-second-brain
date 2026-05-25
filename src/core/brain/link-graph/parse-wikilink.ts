/**
 * Rich wikilink parse helper.
 *
 * The Obsidian wikilink grammar supports four pieces of metadata in
 * one bracket pair:
 *
 *   - target  (`[[NoteName]]`) - the canonical id; required.
 *   - anchor  (`[[Note#Heading]]`) - heading reference; optional.
 *   - block   (`[[Note#^abc]]`) - block-id reference; optional. Same
 *                                   `#` delimiter as the anchor but
 *                                   distinguished by the `^` sigil.
 *   - alias   (`[[Note|display]]`) - human-readable display text;
 *                                   optional.
 *
 * The legacy `parseWikilink` / `normaliseWikilinkTarget` helpers in
 * `wikilink.ts` return just the bare `target` string. This rich
 * variant returns the same target plus the additional slots so
 * downstream consumers (backlink index, unlinked-mentions scanner,
 * concept-cluster assembler) can see paragraph-level intent without
 * losing it at the parser boundary.
 *
 * The helper is intentionally tolerant: any input that doesn't look
 * like a wikilink (no surrounding `[[…]]`) is treated as a bare
 * target body and run through the same decoration-stripping pipeline.
 * Callers that need a "this is literally a wikilink?" predicate
 * should keep using `parseWikilink` (which returns `null` for
 * non-wikilink input).
 */

import { basename } from "node:path";

/**
 * Local regex for the rich extractor. Captures the full bracket
 * body (everything between `[[` and `]]`), so anchor / alias / block
 * info survives for downstream `parseWikilinkRich` consumption.
 *
 * Bracketed by `]]` and forbidding embedded `]` so nested brackets
 * don't collapse two adjacent wikilinks into one match. Anchored to
 * non-newline so a link that spans lines is not silently joined.
 */
const RICH_WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

/**
 * Local mask for fenced and inline code spans. Mirrors the constant
 * used by `extractWikilinks` in `vault.ts` so a wikilink that lives
 * inside a code block does not pollute the index.
 */
const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`]+`/g;

/**
 * Inclusive list of file-extension suffixes (lower-case) that
 * disqualify a wikilink from the backlink index. Mirrors the media
 * filter in `vault.ts:extractWikilinks` so embed-style links don't
 * register as backlinks.
 */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tiff",
  ".avif", ".mp4", ".webm", ".ogv", ".mov", ".mkv", ".avi", ".mp3",
  ".wav", ".ogg", ".flac", ".m4a", ".pdf",
]);

export interface WikilinkParse {
  /** Canonical bare id - same shape `normaliseWikilinkTarget` returns. */
  readonly target: string;
  /**
   * Heading-anchor text (`#Heading`), present only when the link
   * carries a heading anchor (no leading `^`). Absent for block
   * references and for plain targets.
   */
  readonly anchor?: string;
  /**
   * Block-id text (`#^block-id`), present only when the link carries
   * a block anchor. The `^` sigil is stripped; just the bare id.
   */
  readonly block?: string;
  /**
   * Display alias from `[[target|alias]]`. The alias text is
   * preserved verbatim minus surrounding whitespace.
   */
  readonly alias?: string;
}

/**
 * Parse an Obsidian wikilink into its four-slot decomposition.
 *
 * Tolerant of:
 *   - bracketed and bare forms (`[[foo]]` and `foo`)
 *   - alias suffix (`[[foo|display]]`)
 *   - heading anchor (`[[foo#Heading]]`)
 *   - block anchor (`[[foo#^abc]]`)
 *   - folder prefix (`[[Folder/foo]]`)
 *   - trailing `.md` extension (`[[foo.md]]`)
 *   - any combination of the above (alias may follow either anchor
 *     shape; folder prefix may sit on the target side)
 *
 * Returns a frozen object so callers can't mutate shared state. Empty
 * input returns `{target: ""}` (no anchor / block / alias).
 */
export function parseWikilinkRich(value: string): WikilinkParse {
  let s = value.trim();

  // Strip surrounding wikilink brackets when present. Bare-text input
  // skips this branch and goes straight to the decoration-strip
  // pipeline.
  const wm = /^\[\[([^\]]+)\]\]/.exec(s);
  if (wm) s = wm[1]!.trim();

  // Pull alias FIRST. The pipe separator binds tighter than the hash
  // separator in the Obsidian grammar - `[[foo#Heading|alias]]` means
  // target `foo`, anchor `Heading`, alias `alias`. Locating the pipe
  // first lets us safely scan for `#` in just the target+anchor span.
  let alias: string | undefined;
  const pipeIdx = s.indexOf("|");
  if (pipeIdx >= 0) {
    const aliasText = s.slice(pipeIdx + 1).trim();
    if (aliasText.length > 0) alias = aliasText;
    s = s.slice(0, pipeIdx).trim();
  }

  // Pull anchor / block. The `#^` block sigil is structural (Obsidian
  // grammar), not language-specific. The `#` heading sigil is
  // likewise structural - this branch never inspects the anchor
  // text's vocabulary.
  let anchor: string | undefined;
  let block: string | undefined;
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    const afterHash = s.slice(hashIdx + 1);
    if (afterHash.startsWith("^")) {
      const blockText = afterHash.slice(1).trim();
      if (blockText.length > 0) block = blockText;
    } else {
      const anchorText = afterHash.trim();
      if (anchorText.length > 0) anchor = anchorText;
    }
    s = s.slice(0, hashIdx).trim();
  }

  // Normalise the bare target: folder collapse + `.md` strip. Empty
  // input falls through cleanly.
  let target = basename(s);
  if (target.endsWith(".md")) target = target.slice(0, -".md".length);

  return Object.freeze({
    target,
    ...(anchor !== undefined ? { anchor } : {}),
    ...(block !== undefined ? { block } : {}),
    ...(alias !== undefined ? { alias } : {}),
  });
}

/**
 * Yield every wikilink bracket-body from a Markdown content string,
 * preserving anchor / alias / block decoration so callers can run
 * each through {@link parseWikilinkRich}.
 *
 * Skips text inside fenced or inline code blocks (mirrors the
 * masking pass in `extractWikilinks` from `vault.ts`). Media-extension
 * targets (`.png`, `.pdf`, …) are dropped so an embed-style link
 * does not pollute the backlink index.
 *
 * Returns the bare bracket body (no surrounding `[[`/`]]`). Empty
 * input yields an empty array.
 */
export function extractWikilinkRichBodies(content: string): ReadonlyArray<string> {
  const masked = content.replace(CODE_BLOCK_RE, " ");
  const out: string[] = [];
  for (const m of masked.matchAll(RICH_WIKILINK_RE)) {
    const body = m[1]!;
    // Drop embed-style media links - same filter as
    // `extractWikilinks` in `vault.ts`. The check inspects the
    // bare-target portion (before `#`/`|`) to avoid false-positives
    // on aliases that happen to end in a media-shaped extension.
    const targetSide = body.split(/[#|]/, 1)[0]!.trim();
    const dot = targetSide.lastIndexOf(".");
    const ext = dot >= 0 ? targetSide.slice(dot).toLowerCase() : "";
    if (MEDIA_EXTENSIONS.has(ext)) continue;
    out.push(body);
  }
  return out;
}

/**
 * Wikilink parsing helpers for the Brain layer.
 *
 * The Obsidian-flavoured wikilink shape is `[[target]]`, with optional
 * alias (`[[target|alias]]`) and anchor (`[[target#section]]`) suffixes.
 * Brain frontmatter writers always emit the bare `[[id]]` form, but the
 * parsers must tolerate the alias / anchor / folder-prefixed / `.md`-
 * suffixed variants because the on-disk artifacts are user-editable.
 *
 * Surface:
 *
 *   - {@link normaliseWikilinkTarget} extracts the bare target id from
 *     any of those shapes. Used by the doctor command (resolving
 *     `evidenced_by` / `supersedes` pointers against the Brain index)
 *     and by the query command (matching log payload values against a
 *     preference id).
 *
 *   - {@link parseWikilink} returns the target if the input is exactly
 *     a wikilink form (`^\[\[…\]\]$`), or `null` otherwise. Used by the
 *     dream loop's `evidenced_by` walker and the digest's tolerant
 *     contradiction-line parser, where the caller wants to distinguish
 *     "this is a wikilink" from "this is bare text".
 *
 * Both helpers are case-preserving and do NOT validate that the target
 * exists; that's a higher-layer concern (doctor cross-references against
 * the Brain index, dream relies on a follow-up `Map.has` check).
 */

import { basename } from "node:path";

/**
 * Strip wikilink decoration off `value` and return the bare target id.
 *
 * Recognises:
 *   - surrounding `[[…]]` brackets (only the first match wins)
 *   - `|alias` and `#anchor` suffixes (alias / anchor dropped)
 *   - leading folder segments (`folder/foo` → `foo`)
 *   - trailing `.md` extension
 *
 * Returns the input unchanged (minus a trim) when it isn't decorated;
 * callers can still distinguish bare text from "no input" via the empty
 * string.
 */
export function normaliseWikilinkTarget(value: string): string {
  let s = value.trim();
  // Strip surrounding wikilink brackets, retaining only the target.
  const wm = /^\[\[([^\]]+)\]\]/.exec(s);
  if (wm) s = wm[1]!.trim();
  return stripBasenameDecoration(s);
}

/**
 * Drop `|alias`, `#anchor`, leading folder segments, and trailing
 * `.md` from a wikilink body (everything between `[[` and `]]`).
 * Shared between {@link normaliseWikilinkTarget} and
 * {@link parseArtifactRef} — they apply the same Obsidian-flavoured
 * resolution rules to the post-bracket part of the link.
 */
function stripBasenameDecoration(body: string): string {
  let s = body.trim();
  const pipe = s.indexOf("|");
  if (pipe >= 0) s = s.slice(0, pipe).trim();
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash).trim();
  s = basename(s);
  if (s.endsWith(".md")) s = s.slice(0, -".md".length);
  return s;
}

/**
 * Return the bare target id if `value` is exactly a wikilink form
 * (`^\[\[…\]\]$` modulo surrounding whitespace), otherwise `null`.
 *
 * Unlike {@link normaliseWikilinkTarget}, this is anchored: a bare id or
 * a mixed string ("see [[foo]]" embedded in prose) yields `null`. Use
 * this when "is this a wikilink at all?" is the question being asked.
 *
 * Alias / anchor / folder / `.md` decoration on the target itself is
 * stripped via the same logic as `normaliseWikilinkTarget` so callers
 * get a clean id either way.
 */
export function parseWikilink(value: string): string | null {
  const m = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  if (!m) return null;
  return normaliseWikilinkTarget(m[1]!);
}

/**
 * Inclusive 1-based line range extracted from an artifact wikilink
 * (`[[file:120-145]]` → `{start: 120, end: 145}`). Single-line form
 * (`[[file:120]]`) returns `{start: 120, end: 120}`.
 */
export interface ArtifactRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse result for an `artifact` field in an `apply-evidence` event.
 *
 * `target` is the normalised wikilink basename (same shape as
 * {@link normaliseWikilinkTarget} returns). `range` is present iff a
 * well-formed `:N` or `:N-N` suffix was supplied. `malformedRange` is
 * `true` when a range suffix was supplied but failed validation —
 * the artifact is still recorded verbatim by the writer; the
 * `brain_doctor` lint surfaces the failure separately so callers can
 * fix it without losing the underlying event.
 *
 * Original input is preserved as `raw` so the lint message can quote
 * exactly what the user wrote.
 */
export interface ArtifactRefParse {
  readonly raw: string;
  readonly target: string;
  readonly range?: ArtifactRange;
  readonly malformedRange?: true;
  /** When the range suffix is present (well-formed or not). */
  readonly rangeText?: string;
}

const RANGE_SUFFIX_RE = /^(.*):([^:]*)$/;

/**
 * Parse the `artifact` field of an apply-evidence event.
 *
 * Accepts:
 *   - bare wikilink `[[file]]`
 *   - decorated `[[Folder/file.md|Alias]]`
 *   - **range form** `[[file:120-145]]` or `[[file:120]]`
 *   - bare (non-wikilink) text, in which case `target` is the
 *     normalised input minus any range suffix
 *
 * Returns a parse — `target` is always present (possibly empty for
 * empty input). `range` and `malformedRange` are mutually exclusive.
 */
export function parseArtifactRef(value: string): ArtifactRefParse {
  const raw = value;
  // Extract the inside of `[[…]]` if present; otherwise treat the
  // whole input as the target body. Keep the colon suffix here so we
  // can peel the range BEFORE the basename collapse — `Folder/file:120`
  // otherwise has its colon swallowed by `path.basename`.
  let body = value.trim();
  let wasWikilink = false;
  const wm = /^\[\[([^\]]+)\]\]$/.exec(body);
  if (wm) {
    body = wm[1]!.trim();
    wasWikilink = true;
  }
  // Drop `|alias` before the range probe — otherwise the alias text
  // sits between the colon-range and the end of the string and the
  // suffix regex picks up the alias instead.
  const pipe = body.indexOf("|");
  if (pipe >= 0) body = body.slice(0, pipe).trim();

  // Peel `:range` off the END before applying normaliseWikilinkTarget.
  // The numeric heuristic keeps Windows-style paths (`C:foo`) and
  // IPv6 addresses out of the range branch.
  let preRange = body;
  let rangeText: string | undefined;
  const rm = RANGE_SUFFIX_RE.exec(body);
  if (rm) {
    const candidate = rm[2]!.trim();
    if (wasWikilink || /^[0-9-]+$/.test(candidate)) {
      preRange = rm[1]!.trim();
      rangeText = candidate;
    }
  }

  // Delegate the alias/anchor/folder/.md strip to the canonical
  // wikilink normaliser so both call sites stay in sync.
  const target = normaliseWikilinkTarget(preRange);

  if (rangeText === undefined) {
    return { raw, target };
  }

  const range = validateRangeText(rangeText);
  if (range === null) {
    return { raw, target, rangeText, malformedRange: true };
  }
  return { raw, target, rangeText, range };
}

function validateRangeText(text: string): ArtifactRange | null {
  // Accepts `N` or `N-N`, both with 1-based positive integers and
  // `end >= start`. Anything else fails (zero, negative numbers,
  // reversed range, dangling dashes).
  const single = /^\d+$/.exec(text);
  if (single) {
    const n = parseInt(text, 10);
    if (n <= 0) return null;
    return { start: n, end: n };
  }
  const pair = /^(\d+)-(\d+)$/.exec(text);
  if (!pair) return null;
  const start = parseInt(pair[1]!, 10);
  const end = parseInt(pair[2]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start <= 0 || end <= 0) return null;
  if (end < start) return null;
  return { start, end };
}

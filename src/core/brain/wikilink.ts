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

/*
 * Canonical wikilink regex variants.
 *
 * Exactly one definition of the `[[...]]` syntax exists per contract;
 * every parser in the codebase imports the variant whose edge-case
 * behavior it needs instead of declaring a local copy:
 *
 *   - {@link WIKILINK_TARGET_RE}: target before any `|`/`#` suffix,
 *     suffix captured separately. Tolerates newlines inside the
 *     brackets (historical `vault.ts` behavior). For target extraction
 *     and merged-link rewriting.
 *   - {@link WIKILINK_ALIAS_RE}: target plus optional `|alias`
 *     capture, single-line only, `#` stays inside the target. For the
 *     search link/entity extractors.
 *   - {@link RICH_WIKILINK_RE}: whole bracket body in one capture,
 *     single-line only. For the link-graph parser/formatter which
 *     decomposes the body itself.
 *   - {@link WIKILINK_DETECT_RE}: presence check, no captures.
 *   - {@link ANCHORED_WIKILINK_RE} / {@link EXACT_WIKILINK_RE}:
 *     prefix-strip and whole-string forms used by the normalisers in
 *     this module.
 *
 * The `g`-flagged variants are shared module-level instances: use them
 * with `matchAll`/`replace` (which do not leak `lastIndex` state);
 * clone via `new RegExp(re)` before calling `exec`/`test` in a loop.
 */

/** Target capture with separate `[#|]suffix` capture; multi-line tolerant. */
export const WIKILINK_TARGET_RE = /\[\[([^\]|#]+)([#|][^\]]*)?\]\]/g;

/**
 * Target plus optional `|alias` capture; single-line, unicode mode.
 * The `u` flag is inherited from the entity extractor; the link
 * extractor formerly ran the same pattern without it - equivalent
 * here because the pattern only uses negated classes over BMP
 * delimiters.
 */
export const WIKILINK_ALIAS_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+))?\]\]/gu;

/** Whole bracket body in one capture; single-line. */
export const RICH_WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

/** Presence check only; no captures, not global. */
export const WIKILINK_DETECT_RE = /\[\[[^\]\n]+\]\]/u;

/** Leading-wikilink prefix strip; body in one capture. */
export const ANCHORED_WIKILINK_RE = /^\[\[([^\]]+)\]\]/;

/** Whole-string wikilink form; body in one capture. */
export const EXACT_WIKILINK_RE = /^\[\[([^\]]+)\]\]$/;

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
  const wm = ANCHORED_WIKILINK_RE.exec(s);
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
  const m = EXACT_WIKILINK_RE.exec(value.trim());
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
  const wm = EXACT_WIKILINK_RE.exec(body);
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

/**
 * Maximum length of the wikilink title rendered by {@link renderPrefLink}
 * before truncation kicks in. Chosen so a `[[pref-…|title]]` link fits on
 * one Obsidian list-row at typical viewport widths.
 */
export const MAX_PREF_LINK_TITLE_LEN = 80;

/**
 * Render a wikilink to a Brain preference or retired artifact with a
 * human-readable title sourced from the `principle` field.
 *
 * The title is NFC-normalised, whitespace-collapsed, sanitised of
 * wikilink-breaking characters (`[`, `]`, `|`), and truncated to
 * {@link MAX_PREF_LINK_TITLE_LEN} at a word boundary (ellipsised when
 * cut). When the principle is missing or becomes empty after
 * sanitisation, the helper falls back to the bare `[[id]]` form so the
 * link remains resolvable through {@link normaliseWikilinkTarget} and
 * {@link parseWikilink} (both of which already strip `|alias`).
 *
 * Used by every Brain writer that emits a pref / retired reference;
 * signal and external-artifact wikilinks stay bare-id because they have
 * no useful title source.
 */
/** Where a wikilink renders to: Obsidian `[[wikilink]]` or portable `[markdown](path)`. */
export type LinkOutputFormat = "wikilink" | "markdown";

export function renderPrefLink(input: {
  readonly id: string;
  readonly principle?: string;
  readonly format?: LinkOutputFormat;
  readonly targetPath?: string;
}): string {
  const raw = input.principle ?? "";
  // Sanitisation pipeline, in order:
  //   1. NFC normalise so visually-equal inputs hash to the same bytes.
  //   2. Strip C0/C1 control chars except tab/newline (the whitespace
  //      collapse below handles those), zero-width joiners, BiDi
  //      overrides — these can spoof or break Obsidian rendering.
  //   3. Replace wikilink-breaking glyphs (`[`, `]`, `|`) with spaces.
  //   4. Collapse all whitespace runs to a single space, trim.
  const title = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // C0 controls (00-1F) except \t \n; DEL (7F); C1 controls (80-9F).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ")
    // Format / BiDi-override characters that can cause visual spoofing
    // in Obsidian: zero-width space/joiner, LRM/RLM, BiDi embedding +
    // override + isolates, soft hyphen, BOM.
    .replace(/[​-‏‪-‮⁦-⁩­﻿]/g, " ")
    .replace(/[[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) {
    if (input.format === "markdown") {
      return renderMarkdownLink(input.id, inferBrainArtifactPath(input.id, input.targetPath));
    }
    return `[[${input.id}]]`;
  }
  // Measure the cap against code-point count (Array.from yields one
  // entry per Unicode scalar) rather than UTF-16 code units so a
  // string of 50 astral glyphs (100 code units, 50 code points) is
  // not forced into the truncation path when the cap is 80.
  const codepoints = Array.from(title);
  if (codepoints.length <= MAX_PREF_LINK_TITLE_LEN) {
    if (input.format === "markdown") {
      return renderMarkdownLink(title, inferBrainArtifactPath(input.id, input.targetPath));
    }
    return `[[${input.id}|${title}]]`;
  }
  // Truncate to the cap, then back off to the previous word boundary —
  // but only when one exists inside the window. A single oversized token
  // (no space inside the cap) gets a hard cut so we still produce a link
  // rather than dropping back to the bare-id fallback. Slicing happens
  // on code points so an emoji or astral glyph never gets bisected
  // into a lone surrogate before the ellipsis.
  let cutPoints = codepoints.slice(0, MAX_PREF_LINK_TITLE_LEN);
  const lastSpace = cutPoints.lastIndexOf(" ");
  if (lastSpace > 0) cutPoints = cutPoints.slice(0, lastSpace);
  const truncated = `${cutPoints.join("")}…`;
  if (input.format === "markdown") {
    return renderMarkdownLink(truncated, inferBrainArtifactPath(input.id, input.targetPath));
  }
  return `[[${input.id}|${truncated}]]`;
}

function inferBrainArtifactPath(id: string, targetPath?: string): string {
  if (targetPath) return targetPath;
  if (id.startsWith("ret-")) return `Brain/retired/${id}.md`;
  if (id.startsWith("pref-")) return `Brain/preferences/${id}.md`;
  return `Brain/${id}.md`;
}

function renderMarkdownLink(label: string, targetPath: string): string {
  return `[${label}](${encodeMarkdownTarget(targetPath)})`;
}

function encodeMarkdownTarget(targetPath: string): string {
  return encodeURI(targetPath).replace(/\)/g, "%29");
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

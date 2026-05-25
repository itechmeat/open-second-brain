/**
 * Unlinked-mentions scanner.
 *
 * Given a target Brain artifact id, walk every other preference /
 * retired note and emit each raw-text occurrence of the target's
 * title (or any frontmatter alias) that is NOT already inside a
 * `[[...]]` wikilink and NOT inside a fenced / inline code span.
 *
 * The matcher is purely structural:
 *
 *   - Word boundaries use Unicode codepoint classes (`\p{L}`,
 *     `\p{N}`); both edges of the match must sit against a
 *     non-letter, non-digit codepoint (or string edge).
 *   - Single-codepoint terms are rejected as too noisy.
 *   - No vocabulary list, no stopword set, no per-language data.
 *
 * The scanner is read-only and bounded by vault size; pure helper,
 * no I/O beyond the directory walk + per-file read.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";

/** One unlinked-mention occurrence. */
export interface MentionRef {
  /** Source artifact id (basename without `.md`). */
  readonly source: string;
  /** 1-based line number in the source body. */
  readonly line: number;
  /** The literal term that matched (title or alias spelling). */
  readonly term: string;
  /** Line content with the match in situ (single line, untrimmed). */
  readonly contextSnippet: string;
}

export interface FindUnlinkedMentionsOptions {
  /**
   * Maximum number of mentions returned. Default `100`. Pagination is
   * not exposed; callers needing more should call with a larger cap.
   */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 100;

/** Minimum codepoint count for a search term to count as a match. */
const MIN_TERM_CODEPOINTS = 2;

/** Replacement char used to mask brackets / code spans. */
const MASK_CHAR = " ";

const BRACKET_RE = /\[\[[^\]\n]+\]\]/g;
const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`]+`/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * Walk `Brain/preferences/` and `Brain/retired/` for unlinked
 * mentions of the target. Returns a frozen array capped at
 * `opts.limit`.
 */
export function findUnlinkedMentions(
  vault: string,
  targetId: string,
  opts: FindUnlinkedMentionsOptions = {},
): ReadonlyArray<MentionRef> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dirs = brainDirs(vault);

  // Resolve the target's title + aliases from frontmatter.
  const terms = resolveSearchTerms(vault, targetId);
  if (terms.length === 0) return Object.freeze([]) as ReadonlyArray<MentionRef>;

  const collected: MentionRef[] = [];
  scanDir(dirs.preferences, targetId, terms, collected, limit);
  if (collected.length < limit) {
    scanDir(dirs.retired, targetId, terms, collected, limit);
  }

  return Object.freeze(collected) as ReadonlyArray<MentionRef>;
}

function resolveSearchTerms(vault: string, targetId: string): ReadonlyArray<string> {
  const dirs = brainDirs(vault);
  const candidates = [
    join(dirs.preferences, `${targetId}.md`),
    join(dirs.retired, `${targetId}.md`),
  ];
  let metaSource: Record<string, unknown> | null = null;
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const [meta] = parseFrontmatter(c);
      metaSource = meta as Record<string, unknown>;
      break;
    } catch {
      continue;
    }
  }

  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (Array.from(trimmed).length < MIN_TERM_CODEPOINTS) return;
    const key = trimmed.normalize("NFC").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(trimmed);
  };

  if (metaSource) {
    push(metaSource["title"]);
    const aliases = metaSource["aliases"];
    if (Array.isArray(aliases)) for (const a of aliases) push(a);
  }
  // Fall back to the id itself when no title is declared. The id
  // already has at least two codepoints in every realistic case
  // (`pref-x`, `ret-y`).
  if (terms.length === 0) push(targetId);

  return terms;
}

function scanDir(
  dir: string,
  targetId: string,
  terms: ReadonlyArray<string>,
  out: MentionRef[],
  limit: number,
): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (out.length >= limit) return;
    if (!name.endsWith(".md")) continue;
    const source = name.slice(0, -".md".length);
    if (source === targetId) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    // Strip frontmatter before scanning the body.
    const body = stripFrontmatter(text);
    scanBody(body, source, terms, out, limit);
  }
}

function stripFrontmatter(text: string): string {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (!m) return text;
  return text.slice(m[0].length);
}

function scanBody(
  body: string,
  source: string,
  terms: ReadonlyArray<string>,
  out: MentionRef[],
  limit: number,
): void {
  // Mask wikilinks and code spans so matches inside them are
  // ignored. The mask preserves character offsets so line/column
  // bookkeeping stays exact - replace each masked region with a
  // run of MASK_CHAR of identical length.
  const masked = maskRegions(body, [BRACKET_RE, CODE_BLOCK_RE]);
  const lines = masked.split("\n");
  const originalLines = body.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (out.length >= limit) return;
    const maskedLine = lines[i]!;
    const original = originalLines[i] ?? "";
    for (const term of terms) {
      const lowerLine = maskedLine.toLowerCase();
      const lowerTerm = term.toLowerCase();
      let from = 0;
      while (from <= lowerLine.length) {
        const idx = lowerLine.indexOf(lowerTerm, from);
        if (idx < 0) break;
        const before = idx > 0 ? maskedLine[idx - 1] : undefined;
        const after = maskedLine[idx + lowerTerm.length];
        if (isWordEdge(before) && isWordEdge(after)) {
          out.push(
            Object.freeze({
              source,
              line: i + 1,
              term,
              contextSnippet: original,
            }),
          );
          if (out.length >= limit) return;
        }
        from = idx + Math.max(1, lowerTerm.length);
      }
    }
  }
}

function isWordEdge(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !WORD_CHAR_RE.test(ch);
}

function maskRegions(text: string, regexes: ReadonlyArray<RegExp>): string {
  let masked = text;
  for (const re of regexes) {
    masked = masked.replace(re, (s) => MASK_CHAR.repeat(s.length));
  }
  return masked;
}

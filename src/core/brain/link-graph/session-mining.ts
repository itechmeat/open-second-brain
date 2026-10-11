/**
 * Session-entity mining (recall-quality wave, Lane B / t_13a82a31).
 *
 * A precision-biased inverse of fact extraction. `extractFacts` strips
 * code spans before matching, because prose facts must not read code;
 * mining treats code spans and fences as the HIGHEST-precision source,
 * because an identifier someone wrapped in backticks is an identifier on
 * purpose. Four structural families - no natural-language word list in
 * any language:
 *
 *   - `symbol`          - identifier-shaped content of inline code spans
 *                         and fenced code blocks;
 *   - `url`             - the fact-extract URL family, reproduced on the
 *                         raw turn text (pinned equivalent in
 *                         session-mining.test.ts);
 *   - `path`            - separator-plus-extension shapes, in BOTH slash
 *                         directions;
 *   - `qualified-ident` - dotted / double-colon shapes of two or more
 *                         segments carrying a structural cue (a digit, an
 *                         underscore, an internal uppercase, or a third
 *                         segment).
 *
 * Identity care: mined keys are family-scoped and CASE-PRESERVING - NFC
 * plus trim plus a length cap, NOTHING more. `normalizeEntityName`'s
 * lowercase fold and quote fold are promotion's business (the entity
 * kernel applies them when a key is promoted); the ledger must keep
 * `SessionStore` and `sessionstore` distinct because symbols and paths
 * are case-sensitive.
 *
 * Security: a secret-shaped candidate is REFUSED, never written - URLs
 * with `user:pass@host` userinfo or `token=`/`key=` query forms
 * (`redactSpecifierCredentials`), and vendor-prefixed / high-entropy /
 * JWT-shaped tokens in code spans (`redactRawOutput` with
 * `redactTokens`). A refused candidate is counted, never silent.
 *
 * The ledger write is one `session_entity_mention` continuity record per
 * (family, key, sessionRef), deduped within an import run through the
 * caller-owned `seen` set. Rows are append-only; the hallways pass folds
 * duplicates out at the same granularity, so a re-imported transcript
 * folds to the same mention set.
 */

import { privateRegionTexts, redactRawOutput, redactSpecifierCredentials } from "../../redactor.ts";
import { appendContinuityRecord } from "../continuity/store.ts";
import type { ContinuityRecordKind } from "../continuity/types.ts";
import { isoSecond } from "../time.ts";

/** The precision detector families, in scan order. */
export const SESSION_MINING_FAMILIES = Object.freeze([
  "symbol",
  "url",
  "path",
  "qualified-ident",
] as const);

export type SessionMiningFamily = (typeof SESSION_MINING_FAMILIES)[number];

/** The continuity record kind one mined mention is written as. */
export const SESSION_ENTITY_MENTION_KIND: ContinuityRecordKind = "session_entity_mention";

/**
 * Upper bound on a mined key. Mirrors ENTITY_LABEL_MAX_LENGTH's
 * defensible ceiling: a real symbol, URL, path or qualified identifier
 * is short; anything past this is a pasted blob.
 */
export const MINED_KEY_MAX_LENGTH = 200;

/**
 * Defence-in-depth scan cap per line, mirroring the fact-extract
 * convention: a single pathologically long line is never scanned in
 * full, so the capture hot path cannot be turned into a CPU sink.
 */
export const MAX_MINING_SCAN_CHARS = 4000;

/** One mined mention: a family-scoped, case-preserving key. */
export interface MinedMention {
  readonly family: SessionMiningFamily;
  readonly key: string;
}

/**
 * The side key a mined mention keys on: NFC, trim, length cap. Deliberately
 * NOT `normalizeEntityName` - no lowercase fold, no quote fold, no
 * whitespace collapse - because the ledger's keys are case-sensitive
 * identifiers, and folding them is promotion's business, at the entity
 * kernel, behind a threshold and a review.
 */
export function miningKey(raw: string): string {
  const key = raw.normalize("NFC").trim();
  return key.length > MINED_KEY_MAX_LENGTH ? key.slice(0, MINED_KEY_MAX_LENGTH) : key;
}

/**
 * The (family, key, sessionRef) dedupe id: the granularity one mention
 * folds to within an import run, and the fold the hallways pass applies
 * over duplicate ledger rows.
 */
export function miningDedupeId(
  family: SessionMiningFamily,
  key: string,
  sessionRef: string,
): string {
  return `${family}\u0000${key}\u0000${sessionRef}`;
}

// ----- Detection -------------------------------------------------------------

/**
 * The fact-extract URL family, spelled here with the same pattern. The
 * equivalence is pinned in session-mining.test.ts against
 * `extractFacts`' own `url` family, so the two cannot drift silently -
 * fact-extract.ts is a leaf this module must not import from (it pulls
 * the write path with it).
 */
const URL_SPAN_RE = /\bhttps?:\/\/[^\s)>\]]+/giu;

/** A fenced code block's content, non-greedy per block. */
const FENCED_BLOCK_RE = /```[\s\S]*?```/g;
/** An inline code span's content (no newline inside a span). */
const INLINE_CODE_RE = /`([^`\n]+)`/g;

/**
 * A maximal "techy" run in prose: word characters plus the punctuation a
 * path or qualified identifier carries. Runs end at whitespace and at
 * any other punctuation, so `src/core/store.ts,` stops at the comma and
 * `(see notes/idea.md)` stops at the parens.
 */
const TECH_RUN_RE = /[\w@:.\-/\\]+/g;

/** Identifier shape: one token, no spaces, no quotes. */
const IDENTIFIER_SHAPE_RE = /^[\w.$:/\\@-]+$/u;

/** Qualified identifier: segments joined by dots or a double colon. */
const QUALIFIED_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]+)+$/u;

/** At least one letter in any script - a bare number or hash is not a name. */
const HAS_LETTER_RE = /\p{L}/u;

/** The structural code cue an identifier must carry to be worth mining. */
function hasCodeCue(token: string): boolean {
  if (/[_./\\:$@\d]/u.test(token)) return true;
  for (let i = 1; i < token.length; i++) {
    const ch = token[i]!;
    const prev = token[i - 1]!;
    if (ch !== ch.toLowerCase() && prev === prev.toLowerCase()) return true;
  }
  return false;
}

/** Split a code region's content into identifier-shaped candidate tokens. */
function codeTokens(content: string): string[] {
  return content.split(/[^A-Za-z0-9_.$:/\\@-]+/u).filter((t) => t.length >= 2);
}

/** Whether a candidate should be refused as secret-shaped (see module header). */
export function isSecretShapedMention(family: SessionMiningFamily, raw: string): boolean {
  if (family === "url") return redactSpecifierCredentials(raw) !== raw;
  return redactRawOutput(raw, { redactTokens: true }) !== raw;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function overlaps(span: Span, ranges: ReadonlyArray<Span>): boolean {
  return ranges.some((r) => span.start < r.end && span.end > r.start);
}

/**
 * Mine one admitted turn's raw text. Deterministic: same text, same
 * mentions in the same order. Deduped within the turn at (family, key).
 */
export function mineTurnEntities(text: string): ReadonlyArray<MinedMention> {
  return scanTurn(text).mentions;
}

interface TurnScan {
  readonly mentions: MinedMention[];
  /** Secret-shaped candidates refused before any mention was produced. */
  readonly secretRefused: number;
}

function scanTurn(text: string): TurnScan {
  if (!text || text.trim().length === 0) return { mentions: [], secretRefused: 0 };
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line.length > MAX_MINING_SCAN_CHARS ? line.slice(0, MAX_MINING_SCAN_CHARS) : line,
    );
  const joined = lines.join("\n");

  const out: MinedMention[] = [];
  const seen = new Set<string>();
  let secretRefused = 0;
  const push = (family: SessionMiningFamily, raw: string): void => {
    if (isSecretShapedMention(family, raw)) {
      secretRefused++;
      return;
    }
    const key = miningKey(raw);
    if (key.length === 0) return;
    const dedupe = `${family}\u0000${key}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ family, key });
  };

  // Ranges claimed by an earlier family; later passes never re-read them.
  const claimed: Span[] = [];
  const offsetOf = (lineIndex: number, column: number): number =>
    lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0) + column;

  // 1. URLs - the fact-extract family, on every line.
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(URL_SPAN_RE.source, "giu");
    for (const m of lines[i]!.matchAll(re)) {
      const start = offsetOf(i, m.index ?? 0);
      const end = start + m[0]!.length;
      claimed.push({ start, end });
      push("url", m[0]!);
    }
  }

  // 2. Code regions - the symbol family. A code span whose whole content
  //    is identifier-shaped is one candidate; a fenced block is harvested
  //    token by token. A region holding no candidate is still claimed, so
  //    prose-in-backticks never leaks into the prose passes.
  for (const m of joined.matchAll(FENCED_BLOCK_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0]!.length };
    claimed.push(span);
    if (overlaps(span, claimed.slice(0, -1))) continue;
    for (const token of codeTokens(m[0]!.slice(3, -3))) {
      if (HAS_LETTER_RE.test(token) && hasCodeCue(token)) push("symbol", token);
    }
  }
  for (const m of joined.matchAll(INLINE_CODE_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0]!.length };
    claimed.push(span);
    if (overlaps(span, claimed.slice(0, -1))) continue;
    const content = m[1]!.trim();
    if (IDENTIFIER_SHAPE_RE.test(content) && HAS_LETTER_RE.test(content) && hasCodeCue(content)) {
      push("symbol", content);
    }
  }

  // 3. Prose runs - path and qualified-ident. Runs overlapping a URL or
  //    code region are skipped whole.
  for (const m of joined.matchAll(TECH_RUN_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0]!.length };
    if (overlaps(span, claimed)) continue;
    const run = m[0]!;
    // A path: a separator plus an extension on the last segment. Both
    // slash directions; trailing sentence dots are not part of the path.
    const pathCandidate = run.replace(/\.+$/u, "");
    const tail = pathCandidate.split(/[\\/]/u).pop() ?? "";
    if (/[\\/]/u.test(pathCandidate) && /\.[A-Za-z0-9]{1,12}$/u.test(tail)) {
      push("path", pathCandidate);
      continue;
    }
    // A qualified identifier: two or more segments joined by dots or a
    // double colon, with a structural cue beyond two plain words.
    const identCandidate = run.replace(/\.+$/u, "");
    if (QUALIFIED_IDENT_RE.test(identCandidate)) {
      const segments = identCandidate.split(/(?:\.|::)/u);
      const cued =
        segments.length >= 3 || segments.some((s) => /[_\d]/u.test(s) || hasInternalUppercase(s));
      if (cued) push("qualified-ident", identCandidate);
    }
  }

  return { mentions: out, secretRefused };
}

/** Internal uppercase: an uppercase whose preceding character is a lowercase letter. */
function hasInternalUppercase(segment: string): boolean {
  for (let i = 1; i < segment.length; i++) {
    const ch = segment[i]!;
    const prev = segment[i - 1]!;
    if (ch !== ch.toLowerCase() && prev === prev.toLowerCase()) return true;
  }
  return false;
}

// ----- Ledger write ----------------------------------------------------------

export interface MineTurnInput {
  readonly vault: string;
  /** Raw admitted turn text, BEFORE payload externalization. */
  readonly text: string;
  /** Portable session identity (transcript basename), never a host path. */
  readonly sessionRef: string;
  readonly turnId: string;
  /** The turn's own instant, used for the record stamp when valid. */
  readonly turnTimestamp?: string;
  readonly now: Date;
  /** Forecast only: nothing is written, counts land in `withheld`. */
  readonly dryRun?: boolean;
  /**
   * The importing run's dedupe set of {@link miningDedupeId} strings -
   * owned by the caller across turns and files, so one session folds to
   * one record per (family, key).
   */
  readonly seen: Set<string>;
}

export interface MinedTurnOutcome {
  /** Mentions written this turn (records appended). */
  readonly extracted: number;
  /** Mentions already folded for this (family, key, sessionRef). */
  readonly deduped: number;
  /** Mentions a dry run would have written. Always 0 on an applied run. */
  readonly withheld: number;
  /** Secret-shaped candidates refused before any write. */
  readonly secretRefused: number;
  /** 1 when the turn carried a private region and was withheld whole. */
  readonly privateWithheld: number;
}

const EMPTY_OUTCOME: MinedTurnOutcome = Object.freeze({
  extracted: 0,
  deduped: 0,
  withheld: 0,
  secretRefused: 0,
  privateWithheld: 0,
});

/**
 * Mine one turn and fold its mentions into the continuity ledger. A turn
 * whose text carries a `<private>` region is withheld WHOLE - a mention
 * is provenance, and provenance minted from private text must not exist.
 */
export function mineAndRecordTurn(vault: string, input: MineTurnInput): MinedTurnOutcome {
  if (privateRegionTexts(input.text).length > 0) {
    return Object.freeze({ ...EMPTY_OUTCOME, privateWithheld: 1 });
  }
  let extracted = 0;
  let deduped = 0;
  let withheld = 0;
  const scan = scanTurn(input.text);
  const secretRefused = scan.secretRefused;
  for (const mention of scan.mentions) {
    const id = miningDedupeId(mention.family, mention.key, input.sessionRef);
    if (input.seen.has(id)) {
      deduped++;
      continue;
    }
    if (input.dryRun === true) {
      input.seen.add(id);
      withheld++;
      continue;
    }
    try {
      appendContinuityRecord(vault, {
        kind: SESSION_ENTITY_MENTION_KIND,
        createdAt: mentionTimestamp(input.turnTimestamp, input.now),
        sourceRefs: [
          { id: `${input.sessionRef}:${input.turnId}:${mention.family}:${mention.key}` },
        ],
        payload: {
          family: mention.family,
          key: mention.key,
          session_ref: input.sessionRef,
          turn_id: input.turnId,
        },
      });
    } catch {
      // Telemetry-grade lane: one unwritable record never fails the
      // import; the mention re-folds on a later run.
      continue;
    }
    input.seen.add(id);
    extracted++;
  }
  return Object.freeze({ extracted, deduped, withheld, secretRefused, privateWithheld: 0 });
}

/**
 * ISO-second stamp for a mined mention: the turn's own time when valid
 * (so a re-import of the same transcript folds byte-identical records),
 * else the import wall clock.
 */
function mentionTimestamp(turnTimestamp: string | undefined, now: Date): string {
  if (turnTimestamp) {
    const ms = Date.parse(turnTimestamp);
    if (Number.isFinite(ms) && ms > 0 && ms <= now.getTime()) return isoSecond(new Date(ms));
  }
  return isoSecond(now);
}

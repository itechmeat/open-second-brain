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
 *                         directions, relativized against the home
 *                         directory before the key is minted (never a
 *                         host absolute path - the design's rule, which
 *                         also keeps host usernames out of the ledger,
 *                         the hallways artifact and promoted pages);
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
 * with `user:pass@host` userinfo, credential-named query OR FRAGMENT
 * parameters (`token=`/`key=` through `redactSpecifierCredentials`, plus
 * the sibling {@link CREDENTIAL_MENTION_QUERY_PARAMS} spellings), anything
 * the house token pass redacts (`redactRawOutput` with `redactTokens`:
 * vendor-prefixed / high-entropy / JWT-shaped tokens, wherever in the URL
 * they sit - a bot token in a path segment, a webhook id, a bearer in a
 * fragment), and the same token pass for every other family. A refused
 * candidate is counted, never silent. The URL refusal is WHOLE: the ledger
 * keeps the mention id verbatim in `sourceRefs[].id` - only the payload is
 * redacted at the store boundary - so a credential-bearing URL must never
 * be minted at all.
 *
 * The ledger write is one `session_entity_mention` continuity record per
 * (family, key, sessionRef), deduped within an import run through the
 * caller-owned `seen` set - SEEDED from the mention rows already on disk
 * on the run's first turn, so a re-imported transcript folds to dedupe
 * counters instead of appending duplicate rows. Rows are append-only; the
 * hallways pass folds duplicates out at the same granularity, so a
 * re-imported transcript folds to the same mention set either way - the
 * seed keeps the ledger itself from growing on every re-import.
 */

import { homedir } from "node:os";

import { privateRegionTexts, redactRawOutput, redactSpecifierCredentials } from "../../redactor.ts";
import { appendContinuityRecord, listContinuityRecords } from "../continuity/store.ts";
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

/**
 * The continuity record kind one mined mention is written as. Typed at the
 * append input's narrowed kind union (every appendable kind), so the kind
 * the miner writes stays assignable where the record is appended.
 */
export const SESSION_ENTITY_MENTION_KIND: Exclude<ContinuityRecordKind, "source_invalidation"> =
  "session_entity_mention";

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

/**
 * Upper bound on DISTINCT keys recorded per session. A hostile or
 * pathological transcript can carry tens of thousands of distinct
 * identifiers; unbounded minting grows the append-only ledger on every
 * re-import and turns the hallways pairwise fold into an O(k^2) sink. A
 * few hundred is far past any real session's vocabulary. Once a session
 * reaches the cap, further NEW keys are not minted - the turn's outcome
 * counts each in `capOverflow` (counted, never silent), while
 * already-seen keys keep deduping as usual. The count is per
 * (family, key) within one sessionRef, tracked across the importing
 * run's turns through the caller-owned dedupe set.
 */
export const MAX_MINED_KEYS_PER_SESSION = 512;

/**
 * Per-session distinct-key counts for caller-owned dedupe sets, keyed by
 * the set itself (one importing run owns one set; a new run brings a
 * fresh one, so nothing leaks across runs). A count is seeded by one
 * scan of the set and then maintained by THIS module's writes - a caller
 * that mutated the set behind the module's back would read a stale
 * count, and nothing in the tree does.
 */
const sessionKeyBudgets = new WeakMap<Set<string>, Map<string, number>>();

/** The budget map for one dedupe set, created on first use. */
function sessionBudgets(seen: Set<string>): Map<string, number> {
  let budgets = sessionKeyBudgets.get(seen);
  if (budgets === undefined) {
    budgets = new Map();
    sessionKeyBudgets.set(seen, budgets);
  }
  return budgets;
}

/**
 * Run-scoped seed marker: a dedupe set that has already read the ledger
 * once never reads it again, so the seeding cost is one fold per
 * importing run, not per session or per turn.
 */
const seededRuns = new WeakSet<Set<string>>();

/**
 * Seed a fresh run's dedupe set from the mention rows already on disk.
 * Without this, `minedSeen` starts empty on every run and every
 * re-imported transcript appended its full mention set again - up to the
 * per-session cap of duplicate rows each time, growing the ledger without
 * limit under repeated directory imports. The seed restores the
 * caller-owned set to the state the first run left it in: one id per
 * (family, key, sessionRef), and per-session budgets that count the rows
 * already written. Seeding is fail-open: a broken read leaves the run
 * acting like the first, and the appends surface their own failures
 * through `ledgerFailed` as usual.
 */
function seedSeenFromLedger(vault: string, seen: Set<string>, budgets: Map<string, number>): void {
  try {
    for (const record of listContinuityRecords(vault, { kind: SESSION_ENTITY_MENTION_KIND })) {
      if (record.private) continue;
      const family = record.payload["family"];
      const key = record.payload["key"];
      const sessionRef = record.payload["session_ref"];
      if (typeof family !== "string" || typeof key !== "string" || typeof sessionRef !== "string") {
        continue;
      }
      // A hand-planted row under a non-mined family is not a mention the
      // scan can re-reach; it consumes no dedupe id and no budget.
      if (!(SESSION_MINING_FAMILIES as readonly string[]).includes(family)) continue;
      const id = miningDedupeId(family as SessionMiningFamily, key, sessionRef);
      seen.add(id);
      budgets.set(sessionRef, (budgets.get(sessionRef) ?? 0) + 1);
    }
  } catch {
    // Fail-open: see the doc comment.
  }
}

/** Count a set's dedupe ids naming one sessionRef (the seed scan). */
function countSeenKeysForSession(seen: ReadonlySet<string>, sessionRef: string): number {
  const suffix = `\u0000${sessionRef}`;
  let count = 0;
  for (const id of seen) if (id.endsWith(suffix)) count++;
  return count;
}

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

/**
 * A host home prefix a transcript path can carry, spelled for the
 * platforms that matter: the POSIX `/home/<user>` and macOS `/Users/<user>`
 * conventions, and the Windows `C:\Users\<user>` drive-user form.
 */
const HOST_HOME_RE = /^(?:\/(?:home|Users)\/[^/\\]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/])/u;

/**
 * Replace a candidate path's host home prefix with `~` before the key is
 * minted: the design forbids host absolute paths in mined keys, and a
 * username inside one would reach `hallways.md` and promoted pages.
 * The caller's actual home directory counts first (it covers /root, /Users
 * under a matching env and every custom HOME); the textual conventions
 * above catch a home spelled for another user or another machine. A path
 * under no home - a project-relative one, or /usr/... - keeps its form.
 */
function homeRelativizedPath(candidate: string): string {
  const home = homedir();
  if (home.length > 1) {
    for (const sep of ["/", "\\"]) {
      const prefix = `${home}${sep}`;
      if (candidate.startsWith(prefix)) return `~${sep}${candidate.slice(prefix.length)}`;
    }
  }
  const textual = HOST_HOME_RE.exec(candidate);
  return textual === null ? candidate : `~${candidate.slice(textual[0].length)}`;
}

/**
 * The structural code cue an identifier must carry to be worth mining -
 * the SAME definition `hasStructuralCodeShape` applies at the entity
 * kernel: canonical.ts's `CODE_SHAPE_CHAR_RE` (`[_./\p{N}]` - underscore,
 * dot, slash, or a digit of ANY script) plus a camel hump, an uppercase
 * whose preceding character is a lowercase LETTER. Colons, dollars,
 * at-signs and backslashes carry no cue: a `$HOME` or `MCP::SERVER` would
 * fail the doctor's shouted-heading verdict, and minting a key the kernel's
 * own code-shape test rejects defeats the promotion bypass mining feeds.
 */
const CODE_CUE_CHAR_RE = /[_./\p{N}]/u;

function hasCodeCue(token: string): boolean {
  if (CODE_CUE_CHAR_RE.test(token)) return true;
  for (let i = 1; i < token.length; i++) {
    const ch = token[i]!;
    const prev = token[i - 1]!;
    if (ch !== ch.toLowerCase() && prev !== prev.toUpperCase()) return true;
  }
  return false;
}

/** Split a code region's content into identifier-shaped candidate tokens. */
function codeTokens(content: string): string[] {
  return content.split(/[^A-Za-z0-9_.$:/\\@-]+/u).filter((t) => t.length >= 2);
}

/**
 * Query parameter names whose value is a credential in a mined URL. The
 * redactor's exact-name pass ({@link CREDENTIAL_QUERY_KEYS} in the
 * redactor) covers the generic spellings - `token`, `key`, `secret`,
 * `password` - and the redaction-implies-refusal check below turns each
 * into a refusal. These are the SIBLING spellings an exact-name list
 * misses: `api_key`, `apikey`, `access_token`, `auth_token`,
 * `private_token`, `client_secret`, `refresh_token`, `sig`, and their
 * hyphenated / fused forms. Matched case-insensitively, name-anchored (a
 * `?`/`&`/`#` boundary then the name then `=`), so `settings/api_keys`
 * and `?api_key_version=2` stay legitimate URLs. A URL carrying one is
 * refused whole - never minted, never written, counted as refused.
 */
export const CREDENTIAL_MENTION_QUERY_PARAMS: ReadonlyArray<string> = Object.freeze([
  "api_key",
  "apikey",
  "api-key",
  "access_token",
  "accesstoken",
  "access-token",
  "auth_token",
  "authtoken",
  "auth-token",
  "client_secret",
  "clientsecret",
  "client-secret",
  "private_token",
  "privatetoken",
  "private-token",
  "refresh_token",
  "refreshtoken",
  "refresh-token",
  "sig",
]);

const CREDENTIAL_PARAM_BOUNDARY = "[?&#]";
const CREDENTIAL_QUERY_PARAM_RE = new RegExp(
  `${CREDENTIAL_PARAM_BOUNDARY}(?:${CREDENTIAL_MENTION_QUERY_PARAMS.join("|")})=`,
  "i",
);

/** Whether a candidate should be refused as secret-shaped (see module header). */
export function isSecretShapedMention(family: SessionMiningFamily, raw: string): boolean {
  if (family === "url") {
    if (redactSpecifierCredentials(raw) !== raw) return true;
    if (CREDENTIAL_QUERY_PARAM_RE.test(raw)) return true;
    // The house token pass is the catch-all: a vendor-prefixed,
    // high-entropy or JWT-shaped credential anywhere in the URL - a bot
    // token in a path segment, a webhook id, an implicit-flow bearer in
    // the fragment - redacts, and redaction implies refusal.
    return redactRawOutput(raw, { redactTokens: true }) !== raw;
  }
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
  // Prefix-sum offset table, built once per turn: line i starts at
  // `lineOffsets[i]` inside `joined`, so a match's absolute offset is one
  // lookup. The per-match reduction it replaces re-summed every preceding
  // line for every URL hit - O(lines) per match, quadratic per turn, on
  // the capture hot path. Same arithmetic, same answers.
  const lineOffsets: number[] = [];
  {
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = acc;
      acc += lines[i]!.length + 1;
    }
  }
  const offsetOf = (lineIndex: number, column: number): number => lineOffsets[lineIndex]! + column;

  // 1. URLs - the fact-extract family, on every line. The claimed spans
  //    are kept beside the generic claim set: the fence pass masks them
  //    out instead of surrendering the whole block (see below).
  const urlSpans: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(URL_SPAN_RE.source, "giu");
    for (const m of lines[i]!.matchAll(re)) {
      const start = offsetOf(i, m.index ?? 0);
      const end = start + m[0]!.length;
      const span = { start, end };
      claimed.push(span);
      urlSpans.push(span);
      push("url", m[0]!);
    }
  }

  // 2. Code regions - the symbol family. A code span whose whole content
  //    is identifier-shaped is one candidate; a fenced block is harvested
  //    token by token. A region holding no candidate is still claimed, so
  //    prose-in-backticks never leaks into the prose passes.
  //
  //    A URL inside a fence stays the URL pass's - claimed, minted or
  //    refused there - but it must not eat the block whole: the symbol
  //    tokens around it are still mined, from the fence text with every
  //    URL span masked out so a refused URL's own text cannot re-enter
  //    the ledger as a symbol key (a refusal must stay a refusal).
  for (const m of joined.matchAll(FENCED_BLOCK_RE)) {
    const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0]!.length };
    claimed.push(span);
    const inner = m[0]!.slice(3, -3);
    const innerStart = span.start + 3;
    const innerEnd = span.end - 3;
    let masked = "";
    let cursor = 0;
    for (const url of urlSpans) {
      if (url.end <= innerStart || url.start >= innerEnd) continue;
      const from = Math.max(url.start, innerStart) - innerStart;
      const to = Math.min(url.end, innerEnd) - innerStart;
      if (from > cursor) masked += `${inner.slice(cursor, from)} `;
      cursor = Math.max(cursor, to);
    }
    masked += inner.slice(cursor);
    for (const token of codeTokens(masked)) {
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
      push("path", homeRelativizedPath(pathCandidate));
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
  /**
   * Mentions whose ledger append THREW - the telemetry-grade tolerance
   * never fails the import for one unwritable record, but the never-silent
   * convention demands the failure be counted, not swallowed (the
   * `mined_ledger_failed` slot of the import report's `mined_*` family,
   * beside `mined_secret_refused`). A failed mention is left unseen, so it
   * re-folds on a later run.
   */
  readonly ledgerFailed: number;
  /**
   * Mentions dropped because the session already holds
   * {@link MAX_MINED_KEYS_PER_SESSION} distinct keys - the named,
   * counted signal that a run hit the per-session cap (the
   * `mined_cap_overflow` slot beside `mined_ledger_failed`). An overflow
   * mention is left unseen, so a later run re-considers it under a
   * raised cap rather than silently forgetting it.
   */
  readonly capOverflow: number;
}

const EMPTY_OUTCOME: MinedTurnOutcome = Object.freeze({
  extracted: 0,
  deduped: 0,
  withheld: 0,
  secretRefused: 0,
  privateWithheld: 0,
  ledgerFailed: 0,
  capOverflow: 0,
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
  let ledgerFailed = 0;
  let capOverflow = 0;
  const budgets = sessionBudgets(input.seen);
  if (!seededRuns.has(input.seen)) {
    seededRuns.add(input.seen);
    seedSeenFromLedger(input.vault, input.seen, budgets);
  }
  const cached = budgets.get(input.sessionRef);
  let budget = cached ?? countSeenKeysForSession(input.seen, input.sessionRef);
  budgets.set(input.sessionRef, budget);
  const scan = scanTurn(input.text);
  const secretRefused = scan.secretRefused;
  for (const mention of scan.mentions) {
    const id = miningDedupeId(mention.family, mention.key, input.sessionRef);
    if (input.seen.has(id)) {
      deduped++;
      continue;
    }
    if (budget >= MAX_MINED_KEYS_PER_SESSION) {
      // The session's ledger budget is spent: stop minting, say so by
      // count. The mention stays unseen, so a later run re-folds it.
      capOverflow++;
      continue;
    }
    if (input.dryRun === true) {
      input.seen.add(id);
      budget++;
      budgets.set(input.sessionRef, budget);
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
      // import; the mention re-folds on a later run. Counted, never
      // silent - and left unseen, so the retry below really re-folds.
      ledgerFailed++;
      continue;
    }
    input.seen.add(id);
    budget++;
    budgets.set(input.sessionRef, budget);
    extracted++;
  }
  return Object.freeze({
    extracted,
    deduped,
    withheld,
    secretRefused,
    ledgerFailed,
    capOverflow,
    privateWithheld: 0,
  });
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

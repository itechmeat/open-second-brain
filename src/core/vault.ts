/**
 * Vault operations: frontmatter parse/write, slugify, wikilink extraction,
 * Markdown page listing.
 *
 * Mirrors `src/open_second_brain/vault.py`. Designed dependency-free; the small
 * YAML-like emitter handles only the scalar/inline-array shapes that round-trip
 * through Obsidian and the simple parser.
 *
 * ## Frontmatter diagnostics (unit F)
 *
 * The frontmatter reader is a line scanner, not a YAML parser, so it cannot
 * fail — it drops what it does not understand, and the field simply never
 * reaches the parsed map. That is how commit 426d06f8 (block-style lists
 * dropped, producing spurious "missing field" errors in the doctor) stayed
 * invisible until a human noticed the symptom.
 *
 * {@link parseFrontmatterTextWithNotices} is the diagnostic-carrying sibling:
 * same map, same body, plus the notices. The rule for what counts as a
 * dropped line — and what is legitimately skipped content that must stay
 * silent — is stated on that function and is the authority for it.
 * {@link parseFrontmatter} and {@link parseFrontmatterText} delegate to the
 * siblings and discard the notices, so every call site not yet converted is
 * byte-identical.
 *
 * ### Why most readers keep the two-tuple form
 *
 * Two consequences follow from the parser being a scanner rather than a
 * YAML parser, and they are the reason the conversion is deliberately
 * partial:
 *
 *   1. `parseFrontmatter` CANNOT throw. It reads inside its own `try` and
 *      everything after that is string work. Every `catch { … }` wrapped
 *      around nothing but a `parseFrontmatter` call is therefore
 *      unreachable, and the arm that "handles" the failure has never run.
 *      Those arms are removed where the `try` guards nothing else; the
 *      control flow is provably identical because the branch was dead.
 *   2. A reader that returns a plain value - a list of recipes, a graph
 *      node, a ranked candidate set - has nowhere to put a notice.
 *      Widening its return type would create a channel with no consumer,
 *      which is the same silence in a new shape.
 *
 * The condition itself is not lost, because it is observable centrally:
 * {@link listVaultPages}'s opt-in sink feeds `o2b brain doctor`, which
 * sweeps the whole `Brain/` tree unconditionally, and the search indexer
 * reports per-file notices through `IndexStats.frontmatterNotices`. A
 * per-call channel at every reader would duplicate that, not add to it.
 */

import { STORE_VAULT_DIR } from "./store/constants.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { scopedRuleKey } from "./brain/scoped-rule-key.ts";
import { WIKILINK_TARGET_RE, isLiveWikilinkSpan, maskCodeRegions } from "./brain/wikilink.ts";
import {
  FileAlreadyExistsError,
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  isFileAlreadyExists,
} from "./fs-atomic.ts";
import { pathStem, stem } from "./fs-utils.ts";
import {
  DEGRADATION_CODE,
  type DegradationNotice,
  emitDegradationNotice,
} from "./integrity/degradation.ts";
import { vaultRelative } from "./path-safety.ts";
import { type TransportReach } from "./graph/transport-reach.ts";
import { remoteDenyVisibilityTokens } from "./graph/privacy-markers.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN, isRemotelyReadable } from "./graph/visibility.ts";
import type { FrontmatterMap, FrontmatterValue, VaultPage } from "./types.ts";

/**
 * A leading frontmatter block, its body captured. The opening fence takes
 * horizontal whitespace only before its line end: with `\s*` there, a run
 * of blank lines after an unclosed `---` was re-scanned to the end of the
 * text once per blank line, quadratic in its length. Blank lines after the
 * fence still open the block; they are the first lines of its body.
 */
export const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---\s*\n?/;
/** U+FEFF, which may precede a page's opening fence. */
const BYTE_ORDER_MARK = 0xfeff;
/**
 * The key grammar, written once and used by BOTH directions.
 *
 * The scanner has only ever recognised this shape, so it is also the
 * only shape the emitter may write: a key outside it is a key the
 * emitter would put on disk and the parser would then drop or, worse,
 * read as something else. Deriving `KEY_VALUE_RE` from the same source
 * is what makes "round-trips" a fact rather than a claim two regexes
 * happen to agree on.
 */
const FRONTMATTER_KEY_PATTERN = "[a-zA-Z_][a-zA-Z0-9_-]*";
const FRONTMATTER_KEY_RE = new RegExp(`^${FRONTMATTER_KEY_PATTERN}$`);
const KEY_VALUE_RE = new RegExp(`^(${FRONTMATTER_KEY_PATTERN})\\s*:\\s*(.*?)\\s*$`);
// Block-sequence dash item: `- item` or a bare `-` (empty item). The
// leading whitespace is required so `-foo` (a dash-prefixed string, not a
// list item) is NOT matched. Captures the item text after the whitespace.
const DASH_ITEM_RE = /^-(?:\s+(.*))?$/;
const PLAIN_SCALAR_RE = /^[A-Za-z0-9_./-](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$/;
const SLUG_INVALID_RE = /[^a-z0-9]+/g;

/**
 * Hard cap on one slug, enforced by {@link slugify} by truncating from the
 * START of the string. Exported so slug-deriving callers can budget a tail
 * (a collision suffix, a per-record id) to sit INSIDE the cap instead of
 * after it, where truncation would silently drop it.
 */
export const SLUG_MAX_LEN = 64;

const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".tiff",
  ".avif",
  ".mp4",
  ".webm",
  ".ogv",
  ".mov",
  ".mkv",
  ".avi",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".pdf",
]);

// The brain store's reserved folder (`STORE_VAULT_DIR`) holds machine
// records, never notes: no note walk, wikilink resolution or page list
// enters it.
const DEFAULT_SKIP_DIRS = [".git", ".obsidian", ".trash", ".stversions", STORE_VAULT_DIR] as const;
const DEFAULT_SKIP_FILES = ["index.md", "log.md"] as const;

/**
 * Parse YAML-like frontmatter from a Markdown file. Returns `[metadata, body]`.
 * Only simple `key: value` lines are recognized — values are returned as strings,
 * with surrounding quotes stripped. Inline arrays `[a, b]` are parsed into arrays
 * of strings. Lines that don't match are silently skipped.
 *
 * Delegates to {@link parseFrontmatterWithNotices} and DISCARDS its
 * diagnostics, so this signature and its output stay exactly as they were.
 * Prefer the `WithNotices` sibling at any call site that has a report to
 * carry the trace.
 */
export function parseFrontmatter(path: string): readonly [FrontmatterMap, string] {
  const [metadata, body] = parseFrontmatterWithNotices(path);
  return [metadata, body];
}

/**
 * Same parse as {@link parseFrontmatter} but over an in-memory string,
 * so a caller that already holds the file content (e.g. the search
 * indexer) does not pay a second `readFileSync`.
 *
 * Delegates to {@link parseFrontmatterTextWithNotices} and discards its
 * diagnostics — see {@link parseFrontmatter}.
 */
export function parseFrontmatterText(text: string): readonly [FrontmatterMap, string] {
  const [metadata, body] = parseFrontmatterTextWithNotices(text);
  return [metadata, body];
}

/** Site recorded on a notice when the caller names none. */
const FRONTMATTER_SITE = "vault.parseFrontmatter";

/**
 * Longest run of a dropped source line reproduced in a notice `detail`.
 * A notice renders as ONE line in doctor / index output, so an unbounded
 * frontmatter line (a pasted blob, a minified payload) must not be able
 * to dominate a report.
 */
const NOTICE_LINE_MAX = 120;
const NOTICE_LINE_ELLIPSIS = "…";

/** Attribution for the notices a frontmatter parse emits. */
export interface FrontmatterNoticeOptions {
  /**
   * The subsystem to record as the notice `site`. Defaults to the parser
   * itself; a converted call site passes its own name so a reader can
   * tell WHICH walker hit the condition.
   */
  readonly site?: string;
  /**
   * The file the text came from, when the caller knows it. The path form
   * ({@link parseFrontmatterWithNotices}) supplies this itself.
   */
  readonly path?: string;
}

/** `[metadata, body, notices]` — the diagnostic-carrying parse result. */
export type FrontmatterParseWithNotices = readonly [
  FrontmatterMap,
  string,
  ReadonlyArray<DegradationNotice>,
];

/**
 * {@link parseFrontmatter} plus the diagnostics it would otherwise drop.
 *
 * An unreadable file yields one `frontmatter-unreadable` notice naming
 * the path, and the same `[{}, ""]` result the two-tuple form has always
 * returned — the read failure is reported, never raised.
 */
export function parseFrontmatterWithNotices(
  path: string,
  opts: FrontmatterNoticeOptions = {},
): FrontmatterParseWithNotices {
  const site = opts.site ?? FRONTMATTER_SITE;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const notices: DegradationNotice[] = [];
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.frontmatterUnreadable,
      site,
      path,
      detail: `frontmatter read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return [{}, "", notices];
  }
  return parseFrontmatterTextWithNotices(text, { site, path });
}

/**
 * {@link parseFrontmatterText} plus the diagnostics it would otherwise
 * drop. The map and body are byte-identical to the two-tuple form; the
 * third element is the new trace.
 *
 * ## What counts as a DROPPED line
 *
 * The scanner is line-based, not a YAML parser, so "unsupported grammar"
 * has to be defined structurally. A line inside the `---` block is
 * CONSUMED when it is one of:
 *
 *   - a `key: value` pair (`KEY_VALUE_RE`), including the empty-value
 *     form that opens a block sequence or records a null scalar;
 *   - a dash item (`DASH_ITEM_RE`) while a block sequence is open.
 *
 * It is legitimately SKIPPED, with no notice, when it is:
 *
 *   - blank, or whitespace-only — structural separation the format
 *     expects, and a notice per blank line would be noise, not signal;
 *   - a `#` comment — content the format explicitly discards.
 *
 * Everything else is a DROP and emits exactly one
 * `frontmatter-line-dropped` notice carrying the 1-based line number
 * within the block and the offending text. That covers the two shapes
 * seen in the field: grammar the scanner has no branch for (a folded or
 * literal block scalar, an indented nested mapping, a `-foo` string that
 * is not a list item) and a dash item with no open key to land in.
 *
 * Emitting a notice never changes the parse. A dropped line is still
 * dropped, exactly as before; only the trace is new.
 */
export function parseFrontmatterTextWithNotices(
  raw: string,
  opts: FrontmatterNoticeOptions = {},
): FrontmatterParseWithNotices {
  const notices: DegradationNotice[] = [];
  const site = opts.site ?? FRONTMATTER_SITE;
  // A byte-order mark before the opening fence (a spreadsheet export, an
  // editor's UTF-8 setting) must not hide the block: a hidden block is a
  // hidden `visibility`, and the page would read as open.
  const text = raw.charCodeAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return [{}, text.trim(), notices];
  }

  const fmBlock = match[1]!;
  const body = text.slice(match[0].length).trim();
  const metadata: FrontmatterMap = {};

  // Block-sequence state: when a key is opened with an empty value
  // (`key:`) and the following lines are dash items (`- a`), we assemble
  // them into an array. This mirrors standard YAML block lists, which is
  // what Obsidian's Properties editor and several writers emit — the
  // original inline-array-only parser silently dropped such lists and
  // surfaced spurious "missing field" errors in `o2b brain doctor`.
  const lines = fmBlock.split("\n");
  let blockKey: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;

    const dash = DASH_ITEM_RE.exec(line);
    if (dash && blockKey !== null) {
      const arr = (metadata[blockKey] as string[] | undefined) ?? [];
      arr.push(stripQuotes(dash[1] ?? ""));
      metadata[blockKey] = arr;
      continue;
    }

    // Any non-dash line terminates an open block sequence.
    blockKey = null;

    const kv = KEY_VALUE_RE.exec(line);
    if (!kv) {
      emitDegradationNotice(notices, {
        code: DEGRADATION_CODE.frontmatterLineDropped,
        site,
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        detail: `frontmatter line ${i + 1} is not a supported key/value or list item: ${clipNoticeLine(line)}`,
      });
      continue;
    }
    const key = kv[1]!;
    let value = kv[2]!.trim();

    if (value === "") {
      // Empty value. Peek at the next meaningful line: if it is a dash
      // item this is a block-sequence header, otherwise keep the original
      // empty-string behaviour so a genuine null scalar round-trips.
      let j = i + 1;
      let nextMeaningful: string | null = null;
      while (j < lines.length) {
        const cand = lines[j]!.trim();
        if (!cand || cand.startsWith("#")) {
          j++;
          continue;
        }
        nextMeaningful = cand;
        break;
      }
      if (nextMeaningful !== null && DASH_ITEM_RE.test(nextMeaningful)) {
        metadata[key] = [];
        blockKey = key;
      } else {
        metadata[key] = "";
      }
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      metadata[key] = inner ? splitInlineArray(inner) : [];
      continue;
    }
    metadata[key] = stripQuotes(value);
  }

  return [metadata, body, notices];
}

/** Bound one source line to {@link NOTICE_LINE_MAX} for a one-line notice. */
function clipNoticeLine(line: string): string {
  return line.length <= NOTICE_LINE_MAX
    ? line
    : line.slice(0, NOTICE_LINE_MAX) + NOTICE_LINE_ELLIPSIS;
}

/**
 * Whether `key` is a frontmatter key this format can round-trip: one the
 * emitter may write and the scanner will read back as the same key.
 *
 * Exported so a boundary that wants to reject a bad key as the CALLER's
 * fault, naming the argument, can ask the same question the emitter asks
 * rather than restating the grammar.
 */
export function isFrontmatterKey(key: string): boolean {
  return FRONTMATTER_KEY_RE.test(key);
}

/** A frontmatter key this emitter will not write. See {@link formatFrontmatter}. */
export class FrontmatterKeyError extends Error {
  /** The offending key, verbatim, so a caller can point at which one. */
  readonly key: string;
  constructor(key: string) {
    super(
      `frontmatter key ${JSON.stringify(key)} is not a key this format can round-trip; ` +
        "keys are a letter or underscore followed by letters, digits, '_' or '-'",
    );
    this.name = "FrontmatterKeyError";
    this.key = key;
  }
}

/**
 * Render a Markdown file with YAML-like frontmatter to a string. Pure
 * function — exposed so callers can decide *how* to persist (atomic,
 * exclusive, plain) without duplicating the YAML formatter.
 *
 * ## Keys are checked, not escaped
 *
 * The value side was already sound: {@link formatYamlScalar} quotes and
 * escapes any scalar that would break the scanner, so no VALUE has ever
 * been able to add a line to the block. Keys were emitted raw, which
 * made the same guarantee false in the other direction — a key
 * containing a newline emitted extra frontmatter lines, and because the
 * scanner is last-wins and `update_note` merges `{...existing,
 * ...caller}`, a caller could overwrite a key it was never asked to
 * touch. That reach was bounded by the `Brain/` machinery-root refusal,
 * so it was latent rather than live; it is fixed here, at the emitter,
 * so every writer in the tree inherits the guarantee rather than each
 * entry point having to remember it.
 *
 * Escaping is not the fix, because the reader has no quoted-key form to
 * escape INTO: a quoted key would fail `KEY_VALUE_RE` and be dropped on
 * the next parse, which trades an injection for a silent loss. So a key
 * outside the grammar is a typed {@link FrontmatterKeyError}, raised
 * before a single byte is rendered.
 */
export function formatFrontmatter(metadata: FrontmatterMap, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    if (!isFrontmatterKey(key)) throw new FrontmatterKeyError(key);
    lines.push(`${key}: ${formatYamlValue(value)}`);
  }
  lines.push("---");
  if (body) {
    lines.push("");
    lines.push(body);
  }
  return lines.join("\n") + "\n";
}

/**
 * Write a Markdown file with YAML-like frontmatter. Lists are serialized as
 * inline arrays. Scalars that would break the simple parser are quoted and
 * standard control chars are escaped.
 *
 * This variant is non-atomic — used for non-critical writes where a torn
 * file on crash is acceptable (the regenerated `index.md` would just be
 * rebuilt next run; the bootstrap files are templates that can be
 * re-emitted). For writes that must survive concurrent agents and
 * crashes, use `writeFrontmatterAtomic` instead.
 */
export function writeFrontmatter(path: string, metadata: FrontmatterMap, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatFrontmatter(metadata, body), "utf8");
}

export interface WriteFrontmatterAtomicOptions {
  /**
   * When `true`, overwrite an existing target atomically (`rename(2)`).
   * When `false` (default), fail with an `EEXIST`-shaped Error if the
   * target already exists, atomically (`link(2)` semantics).
   */
  readonly overwrite?: boolean;
  /**
   * Optional human-readable label for the artifact kind (e.g. `"receipt"`,
   * `"asset"`, `"pending request"`). When the underlying write hits
   * `EEXIST` and `overwrite` is false, the resulting error message becomes
   * `"<kind> already exists: <path>"` instead of the generic wording.
   * The label affects only the message and the error's `kind` field —
   * callers that don't supply it get the same
   * {@link FileAlreadyExistsError} with the same `EEXIST` code.
   */
  readonly existsErrorKind?: string;
  /** Vault root used to render the relative path in the EEXIST message. */
  readonly vaultForRelativePath?: string;
}

/**
 * Atomic frontmatter writer with optional exclusive-create semantics.
 *
 * Used by the Brain writers where:
 *   - the file must not be torn on crash → atomic rename/link;
 *   - "refuse to overwrite" must be race-free across concurrent processes
 *     (CLI + MCP server, multiple agents) → exclusive `link(2)` instead
 *     of the TOCTOU-prone `existsSync` + `writeFileSync` pair.
 *
 * Returns whether bytes were written. The overwrite branch skips a
 * byte-identical target: the rename pipeline lands a fresh inode on every
 * call, so a re-render that produced the exact bytes already on disk used
 * to bump the file's mtime anyway, and every mtime consumer downstream
 * (recency ranking, validity windows, vault-delta counts) read that
 * phantom bump as a change. Callers that ignore the return keep working
 * unchanged; the exclusive-create branch always writes or throws, so it
 * reports `true` and gains no compare step - a target that exists is a
 * refusal, never a skip.
 *
 * On a collision the function always throws a {@link FileAlreadyExistsError}
 * carrying `code === "EEXIST"`, the absolute path, and the `kind` when one
 * was supplied. Only the message differs between the two call shapes:
 * `"<kind> already exists: <vault-relative path>"` with a kind, the leaf's
 * generic wording without one.
 *
 * It re-wraps rather than re-throwing the leaf's error because the message
 * has to change (the kind, and a vault-relative path instead of an absolute
 * one that would leak the operator's home directory into CLI output and MCP
 * envelopes). The rejected alternative — the plain
 * `new Error(msg, { cause })` this used to throw — dropped `.code` on the
 * way out, leaving the errno reachable only through `.cause`; a caller that
 * wanted to retry a lost race then had nothing to key on but the message
 * string. Wrapping in the same class keeps the wording AND the type, and
 * `isFileAlreadyExists` recognises both shapes without a cause walk at the
 * call site.
 */
export function writeFrontmatterAtomic(
  path: string,
  metadata: FrontmatterMap,
  body: string,
  opts: WriteFrontmatterAtomicOptions = {},
): boolean {
  const contents = formatFrontmatter(metadata, body);
  if (opts.overwrite) {
    return atomicWriteFileSync(path, contents, { skipIfUnchanged: true });
  }
  try {
    atomicCreateFileSyncExclusive(path, contents);
    return true;
  } catch (err) {
    if (opts.existsErrorKind && isFileAlreadyExists(err)) {
      // `vaultRelative` rather than a hand-rolled `startsWith(vault + "/")`
      // slice: the same rendering the rest of the tree uses, so a message
      // here and a message from any other reporting surface name the page
      // the same way, including on the Windows-separator input the manual
      // slice silently failed to strip.
      const rel = opts.vaultForRelativePath ? vaultRelative(path, opts.vaultForRelativePath) : path;
      throw new FileAlreadyExistsError(path, {
        kind: opts.existsErrorKind,
        displayPath: rel,
        cause: err,
      });
    }
    throw err;
  }
}

const SLUG_FALLBACK_PREFIX = "unnamed";
const SLUG_FALLBACK_HASH_LEN = 8;

/**
 * Stable safe basename for a title that slugifies to nothing — empty,
 * whitespace-only, or punctuation / emoji / combining-mark-only input.
 *
 * A bare shared constant (the old `"note"`) is stable but collides: every
 * punctuation-only title lands on the same basename, so `@`, `!!!`, and an
 * emoji all fight for one filename in a synced vault. Instead we suffix a
 * short sha256 digest of the normalized input, which is
 *   - deterministic — the same empty-slug title yields the same basename on
 *     every device and under a re-slug, and
 *   - distinct — different empty-slug titles get different basenames.
 *
 * The suffix is hex (`[a-f0-9]`), so the result stays traversal-safe and is
 * idempotent under a second `slugify` pass.
 */
function unnamedFallbackSlug(normalized: string): string {
  return `${SLUG_FALLBACK_PREFIX}-${slugDigest(normalized)}`;
}

/** The short sha256 hex digest the fallback and device-name slugs carry. */
function slugDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, SLUG_FALLBACK_HASH_LEN);
}

/**
 * Convert a free-form title to a URL-safe slug. Lowercase, alphanumeric
 * runs joined by `-`, trimmed to 64 chars. Inputs that slugify to nothing
 * (empty, whitespace-only, punctuation / emoji / combining-mark-only) fall
 * back to a stable `unnamed-<hash>` basename — see `unnamedFallbackSlug`.
 */
export function slugify(value: string): string {
  const lowered = value.trim().toLowerCase();
  let slug = lowered.replace(SLUG_INVALID_RE, "-").replace(/^-+|-+$/g, "");
  if (!slug) return unnamedFallbackSlug(lowered);
  slug = slug.slice(0, SLUG_MAX_LEN).replace(/-+$/, "");
  // Defensive only: SLUG_MAX_LEN (64) > 0 and the leading-trim above
  // guarantees a non-empty alnum-started slug here, so slicing cannot
  // produce "". Kept so a future SLUG_MAX_LEN or generation change cannot
  // silently produce an empty slug.
  return slug || unnamedFallbackSlug(lowered);
}

/**
 * Slug for a human title that names a record in a synced vault (a
 * decision, an open question, an obligation): letters, combining marks and
 * digits of ANY script stay, through the same key rule the project keys use
 * ({@link scopedRuleKey}: NFC, lowercase, NFC again, every other run one
 * `-`, at most {@link SLUG_MAX_LEN} code units, never half of a surrogate
 * pair). `slugify` keeps only `a-z0-9`, so "Тема-три release" and
 * "Проект release" both became `release` and the second record was refused
 * as a duplicate, and a title with no Latin letter had no words at all.
 *
 * For an ASCII title the result is byte-identical to {@link slugify}, so
 * every slug already on disk for such a title is unchanged, except a title
 * that keys to a Windows device name (below); a title with no letter or
 * digit (combining marks alone included) falls back to the same
 * `unnamed-<hash>` slugify gives it. The output holds no path separator,
 * dot, space or Windows-forbidden character, is never a Windows device
 * name, is NFC (one key on macOS, Windows and Linux whatever form the
 * title came in), and is idempotent, so a slug passed back in as a lookup
 * key resolves to itself.
 */
export function titleSlug(value: string): string {
  const key = titleKeySlug(value);
  return WINDOWS_DEVICE_KEY_RE.test(key) ? `${key}-${slugDigest(key)}` : key;
}

/**
 * {@link titleSlug} without the Windows device-name suffix, for a slug
 * that only ever sits inside a longer name: a prefixed and suffixed file
 * stem (`src-<slug>-<hash>`, `design-<date>-<slug>`, `adr-<sha>-<slug>`),
 * an entity id, a tag segment, a grouping key. Such a name is never a bare
 * device name, so `CON` keeps the stem `con` it always had, and for every
 * ASCII value the result is byte-identical to {@link slugify}.
 */
export function titleKeySlug(value: string): string {
  const key = scopedRuleKey(value);
  if (key === null || !TITLE_KEY_WORD_RE.test(key)) {
    return unnamedFallbackSlug(value.trim().toLowerCase());
  }
  return key;
}

/**
 * True when `value` holds a letter or digit of any script, so its slug is
 * made of its own words; false when the slug would be the hashed
 * `unnamed-<hash>` fallback. Asked of the value itself, never of the slug,
 * so a literal title such as `unnamed-deadbeef` is a title with words.
 */
export function hasTitleWords(value: string): boolean {
  const key = scopedRuleKey(value);
  return key !== null && TITLE_KEY_WORD_RE.test(key);
}

/**
 * The form two titles are compared in when a title names a record: the
 * whitespace runs collapsed and trimmed (the pledge identity's own title
 * normalisation) and NFC, so a title typed in NFD on macOS is the stored
 * NFC title. Nothing else folds: case and punctuation stay, so "Ship the
 * parser to Ada" and "Ship the parser, to Ada" are two titles even though
 * their slugs key alike.
 */
export function titleIdentity(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().normalize("NFC");
}

/**
 * The slug of the page a lookup by `value` names, for a lane whose pages
 * were once written under {@link slugify} and are never renamed: an older
 * release dropped a title's non-Latin words ("Проект release" was
 * `release`), gave a title with no Latin letter `unnamed-<hash>`, and kept
 * a bare Windows device name (`nul`). The {@link titleSlug} page is taken
 * when it is this record: one of its stored titles matches `value` under
 * `sameRecord` (by default, keys like it). Otherwise an old-slug page is
 * taken when it exists and is this record (`value` is that stored slug
 * itself, a listed slug passed back, or a stored title matches): the
 * value's own old slug, or the old slug of its new slug, where a record
 * whose new slug `value` takes was filed. So a different title that once
 * shared the old slug ("Тема release") does not reach the page, and a page
 * at the new slug that holds another record does not hide this one. When
 * nothing matches the answer is the `titleSlug`, which a new record is
 * written under (and which a writer refuses while a page holds it).
 *
 * `storedTitles` answers the titles the page at a slug holds, or null when
 * there is no page there.
 */
export function resolveTitleSlug(
  value: string,
  storedTitles: (slug: string) => readonly string[] | null,
  sameRecord: (stored: string, value: string) => boolean = (stored) =>
    titleSlug(stored) === titleSlug(value),
): string {
  const slug = titleSlug(value);
  // The old slug of every form the value can have been typed in.
  const legacies = legacySlugsOf(value.trim(), slug);
  // An ASCII value (a device name aside) has one slug under both rules:
  // the answer is the old helper's, and nothing is read for it.
  if (legacies.length === 0) return slug;
  const atSlug = storedTitles(slug);
  if (atSlug !== null && atSlug.some((t) => sameRecord(t, value))) return slug;
  // The old slug of the value, then the old slug of the value's new slug:
  // a record an older release filed under `slugify(S)` whose own new slug
  // is `S` ("远程办公" at `unnamed-<hash of 远程办公>`) is the record a
  // keying-alike "远程办公!" meets, though the old hash of that value
  // differs.
  for (const candidate of new Set([...legacies, slugify(slug)])) {
    if (candidate === slug) continue;
    const titles = storedTitles(candidate);
    if (titles === null) continue;
    if (value.trim() === candidate || titles.some((t) => sameRecord(t, value))) return candidate;
  }
  return slug;
}

/** How {@link locateTitledPage} reads the pages one lane holds. */
export interface TitledPageLookup<T> {
  /**
   * The page at `slug`, or null when there is none, when the caller's
   * reach withholds it, or when `slug` cannot name a page of this lane (a
   * bare device name a validated lane refuses). Asked before anything of
   * the page is parsed, so a withheld page is never read.
   */
  readonly read: (slug: string) => T | null;
  /** The title (statement) the page stores. */
  readonly titleOf: (page: T) => string;
  /**
   * Further stems that may hold the title, given the base slugs it keys
   * to (an identity-suffixed `<base>-<hex>` page). Asked only after the
   * bases missed.
   */
  readonly more?: (bases: readonly string[]) => Iterable<string>;
  /**
   * True for a slug this lane issues beyond the fixed points of
   * {@link titleSlug} and {@link slugify}: an identity-suffixed
   * `<base>-<hex>` stem, which is longer than {@link SLUG_MAX_LEN} when
   * its base is at the cap and so is no fixed point of either rule.
   */
  readonly issued?: (value: string) => boolean;
  /**
   * The stem of every page the lane holds, names only (`read` still
   * applies the caller's reach). With it, the slug a title keys to reaches
   * the record an older release filed under a hashed old slug, which no
   * value but the original title derives ({@link locateTitledPage}).
   */
  readonly stems?: () => Iterable<string>;
}

/** Where a lookup by a title or a listed slug landed. */
export interface TitledPageLocation<T> {
  /** The page's slug, or the {@link titleSlug} a refusal names when none matched. */
  readonly slug: string;
  readonly page: T | null;
}

/** The hex digits of the identity suffix (`<base>-<hex>`) a lane appends when its base slot is held. */
export const IDENTITY_SUFFIX_HEX_LENGTH = 6;

/**
 * True for an identity-suffixed stem `<base>-<6 hex>` whose base is a slug
 * either rule issues ({@link isTitleSlug}). At the slug cap such a stem is
 * longer than any slug a title keys to, so it is no fixed point of
 * {@link titleSlug} and is recognised by its shape.
 */
export function isIdentitySuffixedStem(value: string): boolean {
  const cut = value.length - IDENTITY_SUFFIX_HEX_LENGTH - 1;
  return (
    cut > 0 &&
    value[cut] === "-" &&
    /^[0-9a-f]+$/u.test(value.slice(cut + 1)) &&
    isTitleSlug(value.slice(0, cut))
  );
}

/** The identity-suffixed stems among `stems` whose base is one of `bases`, in the order given. */
export function identitySuffixedStemsOf(
  stems: Iterable<string>,
  bases: readonly string[],
): string[] {
  const out: string[] = [];
  for (const name of stems) {
    const cut = name.length - IDENTITY_SUFFIX_HEX_LENGTH - 1;
    if (cut <= 0 || name[cut] !== "-" || !/^[0-9a-f]+$/u.test(name.slice(cut + 1))) continue;
    if (bases.includes(name.slice(0, cut))) out.push(name);
  }
  return out;
}

/**
 * True when `value` is a slug a titled lane issues verbatim: a fixed point
 * of {@link titleSlug} or of the older {@link slugify} (every slug either
 * rule ever wrote, the capped, hashed and device-suffixed ones included).
 */
export function isTitleSlug(value: string): boolean {
  const normalized = value.normalize("NFC");
  return titleSlug(normalized) === normalized || slugify(normalized) === normalized;
}

/**
 * The page a caller's title or listed slug names, for a lane whose pages
 * were once written under {@link slugify} and are never renamed, and where
 * a title is matched as the record's identity, not merely by its slug.
 *
 * A title names only a page whose stored title has the same
 * {@link titleIdentity}: at its {@link titleSlug}, at the Latin-only slug
 * an older release gave it, or at a stem `more` adds (the identity-suffixed
 * page a title takes when its base slug was held). A value that is itself
 * a slug the lane issues ({@link isTitleSlug}, or `issued`) also names the
 * page stored at it, whatever title that page holds, unless a page at the
 * value's own slugs stores the value as its exact title: the title wins,
 * so a statement never selects a page that stores another statement. The
 * writers refuse to mint a record that would make the two meanings part
 * ({@link claimedTitleSlot}), so for records they wrote both hold.
 *
 * When nothing matches the answer is the `titleSlug` (the value itself
 * for an `issued` stem) with no page, which depends only on the value,
 * never on what `read` withheld. An absent slug both rules give alike
 * (every ASCII one) reads nothing more.
 */
export function locateTitledPage<T>(
  value: string,
  lookup: TitledPageLookup<T>,
): TitledPageLocation<T> {
  return locate(value, lookup, true);
}

/**
 * The page that stores exactly `value` as its title (a
 * {@link locateTitledPage} lookup that never answers a page by its slug
 * alone), or null.
 */
export function findTitledPage<T>(
  value: string,
  lookup: TitledPageLookup<T>,
): TitledPageLocation<T> | null {
  const located = locate(value, lookup, false);
  return located.page !== null ? located : null;
}

/**
 * The slug that makes writing a new record titled `value` ambiguous, or
 * null when its {@link titleSlug} may be written (the lane still refuses a
 * slot a page already occupies). Two cases:
 *
 * 1. `value` is itself a slug the lane issues and the page at it stores
 *    another title: a record titled `value` would make that listed slug
 *    name two records.
 * 2. A record whose exact title is `value`'s new slug `S` exists away from
 *    `S` (at the Latin-only slug an older release gave it, or at an
 *    identity-suffixed stem): `S` is that record's own new slug, and a
 *    record written there would answer a lookup by `S` while the title `S`
 *    names the other one.
 *
 * Asked through `read`, so a page the caller's reach withholds is not
 * there for it.
 */
export function claimedTitleSlot<T>(value: string, lookup: TitledPageLookup<T>): string | null {
  const trimmed = value.trim();
  const wanted = titleIdentity(trimmed);
  if (isIssued(trimmed, lookup)) {
    const page = lookup.read(trimmed);
    if (page !== null && titleIdentity(lookup.titleOf(page)) !== wanted) return trimmed;
  }
  const slot = titleSlug(trimmed);
  if (slot !== wanted && findTitledPage(slot, lookup) !== null) return slot;
  return null;
}

function isIssued<T>(value: string, lookup: TitledPageLookup<T>): boolean {
  return isTitleSlug(value) || (lookup.issued?.(value) ?? false);
}

function locate<T>(
  value: string,
  lookup: TitledPageLookup<T>,
  bySlug: boolean,
): TitledPageLocation<T> {
  const trimmed = value.trim();
  const slug = titleSlug(trimmed);
  const legacies = legacySlugsOf(trimmed, slug);
  const wanted = titleIdentity(trimmed);
  const seen = new Map<string, T | null>();
  const at = (candidate: string): T | null => {
    if (!seen.has(candidate)) seen.set(candidate, lookup.read(candidate));
    return seen.get(candidate) ?? null;
  };
  const holds = (page: T | null): page is T =>
    page !== null && titleIdentity(lookup.titleOf(page)) === wanted;
  // A slug spelled in NFD is the same slug: a macOS restore wrote the
  // record's file in NFD, and `list` gives that name back.
  const fixedPoint =
    slug === trimmed || slug === trimmed.normalize("NFC") || legacies.includes(trimmed);
  const issued = fixedPoint || (lookup.issued?.(trimmed) ?? false);
  const miss = { slug: fixedPoint || !issued ? slug : trimmed, page: null };
  let listed: T | null = null;
  let listedSlug = trimmed;
  if (issued) {
    listed = at(trimmed);
    // The same slug in the other Unicode form: a macOS restore writes a
    // record's file in NFD, so the slug the record was issued under (NFC)
    // and the one `list` now prints (NFD) both name it.
    for (const form of [trimmed.normalize("NFD"), trimmed.normalize("NFC")]) {
      if (listed !== null || form === trimmed) continue;
      listed = at(form);
      if (listed !== null) listedSlug = form;
    }
    if (holds(listed)) return { slug: listedSlug, page: listed };
    // An absent slug both rules give alike (every ASCII one) reads nothing
    // more: the old helper's answer, unless the lane files a title at more
    // stems than its slugs (an identity-suffixed pledge, whose base may
    // have been removed). A title that is its own `titleSlug` (a CJK
    // title) may still sit under its old slug, so it goes on.
    if (listed === null && legacies.length === 0 && lookup.more === undefined) return miss;
  }
  // The old slug of every Unicode form of the value: a title stored as
  // "Café plan" was filed at `caf-plan`, and the same title typed with a
  // decomposed "é" gives `cafe-plan`.
  // The new slug in NFD too: a record whose file a macOS restore renamed
  // to NFD (and a vault synced from that Mac carries) sits there on a
  // filesystem that keeps the two forms apart.
  const nfd = slug.normalize("NFD");
  const bases = nfd === slug ? [slug, ...legacies] : [slug, nfd, ...legacies];
  for (const candidate of bases) {
    const page = at(candidate);
    if (holds(page)) return { slug: candidate, page };
  }
  // Every stem the title may be filed at is asked before the listed slug
  // answers a page that stores another title: the title wins.
  for (const candidate of lookup.more?.(bases) ?? []) {
    const page = at(candidate);
    if (holds(page)) return { slug: candidate, page };
  }
  // A title with no Latin letter was filed at `unnamed-<hash>` of its exact
  // spelling, spaces included, so the same title typed with other runs of
  // spaces ("远程 办公", "远程   办公") derives another hash: the lane's
  // hashed old stems are read for the page that stores it. Only such a
  // title pays for the listing.
  if (lookup.stems !== undefined) {
    for (const name of hashedOldStemsFor(trimmed, lookup.stems)) {
      if (bases.includes(name)) continue;
      const page = at(name);
      if (holds(page)) return { slug: name, page };
    }
  }
  if (bySlug && listed !== null) return { slug: listedSlug, page: listed };
  // The slug a title keys to, typed while no page sits at it, names the
  // record an older release filed under an old slug, as it would if that
  // record sat at its new slug: the one record whose stored title keys to
  // the value. Two such records name neither.
  if (bySlug && issued && listed === null && slug === trimmed && slug !== slugify(slug)) {
    const keyed = recordsKeyedTo(slug, lookup, at);
    if (keyed.length === 1) return keyed[0]!;
  }
  return miss;
}

/**
 * Up to two records an older release filed away from `slug` whose stored
 * title's {@link titleSlug} is `slug`: at its Latin-only slug, at a hashed
 * `unnamed-<hex>` slug (a title with no Latin letter, whose hash no other
 * value derives), or, where `stems` lists the lane, at a longer old slug
 * the cap cut `slug` short of, or at a lane-issued stem of the Latin-only
 * slug (an identity-suffixed pledge). Only old slugs are read: a page under
 * a new slug is reached by that slug itself.
 */
function recordsKeyedTo<T>(
  slug: string,
  lookup: TitledPageLookup<T>,
  at: (candidate: string) => T | null,
): TitledPageLocation<T>[] {
  const legacies = [...new Set(legacySlugForms(slug))];
  const out: TitledPageLocation<T>[] = [];
  const consider = (candidate: string): void => {
    const page = at(candidate);
    if (page !== null && titleSlug(lookup.titleOf(page)) === slug) {
      out.push({ slug: candidate, page });
    }
  };
  for (const legacy of legacies) consider(legacy);
  const capped = slug.length >= SLUG_MAX_LEN - 1;
  // Only the hash fallback itself (`unnamed-<8 hex>`): an ordinary base
  // such as `unnamed-release` keeps its longer stems.
  const hashed = legacies.some((legacy) => HASHED_FALLBACK_RE.test(legacy));
  for (const name of lookup.stems?.() ?? []) {
    if (out.length >= 2) break;
    if (name === slug || legacies.includes(name) || !OLD_SLUG_STEM_RE.test(name)) continue;
    const longer =
      !hashed &&
      legacies.some(
        (legacy) => name.startsWith(`${legacy}-`) && (capped || (lookup.issued?.(name) ?? false)),
      );
    if (longer || HASHED_SLUG_STEM_RE.test(name)) consider(name);
  }
  return out.slice(0, 2);
}

/**
 * Every Latin-only {@link slugify} slug an older release may have filed
 * `value` under, in a fixed order, without repeats: one per Unicode form
 * the value can have been typed in (as given, NFC, NFD; "Café" typed with
 * a precomposed "é" was `caf`, typed with a combining mark `cafe`), and
 * the same for its whitespace-canonical spelling ({@link titleIdentity}):
 * a title with no Latin letter was `unnamed-<hash>` of its exact spaces,
 * and a title is the same record whatever runs of spaces it is typed
 * with. Every lane that looks for a record under its old slug asks all of
 * them; for an ASCII value they are one slug.
 */
export function legacySlugForms(value: string): string[] {
  const identity = titleIdentity(value);
  const out: string[] = [];
  for (const form of [
    value,
    value.normalize("NFC"),
    value.normalize("NFD"),
    identity,
    identity.normalize("NFD"),
  ]) {
    const legacy = slugify(form);
    if (!out.includes(legacy)) out.push(legacy);
  }
  return out;
}

/**
 * The hashed old stems (`unnamed-<hex>`, bare or with a lane's suffix)
 * among the lane's `stems` that may hold `value`, when `value` is a title
 * with no Latin letter: an older release filed such a title at the hash of
 * its exact spelling, spaces included, so the same title typed with other
 * runs of spaces derives another hash, and only reading the page tells.
 * Empty, and `stems` never listed, for any other value.
 */
export function hashedOldStemsFor(value: string, stems: () => Iterable<string>): string[] {
  const slug = titleSlug(value);
  if (!legacySlugsOf(value, slug).some((legacy) => HASHED_FALLBACK_RE.test(legacy))) return [];
  return [...stems()].filter((name) => HASHED_SLUG_STEM_RE.test(name));
}

/** {@link legacySlugForms} other than `slug` itself. */
function legacySlugsOf(value: string, slug: string): string[] {
  return legacySlugForms(value).filter((legacy) => legacy !== slug);
}

/** The bare hash fallback slug, `unnamed-<8 hex>`. */
const HASHED_FALLBACK_RE = new RegExp(
  `^${SLUG_FALLBACK_PREFIX}-[0-9a-f]{${SLUG_FALLBACK_HASH_LEN}}$`,
  "u",
);

/** A stem only the Latin-only {@link slugify} rule can have written. */
const OLD_SLUG_STEM_RE = /^[a-z0-9-]+$/u;
/** A hashed `unnamed-<hex>` slug, bare or with a lane's suffix. */
const HASHED_SLUG_STEM_RE = new RegExp(
  `^${SLUG_FALLBACK_PREFIX}-[0-9a-f]{${SLUG_FALLBACK_HASH_LEN}}(?:-[0-9a-f]+)?$`,
  "u",
);

/**
 * The file stem `<slug>-<suffix>` of a page keyed by `value` and an
 * identity suffix (a source path and its hash), for a lane whose pages
 * were once written under {@link slugify} and are never renamed. The
 * suffix alone names the record, so the old-slug page with the same suffix
 * IS this record: it is taken when it exists and the {@link titleKeySlug}
 * page does not, and a re-run updates that page instead of writing a
 * second one beside it. Otherwise the answer is the `titleKeySlug` stem.
 * The stem is prefixed and suffixed, so it is never a bare device name and
 * takes no device suffix: for an ASCII value (`CON` included) both stems
 * are equal to the old one and `exists` is never asked.
 */
export function resolveSuffixedTitleSlug(
  value: string,
  suffix: string,
  exists: (stem: string) => boolean,
): string {
  const fresh = `${titleKeySlug(value)}-${suffix}`;
  // The old slug of every form the value can have been typed in.
  const legacies = legacySlugForms(value)
    .map((legacy) => `${legacy}-${suffix}`)
    .filter((legacy) => legacy !== fresh);
  const nfdFresh = fresh.normalize("NFD");
  if (nfdFresh !== fresh && !legacies.includes(nfdFresh)) legacies.push(nfdFresh);
  if (legacies.length === 0 || exists(fresh)) return fresh;
  return legacies.find((legacy) => exists(legacy)) ?? fresh;
}

/** Where {@link locateSuffixedTitleStem} landed. */
export interface SuffixedTitleStem {
  /** The stem the caller reads, rewrites and names. */
  readonly stem: string;
  /**
   * True when the record's page exists but the caller's reach withholds
   * it: the caller then neither reads nor writes any page and answers as
   * for an absent one, under `stem` (the new slug's stem, so the name does
   * not tell which page exists either).
   */
  readonly withheld: boolean;
}

/**
 * {@link resolveSuffixedTitleSlug} with the caller's reach applied to the
 * stem it selects, before anything of that page is read or written: the
 * new-slug page, or the old-slug page that is the same record. A selected
 * page the caller may not read is withheld whichever slug it sits under,
 * so a rewrite in place never touches it and no second page is written
 * beside it.
 */
export function locateSuffixedTitleStem(
  value: string,
  suffix: string,
  exists: (stem: string) => boolean,
  readable?: (stem: string) => boolean,
): SuffixedTitleStem {
  const selected = resolveSuffixedTitleSlug(value, suffix, exists);
  if (readable === undefined || readable(selected) || !exists(selected)) {
    return { stem: selected, withheld: false };
  }
  return { stem: `${titleKeySlug(value)}-${suffix}`, withheld: true };
}

/**
 * A letter or digit. A key of combining marks alone (a variation selector
 * left after the symbol it modified was dropped: `"\u2764\uFE0F"` and
 * `"\u2600\uFE0F"` both key to `"\uFE0F"`) names nothing, so such titles
 * take the hashed fallback and stay apart.
 */
const TITLE_KEY_WORD_RE = /[\p{L}\p{N}]/u;

/**
 * The device names Windows reserves in every folder and with any extension,
 * as a lowercase key: `con`, `prn`, `aux`, `nul`, and the `com` and `lpt`
 * ports numbered 0-9 or with a superscript digit (`com¹`). A captured note
 * is `captured/<slug>.md` and an obligation `<slug>.md`, with no prefix to
 * protect them, so such a key gets the digest of itself as a suffix: still
 * readable, stable on every machine, and a fixed point of `titleSlug`.
 */
const WINDOWS_DEVICE_KEY_RE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/u;

/**
 * Extract unique `[[wikilink]]` targets from Markdown content. Skips media
 * file extensions, links inside fenced or inline code blocks, and links
 * whose opening or closing bracket is backslash-escaped (an odd backslash
 * run before it - the same rule the neutralizer's detector applies, so a
 * `\[[literal]]` span is data here too and never joins the link graph).
 */
export function extractWikilinks(content: string): string[] {
  const masked = maskCodeRegions(content, () => " ");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of masked.matchAll(WIKILINK_TARGET_RE)) {
    if (!isLiveWikilinkSpan(masked, m.index!, m.index! + m[0].length)) continue;
    const target = m[1]!;
    const dot = target.lastIndexOf(".");
    const ext = dot >= 0 ? target.slice(dot).toLowerCase() : "";
    if (MEDIA_EXTENSIONS.has(ext)) continue;
    if (!seen.has(target)) {
      seen.add(target);
      result.push(target);
    }
  }
  return result;
}

/**
 * What every walker in this module accepts. Separate from
 * {@link ListVaultPagesOptions} because only the walker that PARSES
 * frontmatter can answer the visibility question, and a shared type would
 * have let the cheap basename walkers claim an answer they cannot give.
 */
export interface VaultWalkOptions {
  readonly skipDirs?: ReadonlyArray<string>;
  readonly skipFiles?: ReadonlyArray<string>;
  /**
   * Opt-in diagnostic sink (unit F). When supplied, the walk appends a
   * notice for every directory it could not read and every frontmatter
   * line it dropped, each carrying the absolute path it happened to.
   *
   * The sink is OPT-IN rather than a widened return type so a caller
   * that has nowhere to report stays byte-identical and pays nothing.
   * The walk's control flow does not depend on it: an unreadable
   * subtree is skipped and a page with a dropped line is still listed,
   * exactly as before.
   */
  readonly notices?: DegradationNotice[];
  /** Site recorded on the notices; defaults to `vault.listVaultPages`. */
  readonly site?: string;
}

export interface ListVaultPagesOptions extends VaultWalkOptions {
  /**
   * How far the caller of this walk reached, minted by the transport
   * (`src/core/graph/transport-reach.ts`). REQUIRED, and deliberately so.
   *
   * This walker is one of the three roots every callable surface reaches
   * page content through, and the two ways to get it wrong fail in
   * opposite directions: a maintenance lane that quietly stopped seeing
   * reserved pages would corrupt the link graph it repairs, while a read
   * surface that quietly saw them would be the boundary failing. Neither
   * is a decision to make by omission, so there is no default to inherit
   * - every call site says which caller it is walking for.
   */
  readonly reach: TransportReach;
}

const LIST_VAULT_PAGES_SITE = "vault.listVaultPages";

/**
 * Fixed-locale, numeric-aware collation for the page listing sort. A bare
 * `localeCompare` answers to the host's default locale, so the same vault
 * lists in different orders on different machines - and a lexicographic
 * read of titles puts "note 10" before "note 2". Pinning the locale and
 * turning on `numeric` makes the listing order a property of the vault,
 * not of the machine reading it. The `toLowerCase` pre-pass stays at the
 * sort site: case-insensitivity is the long-standing contract, and the
 * `sensitivity` options would change more than the case handling promised.
 */
const COLLATOR = new Intl.Collator("en", { numeric: true });

/**
 * The tag list a page whose file could not be read answers with: the
 * reserved token, so a page nobody can measure is treated exactly as one
 * that reserved itself. The twin of `UNMEASURABLE_VISIBILITY` in
 * `core/search/result-filters.ts`, which makes the same substitution for
 * roots A and C - spelled from the same exported token so the two cannot
 * come to mean different things.
 */
const UNMEASURABLE_PAGE_VISIBILITY: ReadonlyArray<string> = Object.freeze([
  REMOTE_DENY_VISIBILITY_TOKEN,
]);

/**
 * Walk the vault and return every Markdown page with parsed frontmatter
 * metadata. Pages are sorted by title (case-insensitive) with a
 * numeric-aware, fixed-locale collation — the order does not depend on
 * the host locale and "note 2" precedes "note 10" on every machine.
 * Excluded dirs/files mirror the Python defaults.
 *
 * Pass `opts.notices` to collect what the walk discarded — see
 * {@link VaultWalkOptions}.
 *
 * Root B of the visibility boundary: a page reserved against remote reads
 * is dropped at {@link TRANSPORT_REACH.remote}, over the frontmatter this
 * walk has already parsed, so a caller pays no extra read. The drop
 * happens BEFORE the sort and before the array leaves this function, so
 * no caller can count what it cannot see - a total that still included
 * the withheld page would answer "there is one more page here than I am
 * showing you". A vault that never wrote the token is byte-identical at
 * both reaches.
 *
 * The reservation is read through {@link remoteDenyVisibilityTokens}, so
 * an informal privacy marker (`access: private`, `confidentiality:
 * secret`, `sensitivity: confidential`) withholds the page exactly as a
 * `visibility: private` declaration does. The marker is not a
 * caller-scope token and this walk knows no scopes; it answers the reach
 * question only.
 *
 * FAILS CLOSED on a page whose file could not be read, which is the one
 * input the three roots must not disagree about. The parsed map resolves
 * an unreadable file to `{}`, and reading that as "declares nothing"
 * would admit at remote reach exactly the page
 * {@link isPathReadableAtReach} denies for roots A and C - so the walk
 * carries the read verdict beside the map (see {@link WalkedPage}) and
 * substitutes {@link UNMEASURABLE_PAGE_VISIBILITY} for it, which is the
 * same substitution those roots make.
 */
export function listVaultPages(vaultDir: string, opts: ListVaultPagesOptions): VaultPage[] {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const skipFiles = new Set((opts.skipFiles ?? DEFAULT_SKIP_FILES).map((f) => f.toLowerCase()));

  const walked: WalkedPage[] = [];
  walk(vaultDir, vaultDir, skipDirs, skipFiles, walked, {
    sink: opts.notices,
    site: opts.site ?? LIST_VAULT_PAGES_SITE,
  });
  const pages = walked
    .filter((w) =>
      isRemotelyReadable(
        w.unreadable ? UNMEASURABLE_PAGE_VISIBILITY : remoteDenyVisibilityTokens(w.page.metadata),
        opts.reach,
      ),
    )
    .map((w) => w.page);
  pages.sort((a, b) => COLLATOR.compare(a.title.toLowerCase(), b.title.toLowerCase()));
  return pages;
}

/** Where {@link walk} reports what it discarded, and under which name. */
interface WalkNoticeSink {
  readonly sink: DegradationNotice[] | undefined;
  readonly site: string;
}

/**
 * Cheap basename-only walker over a vault directory. Returns the set
 * of `.md` basenames (without extension) — no frontmatter parsing.
 *
 * Used where callers only need existence-by-basename (Obsidian
 * wikilink resolution semantics) and the YAML parse cost of
 * {@link listVaultPages} is unwarranted.
 *
 * Honours `opts.notices` exactly as {@link listVaultPages} does. The
 * option has always been on this signature — it is the same options type
 * — and until now it was accepted and dropped, so a caller that asked
 * where the walk went blind was answered with silence.
 */
export function listVaultBasenames(vaultDir: string, opts: VaultWalkOptions = {}): Set<string> {
  return new Set(
    listVaultNotePaths(vaultDir, {
      ...opts,
      site: opts.site ?? LIST_VAULT_BASENAMES_SITE,
    }).map(pathStem),
  );
}

/**
 * The same walk as {@link listVaultBasenames}, reported as vault-relative
 * POSIX paths instead of basenames — no frontmatter parsing here either.
 *
 * Two callers need the two shapes for one reason: a basename is what a
 * wikilink resolves against, and a PATH is what the ownership and
 * visibility rules take. A caller that must ask "may this caller see it"
 * before publishing the basename needs both, and deriving the path back
 * from a basename is exactly the guess this project refuses.
 */
export function listVaultNotePaths(vaultDir: string, opts: VaultWalkOptions = {}): Array<string> {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const skipFiles = new Set((opts.skipFiles ?? DEFAULT_SKIP_FILES).map((f) => f.toLowerCase()));
  const out: string[] = [];
  walkBasenames(vaultDir, vaultDir, skipDirs, skipFiles, out, {
    sink: opts.notices,
    site: opts.site ?? LIST_VAULT_NOTE_PATHS_SITE,
  });
  return out;
}

const LIST_VAULT_BASENAMES_SITE = "vault.listVaultBasenames";
const LIST_VAULT_NOTE_PATHS_SITE = "vault.listVaultNotePaths";

function walkBasenames(
  root: string,
  dir: string,
  skipDirs: Set<string>,
  skipFiles: Set<string>,
  out: string[],
  notices: WalkNoticeSink,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Same branch, and the same fail-soft return, as {@link walk}: an
    // unreadable directory removes a whole subtree from the basename
    // universe, and a caller resolving links against that universe
    // cannot tell the missing pages from pages that never existed.
    if (notices.sink !== undefined) {
      emitDegradationNotice(notices.sink, {
        code: DEGRADATION_CODE.vaultWalkEntrySkipped,
        site: notices.site,
        path: dir,
        detail: `directory listing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walkBasenames(root, full, skipDirs, skipFiles, out, notices);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    if (skipFiles.has(entry.name.toLowerCase())) continue;
    const rel = relative(root, full);
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => skipDirs.has(p))) continue;
    out.push(parts.join("/"));
  }
}

/**
 * A walked page plus the one fact the parsed map cannot carry: whether
 * its file could be READ at all.
 *
 * {@link VaultPage.metadata} resolves an unreadable file to `{}`, which is
 * byte-indistinguishable from a page that declares nothing - so root B
 * would read an unreadable page as untagged and admit it, while roots A
 * and C substitute the reserved token for exactly that state and deny it.
 * Two spellings of one rule, disagreeing in the fail direction. Internal
 * to this module: the flag exists to decide the walk's own filter, and
 * `VaultPage` stays the shape every caller already consumes.
 */
interface WalkedPage {
  readonly page: VaultPage;
  readonly unreadable: boolean;
}

function walk(
  root: string,
  dir: string,
  skipDirs: Set<string>,
  skipFiles: Set<string>,
  out: WalkedPage[],
  notices: WalkNoticeSink,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Unit F: an unreadable directory used to make an entire subtree
    // vanish from the listing with no trace. The walk still returns
    // (fail-soft, as before); the branch is now named.
    if (notices.sink !== undefined) {
      emitDegradationNotice(notices.sink, {
        code: DEGRADATION_CODE.vaultWalkEntrySkipped,
        site: notices.site,
        path: dir,
        detail: `directory listing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(root, full, skipDirs, skipFiles, out, notices);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    if (skipFiles.has(entry.name.toLowerCase())) continue;
    const rel = relative(root, full);
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => skipDirs.has(p))) continue;
    // The former `catch { continue }` here was unreachable: the parser
    // is a line scanner over a string it read inside its own try, so it
    // cannot throw. What it CAN do is drop a line or fail the read, and
    // both now reach the sink instead of vanishing. The page is still
    // listed either way - identical control flow.
    const [meta, , pageNotices] = parseFrontmatterWithNotices(full, { site: notices.site });
    if (notices.sink !== undefined) notices.sink.push(...pageNotices);
    const titleVal = meta["title"];
    const title = typeof titleVal === "string" && titleVal ? titleVal : stem(entry.name);
    out.push({
      page: { title, path: full, metadata: meta },
      // The same verdict `readCachedFrontmatterEntry` carries for roots A
      // and C, read off the notices this walk already produced.
      unreadable: pageNotices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable),
    });
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // Symmetric inverse of `formatYamlScalar`: the formatter escapes
    // \ " \n \r \t inside double-quoted scalars, so the parser must
    // unescape the same set. Without this inverse every
    // parse -> format cycle doubled the backslashes (escape
    // amplification - the source of the \\\\\\" chains observed in
    // live preference frontmatter).
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    // The formatter never emits single quotes; treat them as plain
    // delimiters (hand-written YAML) without escape processing.
    return s.slice(1, -1);
  }
  return s;
}

const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "\\": "\\",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
});

function unescapeDoubleQuoted(inner: string): string {
  // Single pass so `\\n` decodes to `\n` (backslash + n), not a
  // newline - sequential .replace calls would re-scan their own
  // output and corrupt exactly the chains we are trying to preserve.
  return inner.replace(/\\([\\"nrt])/g, (_, ch: string) => DOUBLE_QUOTED_ESCAPES[ch] ?? `\\${ch}`);
}

/**
 * Split the body of an inline YAML array on commas, but only on commas that
 * appear outside quoted runs. Without this, `[plain, "needs, comma"]` would
 * be split into three tokens (`plain`, `"needs`, `comma"`) — breaking the
 * round-trip with `formatYamlValue`, which already quotes any element that
 * contains a comma.
 */
function splitInlineArray(inner: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar: '"' | "'" | "" = "";

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inQuote) {
      current += ch;
      if (ch === quoteChar && inner[i - 1] !== "\\") {
        inQuote = false;
        quoteChar = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(stripQuotes(current.trim()));
      current = "";
      continue;
    }
    current += ch;
  }
  // Trailing element (no trailing comma case).
  if (current.trim() !== "") {
    out.push(stripQuotes(current.trim()));
  }
  return out;
}

function formatYamlScalar(value: FrontmatterValue): string {
  const text = typeof value === "string" ? value : String(value);
  if (text && PLAIN_SCALAR_RE.test(text) && !text.includes(": ") && !text.includes(" #")) {
    return text;
  }
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function formatYamlValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => formatYamlScalar(item)).join(", ") + "]";
  }
  return formatYamlScalar(value);
}

/** Re-exported for callers that want the same exclusion lists in JS plugins. */
export const EXCLUDED_DIRS = DEFAULT_SKIP_DIRS;
export const EXCLUDED_FILES = DEFAULT_SKIP_FILES;

export { isDir } from "./fs-utils.ts";

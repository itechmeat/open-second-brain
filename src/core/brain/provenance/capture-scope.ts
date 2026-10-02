/**
 * How much of its source a page actually holds.
 *
 * A distillation, an ingest summary or a research report presents itself as a
 * record of a source. Whether the vault can still show the source's bytes is
 * a separate fact, and before this module nothing stated it: a page whose
 * only evidence is a URL looked like one backed by a file the vault holds.
 *
 * Three members, decided STRUCTURALLY and never inferred from prose:
 *
 *   - `full-local` - the identity is vault-shaped and resolves to a readable
 *     file. It is the trusted verdict of {@link classifySourceTrust}, so the
 *     trust lane and the capture scope never disagree on an identity as
 *     written; {@link classifyCaptureScope} also accepts the Obsidian
 *     spelling of a note without its extension (`[[notes/meeting]]`).
 *   - `url-only` - the identity carries a URI scheme or an authority shape,
 *     or is vault-shaped with nothing behind it: the untrusted verdict.
 *   - `bounded-local` - a `url-only` source whose page stores a verbatim
 *     excerpt the same writer captured, in the marked block rendered by
 *     {@link renderExcerptSection}, together with its digest. A summary is a
 *     paraphrase, not a capture, so nothing else earns this member.
 *
 * Writers stamp the scope only when it is not `full-local`, so every page
 * backed by a vault file stays byte-identical to what it was before this
 * vocabulary existed. Absence therefore means "full-local, or written before
 * the stamp existed", and a reader resolves it by re-deriving the scope from
 * the identity, never by assuming.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import {
  classifySourceTrust,
  normalizeSourceIdentity,
  vaultShapedIdentity,
} from "../intake/source-trust.ts";
import { INTAKE_TRUST, type IntakeTrust } from "../trust/untrusted-provenance.ts";

/** The closed vocabulary. See the module docblock for what each member proves. */
export const CAPTURE_SCOPE = Object.freeze({
  /** The vault holds the source file. */
  fullLocal: "full-local",
  /** The vault holds a verbatim, digested excerpt of a non-local source. */
  boundedLocal: "bounded-local",
  /** The vault holds nothing of the source but its locator. */
  urlOnly: "url-only",
} as const);

/** Closed union over {@link CAPTURE_SCOPE}. */
export type CaptureScope = (typeof CAPTURE_SCOPE)[keyof typeof CAPTURE_SCOPE];

/** Membership list, most-captured first. */
export const CAPTURE_SCOPES: ReadonlyArray<CaptureScope> = Object.freeze([
  CAPTURE_SCOPE.fullLocal,
  CAPTURE_SCOPE.boundedLocal,
  CAPTURE_SCOPE.urlOnly,
]);

/** Narrow a scope read back off a page's frontmatter. */
export function isCaptureScope(value: unknown): value is CaptureScope {
  return typeof value === "string" && (CAPTURE_SCOPES as ReadonlyArray<string>).includes(value);
}

/** Frontmatter key of a single-source page's scope. */
export const CAPTURE_SCOPE_KEY = "capture_scope";

/** Frontmatter key of a multi-source page's scopes, parallel to its sources. */
export const CAPTURE_SCOPES_KEY = "capture_scopes";

/** Frontmatter key of the stored excerpt's digest on a `bounded-local` page. */
export const EXCERPT_HASH_KEY = "excerpt_hash";

/**
 * Largest excerpt a page will store, in UTF-8 bytes. An excerpt is the passage
 * a writer read and cites, not a mirror of the source; 64 KiB holds many pages
 * of text while keeping a page a page. A larger capture is refused by name
 * rather than truncated, because a truncated excerpt would no longer be the
 * verbatim passage its digest claims.
 */
export const CAPTURE_EXCERPT_MAX_BYTES = 65_536;

/** The heading the excerpt section sits under. */
export const CAPTURE_EXCERPT_HEADING = "## Excerpt";

/**
 * Info string of the excerpt's fenced block. A fence keeps the bytes verbatim
 * and keeps wikilink parsing out of them.
 */
export const CAPTURE_EXCERPT_FENCE_INFO = "excerpt";

/** The fence character; a backtick fence admits any info string. */
const FENCE_CHAR = "`";

/** The shortest fence CommonMark recognises. */
const MIN_FENCE_LENGTH = 3;

/** Every run of the fence character, to size a fence that contains them all. */
const FENCE_CHAR_RUN_RE = /`+/g;

/** Line separator of a rendered section. */
const NEWLINE = "\n";

/** The extension a note identity written the Obsidian way leaves off. */
const NOTE_EXTENSION = ".md";

/** What an excerpt with no text is made of: controls, format characters, whitespace. */
const NON_TEXT_RE = /[\p{Cc}\p{Cf}\s]/gu;

/** NUL, which a Markdown page never holds. */
const NUL = "\u0000";

/** The scope a trust verdict stands for: the two can never disagree. */
export function captureScopeForTrust(trust: IntakeTrust): CaptureScope {
  return trust === INTAKE_TRUST.trusted ? CAPTURE_SCOPE.fullLocal : CAPTURE_SCOPE.urlOnly;
}

/** A source identity's scope, and the vault file behind it when there is one. */
export interface CaptureScopeResolution {
  readonly scope: CaptureScope;
  /**
   * Vault-relative POSIX path of the backing file, every `.` and `..` segment
   * resolved; `null` exactly when `url-only`.
   */
  readonly backing: string | null;
}

/**
 * The current scope of a source identity and the file that backs it, from its
 * shape and one `stat` (two for an identity with no extension, retried once as
 * a `.md` note, the way Obsidian links a note). Never reads the source's
 * bytes, so a sweep over many pages stays cheap. `bounded-local` is never
 * returned: it is a property of a page, not of an identity. A refused `stat`
 * propagates as the {@link classifySourceTrust} refusal.
 */
export function resolveCaptureScope(vault: string, identity: string): CaptureScopeResolution {
  const target = normalizeSourceIdentity(identity);
  if (classifySourceTrust(vault, identity) === INTAKE_TRUST.trusted) {
    return { scope: CAPTURE_SCOPE.fullLocal, backing: vaultShapedIdentity(vault, identity) };
  }
  if (target.length > 0 && posix.extname(target) === "") {
    const note = `${target}${NOTE_EXTENSION}`;
    if (classifySourceTrust(vault, note) === INTAKE_TRUST.trusted) {
      return { scope: CAPTURE_SCOPE.fullLocal, backing: vaultShapedIdentity(vault, note) };
    }
  }
  return { scope: CAPTURE_SCOPE.urlOnly, backing: null };
}

/** The scope half of {@link resolveCaptureScope}. */
export function classifyCaptureScope(vault: string, identity: string): CaptureScope {
  return resolveCaptureScope(vault, identity).scope;
}

/** The frontmatter stamp of a single-source page: nothing for `full-local`. */
export function captureScopeFrontmatter(scope: CaptureScope): FrontmatterMap {
  return scope === CAPTURE_SCOPE.fullLocal ? {} : { [CAPTURE_SCOPE_KEY]: scope };
}

/**
 * The frontmatter stamp of a multi-source page: nothing when every source is
 * `full-local`, otherwise the whole list so positions stay aligned with the
 * page's sources.
 */
export function captureScopesFrontmatter(scopes: ReadonlyArray<CaptureScope>): FrontmatterMap {
  return scopes.every((scope) => scope === CAPTURE_SCOPE.fullLocal)
    ? {}
    : { [CAPTURE_SCOPES_KEY]: [...scopes] };
}

/** SHA-256 hex over the UTF-8 bytes of the excerpt exactly as given. */
export function excerptDigest(excerpt: string): string {
  return createHash("sha256").update(excerpt, "utf8").digest("hex");
}

/** A backtick fence longer than every backtick run in `text`. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(FENCE_CHAR_RUN_RE)) longest = Math.max(longest, run[0].length);
  return FENCE_CHAR.repeat(Math.max(MIN_FENCE_LENGTH, longest + 1));
}

/**
 * The excerpt section: the heading, a blank line, then a fenced block whose
 * fence is longer than any backtick run in the excerpt. One newline always
 * separates the excerpt from the closing fence, so an excerpt that ends in a
 * newline keeps it on the way back through {@link readExcerptSection}.
 */
export function renderExcerptSection(excerpt: string): string {
  const fence = fenceFor(excerpt);
  return (
    `${CAPTURE_EXCERPT_HEADING}${NEWLINE}${NEWLINE}` +
    `${fence}${CAPTURE_EXCERPT_FENCE_INFO}${NEWLINE}` +
    `${excerpt}${NEWLINE}` +
    `${fence}${NEWLINE}`
  );
}

/** The opening of a rendered section: heading, blank line, fence, info string. */
const EXCERPT_OPENING_RE = new RegExp(
  `(?:^|${NEWLINE})${CAPTURE_EXCERPT_HEADING}${NEWLINE}${NEWLINE}` +
    `(${FENCE_CHAR}{${MIN_FENCE_LENGTH},})${CAPTURE_EXCERPT_FENCE_INFO}${NEWLINE}`,
);

/**
 * The inverse of {@link renderExcerptSection}. `null` when the section is
 * absent or does not have the rendered shape (no fence, no closing fence),
 * because a damaged section is not a capture.
 */
export function readExcerptSection(body: string): string | null {
  const opening = EXCERPT_OPENING_RE.exec(body);
  if (opening === null) return null;
  const fence = opening[1] ?? "";
  const start = opening.index + opening[0].length;
  const closing = `${NEWLINE}${fence}`;
  // The excerpt may be empty, in which case the closing fence follows the
  // opening line directly; search from one character back to see it.
  const at = body.indexOf(closing, start - NEWLINE.length);
  if (at === -1) return null;
  const after = body.slice(at + closing.length);
  if (after.length > 0 && !after.startsWith(NEWLINE)) return null;
  return at < start ? "" : body.slice(start, at);
}

/**
 * An excerpt the caller supplied cannot be stored. The message carries
 * identifiers and integers only, never excerpt text.
 */
export class CaptureExcerptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureExcerptError";
  }
}

/**
 * Refuse an excerpt this page must not store: one for a source that is not
 * `url-only` (a local file is already the evidence, and an excerpt beside it
 * would be a second, weaker claim), an empty one (nothing but control,
 * format or whitespace characters), one holding NUL, or one past
 * {@link CAPTURE_EXCERPT_MAX_BYTES}.
 */
export function assertExcerptAdmissible(scope: CaptureScope, excerpt: string): void {
  if (scope !== CAPTURE_SCOPE.urlOnly) {
    throw new CaptureExcerptError(
      `excerpt refused: the source is ${scope}; an excerpt is accepted only for a ` +
        `${CAPTURE_SCOPE.urlOnly} source`,
    );
  }
  if (excerpt.replace(NON_TEXT_RE, "").length === 0) {
    throw new CaptureExcerptError("excerpt refused: the excerpt is empty");
  }
  if (excerpt.includes(NUL)) {
    throw new CaptureExcerptError("excerpt refused: the excerpt contains NUL");
  }
  const bytes = Buffer.byteLength(excerpt, "utf8");
  if (bytes > CAPTURE_EXCERPT_MAX_BYTES) {
    throw new CaptureExcerptError(
      `excerpt refused: the excerpt is ${bytes} bytes, past the ` +
        `${CAPTURE_EXCERPT_MAX_BYTES}-byte ceiling`,
    );
  }
}

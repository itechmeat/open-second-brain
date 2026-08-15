/**
 * Where a source came from, decided once for both intake callers.
 *
 * The source-ingest pipeline used to stamp one hardcoded provenance level on
 * every source it saw, which made a scraped URL and a file in the operator's
 * own vault indistinguishable at the moment they entered the brain. There was
 * no untrusted signal at intake to join to, so this module originates one.
 *
 * The decision is STRUCTURAL - it reads the shape of the source identity and
 * nothing else. No word list, no host list, no scheme list: a URI scheme is
 * recognised by its grammar (RFC 3986 §3.1, via {@link hasUriScheme}) and
 * containment is decided by the same vault-boundary check every writer in
 * this repository already funnels through.
 *
 * POLARITY. The first version of this module asked "is this identity provably
 * outside the vault?" and trusted everything else, which handed trust to every
 * identity it simply could not parse: `evil.com/article` and
 * `www.example.com/x` are not absolute, carry no scheme and do not climb out
 * of the vault, so they entered as if the operator had written them, and an
 * agent reading a hostile page could be told by that page to drop the scheme.
 * The question asked here is the other one: is this identity SHAPED like a
 * location inside this vault? Only a yes is trusted. A shape that establishes
 * nothing is not a shape that establishes authority.
 *
 * WHAT THE SHAPE CANNOT SETTLE. `evil.com` and `readme.md` are the same
 * structure - dot-separated labels, no separator - because a hostname and a
 * vault-relative filename are drawn from the same character set. Nothing short
 * of asking the filesystem tells them apart, and asking it would make a note
 * the operator has not written yet untrusted, which confuses absence with
 * authority. So a single-segment identity is resolved by the one structural
 * signal available: it is trusted when it carries this vault's note
 * extension, and untrusted otherwise. `evil.com` therefore lands untrusted,
 * `readme.md` trusted, and the residual ambiguity (`.md` is also a country
 * TLD) costs nothing an attacker did not already have - an identity is a
 * claim, and an attacker willing to write `evil.md` was equally free to write
 * `primer.md`. The shape gate stops the identities that could not be ours; it
 * was never able to stop a lie about one that could.
 *
 * A COLON IS NOT A SCHEME. {@link hasUriScheme} is shared with the markdown
 * link reader, where its input is a link target and a leading `word:` can only
 * be a scheme. A source identity is a FILENAME, a different domain: this
 * project's own vault names notes `Meeting: Q3 planning.md`. Reused unguarded
 * the predicate read that colon as a scheme and quarantined the operator's own
 * note - and quarantine is one-way, so the entities of that intake left every
 * ordinary read with nothing but a success response to show for it. The fix is
 * the reuse, not the predicate: it is applied here only where a scheme can
 * legally appear (before the first separator) and only to a segment that could
 * be a URI at all (a URI admits no whitespace, RFC 3986 §2).
 *
 * THE SHAPE IS NECESSARY, NOT SUFFICIENT (GitHub #160). The shape gate above
 * is the first half of the decision; {@link classifySourceOrigin} then asks
 * the filesystem whether the named file is there. See its docblock for why
 * that question is this module's to ask, and for the limit of the answer.
 */

import { isAbsolute, join } from "node:path";
import { statSync } from "node:fs";

import { canonicalNotePath, ensureInsideVault, hasUriScheme } from "../../path-safety.ts";
import { hashFile } from "../ingest/content-manifest.ts";
import { INTAKE_TRUST, type IntakeTrust } from "../trust/untrusted-provenance.ts";

/** `[[Articles/x.md]]` - the wikilink form the NER tool's `source` arrives in. */
const WIKILINK_WRAPPER_RE = /^\[\[(.*)\]\]$/s;

/** `[[note|Alias]]` - the display text, not part of the target. */
const WIKILINK_ALIAS_SEPARATOR = "|";

/** `[[note#Section]]` - a position within the target, not a different target. */
const WIKILINK_ANCHOR_SEPARATOR = "#";

/**
 * `stat` errnos that answer "there is nothing here", which is a trust verdict.
 * ENOTDIR is the same answer through a different route: a path segment that
 * exists but is a file, so what follows it cannot exist either.
 */
const ERRNO_NO_SUCH_ENTRY = "ENOENT";
const ERRNO_NOT_A_DIRECTORY = "ENOTDIR";

/** What a failure is called when it carries neither an errno nor a name. */
const UNNAMED_ERRNO = "unknown";

/**
 * Largest source this classifier will read in order to record its digest.
 *
 * The hash is an audit record of the bytes an extraction claims to come from,
 * and the material an agent can have read is bounded by the context it read it
 * into: a million-token window is a few megabytes of text, so 8 MiB is above
 * anything an extraction could honestly cite while still refusing to pull a
 * dataset or a video into memory. The rejected alternative was no ceiling at
 * all, which is what shipped: the classifier read the whole file before it had
 * decided anything the caller could act on.
 */
export const SOURCE_HASH_MAX_BYTES = 8_388_608;

/**
 * The filesystem would not answer for a source this vault does own.
 *
 * A distinct class because the two things it must NOT be are both close by: it
 * is not an {@link INTAKE_TRUST.untrusted} verdict (that would quarantine the
 * operator's own note over a chmod, one-way, while reporting success), and it
 * is not the caller's malformed payload. The message carries the vault-RELATIVE
 * identity and the errno code and nothing else. Rethrowing Node's own error put
 * `EACCES: permission denied, statx '/home/<user>/<vault>/x.md'` into an MCP
 * error on a path the CALLER supplied, which is an existence-and-permission
 * oracle over the operator's filesystem; the same release rewrote
 * `writeFrontmatterAtomic` to keep absolute paths out of exactly this channel.
 */
export class SourceTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTrustError";
  }
}

/** A source identity, and the bytes it was found to stand for. */
export interface SourceOrigin {
  /** The lane this source commits in. */
  readonly trust: IntakeTrust;
  /**
   * SHA-256 of the source file's bytes, present only when the verdict is
   * trusted - an untrusted identity has no file of ours to hash, and a hash
   * of nothing would be a claim rather than a record.
   */
  readonly contentHash?: string;
}

const UNTRUSTED_ORIGIN: SourceOrigin = Object.freeze({ trust: INTAKE_TRUST.untrusted });

/** Everything before the first occurrence of `separator`, or the whole string. */
function cutAt(value: string, separator: string): string {
  const at = value.indexOf(separator);
  return at === -1 ? value : value.slice(0, at);
}

/** The separator {@link canonicalNotePath} normalises every identity to. */
const PATH_SEPARATOR = "/";

/** The no-op path segment, dropped before the shape is read. */
const SAME_DIR_SEGMENT = ".";

/** The climbing segment, left in place for the vault-boundary check to judge. */
const PARENT_DIR_SEGMENT = "..";

/**
 * The extension a note in this vault carries. Used for ONE decision - telling
 * a single-segment filename apart from a bare hostname - because that is the
 * only place where the path shape alone cannot decide.
 */
const VAULT_NOTE_EXTENSION = ".md";

/** Any whitespace character; a URI contains none (RFC 3986 §2). */
const WHITESPACE_RE = /\s/;

/**
 * Could this segment be a URI prefix? Whitespace rules it out before the
 * scheme grammar is consulted, so a filename that merely contains a colon
 * (`Meeting: Q3 planning.md`) is never mistaken for `mailto:`.
 */
function bearsUriScheme(segment: string): boolean {
  return !WHITESPACE_RE.test(segment) && hasUriScheme(segment);
}

/**
 * Is this leading segment shaped like an authority rather than a directory?
 * A dot in the FIRST segment is the residue of a scheme-less address
 * (`evil.com/article`); vault directories are named, not dotted. `..` is
 * excluded because it is a path operator, and the vault-boundary check below
 * is the one entitled to answer for it.
 */
function isAuthorityShaped(segment: string): boolean {
  return segment !== PARENT_DIR_SEGMENT && segment.includes(".");
}

/** Does this segment name a note file in this vault's own extension? */
function hasVaultNoteExtension(segment: string): boolean {
  return segment.toLowerCase().endsWith(VAULT_NOTE_EXTENSION);
}

/**
 * The one canonical form of a source identity, for every caller that needs to
 * decide whether two spellings name the same source.
 *
 * The wikilink wrapper, the alias pipe and the anchor fragment are all
 * DECORATION on one target: `[[Articles/x.md]]`, `[[Articles/x.md|Primer]]`
 * and `[[Articles/x.md#Intro]]` are the same file, and Obsidian writes all
 * three. Handling only the wrapper - the state this repository was in - left
 * `note|Alias` as a single dotless segment, which the shape gate reads as a
 * bare hostname and quarantines: a legitimate operator note lost to a link
 * style, and quarantine is one-way.
 *
 * The alias and anchor are stripped ONLY inside the wrapper, because `|` and
 * `#` mean alias and anchor only in wikilink grammar. Outside it they are
 * ordinary characters of the identity - a URL fragment is part of the address
 * the agent read - and cutting them there would silently rewrite the caller's
 * source into a different one.
 */
export function normalizeSourceIdentity(source: string): string {
  const trimmed = source.trim();
  const inner = WIKILINK_WRAPPER_RE.exec(trimmed);
  if (inner === null) return canonicalNotePath(trimmed);
  const target = cutAt(cutAt(inner[1] ?? "", WIKILINK_ALIAS_SEPARATOR), WIKILINK_ANCHOR_SEPARATOR);
  return canonicalNotePath(target.trim());
}

/**
 * Is this identity SHAPED like a location inside this vault? The first half
 * of the decision, and the half that has not changed: it rules out every
 * identity that could not be ours. Returns the vault-absolute path when the
 * shape holds, `null` when it does not.
 */
function resolveVaultShapedPath(vault: string, canonical: string): string | null {
  if (canonical.length === 0) return null;
  if (isAbsolute(canonical)) return null;

  const segments = canonical.split(PATH_SEPARATOR).filter((s) => s !== SAME_DIR_SEGMENT);
  // An empty segment is a doubled separator: the `//host` authority marker,
  // the remains of `scheme://host`, or a trailing slash naming a directory.
  // None of the three is a note identity this vault owns.
  if (segments.some((segment) => segment.length === 0)) return null;

  // A scheme precedes the path, so only the segments before the last one can
  // carry it. The final segment is a basename and its colons are its own.
  if (segments.slice(0, -1).some(bearsUriScheme)) return null;

  const head = segments[0] ?? "";
  const establishedShape =
    segments.length > 1 ? !isAuthorityShaped(head) : hasVaultNoteExtension(head);
  if (!establishedShape) return null;

  try {
    return ensureInsideVault(join(vault, canonical), vault);
  } catch {
    // The identity climbs out of the vault (or escapes it through a
    // symlink). It names a location this vault does not own, which is the
    // same verdict as naming one on another host.
    return null;
  }
}

/** Is this the filesystem saying "nothing is there", rather than refusing? */
function isAbsenceErrno(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === ERRNO_NO_SUCH_ENTRY || code === ERRNO_NOT_A_DIRECTORY;
}

/** The errno code alone, or the error's class when the kernel named none. */
function errnoCode(cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  const name = (cause as Error | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : UNNAMED_ERRNO;
}

/** The refusal above, composed from identifiers only. */
function refusal(identity: string, cause: unknown): SourceTrustError {
  return new SourceTrustError(
    `source ${identity} is inside this vault but could not be read (${errnoCode(cause)})`,
  );
}

/** A source identity that resolved to a file this vault holds. */
interface VaultSourceFile {
  /** The canonical, vault-relative identity - safe to name in a message. */
  readonly identity: string;
  readonly abs: string;
  /** Size from the same `stat` the existence question was answered with. */
  readonly size: number;
}

/**
 * The file a source identity stands for, or `null` when there is nothing
 * there. Shape gate first, then the one filesystem question both callers
 * need, so the lane and the digest are decided from a single `stat`.
 */
function resolveVaultSourceFile(vault: string, sourcePath: string): VaultSourceFile | null {
  const identity = normalizeSourceIdentity(sourcePath);
  const abs = resolveVaultShapedPath(vault, identity);
  if (abs === null) return null;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch (cause) {
    if (isAbsenceErrno(cause)) return null;
    throw refusal(identity, cause);
  }
  // A directory (or a socket, or a device) is not material an extraction can
  // have been read from, even though it is genuinely inside the vault.
  if (!stat.isFile()) return null;
  return { identity, abs, size: stat.size };
}

/**
 * The lane a source commits in, without reading its bytes.
 *
 * Split out for the caller that cites SEVERAL sources: it will discard every
 * digest (see `resolveIntakeOrigin`), so hashing to reach a lane reads whole
 * files for nothing. The lane and the digest ask the same question of the
 * filesystem; only the digest needs the file's contents.
 */
export function classifySourceTrust(vault: string, sourcePath: string): IntakeTrust {
  return resolveVaultSourceFile(vault, sourcePath) === null
    ? INTAKE_TRUST.untrusted
    : INTAKE_TRUST.trusted;
}

/**
 * Classify where a source came from: the lane it commits in, and - when it is
 * ours - the bytes it stands for.
 *
 * Trusted requires two things now. The identity must be SHAPED like a
 * location inside this vault, which is the only authority this system has;
 * and that location must hold a readable file.
 *
 * WHY EXISTENCE IS PART OF THE QUESTION. The docstring this replaces argued
 * the opposite - that whether the file is there says nothing about who was
 * entitled to name the location, and that "a source the operator has not
 * written yet is still inside their own namespace". Answered on its own
 * terms: this classifier does not serve a namespace, it serves an assertion.
 * `brain_intake_entities` asserts that THESE ENTITIES WERE EXTRACTED FROM
 * THIS MATERIAL, and a path with no bytes behind it cannot have produced an
 * extraction. Absence here is not "not yet written", it is "there was nothing
 * to read". Without the check the caller supplying the assertion is the same
 * agent that read the material, so hostile material only had to tell it which
 * plausible path to name (GitHub #160).
 *
 * WHAT THIS DOES NOT BUY, stated plainly because the release note repeats it:
 * an attacker forced to name a real file names `README.md`. The recorded hash
 * is then the digest of the bytes that were CLAIMED, not of the bytes that
 * produced the entities. This removes the free bypass - a plausible-looking
 * string no longer suffices, the caller must name something the operator
 * actually holds - and it makes the claim auditable afterwards. It does not
 * stop the lie, and nothing available on this side of the boundary can: the
 * project already established there is no unforgeable caller identity in the
 * MCP surface (`src/core/write-binding/index.ts`).
 *
 * AN UNREADABLE FILE IS NOT A VERDICT. Only "nothing is there" answers the
 * trust question; every other errno - a permission denial, an I/O failure -
 * is the filesystem refusing to answer, and folding it into `untrusted` would
 * quarantine the operator's own note over a chmod, one-way, while reporting
 * success. Those propagate - as a {@link SourceTrustError} naming the
 * vault-relative identity and the errno code, never the kernel's sentence,
 * because this refusal reaches an MCP caller who chose the path.
 *
 * An EMPTY identity is untrusted here rather than an error, because this
 * function answers about an identity it was given. "The caller named no
 * source at all" is a different failure with a different remedy - the caller
 * can be asked - and it belongs to the boundaries that can still ask.
 */
export function classifySourceOrigin(vault: string, sourcePath: string): SourceOrigin {
  const file = resolveVaultSourceFile(vault, sourcePath);
  if (file === null) return UNTRUSTED_ORIGIN;

  if (file.size > SOURCE_HASH_MAX_BYTES) {
    // Refused rather than committed trusted with no digest: absence of a hash
    // already MEANS "no single set of bytes was recorded" (the several-sources
    // case), so reusing it here would make an unrecordable source look like a
    // multi-source intake and quietly drop the audit record this classifier
    // exists to produce.
    throw new SourceTrustError(
      `source ${file.identity} is ${file.size} bytes, past the ${SOURCE_HASH_MAX_BYTES}-byte ` +
        "ceiling on a source this classifier will read to record its digest",
    );
  }

  try {
    // The one hasher in this repository, so the digest a summary page records
    // and the digest an entity page records cannot drift apart. It stats the
    // file again; that is the price of one hasher, and it is the READ this
    // ceiling was added to bound, not the stat.
    return { trust: INTAKE_TRUST.trusted, contentHash: hashFile(file.abs) };
  } catch (cause) {
    // The file went away between the stat and the read. That is the same
    // answer the stat itself would have given a moment later - there is
    // nothing there - and a race is not a reason to fail an intake that a
    // retry would classify cleanly.
    if (isAbsenceErrno(cause)) return UNTRUSTED_ORIGIN;
    throw refusal(file.identity, cause);
  }
}

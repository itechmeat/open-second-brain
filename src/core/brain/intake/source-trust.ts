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
 */

import { isAbsolute, join } from "node:path";

import { canonicalNotePath, ensureInsideVault, hasUriScheme } from "../../path-safety.ts";
import { INTAKE_TRUST, type IntakeTrust } from "../trust/untrusted-provenance.ts";

/** `[[Articles/x.md]]` - the wikilink form the NER tool's `source` arrives in. */
const WIKILINK_WRAPPER_RE = /^\[\[(.*)\]\]$/s;

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
 * Classify a source identity as trusted or untrusted.
 *
 * Trusted means exactly one thing: the identity is shaped like a location
 * inside this vault, which is the only authority this system actually has.
 * Every other shape - an address with a URI scheme, a protocol-relative or
 * absolute path, a leading segment shaped like a host, a bare name that is
 * not a note, a path that climbs out of the vault, or no identity at all - is
 * untrusted.
 *
 * Note what is NOT tested: whether the file is there. An absent file and an
 * unreadable one are different answers to a different question, and neither
 * changes who was entitled to name the location. A source the operator has
 * not written yet is still inside their own namespace.
 *
 * An EMPTY identity is untrusted here rather than an error, because this
 * function answers about an identity it was given. "The caller named no
 * source at all" is a different failure with a different remedy - the caller
 * can be asked - and it belongs to the boundary that can still ask, which is
 * why `brain_intake_entities` refuses it instead of routing it here.
 */
export function classifySourceTrust(vault: string, sourcePath: string): IntakeTrust {
  const inner = sourcePath.trim().replace(WIKILINK_WRAPPER_RE, "$1").trim();
  if (inner.length === 0) return INTAKE_TRUST.untrusted;

  const canonical = canonicalNotePath(inner);
  if (isAbsolute(canonical)) return INTAKE_TRUST.untrusted;

  const segments = canonical.split(PATH_SEPARATOR).filter((s) => s !== SAME_DIR_SEGMENT);
  // An empty segment is a doubled separator: the `//host` authority marker,
  // the remains of `scheme://host`, or a trailing slash naming a directory.
  // None of the three is a note identity this vault owns.
  if (segments.some((segment) => segment.length === 0)) return INTAKE_TRUST.untrusted;

  // A scheme precedes the path, so only the segments before the last one can
  // carry it. The final segment is a basename and its colons are its own.
  if (segments.slice(0, -1).some(bearsUriScheme)) return INTAKE_TRUST.untrusted;

  const head = segments[0] ?? "";
  const establishedShape =
    segments.length > 1 ? !isAuthorityShaped(head) : hasVaultNoteExtension(head);
  if (!establishedShape) return INTAKE_TRUST.untrusted;

  try {
    ensureInsideVault(join(vault, canonical), vault);
  } catch {
    // The identity climbs out of the vault (or escapes it through a
    // symlink). It names a location this vault does not own, which is the
    // same verdict as naming one on another host.
    return INTAKE_TRUST.untrusted;
  }
  return INTAKE_TRUST.trusted;
}

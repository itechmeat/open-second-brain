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
 */

import { isAbsolute, join } from "node:path";

import { canonicalNotePath, ensureInsideVault, hasUriScheme } from "../../path-safety.ts";
import { INTAKE_TRUST, type IntakeTrust } from "../trust/untrusted-provenance.ts";

/** `[[Articles/x.md]]` - the wikilink form the NER tool's `source` arrives in. */
const WIKILINK_WRAPPER_RE = /^\[\[(.*)\]\]$/s;

/**
 * Classify a source identity as trusted or untrusted.
 *
 * Trusted means exactly one thing: the identity names a location inside this
 * vault, which is the only authority this system actually has. Everything
 * else - an address with a URI scheme, an absolute path, a relative path that
 * climbs out of the vault, or no identity at all - is untrusted.
 *
 * Note what is NOT tested: whether the file is there. An absent file and an
 * unreadable one are different answers to a different question, and neither
 * changes who was entitled to name the location. A source the operator has
 * not written yet is still inside their own namespace.
 */
export function classifySourceTrust(vault: string, sourcePath: string): IntakeTrust {
  const inner = sourcePath.trim().replace(WIKILINK_WRAPPER_RE, "$1").trim();
  if (inner.length === 0) return INTAKE_TRUST.untrusted;

  const canonical = canonicalNotePath(inner);
  if (hasUriScheme(canonical) || isAbsolute(canonical)) return INTAKE_TRUST.untrusted;
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

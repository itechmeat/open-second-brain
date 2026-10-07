/**
 * Hygiene digest hash ledger
 * (context-injection-pipeline, lane B, task B2).
 *
 * Once-per-change state for the Stop hygiene digest: one overwrite-only
 * file, `<vault>/.open-second-brain/hygiene-digest.hash`, holding the
 * SHA-256 of the digest state the hook last emitted. Vault-global and
 * un-synced derived state - beside `hook-state/`, deliberately OUTSIDE
 * it, because per-session scope is the wrong lifetime for
 * "once per change": the findings set belongs to the vault and must
 * re-arm in a new session. Size one, self-overwriting, no cleanup path,
 * so the file cannot grow.
 *
 * Fail-soft on both sides, mirroring the hook-state convention: a
 * missing, unreadable, non-regular or corrupt file reads as `null`,
 * which compares as "changed" so the next eligible turn emits again
 * rather than staying silent forever, and a write reports `false`
 * instead of throwing so the hook's silent-exit-0 contract holds.
 *
 * The module is deliberately import-light (node:fs, the atomic writer,
 * the digest helpers, the no-follow guard), so the hook can statically
 * import it and still stay cheap when the feature flag is off.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteText } from "../../src/core/fs-atomic.ts";
import { sha256Hex, canonicalJson } from "../../src/core/integrity/digest.ts";
import {
  derivedDirIsSymlinked,
  readRegularFileNoFollow,
} from "../../src/core/derived-store-guard.ts";
import { HYGIENE_DIGEST_SEVERITIES } from "./hygiene-digest-text.ts";
import type { HygieneFinding } from "../../src/core/brain/hygiene/types.ts";

/**
 * The vault's hook-surface directory name. `hooks/lib/session-state.ts`
 * owns this constant for the per-session tree; it is redeclared here so
 * the hook's static import graph stays free of the session-state module
 * (and its lock machinery) on the flag-off path.
 */
const OSB_DIR_NAME = ".open-second-brain";

/** The single ledger file name, directly under {@link OSB_DIR_NAME}. */
export const HYGIENE_DIGEST_HASH_FILENAME = "hygiene-digest.hash";

/** A ledger file holds exactly one lowercase hex SHA-256 and nothing else. */
const HASH_LINE_RE = /^[0-9a-f]{64}$/;

/** Absolute path of the ledger file for one vault. */
export function hygieneDigestHashPath(vault: string): string {
  return join(vault, OSB_DIR_NAME, HYGIENE_DIGEST_HASH_FILENAME);
}

/**
 * The hash last recorded for the vault, or `null` when nothing usable is
 * recorded: the file is absent, unreadable, not a regular file, or does
 * not hold a single lowercase hex SHA-256. Never throws.
 */
export function readHygieneDigestHash(vault: string): string | null {
  const read = readRegularFileNoFollow(hygieneDigestHashPath(vault));
  if (read.status !== "ok") return null;
  const line = read.text.trim();
  return HASH_LINE_RE.test(line) ? line : null;
}

/**
 * True when `hash` is exactly what the ledger holds. A missing or
 * corrupt ledger compares unequal: the caller emits and rewrites, which
 * is the lose-not-duplicate direction.
 */
export function hygieneDigestHashMatches(vault: string, hash: string): boolean {
  return readHygieneDigestHash(vault) === hash;
}

/**
 * Overwrite the ledger with `hash`, in place: an atomic rename over the
 * single file, no siblings left behind, no growth. Refuses (returning
 * `false`) when `.open-second-brain` is itself a symbolic link - a vault
 * received from elsewhere could point it at any directory. Never throws.
 */
export function writeHygieneDigestHash(vault: string, hash: string): boolean {
  try {
    if (derivedDirIsSymlinked(vault, OSB_DIR_NAME)) return false;
    if (!HASH_LINE_RE.test(hash)) return false;
    const path = hygieneDigestHashPath(vault);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteText(path, `${hash}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface HygieneDigestHashInput {
  readonly findings: ReadonlyArray<HygieneFinding>;
  /**
   * Dangling-link count as measured for this digest, `null` when the
   * measurement was not taken. An unmeasured count is a different state
   * from a measured zero, on purpose: the canonical payload keeps
   * `null` distinct.
   */
  readonly danglingLinks: number | null;
}

/**
 * The digest state's hash: `sha256Hex(canonicalJson(...))` over the
 * sorted ids of the findings that meet the severity bar (the same bar
 * the composer applies, so the ledger never records a state the hook
 * would not have emitted) plus the dangling-link count. Deterministic
 * and order-insensitive over the findings' input order.
 */
export function computeHygieneDigestHash(input: HygieneDigestHashInput): string {
  const ids = input.findings
    .filter((finding) => HYGIENE_DIGEST_SEVERITIES.includes(finding.severity))
    .map((finding) => finding.id)
    .toSorted();
  return sha256Hex(canonicalJson({ dangling: input.danglingLinks, ids }));
}

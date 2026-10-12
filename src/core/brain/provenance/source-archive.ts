/**
 * The durable raw-source archive (answer trust, t_9b835c8f).
 *
 * Provenance rots because intake throws the bytes away: a summary page
 * records a digest of the source it was read from, and when the file behind
 * that digest decays nothing can re-verify the page against what it claimed.
 * This store keeps the bytes. The ingest trusted-local branch persists its
 * source here - ONCE, redacted, content-addressed - and stamps the entry's
 * digest on the summary page, so the page carries a pointer to evidence that
 * outlives the source file.
 *
 * The contract, each clause load-bearing:
 *
 *   - **Content-addressed.** An entry is `Brain/.archives/<sha256>.txt`,
 *     the digest of the persisted bytes. Identical bytes persist once -
 *     the address IS the dedup - and a re-ingest of an unchanged source
 *     re-lands the same entry it already has.
 *   - **Redacted BEFORE persist.** The bytes run through `redactRawOutput`
 *     before anything touches disk, so a credential captured in the source
 *     never lands in a second file after v1.78-v1.79 taught the rest of the
 *     tree to hold credentials in one custody store. The digest is computed
 *     over the REDACTED bytes - the address names exactly what is on disk,
 *     which is what lets {@link verifySourceArchive} re-hash the file it
 *     finds.
 *   - **Refused, never truncated.** A past-ceiling input raises
 *     {@link SourceArchiveError} and writes nothing: a truncated archive
 *     would no longer be the source's bytes, which is the one property it
 *     exists to keep (the `CaptureExcerptError` posture beside this module).
 *   - **Evidence, not scratch.** No TTL, no prune - the deliberate contrast
 *     to the artifact store. Retention is explicit operator pruning, and
 *     delete-by-source cleanup drops an entry only when its LAST citing page
 *     goes with it.
 *   - **Never wider than the page.** The stamp is written only on success,
 *     so an unstamped page means exactly "not captured" - absence is a
 *     state, never a failure. A source whose bytes are refused to remote
 *     readers is never archived at all; the visibility rule the digest
 *     already obeys is the one the archive inherits.
 *
 * Paths are built from the {@link BRAIN_ARCHIVES_REL} name constant and the
 * entry filename is a validated 64-hex digest before any join, so a
 * caller-supplied hash cannot traverse out of the store.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { ensureInsideVault } from "../../path-safety.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { redactRawOutput } from "../../redactor.ts";
import { listVaultNotePaths, parseFrontmatter } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import { BRAIN_ARCHIVES_REL, BRAIN_PENDING_REL, BRAIN_SOURCES_REL } from "../path-constants.ts";

/**
 * Largest input an archive entry will hold, in UTF-8 bytes: 1 MiB, the
 * `PRE_EXTRACT_MAX_SOURCE_BYTES` ceiling. An archive is a re-verification
 * copy of a source an agent read into a bounded context, not a mirror of
 * the vault; a larger input is refused by {@link SourceArchiveError} rather
 * than truncated, because a truncated archive would no longer be the bytes
 * its address names.
 */
export const ARCHIVE_MAX_BYTES = 1_048_576;

/**
 * An input the store must not hold. The message carries identifiers and
 * integers only - the byte counts and the ceiling - never input text.
 */
export class SourceArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceArchiveError";
  }
}

/** Shape of an archive entry's filename stem: the digest of its own bytes. */
const ARCHIVE_HASH_RE = /^[0-9a-f]{64}$/;

/** Extension every archive entry carries. */
const ARCHIVE_ENTRY_EXT = ".txt";

/** Is this string shaped like the entry digest the store mints? */
export function isArchiveHash(value: unknown): value is string {
  return typeof value === "string" && ARCHIVE_HASH_RE.test(value);
}

/**
 * The closed vocabulary of an archive verification: what comparing a
 * stamped digest against the entry it names concluded. `missing` and
 * `mismatched` are separate members because "the evidence is gone" and
 * "the evidence disagrees" are different repairs, and a boolean would
 * collapse them. The values cross to the wire - they ride the
 * capture-scope detector's finding evidence and the `archive_get` result -
 * so a member must survive the round trip through a string.
 */
export const ARCHIVE_VERIFICATION = Object.freeze({
  /** The entry is there and re-hashes to exactly the stamped digest. */
  verified: "verified",
  /** The entry is there but its bytes no longer hash to the stamp. */
  mismatched: "mismatched",
  /** No entry answers to the stamp. */
  missing: "missing",
} as const);

/** Closed union over {@link ARCHIVE_VERIFICATION}. */
export type ArchiveVerification = (typeof ARCHIVE_VERIFICATION)[keyof typeof ARCHIVE_VERIFICATION];

/** Membership list, best-news-first. */
export const ARCHIVE_VERIFICATIONS: ReadonlyArray<ArchiveVerification> = Object.freeze(
  Object.values(ARCHIVE_VERIFICATION),
);

/** Narrow a verification read back off a wire payload. */
export function isArchiveVerification(value: unknown): value is ArchiveVerification {
  return (
    typeof value === "string" && (ARCHIVE_VERIFICATIONS as ReadonlyArray<string>).includes(value)
  );
}

/** Frontmatter key of the archive digest stamped on a summary page. */
export const SOURCE_ARCHIVE_HASH_KEY = "source_archive_hash";

/** Frontmatter key of the archived entry's byte count, beside the digest. */
export const SOURCE_ARCHIVE_BYTES_KEY = "source_archive_bytes";

/** The store root: `<vault>/Brain/.archives/`, contained. */
export function sourceArchivesDir(vault: string): string {
  return ensureInsideVault(join(vault, BRAIN_ARCHIVES_REL), vault);
}

/**
 * Vault-relative path of one entry, from its digest - the spelling every
 * wire surface reports, so no host path and no second suffix spelling can
 * drift. The digest is validated before the join.
 */
export function sourceArchiveEntryRel(hash: string): string {
  if (!isArchiveHash(hash)) {
    // The negative branch of the guard narrows a `string` parameter to
    // `never`; widen before quoting so the refusal can still name the
    // argument, truncated, without echoing arbitrary length.
    const shown = String(hash);
    throw new SourceArchiveError(
      `archive entry refused: ${JSON.stringify(shown.slice(0, 72))} is not a 64-hex sha-256 digest`,
    );
  }
  return posix.join(BRAIN_ARCHIVES_REL, `${hash}${ARCHIVE_ENTRY_EXT}`);
}

/**
 * One entry's path. The digest is validated BEFORE the join, so a
 * caller-supplied hash cannot traverse out of the store the way an
 * unvalidated filename could.
 */
export function sourceArchivePath(vault: string, hash: string): string {
  return ensureInsideVault(join(vault, sourceArchiveEntryRel(hash)), vault);
}

/** What {@link putSourceArchive} persisted. */
export interface ArchivePutResult {
  /** Digest of the REDACTED bytes on disk - the entry's address. */
  readonly hash: string;
  /** UTF-8 byte count of the persisted (redacted) entry. */
  readonly bytes: number;
}

/**
 * Redact, then persist, then return the address. Idempotent by
 * construction: the address is the digest of the persisted bytes, so the
 * second put of the same bytes finds its own entry already there and
 * leaves it untouched when it still verifies - one file per distinct
 * source text, however many pages cite it. An entry that no longer
 * verifies (truncated or edited on disk, the state the hygiene scan
 * reports as `mismatched`) is rewritten with the same atomic write: the
 * re-ingest of the source is the natural repair, and skipping the write
 * behind an existing entry would leave the mismatch standing forever.
 *
 * The redaction is the artifact-store posture: the whole input scanned
 * with no scan-window cap (the archive IS the recoverable bytes), and the
 * infra-topology pass on, because a bare internal hostname in a captured
 * source is a likelier leak than a key=value token.
 */
export function putSourceArchive(vault: string, bytes: Uint8Array | string): ArchivePutResult {
  const raw = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  const redacted = redactRawOutput(raw, { maxInput: Number.POSITIVE_INFINITY, redactInfra: true });
  const persisted = Buffer.from(redacted, "utf8");
  if (persisted.length > ARCHIVE_MAX_BYTES) {
    throw new SourceArchiveError(
      `source archive refused: the redacted source is ${persisted.length} bytes, past the ` +
        `${ARCHIVE_MAX_BYTES}-byte ceiling; nothing was written`,
    );
  }
  const hash = createHash("sha256").update(redacted, "utf8").digest("hex");
  const path = sourceArchivePath(vault, hash);
  if (!existsSync(path)) {
    mkdirSync(sourceArchivesDir(vault), { recursive: true });
    // Identical bytes persist once: the write happens only when no entry
    // with this address is already there, so a re-ingest never churns the
    // entry's mtime (and never doubles it under concurrency - the bytes
    // an idempotent re-land would write are the bytes already on disk).
    atomicWriteFileSync(path, redacted);
  } else if (entryMismatched(path, hash)) {
    // The repair arm: same address, disagreeing bytes. Written with the
    // store's atomic write, so the entry is never observed half-replaced.
    atomicWriteFileSync(path, redacted);
  }
  return { hash, bytes: persisted.length };
}

/**
 * Does the entry file at `path` still hash to the digest it is addressed
 * by? A file that vanished mid-check is no mismatch - there is nothing
 * here to repair, and the next put will find the store empty.
 */
function entryMismatched(path: string, hash: string): boolean {
  const text = readFileSync(path, "utf8");
  return createHash("sha256").update(text, "utf8").digest("hex") !== hash;
}

/** What {@link verifySourceArchive} concluded. */
export interface ArchiveVerificationResult {
  readonly state: ArchiveVerification;
  /** The digest the caller asked about, verbatim. */
  readonly hash: string;
}

/**
 * Re-hash the entry a stamp names and compare. A malformed stamp names no
 * entry the store could hold, so it answers {@link ARCHIVE_VERIFICATION.missing}
 * - the stamp cannot be true - rather than an error; the boundaries that
 * take a hash from a CALLER (not off a page) validate the argument first
 * and refuse it as their own concern.
 */
export function verifySourceArchive(vault: string, hash: string): ArchiveVerificationResult {
  if (!isArchiveHash(hash)) return { state: ARCHIVE_VERIFICATION.missing, hash };
  const entry = readSourceArchiveEntry(vault, hash);
  return entry === null
    ? { state: ARCHIVE_VERIFICATION.missing, hash }
    : { state: entry.state, hash };
}

/** One entry read back: its verification against its own address, and its bytes. */
export interface SourceArchiveEntry {
  /** `verified` or `mismatched` - a read entry is never `missing`. */
  readonly state: ArchiveVerification;
  /** The digest the entry was addressed by, verbatim. */
  readonly hash: string;
  /** UTF-8 byte count of the stored text. */
  readonly bytes: number;
  /** The stored (redacted) text. */
  readonly text: string;
}

/**
 * Read the entry addressed by `hash`: `null` when no such entry exists or
 * the stamp is malformed (the caller decides what a malformed argument
 * deserves), otherwise the stored text with its re-hash verdict attached.
 */
export function readSourceArchiveEntry(vault: string, hash: string): SourceArchiveEntry | null {
  const path = sourceArchivePath(vault, hash);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    state: actual === hash ? ARCHIVE_VERIFICATION.verified : ARCHIVE_VERIFICATION.mismatched,
    hash,
    bytes: Buffer.byteLength(text, "utf8"),
    text,
  };
}

/** What {@link sourceArchiveStats} measured about the store. */
export interface ArchiveStats {
  /** Entries held: `<64-hex>.txt` regular files, however stale. */
  readonly entries: number;
  /** Their combined size in bytes - the growth number the doctor reports. */
  readonly totalBytes: number;
}

/**
 * Measure the store. Never throws for an absent store - a vault that has
 * never captured a source has an empty one - and counts nothing it does
 * not recognize (a stray non-entry file is not an archive entry).
 */
export function sourceArchiveStats(vault: string): ArchiveStats {
  const root = sourceArchivesDir(vault);
  if (!existsSync(root)) return { entries: 0, totalBytes: 0 };
  let entries = 0;
  let totalBytes = 0;
  for (const name of readdirSync(root).toSorted()) {
    if (!name.endsWith(ARCHIVE_ENTRY_EXT)) continue;
    if (!isArchiveHash(name.slice(0, -ARCHIVE_ENTRY_EXT.length))) continue;
    let size: number;
    try {
      const stat = statSync(join(root, name));
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue; // Vanished or unreadable mid-walk: not an entry this run counted.
    }
    entries += 1;
    totalBytes += size;
  }
  return { entries, totalBytes };
}

/**
 * Remove the entry addressed by `hash`, when there is one and nothing else
 * has decided to keep it - the caller owns the last-citing-page question.
 * False when there was nothing to remove; true only when bytes went away.
 */
export function discardSourceArchive(vault: string, hash: string): boolean {
  const path = sourceArchivePath(vault, hash);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * The only pages a stamp is written on: `Brain/sources/` and its staged
 * counterparts under `Brain/pending/`. The citation probe walks exactly
 * these, which makes the one-writer assumption load-bearing: a stamped
 * page anywhere else would cite an entry the probe cannot see. That
 * assumption is architecture, not convention - it is pinned by the
 * source-archive stamp census (`tests/core/architecture/source-archive-
 * stamp-census.test.ts`), which fails by name when a second writer of
 * the `source_archive_hash` key appears outside the ingest lane.
 */
const STAMP_ROOTS: ReadonlyArray<string> = Object.freeze([BRAIN_SOURCES_REL, BRAIN_PENDING_REL]);

/** Visit every stampable page's frontmatter, once per page. */
function walkStampedPages(
  vault: string,
  visit: (root: string, rel: string, meta: FrontmatterMap) => void,
): void {
  for (const root of STAMP_ROOTS) {
    const dir = join(vault, root);
    if (!existsSync(dir)) continue;
    for (const rel of listVaultNotePaths(dir)) {
      const abs = join(dir, rel);
      // `parseFrontmatter` never throws (it reads inside its own try and
      // answers an empty map for a failed read), so a page that will not
      // parse falls out as citing nothing - the fail-safe answer for an
      // entry-removal decision.
      const [meta] = parseFrontmatter(abs);
      visit(root, rel, meta);
    }
  }
}

/**
 * Every ingest summary page stamping `hash` as its archive digest,
 * vault-relative and sorted. The inverse index of the stamp, for the
 * delete path that must remove an entry only when its LAST citing page
 * goes. A staged page counts as citing: rejecting it removes the citation
 * with the page, but publishing it would revive a stamp whose entry must
 * still be there.
 */
export function sourceArchiveCitingPages(vault: string, hash: string): ReadonlyArray<string> {
  const pages: string[] = [];
  walkStampedPages(vault, (root, rel, meta) => {
    if (meta[SOURCE_ARCHIVE_HASH_KEY] === hash) {
      pages.push(posix.join(root, rel.split("\\").join("/")));
    }
  });
  return pages.toSorted();
}

/**
 * The digests of every entry the store holds, sorted - the entry stems of
 * the `<64-hex>.txt` files {@link sourceArchiveStats} counts, so a stray
 * file is never mistaken for an entry and a vanished one is never named.
 */
export function sourceArchiveEntryHashes(vault: string): ReadonlyArray<string> {
  const root = sourceArchivesDir(vault);
  if (!existsSync(root)) return [];
  const hashes: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(ARCHIVE_ENTRY_EXT)) continue;
    const stem = name.slice(0, -ARCHIVE_ENTRY_EXT.length);
    if (!isArchiveHash(stem)) continue;
    try {
      if (!statSync(join(root, name)).isFile()) continue;
    } catch {
      continue; // Vanished or unreadable mid-walk: not an entry this run named.
    }
    hashes.push(stem);
  }
  return hashes.toSorted();
}

/**
 * The store's entries that NO page cites - the leftovers the citation
 * probe cannot reach through a page: a re-stamped page orphans the entry
 * the old stamp named, and a staged ingest rejected by review leaves its
 * entry behind. One walk over the stamp roots builds the set of stamps
 * any page carries, so the verdict is the exact answer the per-entry
 * probe ({@link sourceArchiveCitingPages} empty) would give, without
 * re-walking the pages once per entry. Sorted, so audit output is
 * deterministic.
 */
export function sourceArchiveUncitedHashes(vault: string): ReadonlyArray<string> {
  const cited = new Set<string>();
  walkStampedPages(vault, (_root, _rel, meta) => {
    const value = meta[SOURCE_ARCHIVE_HASH_KEY];
    if (typeof value === "string") cited.add(value);
  });
  return sourceArchiveEntryHashes(vault).filter((hash) => !cited.has(hash));
}

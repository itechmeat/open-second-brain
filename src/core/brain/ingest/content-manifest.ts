/**
 * Content-hash skip-unchanged manifest for incremental ingest.
 *
 * The source-ingest pipeline already computes a source-IDENTITY hash
 * ({@link sourceIdentityHash}) that answers "is this the same logical source" -
 * a stable key for idempotent dedup, hashed over the source-path string. This
 * module answers a DIFFERENT question: "are the source's bytes unchanged since
 * we last ingested it?" - hashed over the file CONTENT, not its identity. The
 * two are deliberately distinct artifacts:
 *
 *   - identity hash  → which summary page a source maps to (path-derived),
 *   - content hash   → whether a re-ingest can skip the expensive extraction
 *                       pass because nothing actually changed (byte-derived).
 *
 * The manifest is TIMESTAMP-INDEPENDENT by design. A `git checkout`, an `rsync`,
 * or an NFS restat bumps a file's mtime without changing its bytes; an mtime-
 * driven cache would force a needless re-ingest (and a needless LLM pass) in
 * that case. Comparing content hashes instead means only a real byte change
 * re-triggers ingestion.
 *
 * A changed extraction contract ({@link ./contract.ts}) must reprocess every
 * source once even when its bytes did not move (t_586d5d8b), so each entry
 * records the contract fingerprint it was written under (schema_version 3).
 * The plan-level decision reads the ENTRIES: a manifest reads back
 * contract-changed while ANY entry predates the live contract, so ingesting
 * one source after a contract change can no longer cancel the reprocess owed
 * to the others. The manifest-wide `contract` field remains as the
 * current-contract marker only - informational, never the skip authority.
 *
 * The on-disk format is ONE-WAY from schema_version 2 on: there is no
 * write-side downgrade. A binary older than the manifest-wide contract field
 * refuses a v2 or v3 file outright, and a binary older than per-entry
 * fingerprints refuses v3. Reading DEGRADES toward reprocessing, never
 * toward skipping: a v2 manifest (bare-digest entries, no per-entry
 * fingerprints) reads back contract-changed for every entry, owing one full
 * reprocess under the live contract.
 *
 * The manifest lives at `<vault>/.open-second-brain/ingest-manifest.json`, a
 * MACHINE artifact - not curated memory, so NOT under `Brain/`. This mirrors the
 * existing `<vault>/.open-second-brain/` location used by the search index and
 * the Aider install sidecar. Writes are atomic and a no-op rerun (every source
 * unchanged) rewrites nothing, so the file's bytes and mtime stay stable.
 *
 * Language-agnostic: hashing is over raw bytes; no natural-language content is
 * inspected.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { acquireLockSyncWithRetry, ingestLockRemedy } from "../sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { computeExtractionContractFingerprint } from "./contract.ts";

/** The schema version this module writes. Earlier versions are read, not written. */
const SCHEMA_VERSION = 3 as const;

/** Every on-disk schema version this module reads; anything else is refused. */
type ManifestSchemaVersion = 1 | 2 | typeof SCHEMA_VERSION;

/** Every schema version {@link readManifest} accepts. Anything else is refused. */
const SUPPORTED_SCHEMA_VERSIONS: readonly ManifestSchemaVersion[] = Object.freeze([
  1,
  2,
  SCHEMA_VERSION,
]);

/** Vault-relative directory holding OSB machine artifacts (not curated memory). */
const MACHINE_ARTIFACT_DIR = ".open-second-brain";

/** Basename of the ingest content-hash manifest. */
const MANIFEST_FILE = "ingest-manifest.json";

/** The manifest-wide extraction-contract record (t_586d5d8b). */
export interface ManifestContract {
  /** {@link computeExtractionContractFingerprint} of the pass that wrote it. */
  readonly fingerprint: string;
}

/**
 * One entry's recorded state: the content digest AND the extraction contract
 * the entry was recorded under.
 */
export interface ManifestEntry {
  /** 64-char lowercase SHA-256 hex of the source's content at last ingest. */
  readonly sha256: string;
  /**
   * {@link computeExtractionContractFingerprint} of the pass that recorded
   * THIS entry. Absent on entries recorded before per-entry fingerprints
   * existed (every v1 and v2 manifest); an absent fingerprint is that
   * entry's stale-contract marker - it reprocesses once under the live
   * contract, never skips.
   */
  readonly fingerprint?: string;
}

/**
 * The persisted manifest: a map from a canonical vault-relative source path
 * to the state recorded for it at last ingest, plus the contract the
 * recorded state answers under.
 */
export interface ContentManifest {
  /**
   * The schema version the MANIFEST FILE carries: the version actually on
   * disk for a read file, and the current {@link SCHEMA_VERSION} for the
   * missing-file empty manifest (no file exists, so the current shape is the
   * honest answer). Deliberately not the write constant - an accepted v1
   * manifest that reported itself as v3 would make every "which version is
   * on disk" diagnostic lie about exactly the legacy shapes this module
   * supports.
   */
  readonly schema_version: ManifestSchemaVersion;
  /** Canonical vault-relative path → the digest and contract it was recorded under. */
  readonly entries: Readonly<Record<string, ManifestEntry>>;
  /**
   * The contract the recorded state answers under, DERIVED per read from the
   * entries against the live contract: every entry's fingerprint must equal
   * the live one, and the manifest then answers under the live contract;
   * ANY entry that predates it (an absent fingerprint, or a differing one)
   * makes this `null` - the changed-contract marker every consumer treats
   * as "reprocess under the live contract, skip nothing". The marker is
   * derived per read, not read from a manifest-wide stamp, so a write that
   * recorded only some entries cannot cancel the reprocess owed to the
   * rest (the t_586d5d8b regression this field's derivation exists for).
   * A manifest file that does not exist reads back as current-shaped under
   * the LIVE contract - an empty manifest was never written under an older
   * one, so nothing in it can be stale.
   */
  readonly contract: ManifestContract | null;
}

/** Result of classifying a set of paths against a manifest. */
export interface PathClassification {
  /** On disk, absent from the manifest. */
  readonly new: string[];
  /** On disk, present in the manifest, bytes differ. */
  readonly modified: string[];
  /** On disk, present in the manifest, bytes identical. */
  readonly unchanged: string[];
  /** In the manifest (or requested) but no longer on disk. */
  readonly missing: string[];
}

/** Absolute path of the content-hash manifest for a vault. */
export function manifestPath(vault: string): string {
  return join(vault, MACHINE_ARTIFACT_DIR, MANIFEST_FILE);
}

/**
 * SHA-256 hex over raw bytes already in memory. The one digest every source
 * record in this repository uses, so a caller that read a file once for
 * another purpose records the same digest {@link hashFile} would.
 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * SHA-256 hex over a single file's raw bytes. Timestamp-independent: only the
 * content contributes to the digest. Throws if the path is a directory - use
 * {@link hashTree} for those.
 */
export function hashFile(absPath: string): string {
  const stat = statSync(absPath);
  if (stat.isDirectory()) {
    throw new Error(`hashFile: path is a directory, use hashTree: ${absPath}`);
  }
  return hashBytes(readFileSync(absPath));
}

/**
 * SHA-256 hex over a directory TREE, deterministic and content-only. Every
 * regular file under `dir` is enumerated, sorted by its POSIX relative path,
 * and folded into one digest as `<relPath>\0<fileContentHash>\n`. Because the
 * relative path is part of the digest, moving a file changes the tree hash even
 * if its bytes are unchanged; because file contents are hashed (not their
 * mtimes), a touch that leaves bytes identical does not.
 */
export function hashTree(dir: string): string {
  const rels: string[] = [];
  collectFilesRel(dir, "", rels);
  rels.sort();
  const hash = createHash("sha256");
  for (const rel of rels) {
    hash.update(rel);
    hash.update("\0");
    hash.update(hashFile(join(dir, rel)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** SHA-256 over a file or a directory tree, dispatching on the path's type. */
export function hashPath(absPath: string): string {
  return statSync(absPath).isDirectory() ? hashTree(absPath) : hashFile(absPath);
}

/**
 * Read the manifest for a vault. A missing file is an empty, current-shaped
 * manifest under the live contract (every path then classifies `new`). A
 * corrupted file is a hard error, and so is an unknown `schema_version` -
 * never a silent reset that would masquerade every source as unchanged or
 * force a full re-ingest without saying so. Legacy files are accepted and
 * degrade toward reprocessing: a v1 manifest (written before the contract
 * field existed) and a v2 manifest (written before per-entry fingerprints
 * existed) both read back with `contract: null` - the changed-contract
 * marker that makes every source reprocess once before the rewrite lands
 * as v3.
 */
export function readManifest(vault: string): ContentManifest {
  const path = manifestPath(vault);
  if (!existsSync(path)) {
    return {
      schema_version: SCHEMA_VERSION,
      entries: {},
      contract: { fingerprint: computeExtractionContractFingerprint(vault) },
    };
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`ingest manifest is corrupted JSON: ${path}`, { cause: e });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ingest manifest is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  const sv = obj["schema_version"];
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly unknown[]).includes(sv)) {
    throw new Error(
      `ingest manifest schema_version ${String(sv)} not supported ` +
        `(expected ${SUPPORTED_SCHEMA_VERSIONS.join(" or ")}): ${path}`,
    );
  }
  const entries = readEntries(obj);
  return {
    schema_version: sv as ManifestSchemaVersion,
    entries,
    contract: deriveContract(entries, vault),
  };
}

/**
 * The persisted entry map, across every read schema version: a bare digest
 * string (v1/v2) or a `{sha256, fingerprint}` object (v3) per entry.
 * Anything else a write could never have produced is dropped - the path then
 * classifies `new`, the fail-toward-reprocessing direction.
 */
function readEntries(obj: Record<string, unknown>): Record<string, ManifestEntry> {
  const entries: Record<string, ManifestEntry> = {};
  const rawEntries = obj["entries"];
  if (rawEntries === null || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
    return entries;
  }
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const entry = parseEntryValue(value);
    if (entry !== null) entries[key] = entry;
  }
  return entries;
}

/** One persisted entry value; see {@link readEntries} for the accepted shapes. */
function parseEntryValue(value: unknown): ManifestEntry | null {
  if (typeof value === "string") return { sha256: value };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["sha256"] !== "string") return null;
  const fingerprint = record["fingerprint"];
  return {
    sha256: record["sha256"],
    ...(typeof fingerprint === "string" ? { fingerprint } : {}),
  };
}

/**
 * The changed-contract decision, derived from the entries against the LIVE
 * contract: `null` while any entry predates it (no fingerprint, or a
 * fingerprint that differs - an empty manifest has no such entry), the live
 * contract once every entry has been re-recorded under it. The manifest-wide
 * marker on disk is deliberately not consulted: it is informational, and
 * consulting it is what let one source's ingest cancel the others' owed
 * reprocess (t_586d5d8b).
 */
function deriveContract(
  entries: Readonly<Record<string, ManifestEntry>>,
  vault: string,
): ManifestContract | null {
  const live = computeExtractionContractFingerprint(vault);
  for (const entry of Object.values(entries)) {
    if (entry.fingerprint !== live) return null;
  }
  return { fingerprint: live };
}

/**
 * Serialize `entries` to the canonical manifest bytes: keys sorted so the
 * output is deterministic regardless of insertion order, `schema_version` and
 * the contract field first, trailing newline. The shape follows the contract
 * argument the way {@link writeManifestAtomic} documents it.
 */
function serializeManifest(
  vault: string,
  entries: Readonly<Record<string, ManifestEntry>>,
  contract: ManifestContract | null | undefined,
): string {
  const sortedKeys = Object.keys(entries).toSorted();
  let body: Record<string, unknown>;
  if (contract === undefined) {
    // The post-extraction write: every entry passed in was just recorded
    // under the live contract, so each carries that fingerprint.
    const live = computeExtractionContractFingerprint(vault);
    const stamped: Record<string, ManifestEntry> = {};
    for (const key of sortedKeys) stamped[key] = { ...entries[key]!, fingerprint: live };
    body = { schema_version: SCHEMA_VERSION, contract: { fingerprint: live }, entries: stamped };
  } else if (
    contract === null &&
    !Object.values(entries).some((entry) => entry.fingerprint !== undefined)
  ) {
    // Legacy-shaped entries: the V1 shape - digests only, contract-less - so
    // a v1 read round-trips as v1 and the changed-contract marker survives.
    const digests: Record<string, string> = {};
    for (const key of sortedKeys) digests[key] = entries[key]!.sha256;
    body = { schema_version: 1, entries: digests };
  } else {
    const sorted: Record<string, ManifestEntry> = {};
    for (const key of sortedKeys) sorted[key] = entries[key]!;
    body =
      contract === null
        ? // Fingerprint-bearing entries with a `null` contract: v3 with the
          // live fingerprint as the marker. The marker is informational - the
          // read-side decision derives from the entries - so stamping it
          // cannot forfeit the owed reprocess the `null` protects.
          {
            schema_version: SCHEMA_VERSION,
            contract: { fingerprint: computeExtractionContractFingerprint(vault) },
            entries: sorted,
          }
        : { schema_version: SCHEMA_VERSION, contract, entries: sorted };
  }
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * Atomically write the manifest, but ONLY if its serialized bytes differ from
 * what is already on disk. Returns `true` when a write happened, `false` on a
 * no-op. The byte-identity check is what makes an all-unchanged rerun rewrite
 * nothing (and leaves the file's mtime alone).
 *
 * `contract` is what the write records, and the entries carry the per-entry
 * truth alongside it:
 *
 *   - Omitted: the post-extraction write. EVERY entry passed in was just
 *     recorded under the live contract, so each gets the live fingerprint
 *     stamped and the manifest lands as v3. A caller that reprocessed only
 *     SOME entries must not use this form - stamping the rest would forfeit
 *     their owed reprocess; {@link updateManifest} passes the explicit form
 *     below instead.
 *   - A contract object: the entries round-trip verbatim (untouched entries
 *     keep the fingerprint they were recorded under) and the object is
 *     recorded as the current-contract marker - informational only, since
 *     the read-side decision derives from the entries.
 *   - Explicit `null` (the changed-contract marker read back): legacy-shaped
 *     entries serialize as V1, contract-less, so the marker survives a write
 *     that reprocessed nothing; fingerprint-bearing entries serialize as v3
 *     with the live marker. Either way no entry gains a fingerprint it did
 *     not have, so the owed reprocess is never forfeited by an edit write
 *     (t_586d5d8b).
 */
export function writeManifestAtomic(
  vault: string,
  entries: Record<string, string | ManifestEntry>,
  contract?: ManifestContract | null,
): boolean {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = manifestPath(vault);
  const normalized: Record<string, ManifestEntry> = {};
  for (const [key, value] of Object.entries(entries)) {
    normalized[key] = typeof value === "string" ? { sha256: value } : value;
  }
  const next = serializeManifest(vault, normalized, contract);
  if (existsSync(path) && readFileSync(path, "utf8") === next) {
    return false;
  }
  atomicWriteFileSync(path, next);
  return true;
}

/**
 * Classify each requested path against the manifest by comparing its LIVE
 * content hash to the recorded digest:
 *   - not on disk            → `missing`,
 *   - on disk, not recorded  → `new`,
 *   - on disk, hash matches  → `unchanged`,
 *   - on disk, hash differs  → `modified`.
 * The buckets answer the BYTES question only - the extraction-contract
 * question is the manifest's derived `contract` field, kept deliberately
 * separate so a bytes-based read-back (the import census) is never affected
 * by contract staleness. Paths are canonicalized before lookup so they match
 * the keys written by {@link updateManifest}. Order within each bucket
 * follows the input order.
 */
export function classifyPaths(
  vault: string,
  paths: readonly string[],
  manifest: ContentManifest,
): PathClassification {
  const result: PathClassification = { new: [], modified: [], unchanged: [], missing: [] };
  for (const path of paths) {
    const canonical = canonicalNotePath(path);
    const abs = join(vault, canonical);
    if (!existsSync(abs)) {
      result.missing.push(canonical);
      continue;
    }
    const recorded = manifest.entries[canonical];
    const live = hashPath(abs);
    if (recorded === undefined) {
      result.new.push(canonical);
    } else if (recorded.sha256 === live) {
      result.unchanged.push(canonical);
    } else {
      result.modified.push(canonical);
    }
  }
  return result;
}

/**
 * Record post-ingest state for `paths`, merging into the existing manifest.
 * A path still on disk gets its current hash recorded TOGETHER with the live
 * contract fingerprint - the entry now answers under the live contract; a
 * path that has been deleted is dropped from the manifest (so it will
 * re-classify as `new` if it ever reappears). Entries for paths NOT in
 * `paths` round-trip untouched, fingerprint included, so ingesting one
 * source cannot mark the others as current (the t_586d5d8b regression this
 * per-entry stamping exists for). Writes atomically and skips the write
 * entirely when nothing changed. Returns `true` when the manifest was
 * rewritten.
 *
 * The read, the merge and the write are ONE critical section, held under the
 * same sync lock every other Brain read-modify-write takes. Atomicity alone is
 * not enough: `atomicWriteFileSync` renames a complete file into place, so no
 * reader sees torn bytes, but two processes that both read the manifest before
 * either wrote it would each write back a snapshot missing the other's entry.
 * The batch planner dispatches sources across parallel subagents, so that
 * overlap is the designed case rather than a rare one.
 */
export function updateManifest(vault: string, paths: readonly string[]): boolean {
  const handle = acquireLockSyncWithRetry(manifestPath(vault), undefined, {
    remedy: ingestLockRemedy,
  });
  try {
    const entries: Record<string, ManifestEntry> = { ...readManifest(vault).entries };
    const live = computeExtractionContractFingerprint(vault);
    for (const path of paths) {
      const canonical = canonicalNotePath(path);
      const abs = join(vault, canonical);
      if (existsSync(abs)) {
        entries[canonical] = { sha256: hashPath(abs), fingerprint: live };
      } else {
        delete entries[canonical];
      }
    }
    // Explicit contract: the live fingerprint rides along as the
    // current-contract MARKER only. The omitted form would stamp every entry
    // as current, and the untouched entries here may predate the live
    // contract - their owed reprocess must survive this write.
    return writeManifestAtomic(vault, entries, { fingerprint: live });
  } finally {
    handle.release();
  }
}

/** Recursively collect regular-file relative paths under `dir` (POSIX slashes). */
function collectFilesRel(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectFilesRel(join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

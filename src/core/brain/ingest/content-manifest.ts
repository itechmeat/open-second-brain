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

/** Only schema version currently understood. Unknown versions are refused. */
const SCHEMA_VERSION = 1 as const;

/** Vault-relative directory holding OSB machine artifacts (not curated memory). */
const MACHINE_ARTIFACT_DIR = ".open-second-brain";

/** Basename of the ingest content-hash manifest. */
const MANIFEST_FILE = "ingest-manifest.json";

/**
 * The persisted manifest: a map from a canonical vault-relative source path to
 * the SHA-256 hex of its content at last ingest.
 */
export interface ContentManifest {
  readonly schema_version: typeof SCHEMA_VERSION;
  /** Canonical vault-relative path → 64-char lowercase SHA-256 hex of content. */
  readonly entries: Readonly<Record<string, string>>;
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
 * SHA-256 hex over a single file's raw bytes. Timestamp-independent: only the
 * content contributes to the digest. Throws if the path is a directory - use
 * {@link hashTree} for those.
 */
export function hashFile(absPath: string): string {
  const stat = statSync(absPath);
  if (stat.isDirectory()) {
    throw new Error(`hashFile: path is a directory, use hashTree: ${absPath}`);
  }
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
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
 * Read the manifest for a vault. A missing file is an empty manifest (every
 * path then classifies `new`). A corrupted file or an unknown `schema_version`
 * is a hard error - never a silent reset that would masquerade every source as
 * unchanged or force a full re-ingest without saying so.
 */
export function readManifest(vault: string): ContentManifest {
  const path = manifestPath(vault);
  if (!existsSync(path)) {
    return { schema_version: SCHEMA_VERSION, entries: {} };
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
  if (sv !== SCHEMA_VERSION) {
    throw new Error(
      `ingest manifest schema_version ${String(sv)} not supported (expected ${SCHEMA_VERSION}): ${path}`,
    );
  }
  const rawEntries = obj["entries"];
  const entries: Record<string, string> = {};
  if (rawEntries !== null && typeof rawEntries === "object" && !Array.isArray(rawEntries)) {
    for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (typeof value === "string") entries[key] = value;
    }
  }
  return { schema_version: SCHEMA_VERSION, entries };
}

/**
 * Serialize `entries` to the canonical manifest bytes: keys sorted so the
 * output is deterministic regardless of insertion order, `schema_version`
 * first, trailing newline.
 */
function serializeManifest(entries: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(entries).toSorted()) {
    sorted[key] = entries[key]!;
  }
  return JSON.stringify({ schema_version: SCHEMA_VERSION, entries: sorted }, null, 2) + "\n";
}

/**
 * Atomically write the manifest, but ONLY if its serialized bytes differ from
 * what is already on disk. Returns `true` when a write happened, `false` on a
 * no-op. The byte-identity check is what makes an all-unchanged rerun rewrite
 * nothing (and leaves the file's mtime alone).
 */
export function writeManifestAtomic(vault: string, entries: Record<string, string>): boolean {
  const path = manifestPath(vault);
  const next = serializeManifest(entries);
  if (existsSync(path) && readFileSync(path, "utf8") === next) {
    return false;
  }
  atomicWriteFileSync(path, next);
  return true;
}

/**
 * Classify each requested path against the manifest by comparing its LIVE
 * content hash to the recorded one:
 *   - not on disk            → `missing`,
 *   - on disk, not recorded  → `new`,
 *   - on disk, hash matches  → `unchanged`,
 *   - on disk, hash differs  → `modified`.
 * Paths are canonicalized before lookup so they match the keys written by
 * {@link updateManifest}. Order within each bucket follows the input order.
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
    } else if (recorded === live) {
      result.unchanged.push(canonical);
    } else {
      result.modified.push(canonical);
    }
  }
  return result;
}

/**
 * Record post-ingest content hashes for `paths`, merging into the existing
 * manifest. A path still on disk gets its current hash recorded; a path that
 * has been deleted is dropped from the manifest (so it will re-classify as
 * `new` if it ever reappears). Writes atomically and skips the write entirely
 * when nothing changed. Returns `true` when the manifest was rewritten.
 */
export function updateManifest(vault: string, paths: readonly string[]): boolean {
  const entries: Record<string, string> = { ...readManifest(vault).entries };
  for (const path of paths) {
    const canonical = canonicalNotePath(path);
    const abs = join(vault, canonical);
    if (existsSync(abs)) {
      entries[canonical] = hashPath(abs);
    } else {
      delete entries[canonical];
    }
  }
  return writeManifestAtomic(vault, entries);
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

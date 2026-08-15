/**
 * SHA-256 file inventory over `Brain/` minus the entries the snapshot
 * family never touches, plus the record of what the snapshot did with
 * the derived SQLite store that lives one directory away, plus why the
 * snapshot was taken at all.
 *
 * Symlinks are dropped via `lstatSync` — a malicious snapshot archive
 * planting a symlink under `Brain/` must not let the walker hash
 * `/etc/passwd`. Output is sorted by path so two runs against
 * identical bytes produce byte-identical JSON on disk.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sha256Hex } from "../integrity/digest.ts";
import { pathCovers } from "../vault-scope/defaults.ts";
import { BRAIN_ROOT_REL, BRAIN_SNAPSHOT_EXCLUDED_ENTRIES, brainDirs } from "./paths.ts";
import { isoSecond } from "./time.ts";
import { isBrainSnapshotReason, type BrainSnapshotReason } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/**
 * NOT bumped by the derived-store or snapshot-reason fields, deliberately.
 *
 * {@link readManifestSidecar} rejects any version it does not recognize,
 * and the snapshots directory rides the same peer-to-peer replication as
 * the rest of the vault. Bumping would therefore make every older peer
 * read `null` for every NEW sidecar and silently lose drift detection on
 * exactly the snapshots that matter most. An additive key at the current
 * version is ignored by those readers and their guarantee is untouched,
 * which is this project's additive-only rule for persisted formats.
 */
export const BRAIN_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * The release that introduced the sidecar manifest, and therefore the
 * release before which a snapshot has no drift record at all.
 *
 * Named once because the warning the CLI prints, the help text that
 * explains it, and the operating manual all state it, and three
 * hand-kept copies of one version string is three chances to be wrong.
 */
export const BRAIN_MANIFEST_SIDECAR_SINCE_VERSION = "v0.10.6";

/**
 * Why a snapshot does not carry the derived store.
 *
 * Four members, and none of them is "it failed": inclusion never
 * degrades into an omission at snapshot time. When the store WAS
 * requested and any step could not be completed, `createSnapshot` throws
 * and no archive is left behind - the reason then travels in the error
 * rather than in a manifest that would claim a snapshot happened. These
 * codes are what a manifest can honestly record about a snapshot that
 * SUCCEEDED without the store in it.
 */
export const SNAPSHOT_STORE_EXCLUSION = Object.freeze({
  /** Coverage is off (the default). Nothing was attempted. */
  not_requested: "not-requested",
  /** There is no store file at the resolved path. */
  absent: "absent",
  /** The structural integrity scan condemned the file. */
  integrity_fault: "integrity-fault",
  /** The live store is larger than the configured ceiling. */
  over_size_ceiling: "over-size-ceiling",
} as const);

/** Closed union over {@link SNAPSHOT_STORE_EXCLUSION}. */
export type SnapshotStoreExclusionReason =
  (typeof SNAPSHOT_STORE_EXCLUSION)[keyof typeof SNAPSHOT_STORE_EXCLUSION];

/** Membership list, in the order the reasons are evaluated. */
export const SNAPSHOT_STORE_EXCLUSION_REASONS: ReadonlyArray<SnapshotStoreExclusionReason> =
  Object.freeze([
    SNAPSHOT_STORE_EXCLUSION.not_requested,
    SNAPSHOT_STORE_EXCLUSION.absent,
    SNAPSHOT_STORE_EXCLUSION.integrity_fault,
    SNAPSHOT_STORE_EXCLUSION.over_size_ceiling,
  ]);

/** Narrow a string read back off a sidecar written by any peer. */
export function isSnapshotStoreExclusionReason(
  value: unknown,
): value is SnapshotStoreExclusionReason {
  return (
    typeof value === "string" &&
    (SNAPSHOT_STORE_EXCLUSION_REASONS as ReadonlyArray<string>).includes(value)
  );
}

export interface BrainManifestEntry {
  readonly sha256: string;
  readonly size: number;
}

/**
 * What one snapshot did about the derived SQLite store.
 *
 * ## Why `live_size` is recorded even when nothing was archived
 *
 * What derived-store coverage protects is SPEND, not information:
 * feedback, activation and tuning are replayable JSON folds inside
 * `Brain/`, and only the embeddings and a tier baseline are
 * database-only. So the question an operator actually has is "what would
 * this cost me", and the answer is a number they should not have to go
 * and measure. Retention keeps ten copies and the snapshots directory is
 * replicated to every peer, so the honest framing is ten times this
 * number on every device - which is exactly why coverage is opt-in, why
 * the ceiling refuses rather than truncates, and why this field is
 * present in every manifest whether or not the store was included.
 */
export interface BrainManifestDerivedStore {
  /** True when {@link archive_name} names a real sibling archive. */
  readonly included: boolean;
  /** Resolved absolute path of the live store this record describes. */
  readonly source_path: string;
  /** Filename of the sibling archive in `.snapshots/`; null when excluded. */
  readonly archive_name: string | null;
  /** SHA-256 over the archived (compressed) bytes; null when excluded. */
  readonly archive_sha256: string | null;
  /** Byte length of the archive as written; null when excluded. */
  readonly archive_size: number | null;
  /**
   * Byte length of the LIVE store at snapshot time. `null` means the
   * file was not there to measure - never "zero", which is a real size a
   * freshly created database can legitimately have.
   */
  readonly live_size: number | null;
  /** Named reason from {@link SNAPSHOT_STORE_EXCLUSION}; null when included. */
  readonly exclusion_reason: SnapshotStoreExclusionReason | null;
}

export interface BrainManifest {
  readonly schema_version: typeof BRAIN_MANIFEST_SCHEMA_VERSION;
  /** ISO-8601 UTC, second precision. */
  readonly generated_at: string;
  readonly brain_root: typeof BRAIN_ROOT_REL;
  /** Keys are vault-relative paths under `Brain/`, sorted lexicographically. */
  readonly files: Readonly<Record<string, BrainManifestEntry>>;
  /**
   * Set when a `derived_store` record was present and could not be read.
   *
   * Distinct from the field's absence, which means the snapshot predates
   * derived-store coverage. A caller that would restore the store must
   * refuse on this; a caller that only compares the Markdown tree may
   * ignore it, which is the whole reason the failure is contained here
   * rather than discarding the file map.
   */
  readonly derived_store_unreadable?: true;
  /**
   * Set when a `snapshot_reason` was present and is not a reason this
   * build registers - typically written by a later build, since the
   * vault replicates between machines that need not run the same one.
   *
   * The provenance is unusable and says so; the drift comparison the rest
   * of this record supports is unaffected.
   */
  readonly snapshot_reason_unreadable?: true;
  /**
   * Absent on every sidecar written before derived-store coverage
   * shipped. Absent means UNKNOWN - the snapshot predates the feature
   * and nothing can be said about what it covered. It must never be
   * rendered as `excluded`, which is a claim that a check ran.
   */
  readonly derived_store?: BrainManifestDerivedStore;
  /**
   * Why the recovery point was taken (U7). Absent on every sidecar
   * written before the reason existed, and absence is UNKNOWN: the run id
   * that names the archive begins with a registered reason at every call
   * site that writes one, so the temptation to recover the field by
   * parsing that prefix is real - and it would manufacture provenance the
   * archive does not carry, for a hand-named or third-party archive just
   * as readily as for one of ours. The key is omitted rather than nulled
   * so absence has exactly one spelling.
   */
  readonly snapshot_reason?: BrainSnapshotReason;
}

export interface BrainManifestDiffEntry {
  readonly path: string;
  readonly before: BrainManifestEntry | null;
  readonly after: BrainManifestEntry | null;
}

export interface BrainManifestDiff {
  readonly added: ReadonlyArray<BrainManifestDiffEntry>;
  readonly removed: ReadonlyArray<BrainManifestDiffEntry>;
  readonly changed: ReadonlyArray<BrainManifestDiffEntry>;
}

// ---------- buildManifest --------------------------------------------------

/**
 * The two facts about a snapshot that the walker cannot discover for
 * itself, so the archiver hands them over.
 *
 * Both are omitted by the live-tree rebuild the drift check performs, and
 * that is correct rather than lax: drift is computed over `files` alone,
 * so a live manifest carrying neither field stays comparable with a
 * stored one carrying both.
 */
export interface BuildManifestOptions {
  /** What the snapshot did about the sibling SQLite store. */
  readonly derivedStore?: BrainManifestDerivedStore;
  /** Why the recovery point was taken. */
  readonly snapshotReason?: BrainSnapshotReason;
}

/**
 * Walk `brainRoot` (the `<vault>/Brain/` directory) and hash every
 * regular file. The caller is responsible for pointing at the
 * `Brain/` directory itself — passing a vault root would silently
 * include sibling user content the Brain layer does not own.
 *
 * The walker is iterative (explicit stack) to keep recursion depth
 * predictable on deeply-nested vault trees. Files are hashed
 * one-at-a-time; Brain trees in practice stay well under 10 MB.
 *
 * Only the archiver knows whether a store archive was written and why the
 * snapshot was taken, so both travel in {@link BuildManifestOptions}
 * rather than being rediscovered here.
 */
export function buildManifest(brainRoot: string, opts: BuildManifestOptions = {}): BrainManifest {
  const generated_at = isoSecond();
  const collected = new Map<string, BrainManifestEntry>();

  if (!existsSync(brainRoot)) {
    return freezeManifest(generated_at, collected, opts);
  }

  const stack: string[] = [brainRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: ReadonlyArray<string>;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      // Skip symlinks unconditionally — see module docstring.
      if (st.isSymbolicLink()) continue;
      const rel = relative(brainRoot, abs).replaceAll("\\", "/");
      // The entries the snapshot family never touches. Hashing something
      // the archive does not contain and the restore does not replace
      // makes the drift gate fire on churn no rollback would ever undo.
      if (BRAIN_SNAPSHOT_EXCLUDED_ENTRIES.some((entry) => pathCovers(entry, rel))) {
        continue;
      }
      // Defense-in-depth: a `..` path *segment* cannot legitimately
      // appear inside a sane Brain tree. `pathCovers` anchors on the
      // segment boundary, so an otherwise-valid filename like
      // `..notes.md` (legal as a Unix dotfile) is not silently dropped
      // from manifest coverage.
      if (pathCovers("..", rel)) continue;
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      collected.set(rel, hashFile(abs));
    }
  }

  return freezeManifest(generated_at, collected, opts);
}

function hashFile(abs: string): BrainManifestEntry {
  // Derive size from the actually-hashed bytes rather than the
  // pre-read `lstat` so the (sha256, size) pair always describes
  // the same payload. If the file changed between stat and read,
  // the stat-based size could disagree with the hash and confuse a
  // future drift comparison.
  const buf = readFileSync(abs);
  const sha256 = sha256Hex(buf);
  return Object.freeze({ sha256, size: buf.byteLength });
}

function freezeManifest(
  generated_at: string,
  entries: Map<string, BrainManifestEntry>,
  opts: BuildManifestOptions,
): BrainManifest {
  // Materialise in sorted key order so JSON.stringify yields stable
  // bytes across runs.
  const sorted = Array.from(entries.keys()).toSorted();
  const files: Record<string, BrainManifestEntry> = {};
  for (const k of sorted) files[k] = entries.get(k)!;
  return Object.freeze({
    schema_version: BRAIN_MANIFEST_SCHEMA_VERSION,
    generated_at,
    brain_root: BRAIN_ROOT_REL,
    files: Object.freeze(files),
    // Spread rather than assign, for both optional keys: a manifest built
    // without a record must OMIT the key, because an explicit `undefined`
    // would serialise the same as absent here but read as present to a
    // structural check, and absent is a load-bearing state (unknown, not
    // excluded; unstamped, not reason-less).
    ...(opts.derivedStore !== undefined ? { derived_store: Object.freeze(opts.derivedStore) } : {}),
    ...(opts.snapshotReason !== undefined ? { snapshot_reason: opts.snapshotReason } : {}),
  });
}

// ---------- diffManifests --------------------------------------------------

/**
 * Sort order for every diff bucket: one comparator, defined once. The three
 * buckets must agree, and a comparator rebuilt per call is three chances for
 * them to stop agreeing.
 */
const byManifestPath = (a: BrainManifestDiffEntry, b: BrainManifestDiffEntry): number =>
  a.path.localeCompare(b.path);

/**
 * Compute the path-keyed diff between two manifests. Order of the
 * arguments matters: `before → after` is the conventional direction
 * (left is the older state).
 *
 * Each bucket is sorted by `path` ascending for stable rendering.
 */
export function diffManifests(before: BrainManifest, after: BrainManifest): BrainManifestDiff {
  const added: BrainManifestDiffEntry[] = [];
  const removed: BrainManifestDiffEntry[] = [];
  const changed: BrainManifestDiffEntry[] = [];
  const seen = new Set<string>();

  for (const path of Object.keys(before.files)) {
    seen.add(path);
    const left = before.files[path]!;
    const right = after.files[path];
    if (right === undefined) {
      removed.push({ path, before: left, after: null });
      continue;
    }
    if (left.sha256 !== right.sha256 || left.size !== right.size) {
      changed.push({ path, before: left, after: right });
    }
  }
  for (const path of Object.keys(after.files)) {
    if (seen.has(path)) continue;
    const right = after.files[path]!;
    added.push({ path, before: null, after: right });
  }

  added.sort(byManifestPath);
  removed.sort(byManifestPath);
  changed.sort(byManifestPath);
  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
  });
}

/** Convenience: `true` when any of the three buckets is non-empty. */
export function manifestDiffHasDrift(diff: BrainManifestDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

/**
 * Compact human-readable render of a manifest diff for the rollback
 * drift-detection abort message. Sections are emitted only when their
 * bucket is non-empty so the operator's eye lands on real differences.
 */
export function renderManifestDriftMarkdown(diff: BrainManifestDiff, runId: string): string {
  const lines: string[] = [
    `Drift detected between snapshot '${runId}' and the live Brain/ tree.`,
    `Pass --force-rollback to overwrite anyway.`,
    ``,
  ];
  if (diff.added.length > 0) {
    lines.push(`Added in live (${diff.added.length}):`);
    for (const e of diff.added) lines.push(`  - ${e.path}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`Removed from live (${diff.removed.length}):`);
    for (const e of diff.removed) lines.push(`  - ${e.path}`);
  }
  if (diff.changed.length > 0) {
    lines.push(`Changed in live (${diff.changed.length}):`);
    for (const e of diff.changed) lines.push(`  - ${e.path}`);
  }
  return lines.join("\n");
}

/** Structured form of {@link renderManifestDriftMarkdown} for `--json`. */
export function renderManifestDriftJson(
  diff: BrainManifestDiff,
  runId: string,
): {
  run_id: string;
  drift: boolean;
  added: ReadonlyArray<string>;
  removed: ReadonlyArray<string>;
  changed: ReadonlyArray<string>;
} {
  return {
    run_id: runId,
    drift: manifestDiffHasDrift(diff),
    added: diff.added.map((e) => e.path),
    removed: diff.removed.map((e) => e.path),
    changed: diff.changed.map((e) => e.path),
  };
}

// ---------- Sidecar I/O ----------------------------------------------------

/**
 * Path of the sidecar manifest for a given snapshot run id. Lives in
 * `<vault>/Brain/.snapshots/<run-id>.manifest.json` so list and prune
 * operations stay symmetrical with the archive itself.
 */
export function manifestSidecarPath(vault: string, runId: string): string {
  return join(brainDirs(vault).snapshots, `${runId}.manifest.json`);
}

/**
 * Read the sidecar manifest for `runId`. Returns `null` when the file
 * is missing, unreadable, malformed JSON, or carries an unknown
 * schema_version — callers fall back to the legacy "no drift check"
 * path on a null return.
 */
export function readManifestSidecar(vault: string, runId: string): BrainManifest | null {
  const path = manifestSidecarPath(vault, runId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== BRAIN_MANIFEST_SCHEMA_VERSION) return null;
  if (obj["brain_root"] !== BRAIN_ROOT_REL) return null;
  if (typeof obj["generated_at"] !== "string") return null;
  const files = obj["files"];
  if (files === null || typeof files !== "object") return null;
  // Validate every entry shape. The sidecar lives on the same
  // distribution channel as the live tree (Syncthing, manual
  // backups, hand-edited by an operator who lost their nerves) —
  // we never trust the on-disk bytes without checking. A single
  // malformed entry forces the whole manifest to `null` so the
  // rollback path degrades to the legacy "no drift check" branch
  // instead of crashing in `diffManifests` later.
  const entries: Record<string, BrainManifestEntry> = {};
  for (const [path, raw] of Object.entries(files as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") return null;
    const entry = raw as Record<string, unknown>;
    if (typeof entry["sha256"] !== "string") return null;
    if (typeof entry["size"] !== "number") return null;
    entries[path] = Object.freeze({
      sha256: entry["sha256"],
      size: entry["size"],
    });
  }
  // The derived-store record follows the SAME rule as the file map: an
  // absent key is a legal older sidecar, a present-but-malformed one
  // fails the whole manifest closed. Anything looser would let a
  // half-written record claim a coverage the archive does not have.
  const rawStore = obj["derived_store"];
  let derivedStore: BrainManifestDerivedStore | undefined;
  // An unreadable OPTIONAL field does not void the mandatory record.
  //
  // Failing the whole manifest closed was the first shape of this, and it
  // reproduced the loss that keeping `schema_version` at 1 exists to
  // prevent: a peer running a later build writes a value this one does
  // not know, this one discards the file map with it, and the rollback
  // gate then reports no sidecar at all and skips drift detection - the
  // silent-overwrite path, reached by a different route and announced
  // with a message that is false twice over.
  //
  // So each optional field has three states rather than two. Valid,
  // absent, or present-and-unreadable - and the third is recorded, never
  // folded into either of the others, because a caller that acts on the
  // field needs to refuse while a caller that only needs the file map
  // carries on.
  let derivedStoreUnreadable = false;
  if (rawStore !== undefined) {
    const parsedStore = parseDerivedStore(rawStore);
    if (parsedStore === null) derivedStoreUnreadable = true;
    else derivedStore = parsedStore;
  }
  const rawReason = obj["snapshot_reason"];
  const reasonUnreadable = rawReason !== undefined && !isBrainSnapshotReason(rawReason);

  return Object.freeze({
    schema_version: BRAIN_MANIFEST_SCHEMA_VERSION,
    generated_at: obj["generated_at"],
    brain_root: BRAIN_ROOT_REL,
    files: Object.freeze(entries),
    ...(derivedStore !== undefined ? { derived_store: derivedStore } : {}),
    ...(derivedStoreUnreadable ? { derived_store_unreadable: true as const } : {}),
    ...(!reasonUnreadable && rawReason !== undefined ? { snapshot_reason: rawReason } : {}),
    ...(reasonUnreadable ? { snapshot_reason_unreadable: true as const } : {}),
  });
}

/** `null` on any malformation, so the caller can fail the manifest closed. */
function parseDerivedStore(raw: unknown): BrainManifestDerivedStore | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const included = rec["included"];
  const sourcePath = rec["source_path"];
  if (typeof included !== "boolean") return null;
  if (typeof sourcePath !== "string" || sourcePath === "") return null;

  const archiveName = nullableOf(rec["archive_name"], (v) => typeof v === "string" && v !== "");
  const archiveSha = nullableOf(rec["archive_sha256"], (v) => typeof v === "string" && v !== "");
  const archiveSize = nullableOf(rec["archive_size"], isNonNegativeInteger);
  const liveSize = nullableOf(rec["live_size"], isNonNegativeInteger);
  const reason = nullableOf(rec["exclusion_reason"], isSnapshotStoreExclusionReason);
  if (
    archiveName === INVALID ||
    archiveSha === INVALID ||
    archiveSize === INVALID ||
    liveSize === INVALID ||
    reason === INVALID
  ) {
    return null;
  }

  // Cross-field consistency. A record claiming inclusion without the
  // three fields that make the archive verifiable is not a weaker
  // record, it is a false one - and the same holds in reverse for an
  // exclusion that names no reason.
  const archived = archiveName !== null && archiveSha !== null && archiveSize !== null;
  if (included !== archived) return null;
  if (included === (reason !== null)) return null;

  return Object.freeze({
    included,
    source_path: sourcePath,
    archive_name: archiveName as string | null,
    archive_sha256: archiveSha as string | null,
    archive_size: archiveSize as number | null,
    live_size: liveSize as number | null,
    exclusion_reason: reason as SnapshotStoreExclusionReason | null,
  });
}

/**
 * Sentinel for "the value was present and did not satisfy the check".
 * Distinct from `null`, which is a legal recorded value in every one of
 * these fields, so a rejection can never be mistaken for a null.
 */
const INVALID = Symbol("invalid-manifest-field");

/** `null`, a value passing `check`, or {@link INVALID}. */
function nullableOf(value: unknown, check: (v: unknown) => boolean): unknown {
  if (value === null) return null;
  return check(value) ? value : INVALID;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Write the sidecar manifest atomically. Pretty-printed with two-space
 * indent so a manual `cat` or `git diff` stays readable.
 */
export function writeManifestSidecar(vault: string, runId: string, manifest: BrainManifest): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = manifestSidecarPath(vault, runId);
  atomicWriteFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

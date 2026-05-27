/**
 * SHA-256 file inventory over `Brain/` minus `.snapshots/`.
 *
 * Symlinks are dropped via `lstatSync` — a malicious snapshot archive
 * planting a symlink under `Brain/` must not let the walker hash
 * `/etc/passwd`. Output is sorted by path so two runs against
 * identical bytes produce byte-identical JSON on disk.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { BRAIN_ROOT_REL, brainDirs } from "./paths.ts";
import { isoSecond } from "./time.ts";

export const BRAIN_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface BrainManifestEntry {
  readonly sha256: string;
  readonly size: number;
}

export interface BrainManifest {
  readonly schema_version: typeof BRAIN_MANIFEST_SCHEMA_VERSION;
  /** ISO-8601 UTC, second precision. */
  readonly generated_at: string;
  readonly brain_root: typeof BRAIN_ROOT_REL;
  /** Keys are vault-relative paths under `Brain/`, sorted lexicographically. */
  readonly files: Readonly<Record<string, BrainManifestEntry>>;
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
 * Walk `brainRoot` (the `<vault>/Brain/` directory) and hash every
 * regular file. The caller is responsible for pointing at the
 * `Brain/` directory itself — passing a vault root would silently
 * include sibling user content the Brain layer does not own.
 *
 * The walker is iterative (explicit stack) to keep recursion depth
 * predictable on deeply-nested vault trees. Files are hashed
 * one-at-a-time; Brain trees in practice stay well under 10 MB.
 */
export function buildManifest(brainRoot: string): BrainManifest {
  const generated_at = isoSecond();
  const collected = new Map<string, BrainManifestEntry>();

  if (!existsSync(brainRoot)) {
    return freezeManifest(generated_at, collected);
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
      // `.snapshots/` is the snapshot family's home; including its
      // contents in the manifest would either explode the listing or
      // create a self-referential loop on rotate.
      if (rel === ".snapshots" || rel.startsWith(".snapshots/")) continue;
      // Defense-in-depth: a `..` path *segment* cannot legitimately
      // appear inside a sane Brain tree. We anchor on the segment
      // boundary so an otherwise-valid filename like `..notes.md`
      // (legal as a Unix dotfile) is not silently dropped from
      // manifest coverage.
      if (rel === ".." || rel.startsWith("../")) continue;
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      collected.set(rel, hashFile(abs));
    }
  }

  return freezeManifest(generated_at, collected);
}

function hashFile(abs: string): BrainManifestEntry {
  // Derive size from the actually-hashed bytes rather than the
  // pre-read `lstat` so the (sha256, size) pair always describes
  // the same payload. If the file changed between stat and read,
  // the stat-based size could disagree with the hash and confuse a
  // future drift comparison.
  const buf = readFileSync(abs);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return Object.freeze({ sha256, size: buf.byteLength });
}

function freezeManifest(
  generated_at: string,
  entries: Map<string, BrainManifestEntry>,
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
  });
}

// ---------- diffManifests --------------------------------------------------

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

  const cmp = (a: BrainManifestDiffEntry, b: BrainManifestDiffEntry): number =>
    a.path.localeCompare(b.path);
  added.sort(cmp);
  removed.sort(cmp);
  changed.sort(cmp);
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
  return Object.freeze({
    schema_version: BRAIN_MANIFEST_SCHEMA_VERSION,
    generated_at: obj["generated_at"],
    brain_root: BRAIN_ROOT_REL,
    files: Object.freeze(entries),
  });
}

/**
 * Write the sidecar manifest atomically. Pretty-printed with two-space
 * indent so a manual `cat` or `git diff` stays readable.
 */
export function writeManifestSidecar(vault: string, runId: string, manifest: BrainManifest): void {
  const path = manifestSidecarPath(vault, runId);
  atomicWriteFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

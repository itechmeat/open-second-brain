/**
 * Open-loops live scan (today-operator-surface, Task 2).
 *
 * An open loop is an `@osb loop <free text>` marker jotted into note
 * prose. It stays in the prose forever and is never consumed; it counts
 * as open until a structural close token `@osb loop close id=<id>`
 * referencing its id appears anywhere in the scanned note space. There
 * is no store - the open set is re-derived on every call, so a hand
 * edit that deletes the marker silently closes the loop (accepted, per
 * design.md).
 *
 * This module is strictly read-only: it walks the configured note paths
 * via {@link walkMarkdownFiles}, discovers markers with
 * {@link discoverMarkers} (fence-aware, consumed-sentinel-skipping), and
 * computes the open set. It never writes a signal, rewrites a file, or
 * annotates a marker. Feedback and `set` markers in the same files are
 * ignored - only `kind === "loop"` markers are read here.
 *
 * Determinism: files are scanned in sorted vault-relative-path order and
 * markers within a file in document order, so "first occurrence in walk
 * order" (used to collapse duplicate ids) is stable across runs. No wall
 * clock is read; the returned envelope is deeply frozen.
 *
 * Loop id: an explicit `id=` on the marker wins; otherwise the id is the
 * first 8 hex chars of the SHA-256 of the normalized loop text
 * (trim + collapse whitespace runs to single spaces, byte-exact
 * otherwise - no case folding, so it is language-agnostic). Editing the
 * text therefore changes the id and reopens the loop, which is the
 * honest reading of "the intention changed".
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { discoverMarkers, type ParsedMarker } from "./inline.ts";
import {
  buildNoteWalkRules,
  resolveNoteRoots,
  walkMarkdownFiles,
  type NoteWalkFile,
} from "./notes/note-walk.ts";

/** Same 1 MiB per-file cap `scanInline` applies. */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/** One open loop in the derived open set. */
export interface OpenLoop {
  /** Explicit `id=` value, or the derived short hash of the loop text. */
  readonly id: string;
  /** The loop's free text (whitespace-collapsed by the parser). */
  readonly text: string;
  /** Vault-relative POSIX path of the note the marker sits in. */
  readonly path: string;
  /** 1-based line where the marker starts. */
  readonly line: number;
}

/**
 * A second-or-later open marker sharing an id already claimed by an
 * earlier marker in walk order. The earlier marker is the canonical
 * open loop; these extras are reported so the operator can see the
 * collision rather than have it silently dropped.
 */
export interface DuplicateOpenLoop {
  readonly id: string;
  readonly text: string;
  readonly path: string;
  readonly line: number;
}

/**
 * A `@osb loop close id=<id>` token whose id matches no open marker
 * anywhere in the scanned space. Not an error - the open marker may have
 * been hand-deleted (design.md accepts prose edits as loop closure) - so
 * it is surfaced for visibility instead of failing the scan.
 */
export interface OrphanClose {
  readonly id: string;
  readonly path: string;
  readonly line: number;
}

export interface OpenLoopCounts {
  /** Distinct open loops still open (equals `openLoops.length`). */
  readonly openCount: number;
  /** Distinct open-loop ids that have a matching close token. */
  readonly closedCount: number;
  /** Number of note files actually read during the scan. */
  readonly scannedFiles: number;
}

/** Frozen result envelope of {@link scanOpenLoops}. */
export interface OpenLoopScan {
  readonly openLoops: ReadonlyArray<OpenLoop>;
  readonly counts: OpenLoopCounts;
  readonly duplicates: ReadonlyArray<DuplicateOpenLoop>;
  readonly orphanCloses: ReadonlyArray<OrphanClose>;
}

export interface ScanOpenLoopsOptions {
  /** Explicit vault-relative roots; overrides `notes.read_paths`. */
  readonly paths?: ReadonlyArray<string>;
  /** Extra vault-relative exclude prefixes. */
  readonly exclude?: ReadonlyArray<string>;
  /** Per-file byte cap. Defaults to the 1 MiB `scanInline` cap. */
  readonly maxFileSizeBytes?: number;
}

/**
 * Collapse a loop text to its id-normal form: trim, then collapse every
 * run of whitespace to a single space. No case folding - the hash must
 * be byte-exact so non-Latin scripts are handled identically.
 */
function normaliseLoopText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Derive the deterministic short id from a loop's normalized text. */
function deriveLoopId(text: string): string {
  return createHash("sha256").update(normaliseLoopText(text), "utf8").digest("hex").slice(0, 8);
}

/** Explicit `id=` wins; otherwise derive from the loop text. */
function resolveLoopId(marker: ParsedMarker): string {
  if (typeof marker.id === "string" && marker.id.length > 0) return marker.id;
  return deriveLoopId(marker.text ?? "");
}

interface OpenRecord {
  readonly id: string;
  readonly text: string;
  readonly path: string;
  readonly line: number;
}

interface CloseRecord {
  readonly id: string;
  readonly path: string;
  readonly line: number;
}

/**
 * Scan the configured note space and compute the open-loop set.
 *
 * Read-only and deterministic. Returns a frozen {@link OpenLoopScan}.
 * When no note paths are configured the scan is a well-formed empty
 * result rather than an error - there is simply nothing to walk.
 */
export function scanOpenLoops(vault: string, opts: ScanOpenLoopsOptions = {}): OpenLoopScan {
  const roots = resolveNoteRoots(vault, opts.paths);
  if (roots.length === 0) return emptyScan();

  const rules = buildNoteWalkRules(vault, opts.exclude);
  const cap = opts.maxFileSizeBytes ?? MAX_FILE_SIZE_BYTES;

  // Collect every file first so we can scan in a deterministic
  // vault-relative-path order independent of the walker's internal
  // traversal order. This is what makes "first occurrence in walk
  // order" (duplicate collapse) stable across runs.
  const files: NoteWalkFile[] = [
    ...walkMarkdownFiles(vault, roots, rules, { maxFileSizeBytes: cap }),
  ];
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const opens: OpenRecord[] = [];
  const closes: CloseRecord[] = [];
  let scannedFiles = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.absPath, "utf8");
    } catch {
      continue; // races a delete - skip, do not count
    }
    scannedFiles++;
    for (const marker of discoverMarkers(content)) {
      if (marker.kind !== "loop") continue; // feedback / set ignored
      if (marker.loop === "close") {
        if (typeof marker.id === "string" && marker.id.length > 0) {
          closes.push({ id: marker.id, path: file.relPath, line: marker.originLine });
        }
        continue;
      }
      if (marker.loop === "open") {
        opens.push({
          id: resolveLoopId(marker),
          text: marker.text ?? "",
          path: file.relPath,
          line: marker.originLine,
        });
      }
    }
  }

  const closeIds = new Set(closes.map((c) => c.id));
  const openIds = new Set(opens.map((o) => o.id));

  // First open marker per id (in walk order) is canonical; the rest are
  // duplicates. Iterating `opens` in order preserves first occurrence.
  const canonical = new Map<string, OpenRecord>();
  const duplicates: DuplicateOpenLoop[] = [];
  for (const rec of opens) {
    if (canonical.has(rec.id)) {
      duplicates.push({ id: rec.id, text: rec.text, path: rec.path, line: rec.line });
      continue;
    }
    canonical.set(rec.id, rec);
  }

  const openLoops: OpenLoop[] = [];
  let closedCount = 0;
  for (const rec of canonical.values()) {
    if (closeIds.has(rec.id)) {
      closedCount++;
      continue;
    }
    openLoops.push({ id: rec.id, text: rec.text, path: rec.path, line: rec.line });
  }

  const orphanCloses: OrphanClose[] = closes
    .filter((c) => !openIds.has(c.id))
    .map((c) => ({ id: c.id, path: c.path, line: c.line }));

  return Object.freeze({
    openLoops: Object.freeze(openLoops),
    counts: Object.freeze({ openCount: openLoops.length, closedCount, scannedFiles }),
    duplicates: Object.freeze(duplicates),
    orphanCloses: Object.freeze(orphanCloses),
  });
}

function emptyScan(): OpenLoopScan {
  return Object.freeze({
    openLoops: Object.freeze([]) as ReadonlyArray<OpenLoop>,
    counts: Object.freeze({ openCount: 0, closedCount: 0, scannedFiles: 0 }),
    duplicates: Object.freeze([]) as ReadonlyArray<DuplicateOpenLoop>,
    orphanCloses: Object.freeze([]) as ReadonlyArray<OrphanClose>,
  });
}

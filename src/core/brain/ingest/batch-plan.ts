/**
 * Batch-plan step for large-folder ingest (A3, t_9eeb8ca2).
 *
 * OSB's ingest pipeline ({@link ingestSource}) handles ONE source at a time and
 * has no planner to shard a large folder into bounded parallel work. This module
 * supplies that planner: {@link planBatches} discovers the ingestible files under
 * a source directory, consults A1's content-hash manifest to skip everything that
 * is `unchanged` since the last ingest, and splits the `new`/`modified` remainder
 * into size+count-bounded batches. The caller (an agent or the CLI) dispatches
 * each batch as a parallel subagent - the kernel runs NO ingestion and spawns NO
 * subagents itself. Planning stays deterministic and model-free.
 *
 * Determinism: files are discovered by a stable recursive walk, sorted by their
 * canonical vault-relative path, then packed greedily - each batch is filled up
 * to the byte cap and the file-count cap, whichever binds first. The same
 * directory (same bytes on disk) always yields the same batch list.
 *
 * Ingestibility mirrors the pipeline's "text-bearing sources only" contract (no
 * OCR, binary, or media): a small, extensible set of text/document extensions.
 * The match is language-agnostic - it is over file extension and bytes, never
 * over natural-language content. Hidden files and dot-directories (`.git`,
 * `.open-second-brain`, ...) are skipped so machine artifacts never masquerade
 * as ingestible sources.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

import { IgnoreScope, parseIgnorePatterns } from "../../fs/ignore.ts";
import { canonicalNotePath, ensureInsideVault } from "../../path-safety.ts";
import { computePlanId, readCheckpoint } from "./checkpoint.ts";
import { classifyPaths, readManifest } from "./content-manifest.ts";
import {
  extractableAllowlist,
  partitionExtractable,
  type SkippedPage,
} from "./extractable-gate.ts";

/**
 * Default set of ingestible (text-bearing) extensions, lowercase with the dot.
 * Deliberately conservative - the pipeline runs no OCR/binary path, so only
 * plain-text and lightweight-markup document formats qualify. Callers may
 * override via {@link BatchPlanOptions.extensions}.
 */
export const DEFAULT_INGESTIBLE_EXTENSIONS: readonly string[] = Object.freeze([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".rst",
  ".org",
]);

export interface BatchPlanOptions {
  /** Hard upper bound on the summed bytes of one batch (must be > 0). */
  readonly maxBatchBytes: number;
  /** Hard upper bound on the file count of one batch (must be a positive int). */
  readonly maxBatchFiles: number;
  /**
   * Override the ingestible extension set (lowercase, dot-prefixed). Absent →
   * {@link DEFAULT_INGESTIBLE_EXTENSIONS}.
   */
  readonly extensions?: readonly string[];
  /**
   * Resume an interrupted plan (t_ba1fa5f6): when true, items already recorded
   * in this plan's checkpoint are excluded from the batches, on top of the
   * manifest-`unchanged` skip. The plan id is derived from the full discovered
   * set so it is stable across resumes. Absent → a fresh, checkpoint-blind plan.
   */
  readonly resume?: boolean;
  /**
   * Scope discovery to a subtree of `sourceDir` (t_e82101a5), e.g. `pkg/a` in a
   * monorepo. Resolved relative to the source dir; a value escaping it throws.
   * Absent → the whole source dir is walked (byte-identical to before).
   */
  readonly srcSubpath?: string;
  /**
   * Gitignore-style patterns (t_e82101a5), matched by the shared
   * {@link parseIgnorePatterns} engine relative to `sourceDir`. Discovered
   * paths matching any pattern are dropped. Absent/empty → no exclusion.
   */
  readonly exclude?: readonly string[];
}

/** One file selected for (re-)ingest, with the reason it was selected. */
export interface PlannedFile {
  /** Canonical vault-relative POSIX path (the id ingest addresses). */
  readonly path: string;
  /** File size in bytes (drives the byte-cap packing). */
  readonly bytes: number;
  /** Why the file is being ingested: absent from / differing in the manifest. */
  readonly status: "new" | "modified";
}

/** One bounded batch the caller dispatches as a single parallel unit. */
export interface IngestBatch {
  /** Zero-based position of the batch within the plan. */
  readonly index: number;
  /** Files in this batch, in sorted-by-path order. */
  readonly files: readonly PlannedFile[];
  /** Summed bytes of the batch's files. */
  readonly totalBytes: number;
}

export interface BatchPlan {
  /** Canonical vault-relative POSIX path of the planned source directory. */
  readonly sourceDir: string;
  readonly maxBatchBytes: number;
  readonly maxBatchFiles: number;
  /** The bounded batches, in packing order. Empty when nothing needs ingest. */
  readonly batches: readonly IngestBatch[];
  /** Canonical paths classified `unchanged` and therefore skipped, sorted. */
  readonly skipped: readonly string[];
  /**
   * Pages skipped before extraction because their `schema_type` is not in the
   * schema `extractable` allowlist (t_ed856388). Empty when the allowlist is
   * unset (the gate is off), keeping the plan byte-identical to before.
   */
  readonly skippedNonExtractable: readonly SkippedPage[];
  /** Total number of files across all batches (`new` + `modified`). */
  readonly totalFiles: number;
  /** Total bytes across all batches. */
  readonly totalBytes: number;
  /**
   * Stable id for this plan (t_ba1fa5f6), derived from the source dir and the
   * full discovered path set. The key an interrupted run resumes against.
   */
  readonly planId: string;
  /**
   * Count of new/modified items excluded because this plan's checkpoint already
   * recorded them completed. Zero on a fresh plan or when `resume` is off.
   */
  readonly resumedCompleted: number;
}

/**
 * Plan the ingest of a source directory into bounded parallel batches.
 *
 * Discovers the ingestible files under `sourceDir` (a vault-relative path),
 * skips those the content-hash manifest classifies `unchanged`, and packs the
 * `new`/`modified` remainder greedily into batches that respect BOTH caps. A
 * single file larger than the byte cap cannot be split, so it forms its own
 * singleton batch (documented, honest - never silently dropped or truncated).
 *
 * Throws when a cap is not a positive number, or when `sourceDir` does not
 * resolve to an existing directory inside the vault (no misleading empty-plan
 * fallback for a typo'd or escaping path).
 */
export function planBatches(vault: string, sourceDir: string, opts: BatchPlanOptions): BatchPlan {
  if (!Number.isFinite(opts.maxBatchBytes) || opts.maxBatchBytes <= 0) {
    throw new Error(`planBatches: maxBatchBytes must be > 0, got ${opts.maxBatchBytes}`);
  }
  if (!Number.isInteger(opts.maxBatchFiles) || opts.maxBatchFiles <= 0) {
    throw new Error(
      `planBatches: maxBatchFiles must be a positive integer, got ${opts.maxBatchFiles}`,
    );
  }

  const dirRel = canonicalNotePath(sourceDir);
  const dirAbs = ensureInsideVault(join(vault, dirRel), vault);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    throw new Error(`planBatches: source dir is not an existing directory: ${sourceDir}`);
  }

  // Optional subtree scoping (t_e82101a5): resolve `srcSubpath` under the
  // source dir. ensureInsideVault throws a typed error if it escapes.
  let walkRoot = dirAbs;
  if (opts.srcSubpath !== undefined && opts.srcSubpath.length > 0) {
    walkRoot = ensureInsideVault(join(dirAbs, opts.srcSubpath), dirAbs);
    if (!existsSync(walkRoot) || !statSync(walkRoot).isDirectory()) {
      throw new Error(`planBatches: src subpath is not an existing directory: ${opts.srcSubpath}`);
    }
  }

  const extensions = normalizeExtensions(opts.extensions ?? DEFAULT_INGESTIBLE_EXTENSIONS);
  // Optional exclusion (t_e82101a5): reuse the shared ignore engine so there is
  // no second matcher. Patterns are relative to the source dir. A malformed
  // pattern is a user error, surfaced loudly rather than silently ignored.
  const excludeScope = buildExcludeScope(opts.exclude ?? [], dirRel);

  // Discover ingestible files as canonical vault-relative paths, sorted.
  const discovered: string[] = [];
  collectIngestible(walkRoot, vault, extensions, excludeScope, discovered);
  const discoveredRel = discovered
    .map((abs) => canonicalNotePath(toPosixRel(vault, abs)))
    .toSorted();

  // Honor the schema `extractable` allowlist (t_ed856388): pages whose
  // schema_type is not extractable are skipped BEFORE extraction, reported with
  // a reason, and logged. An empty allowlist gates nothing, so the discovered
  // set (hence planId and the whole plan) stays byte-identical to before.
  const partition = partitionExtractable(vault, discoveredRel, extractableAllowlist(vault));
  const relPaths = partition.extractable;
  const skippedNonExtractable = partition.skipped;
  for (const s of skippedNonExtractable) {
    process.stderr.write(`batch-plan: skipping non-extractable page ${s.path} (${s.reason})\n`);
  }

  // The plan id keys on the FULL discovered set, so it is identical before and
  // after an interruption regardless of how many items have completed.
  const planId = computePlanId(dirRel, relPaths);

  // On resume, drop items this plan's checkpoint already recorded completed
  // BEFORE classification, so those items are not re-hashed at all - the
  // resume fast-path that keeps a large-vault resume near-free. The content
  // manifest stays authoritative for anything the checkpoint does not cover.
  const completed =
    opts.resume === true
      ? new Set(readCheckpoint(vault, planId)?.completed ?? [])
      : new Set<string>();
  const toClassify = relPaths.filter((p) => !completed.has(p));
  const resumedCompleted = relPaths.length - toClassify.length;

  // Consult A1's manifest: only `new`/`modified` sources are worth ingesting.
  const classification = classifyPaths(vault, toClassify, readManifest(vault));
  const skipped = [...classification.unchanged].toSorted();

  // Build the planned-file list, tagging each with why it was selected, in
  // sorted-by-path order so packing (and the whole plan) is deterministic.
  const status = new Map<string, "new" | "modified">();
  for (const p of classification.new) status.set(p, "new");
  for (const p of classification.modified) status.set(p, "modified");
  const planned: PlannedFile[] = [...status.keys()].toSorted().map((path) => ({
    path,
    bytes: statSync(join(vault, path)).size,
    status: status.get(path)!,
  }));

  const batches = packBatches(planned, opts.maxBatchBytes, opts.maxBatchFiles);

  return {
    sourceDir: dirRel,
    maxBatchBytes: opts.maxBatchBytes,
    maxBatchFiles: opts.maxBatchFiles,
    batches,
    skipped,
    skippedNonExtractable,
    totalFiles: planned.length,
    totalBytes: planned.reduce((sum, f) => sum + f.bytes, 0),
    planId,
    resumedCompleted,
  };
}

/**
 * Greedily pack sorted files into batches. A file joins the current batch unless
 * doing so would breach the byte cap or the count cap, in which case the current
 * batch is flushed and the file opens a new one. The `current.length > 0` guard
 * ensures a lone file that itself exceeds the byte cap is never deferred forever
 * - it becomes its own (oversize, unsplittable) singleton batch.
 */
function packBatches(
  files: readonly PlannedFile[],
  maxBatchBytes: number,
  maxBatchFiles: number,
): IngestBatch[] {
  const batches: IngestBatch[] = [];
  let current: PlannedFile[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({ index: batches.length, files: current, totalBytes: currentBytes });
    current = [];
    currentBytes = 0;
  };

  for (const file of files) {
    const wouldExceedBytes = current.length > 0 && currentBytes + file.bytes > maxBatchBytes;
    const wouldExceedCount = current.length >= maxBatchFiles;
    if (wouldExceedBytes || wouldExceedCount) flush();
    current.push(file);
    currentBytes += file.bytes;
  }
  flush();

  return batches;
}

/**
 * Build the exclusion scope from `--exclude` patterns, relative to the source
 * dir. A malformed pattern is a user error and throws (never a silent skip). An
 * empty pattern list yields an empty scope that ignores nothing, keeping the
 * no-flag path byte-identical.
 */
function buildExcludeScope(patterns: readonly string[], baseDir: string): IgnoreScope {
  if (patterns.length === 0) return IgnoreScope.empty();
  const { layer, warnings } = parseIgnorePatterns(patterns, baseDir, "--exclude");
  if (warnings.length > 0) {
    const w = warnings[0]!;
    throw new Error(`planBatches: malformed --exclude pattern "${w.pattern}": ${w.reason}`);
  }
  return IgnoreScope.empty().extend(layer);
}

/**
 * Recursively collect ingestible regular-file absolute paths, skipping hidden
 * entries and anything the exclusion scope matches (t_e82101a5). An excluded
 * directory is pruned so its subtree is never walked.
 */
function collectIngestible(
  dir: string,
  vault: string,
  extensions: ReadonlySet<string>,
  exclude: IgnoreScope,
  out: string[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // hidden file or dot-directory
    const abs = join(dir, entry.name);
    const rel = toPosixRel(vault, abs);
    if (entry.isDirectory()) {
      if (exclude.isIgnored(rel, true)) continue;
      collectIngestible(abs, vault, extensions, exclude, out);
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      if (exclude.isIgnored(rel, false)) continue;
      out.push(abs);
    }
  }
}

/** Lowercase, dot-prefixed extension of a filename, or "" when it has none. */
function extname(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Normalize an extension list to a lowercase, dot-prefixed lookup set. */
function normalizeExtensions(exts: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const raw of exts) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    set.add(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
  }
  return set;
}

/** Vault-relative POSIX path for an absolute path inside the vault. */
function toPosixRel(vault: string, abs: string): string {
  return relative(vault, abs).split(/[\\/]/).join(posix.sep);
}

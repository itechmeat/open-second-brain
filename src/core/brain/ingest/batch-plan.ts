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
 *
 * Discovery is git-aware (t_4b2bd8f7) through the shared
 * {@link ../../fs/git-discovery.ts} module the hygiene repo scan also composes:
 * a source directory's own `.gitignore`, its nested `.gitignore` files and its
 * `.git/info/exclude` all narrow the walk, and a submodule or nested checkout
 * is not descended into - not as a `readdir` child, and not as a directory a
 * `--src-subpath` starts below either (that is refused outright, since those
 * files belong to another repository). An ignore file that exists but cannot be
 * honoured never passes silently: it comes back on
 * {@link BatchPlan.ignoreWarnings}. Layer precedence, lowest first: `.git/info/exclude`,
 * the source dir's `.gitignore`, each nested `.gitignore` by depth, then the
 * operator's `--exclude` - so an operator pattern always has the last word.
 * Discovery stays in-process: shelling out to `git ls-files` would make the
 * reproducible {@link BatchPlan.planId} depend on an external binary and on
 * user-global git configuration.
 *
 * Path space: layer base directories and the paths matched against them are
 * both VAULT-relative here, which is the base-dir contract git-discovery
 * documents. The hygiene scan chooses repo-root-relative instead; the shared
 * module assumes neither.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

import {
  buildRepositoryBaseScope,
  extendWithDirectoryIgnore,
  IGNORE_WARNING_NO_LINE,
  isNestedRepositoryBoundary,
} from "../../fs/git-discovery.ts";
import {
  parseIgnorePatterns,
  type IgnoreLayer,
  type IgnoreScope,
  type IgnoreWarning,
} from "../../fs/ignore.ts";
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
   * Narrows the walk, never widens it: a subpath under a directory the
   * repository ignores plans nothing and reports why on
   * {@link BatchPlan.ignoreWarnings} (override it with an `exclude`
   * re-include), and a subpath under a submodule or nested checkout throws.
   * Absent → the whole source dir is walked (byte-identical to before).
   */
  readonly srcSubpath?: string;
  /**
   * Gitignore-style patterns (t_e82101a5), matched by the shared
   * {@link parseIgnorePatterns} engine relative to `sourceDir`. Discovered
   * paths matching any pattern are dropped. Layered ABOVE every ignore file the
   * repository declares, so an operator pattern - including a `!` re-include -
   * overrides the repository. Absent/empty → no exclusion.
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
  /**
   * Everything the walk could not apply as declared (t_4b2bd8f7), sorted by
   * source then line: a malformed pattern in the repository's OWN ignore files,
   * an ignore file that exists but could not be read (unreadable, a symlink,
   * oversized - `line` 0), and a `--src-subpath` that pointed inside a subtree
   * the repository ignores (`source` `--src-subpath`, `line` 0). None of these
   * fails the plan - the repository is an input, not operator intent - but none
   * of them passes silently either. A malformed operator `--exclude` still
   * throws, and so does a subpath crossing a repository boundary. Empty on a
   * tree whose ignore files all compile, and on a tree that declares none.
   */
  readonly ignoreWarnings: readonly IgnoreWarning[];
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
  const srcSubpath =
    opts.srcSubpath !== undefined && opts.srcSubpath.length > 0 ? opts.srcSubpath : null;
  let walkRoot = dirAbs;
  if (srcSubpath !== null) {
    walkRoot = ensureInsideVault(join(dirAbs, srcSubpath), dirAbs);
    if (!existsSync(walkRoot) || !statSync(walkRoot).isDirectory()) {
      throw new Error(`planBatches: src subpath is not an existing directory: ${srcSubpath}`);
    }
  }

  const extensions = normalizeExtensions(opts.extensions ?? DEFAULT_INGESTIBLE_EXTENSIONS);
  // Optional exclusion (t_e82101a5): reuse the shared ignore engine so there is
  // no second matcher. Patterns are relative to the source dir. A malformed
  // pattern is a user error, surfaced loudly rather than silently ignored.
  const excludeLayer = buildExcludeLayer(opts.exclude ?? [], dirRel);

  // What the repository declares about itself (t_4b2bd8f7), beneath the
  // operator's layer. The source dir is the repository root for this purpose; a
  // subpath-scoped walk starts from the declarations above it AND obeys them, so
  // naming a subpath can neither re-enter an ignored subtree nor cross into
  // another repository (both would make the same tree answer two ways).
  const ignoreWarnings: IgnoreWarning[] = [];
  const base = buildRepositoryBaseScope(dirAbs, dirRel);
  ignoreWarnings.push(...base.warnings);
  let walkScope = base.scope;
  let prunedWarning: IgnoreWarning | null = null;
  if (srcSubpath !== null) {
    const descent = descendToSubpathRoot({
      scope: base.scope,
      excludeLayer,
      sourceDirAbs: dirAbs,
      sourceDirRel: dirRel,
      subpath: srcSubpath,
      walkRoot,
      warnings: ignoreWarnings,
    });
    walkScope = descent.scope;
    prunedWarning = descent.prunedWarning;
    if (prunedWarning !== null) ignoreWarnings.push(prunedWarning);
  }

  // Discover ingestible files as canonical vault-relative paths, sorted. A walk
  // root inside an ignored subtree discovers nothing and says why on the plan.
  const discovered: string[] = [];
  if (prunedWarning === null) {
    collectIngestible(walkRoot, walkScope, {
      vault,
      extensions,
      excludeLayer,
      out: discovered,
      warnings: ignoreWarnings,
    });
  }
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
    // Sorted so the plan is fully deterministic: the walk visits directories in
    // readdir order, which is not guaranteed stable across platforms.
    ignoreWarnings: ignoreWarnings.toSorted(compareIgnoreWarnings),
  };
}

/** Order warnings by their ignore file, then by line within it. */
function compareIgnoreWarnings(a: IgnoreWarning, b: IgnoreWarning): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.line - b.line;
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
 * Compile the `--exclude` patterns into one layer, relative to the source dir.
 * A malformed pattern is a user error and throws (never a silent skip) - unlike
 * a malformed pattern in the repository's own ignore files, which the operator
 * did not write and which is reported on {@link BatchPlan.ignoreWarnings}. An
 * empty pattern list yields `null`, so the no-flag path stacks no layer at all
 * and stays byte-identical.
 */
function buildExcludeLayer(patterns: readonly string[], baseDir: string): IgnoreLayer | null {
  if (patterns.length === 0) return null;
  const { layer, warnings } = parseIgnorePatterns(patterns, baseDir, "--exclude");
  if (warnings.length > 0) {
    const w = warnings[0]!;
    throw new Error(`planBatches: malformed --exclude pattern "${w.pattern}": ${w.reason}`);
  }
  return layer;
}

/** Everything {@link descendToSubpathRoot} needs to reach a subpath walk root. */
interface SubpathDescentInput {
  /** Scope governing the source dir, before any intermediate directory is added. */
  readonly scope: IgnoreScope;
  /** Operator `--exclude`, stacked above every repository layer. Null when absent. */
  readonly excludeLayer: IgnoreLayer | null;
  readonly sourceDirAbs: string;
  readonly sourceDirRel: string;
  /** The operator's `--src-subpath` value, recorded on a prune warning. */
  readonly subpath: string;
  readonly walkRoot: string;
  /** Accumulates malformed patterns found on the way down. */
  readonly warnings: IgnoreWarning[];
}

/** The scope governing the walk root, or the reason it must not be walked. */
interface SubpathDescent {
  readonly scope: IgnoreScope;
  /**
   * Null when every directory on the way down is walkable. Non-null when one of
   * them is ignored: the requested subtree sits inside an ignored one, is NOT
   * walked, and this warning carries the explanation onto the plan.
   */
  readonly prunedWarning: IgnoreWarning | null;
}

/** Provenance recorded on a warning caused by the `--src-subpath` flag itself. */
const SRC_SUBPATH_WARNING_SOURCE = "--src-subpath";

/**
 * Walk from the source dir (exclusive) down to the subpath walk root
 * (inclusive), applying to every directory on the way the same two rules
 * {@link collectIngestible} applies to a directory it meets as a `readdir`
 * entry - a nested repository is a boundary, an ignored directory prunes its
 * subtree - and layering each directory's own `.gitignore` for what lies below
 * it. Without this a `--src-subpath` would re-enter a subtree the repository
 * declared off-limits, or a foreign repository, purely because the walk never
 * passed through the parent that would have stopped it.
 *
 * Throws when a directory on the way down is a submodule or nested checkout.
 */
function descendToSubpathRoot(input: SubpathDescentInput): SubpathDescent {
  let current = input.scope;
  let abs = input.sourceDirAbs;
  let rel = input.sourceDirRel;
  for (const segment of toPosixRel(input.sourceDirAbs, input.walkRoot).split(posix.sep)) {
    if (segment.length === 0) continue;
    abs = join(abs, segment);
    rel = posix.join(rel, segment);
    // A boundary, not an ignore rule: those files are another repository's, so
    // no operator flag can re-include them and the plan refuses outright rather
    // than attributing a foreign repository's files to this tree.
    if (isNestedRepositoryBoundary(abs)) {
      throw new Error(
        `planBatches: src subpath "${input.subpath}" crosses a nested repository ` +
          `boundary at "${rel}": those files belong to that repository - plan against ` +
          "it directly",
      );
    }
    // Ignored-ness is decided by the layers governing the PARENT plus the
    // operator's `--exclude`, exactly as it is for a readdir child, so an
    // `--exclude` re-include remains the one way to override the repository.
    const effective = input.excludeLayer === null ? current : current.extend(input.excludeLayer);
    if (effective.isIgnored(rel, true)) {
      return { scope: current, prunedWarning: subpathIgnoredWarning(input.subpath, rel) };
    }
    const extended = extendWithDirectoryIgnore(current, abs, rel);
    input.warnings.push(...extended.warnings);
    current = extended.scope;
  }
  return { scope: current, prunedWarning: null };
}

/**
 * The structured warning a subpath pointing into an ignored subtree produces.
 * The plan comes back empty on purpose - the same tree must answer the same way
 * however it is addressed - and this says so instead of leaving the operator
 * with a silent empty plan.
 */
function subpathIgnoredWarning(subpath: string, ignoredDir: string): IgnoreWarning {
  return {
    source: SRC_SUBPATH_WARNING_SOURCE,
    line: IGNORE_WARNING_NO_LINE,
    pattern: subpath,
    reason:
      `"${ignoredDir}" is ignored by the repository, so nothing under the requested ` +
      'subpath was planned; override it with an --exclude "!" re-include',
  };
}

/** Everything the recursive walk needs beyond the current directory and scope. */
interface WalkContext {
  readonly vault: string;
  readonly extensions: ReadonlySet<string>;
  /** Operator `--exclude`, stacked above every repository layer. Null when absent. */
  readonly excludeLayer: IgnoreLayer | null;
  /** Accumulates discovered absolute file paths. */
  readonly out: string[];
  /** Accumulates malformed patterns found in the repository's own ignore files. */
  readonly warnings: IgnoreWarning[];
}

/**
 * Recursively collect ingestible regular-file absolute paths, skipping hidden
 * entries and anything the composed ignore scope matches. An ignored directory
 * is pruned so its subtree is never walked.
 *
 * `scope` already carries the layers governing `dir`; a child directory's own
 * `.gitignore` is stacked before descending into it, so a deeper file scopes
 * only what it governs and a nearer `!` re-include wins. The operator's
 * `--exclude` is applied on top for every match, keeping it above the whole
 * repository-declared stack no matter how deep the walk goes.
 */
function collectIngestible(dir: string, scope: IgnoreScope, ctx: WalkContext): void {
  const effective = ctx.excludeLayer === null ? scope : scope.extend(ctx.excludeLayer);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // hidden file or dot-directory
    const abs = join(dir, entry.name);
    const rel = toPosixRel(ctx.vault, abs);
    if (entry.isDirectory()) {
      // A submodule or nested checkout belongs to another repository's index.
      // This is a boundary, not an ignore rule, so `--exclude` cannot re-include
      // it - an operator wanting those files plans against that repository.
      if (isNestedRepositoryBoundary(abs)) continue;
      if (effective.isIgnored(rel, true)) continue;
      const child = extendWithDirectoryIgnore(scope, abs, rel);
      ctx.warnings.push(...child.warnings);
      collectIngestible(abs, child.scope, ctx);
    } else if (entry.isFile() && ctx.extensions.has(extname(entry.name).toLowerCase())) {
      if (effective.isIgnored(rel, false)) continue;
      ctx.out.push(abs);
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

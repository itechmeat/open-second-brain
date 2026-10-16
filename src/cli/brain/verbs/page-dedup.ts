/**
 * `o2b brain page-dedup` - scan the vault for pages that share a
 * normalised dedup key and (optionally) merge them.
 *
 * Default mode is read-only listing. `--apply` performs the merge
 * for every reported candidate: writes `merged_into:` on each
 * secondary and rewrites `[[<secondary>]]` references across the
 * vault to point at the canonical page. A merge attempt that refuses
 * (a MergeChainError) or cannot write its links is collected and
 * reported per cluster; the remaining clusters still apply, and the
 * run exits 1 when any failure was collected.
 */

import type { DedupCandidate } from "../../../core/brain/page-dedup.ts";
import {
  findDuplicateCandidates,
  mergePage,
  PatchWikilinksError,
} from "../../../core/brain/page-dedup.ts";
import { brainVerbContext, fail, okJson, parse } from "../helpers.ts";

/**
 * One merge attempt that refused to land: the cluster's dedup key, the
 * SECONDARY that refused (review L8 - a cluster can hold several, and a
 * report that names only the cluster leaves the operator guessing which
 * page is still awaiting a decision), and the named error. A chain refusal
 * (MergeChainError) writes nothing, so the secondary is left exactly as it
 * was. A link-pass refusal can arrive AFTER the `merged_into:` stamp has
 * landed on the secondary - by then the merge is half-applied, and
 * {@link DedupApplyFailure.wikilinksUpdated} carries how many files the
 * rewrite repointed before the write that refused.
 */
export interface DedupApplyFailure {
  readonly key: string;
  /** The id of the secondary whose merge refused. */
  readonly secondary: string;
  readonly message: string;
  /**
   * Files the link pass rewrote before the write that refused, present
   * only when the failure came after the rewrite had already run. Absent
   * means the secondary is untouched, not zero.
   */
  readonly wikilinksUpdated?: number;
}

/** What one apply pass over a set of candidates did. */
export interface DedupApplyReport {
  readonly merged: number;
  readonly wikilinksUpdated: number;
  /** Per-attempt failures, in cluster order; empty on a clean apply. */
  readonly failures: ReadonlyArray<DedupApplyFailure>;
}

/**
 * Merge every secondary into its canonical, collecting per-attempt failures
 * instead of throwing: one cluster's MergeChainError (or one blocked wikilink
 * write) leaves every later cluster still applied. The report carries the
 * honest counts alongside the failures, so the caller can exit non-zero
 * without re-deriving what landed.
 */
export function applyDedupCandidates(
  vault: string,
  candidates: ReadonlyArray<DedupCandidate>,
): DedupApplyReport {
  let mergedCount = 0;
  let wikilinksTouched = 0;
  const failures: DedupApplyFailure[] = [];
  for (const c of candidates) {
    for (const s of c.secondaries) {
      try {
        const res = mergePage(vault, s.id, c.canonical.id);
        mergedCount++;
        wikilinksTouched += res.wikilinksUpdated;
      } catch (err) {
        // A late failure (PatchWikilinksError) means the stamp landed and
        // part of the rewrite did too: keep the partial count on the
        // failure and fold it into the aggregate, which counts files the
        // vault actually took, not only the ones behind a clean merge.
        const partial = err instanceof PatchWikilinksError ? err.rewritten : undefined;
        if (partial !== undefined) wikilinksTouched += partial;
        failures.push({
          key: c.key,
          secondary: s.id,
          message: (err as Error)?.message ?? String(err),
          ...(partial === undefined ? {} : { wikilinksUpdated: partial }),
        });
      }
    }
  }
  return {
    merged: mergedCount,
    wikilinksUpdated: wikilinksTouched,
    failures: Object.freeze(failures),
  };
}

export async function cmdBrainPageDedup(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
    yes: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  const apply = Boolean(flags["apply"]);
  if (apply && !flags["yes"] && (flags["json"] || !process.stdin.isTTY)) {
    return fail("brain page-dedup --apply requires --yes in non-interactive mode");
  }

  const report = findDuplicateCandidates(vault);

  if (!apply) {
    if (flags["json"]) {
      okJson({
        scanned: report.scanned,
        candidates: report.candidates.map((c) => ({
          key: c.key,
          canonical: c.canonical.id,
          secondaries: c.secondaries.map((s) => s.id),
        })),
      });
      return 0;
    }
    process.stdout.write(`pages scanned: ${report.scanned}\n`);
    process.stdout.write(`duplicate clusters: ${report.candidates.length}\n`);
    for (const c of report.candidates) {
      process.stdout.write(`\ncanonical: ${c.canonical.id}  (topic: ${c.canonical.topic})\n`);
      for (const s of c.secondaries) {
        process.stdout.write(`  -> ${s.id}\n`);
      }
    }
    if (report.candidates.length === 0) {
      process.stdout.write("no duplicate clusters detected.\n");
    } else {
      process.stdout.write("\nre-run with --apply --yes to merge.\n");
    }
    return 0;
  }

  const applied = applyDedupCandidates(vault, report.candidates);
  // Collected failures are an honest non-zero exit, not a crash: every
  // merge that could land did land, and the failures name what did not.
  const exitCode = applied.failures.length > 0 ? 1 : 0;

  if (flags["json"]) {
    okJson({
      scanned: report.scanned,
      clusters: report.candidates.length,
      merged: applied.merged,
      wikilinks_updated: applied.wikilinksUpdated,
      failures: applied.failures.map((f) => ({
        key: f.key,
        secondary: f.secondary,
        message: f.message,
        ...(f.wikilinksUpdated === undefined ? {} : { wikilinks_updated: f.wikilinksUpdated }),
      })),
    });
    return exitCode;
  }
  process.stdout.write(`merged ${applied.merged} page(s) into canonicals.\n`);
  process.stdout.write(`wikilinks updated: ${applied.wikilinksUpdated}\n`);
  for (const f of applied.failures) {
    const partial =
      f.wikilinksUpdated === undefined ? "" : ` (wikilinks updated first: ${f.wikilinksUpdated})`;
    process.stdout.write(
      `failed cluster ${f.key}, secondary ${f.secondary}: ${f.message}${partial}\n`,
    );
  }
  return exitCode;
}

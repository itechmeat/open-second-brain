/**
 * Document retirement applier core (storage lifecycle, Lane 4; plan
 * task 4.3).
 *
 * The consumer of the `document-dedup` detector's findings: for each
 * near-duplicate copy a plan selects, retire the copy and keep the
 * canonical page -
 *
 *   1. retarget every inbound `[[stale-copy]]` wikilink to the
 *      canonical spelling (the report is carried, never swallowed);
 *      a write that could not land refuses the copy before the
 *      removal, so no retired page strands the link it could not
 *      repoint (review M7);
 *   2. remove the stale page (per-file removal via the shared
 *      `removeFile`, so a failure is one copy's failure);
 *   3. MARK the copy's source manifest entry `retired_into` the
 *      canonical page, round-tripping the contract the manifest was
 *      read under - the same t_586d5d8b rule deleteBySource applies: a
 *      retirement never re-stamps the contract the surviving entries
 *      were recorded under. The marker is the resurrect guard (review
 *      H3): dropping the entry would classify the unchanged source
 *      `new` again and the next batch plan would re-ingest it, quietly
 *      undoing the retirement. With the marker, the unchanged source
 *      classifies `retired` and no plan queues it; a real byte change
 *      re-admits it as `modified`, and a deliberate re-ingest re-records
 *      the entry without the marker;
 *   4. append one `source_invalidation` continuity record PER COPY
 *      naming canonical id, retired id, marked manifest key and the
 *      retained source-archive hash - the audit the page-dedup merge
 *      never needed, because a merge keeps both pages and this
 *      operation deletes one.
 *
 * The whole span sits inside `withDestructiveSnapshot`. The snapshot
 * reason is `deleteBySource`'s: a retired summary page is a source's
 * derived material, which is exactly what that reason documents, and
 * the reason vocabulary lives in a file this lane does not own. The
 * source archive (`Brain/.archives/<hash>.txt`) is deliberately NOT
 * removed - it is evidence under a no-TTL contract, and the audit
 * names its digest so the provenance chain survives the page.
 *
 * Failure posture is per-copy fail-soft: one copy's failure is
 * collected as `{path, message}`, and the remaining copies still
 * retire. The message says WHERE the copy ended up: a failure BEFORE
 * the page's own removal (the existence, frontmatter or canonical
 * checks, the ambiguous-basename refusal, an inbound-link rewrite that
 * could not land) leaves the copy on disk; a failure AFTER it - the
 * manifest marker, the continuity record - reports the page as REMOVED,
 * because it is, and names the step that lost it. Copy-level input
 * mistakes (a path equal to its own canonical) are caller bugs and
 * refuse loudly before any work.
 *
 * Dry runs never reach this module: the hygiene apply plan previews
 * retire findings without executing them, and the surfaces' count
 * guard runs on the selected findings before this applier is called.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { isoSecond } from "./time.ts";
import { markManifestRetired } from "./ingest/content-manifest.ts";
import { appendContinuitySourceInvalidation } from "./continuity/store.ts";
import { removeFile } from "./source-cleanup.ts";
import { basenameCollides, retargetWikilinks } from "./page-dedup.ts";
import type { WikilinkRetargetReport } from "./page-dedup.ts";
import { BRAIN_SNAPSHOT_REASON } from "./types.ts";
import { withDestructiveSnapshot } from "./snapshot-gate.ts";
import { REVIEW_LANE } from "./write-gate.ts";
import {
  classifyRecoverability,
  type DestructiveBlastRadius,
  type RecoverabilityVerdict,
} from "./gates/recoverability.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { refuseDocumentDeny, type WriteSubject } from "./write-disposition.ts";
import type { ResolveWriteDispositionOptions } from "./write-disposition.ts";
import { BRAIN_SOURCE_KIND } from "./ingest/ingest.ts";
import type { SourceCleanupFailure } from "./source-cleanup.ts";

/** The agent named on the audit record when the caller names none. */
const DEFAULT_AGENT = "document_retire";

/** Basename without the `.md` extension - the wikilink spelling of a page. */
function linkTarget(pagePath: string): string {
  const base = pagePath.split("/").at(-1) ?? pagePath;
  return base.replace(/\.md$/, "");
}

/**
 * Why a copy whose inbound-link pass cannot run unambiguously is REFUSED
 * (storage lifecycle, PR #257 review L5): another page in the vault
 * carries the retired copy's basename, so the bare `[[basename]]`
 * spelling resolves to more than one page and a retarget keyed on the
 * spelling alone would repoint links that meant the OTHER page - edits
 * to pages outside the detector's near-duplicate scope, made on a guess.
 * Removing the page anyway is worse than skipping the rewrite: every
 * leftover `[[basename]]` would then RESOLVE to the namesake, silently
 * re-pointed by a deletion instead of left visibly stale. So the copy is
 * refused and stays on disk; the finding comes back to the operator.
 */
export const RETIRE_BASENAME_COLLISION_REFUSAL =
  "another page carries the same basename, so the bare-basename link spelling is ambiguous";

/** Frontmatter key carrying the digest of the archived source bytes. */
const SOURCE_ARCHIVE_HASH_KEY = "source_archive_hash";

/** Frontmatter key carrying the canonical source path a page derives from. */
const SOURCE_PATH_KEY = "source_path";

/** One near-duplicate copy to retire, with the page that survives it. */
export interface RetireDocumentCopyInput {
  /** Vault-relative path of the near-duplicate summary page to retire. */
  readonly path: string;
  /** Vault-relative path of the canonical page that survives. */
  readonly canonical: string;
}

export interface RetireDocumentsOptions {
  /** Named on the audit record. Defaults to {@link DEFAULT_AGENT}. */
  readonly agent?: string;
  /** Injected clock for the audit stamps. */
  readonly now?: Date;
  /**
   * Credential subject for the permissions-document deny consult, which
   * runs per copy before anything is read for deletion (the ingest
   * lane, matching deleteBySource). With no permissions document this
   * is a no-op.
   */
  readonly subject?: WriteSubject;
}

/** One copy that retired cleanly, with everything the run did to it. */
export interface RetiredDocumentCopy {
  readonly path: string;
  readonly canonical: string;
  /** The source path whose manifest entry was targeted, or `null`. */
  readonly manifestKey: string | null;
  /** True when the manifest was rewritten to carry the `retired_into` marker. */
  readonly manifestRetired: boolean;
  /**
   * The retired page's size in bytes, measured BEFORE its removal - the
   * freed half of the run's disk accounting (review M6).
   */
  readonly pageBytes: number;
  /**
   * The full retarget report for this copy's inbound wikilinks. A copy
   * whose pass could not run unambiguously - the basename collision - is
   * refused before any write and lands in {@link RetireDocumentsResult.failed}
   * instead, so a report row always carries a pass that ran.
   */
  readonly wikilinks: WikilinkRetargetReport;
  /** Digest named in the audit; from the page's frontmatter, or `null`. */
  readonly sourceArchiveHash: string | null;
  /** The id of the `source_invalidation` continuity record this retirement appended. */
  readonly auditRecordId: string;
}

/**
 * The run's disk accounting (review M6, retire half): the destructive span
 * archives `Brain/` into `Brain/.snapshots/` - a surface the storage census
 * counts - BEFORE it frees anything, so removal counts alone can read as a
 * shrink on a run that actually grew the vault. The result carries both
 * sides and the net between them.
 */
export interface RetireDiskAccounting {
  /**
   * Bytes of the snapshot archive the gate wrote for this run, or `null`
   * when no snapshot was taken (a run with no copies).
   */
  readonly snapshotBytes: number | null;
  /** Summed bytes of the pages the run removed, measured before removal. */
  readonly removedBytes: number;
  /** `snapshotBytes - removedBytes`; `null` beside a `null` snapshot size. */
  readonly netBytes: number | null;
}

export interface RetireDocumentsResult {
  readonly retired: ReadonlyArray<RetiredDocumentCopy>;
  /**
   * Per-copy failures, collected. A failure BEFORE the page's own
   * removal leaves the copy on disk; a failure after it says so in its
   * message - the page is gone, and the message names the step that
   * lost it.
   */
  readonly failed: ReadonlyArray<SourceCleanupFailure>;
  /**
   * The run's disk accounting (review M6): both sides and the net
   * between them, as the module header promises. Per-copy bytes ride
   * {@link RetiredDocumentCopy.pageBytes}; this carries the run totals.
   */
  readonly disk: RetireDiskAccounting;
  readonly snapshotRunId: string | null;
  readonly snapshotPath: string | null;
  readonly recoverability: RecoverabilityVerdict;
}

/** What one copy's retirement read off the page before acting. */
interface CopyFacts {
  readonly sourcePath: string | null;
  readonly archiveHash: string | null;
  readonly kind: string | null;
}

function readCopyFacts(vault: string, pagePath: string): CopyFacts | null {
  let meta: Record<string, unknown>;
  try {
    [meta] = parseFrontmatter(join(vault, pagePath));
  } catch {
    return null;
  }
  const sourcePath = meta[SOURCE_PATH_KEY];
  const archiveHash = meta[SOURCE_ARCHIVE_HASH_KEY];
  return {
    kind: typeof meta["kind"] === "string" ? meta["kind"] : null,
    sourcePath: typeof sourcePath === "string" && sourcePath.length > 0 ? sourcePath : null,
    archiveHash: typeof archiveHash === "string" && archiveHash.length > 0 ? archiveHash : null,
  };
}

/**
 * Retire the given near-duplicate copies. Writes by contract: the
 * vault-identity write guard runs at the entry point, before any other
 * work, per the one rule every applier shares.
 */
export function retireDocumentCopies(
  vault: string,
  copies: ReadonlyArray<RetireDocumentCopyInput>,
  opts: RetireDocumentsOptions = {},
): RetireDocumentsResult {
  // Write guard first - see the module header. This applier always
  // writes when called; the dry-run boundary lives in the hygiene plan.
  assertVaultIdentityForWrite(vault);

  for (const copy of copies) {
    if (copy.path === copy.canonical) {
      throw new Error(
        `retireDocumentCopies: ${copy.path} is named as both the retired copy and the canonical`,
      );
    }
  }

  if (copies.length === 0) {
    return Object.freeze({
      retired: Object.freeze([]),
      failed: Object.freeze([]),
      disk: Object.freeze({ snapshotBytes: null, removedBytes: 0, netBytes: null }),
      snapshotRunId: null,
      snapshotPath: null,
      // Nothing to destroy, so the classifier says so - neither the
      // alarm of `unproven` nor the false comfort of `covered`.
      recoverability: classifyRecoverability({ recoveryPoint: false, blastRadius: {} }),
    });
  }

  // Deny-consulted evidence (write-side trust, Task 12), per copy and
  // BEFORE any read-for-deletion, one ledger row behind a deny - the
  // same ladder deleteBySource climbs. A deny throws here, so nothing
  // has been snapshotted or removed when it lands.
  const denyOpts: ResolveWriteDispositionOptions = opts.now !== undefined ? { now: opts.now } : {};
  for (const copy of copies) {
    refuseDocumentDeny(vault, REVIEW_LANE.ingest, opts.subject, {
      target: copy.path,
      ...denyOpts,
    });
  }

  const retired: RetiredDocumentCopy[] = [];
  const failed: SourceCleanupFailure[] = [];

  const runRetirement = (): void => {
    for (const copy of copies) {
      try {
        retired.push(retireOneCopy(vault, copy, opts));
      } catch (error) {
        failed.push({
          path: copy.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // Only snapshot when there is something to remove; a caller that
  // passes no work gets no archive churn.
  const blastRadius: DestructiveBlastRadius = { brainTopLevel: true, outsideBrainRoot: false };
  const gated = withDestructiveSnapshot(
    vault,
    BRAIN_SNAPSHOT_REASON.deleteBySource,
    runRetirement,
    {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      blastRadius,
    },
  );

  // The disk accounting (review M6, retire half): the archive sits in a
  // counted surface, so the result states what the snapshot cost beside
  // what the removals freed.
  const removedBytes = retired.reduce((sum, copy) => sum + copy.pageBytes, 0);
  const snapshotBytes = existsSync(gated.snapshot.path) ? statSync(gated.snapshot.path).size : null;
  const disk: RetireDiskAccounting = Object.freeze({
    snapshotBytes,
    removedBytes,
    netBytes: snapshotBytes === null ? null : snapshotBytes - removedBytes,
  });

  return Object.freeze({
    retired: Object.freeze(retired),
    failed: Object.freeze(failed),
    disk,
    snapshotRunId: gated.snapshot.runId,
    snapshotPath: gated.snapshot.path,
    recoverability: gated.recoverability,
  });
}

/** Retire one copy. Throws to the caller's per-copy collector. */
function retireOneCopy(
  vault: string,
  copy: RetireDocumentCopyInput,
  opts: RetireDocumentsOptions,
): RetiredDocumentCopy {
  const abs = join(vault, copy.path);
  // Containment before existence: removeFile answers a vault-escaping path
  // with the same `false` a vanished page gets, and the message below would
  // then claim a copy vanished that was never inside the vault to begin
  // with. Named here for what it is, so the per-copy failure says the path
  // escapes the vault rather than inventing a disappearance.
  try {
    ensureInsideVault(abs, vault);
  } catch {
    throw new Error(`retired copy path escapes the vault: ${copy.path}`);
  }
  if (!existsSync(abs)) {
    throw new Error(`retired copy not found on disk: ${copy.path}`);
  }
  // Measured before anything acts: the freed half of the run's disk
  // accounting (review M6).
  const pageBytes = statSync(abs).size;
  const facts = readCopyFacts(vault, copy.path);
  if (facts === null) {
    throw new Error(`retired copy frontmatter does not parse: ${copy.path}`);
  }
  if (facts.kind !== BRAIN_SOURCE_KIND) {
    throw new Error(`retired copy is not an ingest summary page (kind ${String(facts.kind)})`);
  }
  if (!existsSync(join(vault, copy.canonical))) {
    throw new Error(`canonical page not found on disk: ${copy.canonical}`);
  }

  // 1. Links first, so no reader between steps ever sees a stranded
  // `[[stale-copy]]`. The pass keys on the bare basename, so when another
  // page carries the same basename the spelling is ambiguous: rewriting it
  // would repoint links that meant the other page, and removing the page
  // anyway would leave every leftover spelling resolving to the namesake
  // silently (review L5). The copy is refused BEFORE any write and stays
  // on disk - a refusal is one copy's collected failure.
  if (basenameCollides(vault, linkTarget(copy.path), copy.path)) {
    throw new Error(
      `retirement refused, the copy stays in place: ${RETIRE_BASENAME_COLLISION_REFUSAL}: ${copy.path}`,
    );
  }
  // Failure to write a file is collected in the report, not thrown - the
  // pass has already rewritten the files before it (the retargetWikilinks
  // argument, verbatim).
  const wikilinks = retargetWikilinks(vault, [
    { from: linkTarget(copy.path), to: linkTarget(copy.canonical) },
  ]);
  // A retarget write that failed refuses the copy (review M7): retiring
  // the page over an unreplicable link would strand exactly the inbound
  // reference the pass could not repoint - the design's "a copy whose
  // retarget fails stays in place". The refusal is BEFORE the removal, so
  // the copy stays on disk as one collected per-copy failure; the files
  // the pass DID rewrite now point at the canonical, which exists, so no
  // link is stranded by the partial rewrite either.
  if (wikilinks.failed.length > 0) {
    throw new Error(
      `inbound wikilink retarget left ${wikilinks.failed.length} file(s) unwritten; ` +
        `the copy stays in place: ` +
        wikilinks.failed.map((f) => `${f.path} (${f.reason})`).join("; "),
    );
  }

  // 2. Remove the stale page. `false` here means the page vanished
  // between the existence check and the unlink - that is a failure to
  // report, not a success to claim.
  if (!removeFile(vault, copy.path)) {
    throw new Error(`retired copy vanished before removal: ${copy.path}`);
  }

  // Everything below runs AFTER the page is gone. A failure here cannot
  // leave the copy on disk, so it is rethrown AS that fact - the report
  // must never send an operator looking for a page that is not there.
  try {
    // 3. Mark the manifest entry for the copy's source `retired_into` the
    // canonical page, round-tripping the read contract (t_586d5d8b): the
    // surviving entries keep the fingerprint they were recorded under, so
    // the owed one-time reprocess is never forfeited by a retirement. The
    // per-copy reason is worded from what actually happened - a mark, a
    // refusal, an entry already marked, an entry absent, or no key
    // recorded at all - never from the key's existence alone.
    let manifestRetired = false;
    let manifestClause: string;
    if (facts.sourcePath === null) {
      manifestClause = "no manifest key recorded";
    } else {
      // One locked read-modify-write, so a concurrent ingest's manifest
      // write can neither be lost to this one nor drop the marker.
      const mark = markManifestRetired(vault, facts.sourcePath, copy.canonical);
      if (mark === "no-manifest") {
        manifestClause = `manifest absent, nothing to mark for ${facts.sourcePath}`;
      } else if (mark === "no-entry") {
        manifestClause = `manifest key ${facts.sourcePath} absent, nothing to mark`;
      } else if (mark === "already-marked") {
        // The entry already carries THIS retirement's marker: the clause
        // names that success-shaped fact - a concurrent retirer got there
        // first.
        manifestClause = `manifest key ${facts.sourcePath} already marked retired`;
      } else {
        manifestRetired = true;
        manifestClause = `marked manifest key ${facts.sourcePath} retired into ${copy.canonical}`;
      }
    }

    // 4. The provenance record: one per copy, naming what survives, what
    // went, what was marked and what evidence is retained.
    const agent = opts.agent?.trim() ? opts.agent.trim() : DEFAULT_AGENT;
    const record = appendContinuitySourceInvalidation(vault, {
      createdAt: isoSecond(opts.now ?? new Date()),
      source: {
        id: facts.sourcePath ?? copy.path,
        ...(facts.sourcePath !== null ? { path: facts.sourcePath } : {}),
        kind: "source",
      },
      reason:
        `${agent}: retired near-duplicate copy ${linkTarget(copy.path)} into canonical ` +
        `${linkTarget(copy.canonical)}; ${manifestClause}; ` +
        `source archive ${facts.archiveHash ?? "none"} retained`,
    });

    return Object.freeze({
      path: copy.path,
      canonical: copy.canonical,
      manifestKey: facts.sourcePath,
      manifestRetired,
      pageBytes,
      wikilinks,
      sourceArchiveHash: facts.archiveHash,
      auditRecordId: record.id,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `retirement removed ${copy.path}, then a post-removal step failed ` +
        `(the copy is not on disk): ${detail}`,
      { cause: error },
    );
  }
}

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
 *   2. remove the stale page (per-file removal via the shared
 *      `removeFile`, so a failure is one copy's failure);
 *   3. drop the copy's content-manifest entry, round-tripping the
 *      contract the manifest was read under - the same t_586d5d8b rule
 *      deleteBySource applies: a removal never re-stamps the contract
 *      the surviving entries were recorded under. The drop is the
 *      resurrect guard: with the entry gone, the retired source
 *      classifies `new` again, so no later ingest can claim the
 *      retired page's records are current; the source can only return
 *      as a deliberate full re-ingest;
 *   4. append one `source_invalidation` continuity record PER COPY
 *      naming canonical id, retired id, dropped manifest key and the
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
 * checks) leaves the copy on disk; a failure AFTER it - the manifest
 * drop, the continuity record - reports the page as REMOVED, because it
 * is, and names the step that lost it. Copy-level input mistakes (a
 * path equal to its own canonical) are caller bugs and refuse loudly
 * before any work.
 *
 * Dry runs never reach this module: the hygiene apply plan previews
 * retire findings without executing them, and the surfaces' count
 * guard runs on the selected findings before this applier is called.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { isoSecond } from "./time.ts";
import { readManifest, writeManifestAtomic, manifestPath } from "./ingest/content-manifest.ts";
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
 * Why a copy's inbound-link pass did not run: another page in the vault
 * carries the retired copy's basename, so the bare `[[basename]]`
 * spelling resolves to more than one page and a retarget keyed on the
 * spelling alone would repoint links that meant the OTHER page - edits
 * to pages outside the detector's near-duplicate scope, made on a guess.
 * The copy still retires; the skipped pass leaves a stale link, which a
 * reader can discover, where a mis-pointed link misleads silently.
 */
export const RETIRE_LINKS_SKIPPED_BASENAME_COLLISION =
  "another page carries the same basename; the bare-basename link spelling is ambiguous";

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
  /** True when the manifest was rewritten without the entry. */
  readonly manifestDropped: boolean;
  /**
   * The full retarget report for this copy's inbound wikilinks, `null`
   * when the pass was SKIPPED - {@link RetiredDocumentCopy.wikilinksSkipped}
   * names why. `null` is never a silent zero: a skipped pass left every
   * inbound link exactly as it was.
   */
  readonly wikilinks: WikilinkRetargetReport | null;
  /** Why the link pass did not run, `null` when it ran. */
  readonly wikilinksSkipped: string | null;
  /** Digest named in the audit; from the page's frontmatter, or `null`. */
  readonly sourceArchiveHash: string | null;
  /** The id of the `source_invalidation` continuity record this retirement appended. */
  readonly auditRecordId: string;
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

  return Object.freeze({
    retired: Object.freeze(retired),
    failed: Object.freeze(failed),
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
  // `[[stale-copy]]`. Failure to write a file is collected in the
  // report, not thrown - the pass has already rewritten the files
  // before it (the retargetWikilinks argument, verbatim). The pass
  // keys on the bare basename, so when another page carries the same
  // basename the spelling is ambiguous: rewriting it would repoint
  // links that meant the other page. The copy then retires without its
  // link pass and the report names why - a stale link is discoverable,
  // a mis-pointed one misleads silently.
  const wikilinks = basenameCollides(vault, linkTarget(copy.path), copy.path)
    ? null
    : retargetWikilinks(vault, [{ from: linkTarget(copy.path), to: linkTarget(copy.canonical) }]);

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
    // 3. Drop the manifest entry for the copy's source, round-tripping
    // the read contract (t_586d5d8b): the surviving entries keep the
    // fingerprint they were recorded under, so the owed one-time
    // reprocess is never forfeited by a removal. The per-copy reason is
    // worded from what actually happened - a drop, a refusal, an entry
    // already absent, or nothing to drop at all - never from the key's
    // existence alone.
    let manifestDropped = false;
    let manifestClause: string;
    if (facts.sourcePath === null) {
      manifestClause = "no manifest key recorded";
    } else if (!existsSync(manifestPath(vault))) {
      manifestClause = `manifest absent, nothing to drop for ${facts.sourcePath}`;
    } else {
      const manifest = readManifest(vault);
      const entries = { ...manifest.entries };
      if (entries[facts.sourcePath] === undefined) {
        manifestClause = `manifest key ${facts.sourcePath} already absent`;
      } else {
        delete entries[facts.sourcePath];
        manifestDropped = writeManifestAtomic(vault, entries, manifest.contract);
        // A `false` from the atomic write after deleting a PRESENT key means
        // the serialized bytes were already identical - the key was already
        // gone on disk, i.e. a concurrent retirer got there first. The
        // reason names that success-shaped fact, not a failure to drop.
        manifestClause = manifestDropped
          ? `dropped manifest key ${facts.sourcePath}`
          : `manifest already without key ${facts.sourcePath}`;
      }
    }

    // 4. The provenance record: one per copy, naming what survives, what
    // went, what was dropped and what evidence is retained.
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
      manifestDropped,
      wikilinks,
      wikilinksSkipped: wikilinks === null ? RETIRE_LINKS_SKIPPED_BASENAME_COLLISION : null,
      sourceArchiveHash: facts.archiveHash,
      auditRecordId: record.id,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `retirement removed ${copy.path}, then a post-removal step failed ` +
        `(the copy is not on disk): ${detail}`,
    );
  }
}

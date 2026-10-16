/**
 * Source-ingest pipeline (Knowledge Provenance suite).
 *
 * Turns one text-bearing source (a document, note, or URL's text) into
 * cross-referenced Brain knowledge: the entities and concepts it mentions
 * become registry pages, and a per-source summary page links back to the raw
 * artifact, lists the entities it introduced, and lists its connections to
 * material already in the brain.
 *
 * Provider-agnostic: the calling agent extracts the entities/relations and
 * writes the prose summary; this pipeline never runs a model. OSB owns the
 * deterministic half - routing the extraction through the shared intake
 * primitive, stamping provenance, and committing the summary page idempotently
 * (one source path maps to one summary page, rewritten in place on re-ingest,
 * never duplicated). Text-bearing sources only: no OCR, binary, or media path.
 *
 * The connections list is derived, not guessed: an entity that ALREADY existed
 * before this ingest (the intake reports it as updated, not created) is a
 * genuine connection to prior material; a freshly created entity is not.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { dirname, join, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { normToken, REMOTE_DENY_VISIBILITY_TOKEN } from "../../graph/visibility.ts";
import { canonicalNotePath, ensureInsideVault } from "../../path-safety.ts";
import { assertCheckpointId } from "../checkpoint-store.ts";
import {
  formatFrontmatter,
  parseFrontmatter,
  slugify,
  writeFrontmatterAtomic,
} from "../../vault.ts";
import { isoSecond } from "../time.ts";
import { sourcePagePath } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  intakeExtraction,
  type ExtractionIntake,
  type IntakeRelation,
} from "../intake/extract-intake.ts";
import {
  SourceTrustError,
  errnoCode,
  isSourceHidden,
  normalizeSourceIdentity,
  readSourceOrigin,
} from "../intake/source-trust.ts";
import {
  INTAKE_TRUST,
  untrustedSourceFrontmatter,
  type IntakeTrust,
} from "../trust/untrusted-provenance.ts";
import {
  captureScopeForTrust,
  captureScopeFrontmatter,
  type CaptureScope,
} from "../provenance/capture-scope.ts";
import {
  SOURCE_ARCHIVE_BYTES_KEY,
  SOURCE_ARCHIVE_HASH_KEY,
  SourceArchiveError,
  putSourceArchive,
} from "../provenance/source-archive.ts";
import type { FrontmatterCache } from "../../search/result-filters.ts";
import { isPathReadableAtReach } from "../../search/result-filters.ts";
import { TRANSPORT_REACH } from "../../graph/transport-reach.ts";
import {
  renderProvenanceSection,
  sourceIdentityHash,
  type Provenance,
} from "../provenance/provenance.ts";
import { PLAN_ID_LABEL, recordCompleted } from "./checkpoint.ts";
import {
  extractedBytesOf,
  extractedDigestOf,
  readManifest,
  updateManifest,
} from "./content-manifest.ts";
import { computeExtractionContractFingerprint } from "./contract.ts";
import { cutAppendedDelta } from "./tail-read.ts";
import {
  PRE_EXTRACT_MAX_SOURCE_BYTES,
  SOURCE_OPEN_FLAGS,
  SOURCE_UNREAD,
  readSourceBounded,
} from "./source-read.ts";
import { deriveSourceSection, type PartsOutcome, type TableOutcome } from "./extract-source.ts";
import {
  isCodeStructureSource,
  preExtractCodeStructure,
  type PreExtractResult,
} from "./pre-extract.ts";
import { REVIEW_LANE } from "../write-gate.ts";
import {
  listPendingLane,
  resolveWriteDisposition,
  stageForReview,
} from "../pending/pending-lanes.ts";
import type { WriteSubject } from "../write-disposition.ts";

/** Frontmatter `kind:` marker of an ingested source summary page. */
export const BRAIN_SOURCE_KIND = "brain-source";

export interface IngestSourceInput {
  /** Source identity - a vault-relative path or a URL. Canonicalized on write. */
  readonly sourcePath: string;
  /** Agent-written summary prose for the source. */
  readonly summary: string;
  /** The entities + relations the agent extracted from the source. */
  readonly extraction: ExtractionIntake;
}

export interface IngestSourceOptions {
  readonly agent: string;
  readonly now: Date;
  /**
   * Batch-plan id (t_ba1fa5f6). When set, a successful ingest of a vault-file
   * source records the source into that plan's resume checkpoint
   * (union-as-you-go). The content manifest stays the authoritative final
   * state; the checkpoint only tracks plan progress. Absent → no checkpoint.
   *
   * Held to the checkpoint store's id grammar (lowercase hex - the id becomes
   * a filename) and REFUSED here, before any write, when it is not. The
   * checkpoint write below is best-effort, and a caller-supplied id that can
   * never work is not the transient fault that tolerance is for: swallowed,
   * it left every source ingested with no plan progress recorded at all and
   * `--reconcile` reporting the whole batch as never ingested.
   */
  readonly planId?: string;
  /**
   * Run the deterministic code-structure pre-extraction pass (P4, t_ef786747)
   * over the source file and surface its JSON seeds on the result, so the agent
   * step can use them as pre-extracted facts. Off by default: with the pass
   * unset the ingest is byte-identical to before (no file read, no result
   * field). The seeds are NEVER written into the summary page - they travel on
   * the result only, keeping the persisted page unchanged.
   */
  readonly preExtract?: boolean;
  /**
   * May the caller read the vault file at this vault-relative path? Handed to
   * the intake: a source the predicate refuses is classified as one with no
   * local bytes (untrusted lane, no digest, `url-only`). A summary page it
   * refuses is left as it is and answered as absent. A local caller passes
   * nothing.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * The credential-minted subject of the caller (write-side-trust, Task
   * 7), when the transport resolved one. It WINS over `agent` as the
   * permission subject the review disposition consults - a caller-supplied
   * agent is content attribution, never the identity a document's rules
   * answer. Absent (stdio, the CLI) the disposition falls back to
   * `agent`, then to the config identity.
   */
  readonly subject?: WriteSubject;
}

export interface IngestSourceResult {
  /** Vault-relative path of the summary page. */
  readonly summaryPath: string;
  /** `false` when the summary page already existed and was rewritten. */
  readonly created: boolean;
  /** Entity ids newly created by this ingest. */
  readonly entitiesCreated: readonly string[];
  /** Entity ids that already existed and were touched. */
  readonly entitiesUpdated: readonly string[];
  /** Pre-existing entity ids this source connected to (its connections). */
  readonly connections: readonly string[];
  /**
   * How much of the source this page's knowledge was captured from: the
   * intake's lane for the cited source, as a capture scope. `full-local` for
   * a vault file, `url-only` for a source with no local bytes. Ingest never
   * stores an excerpt, so it never answers `bounded-local`: the summary is a
   * paraphrase, not a capture.
   */
  readonly captureScope: CaptureScope;
  /**
   * Digest of the durable archive entry holding this source's bytes
   * (redacted, content-addressed under `Brain/.archives/`), present only
   * when the trusted-local branch captured them - the same value the
   * summary page stamps as `source_archive_hash`. Absent means exactly
   * "not archived": an unstamped page is a state, never a failure.
   */
  readonly sourceArchiveHash?: string;
  /** UTF-8 byte count of the archived (redacted) entry, with the hash. */
  readonly sourceArchiveBytes?: number;
  /**
   * The named reason an ELIGIBLE capture FAILED - a past-ceiling input the
   * archive refused, or an archive write that could not land. Recorded so
   * the skip is not silent; the page stays unstamped either way. A source
   * that vanished between classification and the capture read is the
   * deliberate silent arm: neither stamp nor refusal (absence stays
   * absence), because a source that is gone is no longer trusted-local,
   * not a failed capture. Nor is this field ever present when the source
   * was simply not capture-eligible (untrusted, non-local, withheld from
   * remote readers): those behave exactly as before this field existed.
   * The text is identifiers only - a vault-relative source identity, byte
   * counts, an errno code - never a host path, since the field crosses to
   * the wire (see {@link archiveRefusalMessage}).
   */
  readonly sourceArchiveRefusal?: string;
  /**
   * Code-structure pre-extraction seeds (P4), present only when the pass was
   * requested via {@link IngestSourceOptions.preExtract}. `extracted: false`
   * when the source is not a supported code file or has no readable bytes -
   * never a fake empty success. Absent entirely when the pass was off.
   */
  readonly preExtract?: PreExtractResult;
  /**
   * What the HTML extractor made of an HTML source: a part count, or the
   * named reason there is no `## Parts` section. Absent for every other
   * format.
   */
  readonly parts?: PartsOutcome;
  /**
   * What the table note made of a CSV or TSV source: its counts, or the
   * named reason there is no `## Table` section. Absent for every other
   * format.
   */
  readonly table?: TableOutcome;
  /**
   * True when the review gate staged this FIRST publish of the summary
   * page into `Brain/pending/ingest/` instead of `Brain/sources/`
   * (write-side trust, Task 9). Registration - the intake, the manifest,
   * the plan checkpoint - completes exactly as before; only the page's
   * directory changes, and {@link pendingId} names the queue entry an
   * operator applies to publish it. A re-ingest of an already-published
   * page never stages: the review boundary is entry, not mutation.
   */
  readonly staged?: boolean;
  /** Id of the pending queue entry holding the staged summary page. */
  readonly pendingId?: string;
  /**
   * Present only on a staged ingest, and only when non-empty (review M13):
   * extracted relations the intake deferred because applying one would have
   * written `[[staged-id]]` into an already-published entity page - a link
   * to an entity that exists only in the review queue, left behind for good
   * if the operator rejects the staged page. They ride this result verbatim;
   * the re-ingest a held-back manifest row guarantees applies them through
   * the ordinary idempotent path once both endpoints are published.
   */
  readonly deferredRelations?: ReadonlyArray<IntakeRelation>;
  /**
   * The appended delta this source grew by since its recorded extraction
   * watermark (t_a9cd4221): the boundary-safe byte range
   * {@link ./tail-read.ts} verified as a pure append - the recorded digest
   * still described the leading bytes. Present ONLY on that append shape: a
   * first ingest, a rewritten source, or a source with no watermark reports
   * no delta and reprocesses fully.
   *
   * On the `appended` kind the stamp below advances the watermark to
   * exactly this range's `toByte` and records the digest of those leading
   * bytes (review M15), so the next append's prefix proof verifies against
   * the boundary the delta series announced. The range ends at the LAST
   * COMPLETE newline, so an append with no complete line yet reports an
   * EMPTY delta (`toByte === fromByte`) and the watermark stays at
   * `fromByte`: the unterminated fragment is extracted (extraction is
   * whole-source) but announced by no delta, and the NEXT append's delta
   * starts AT it, stitching the fragment in. A fragment only enters a
   * reported delta when the append that carries it ends with a newline
   * before this run reads.
   *
   * The `appended-over-cap` kind names a proven append whose tail passed
   * the delta cap: the range is the whole appended span, reported without
   * its text (review L3). The run stays a whole-source pass, so the stamp
   * still covered the full current file - the named outcome is the
   * difference from a rewrite, which reports no delta at all.
   *
   * Coverage (review L4): the watermark records what the CALLER
   * summarized, under the trusted lane's whole-source contract - a caller
   * the intake trusts has read the source it summarizes at its reach, so
   * every stamped byte was covered by this run's extraction. The optional
   * code-structure pre-extract pass is NOT that extraction; its skips
   * (unsupported format, source past the pre-extract cap) never gate the
   * stamp.
   */
  readonly extractionDelta?: AppendedDeltaOutcome;
}

/**
 * Frontmatter key an operator sets to scope a page's visibility. Kept on a
 * rewrite like `created_at`: dropping it on re-ingest would widen a page the
 * operator narrowed.
 */
const VISIBILITY_FRONTMATTER_KEY = "visibility";

function renderLinkSection(heading: string, ids: readonly string[]): string {
  if (ids.length === 0) return "";
  return [`## ${heading}`, "", ...ids.map((id) => `- [[${id}]]`)].join("\n");
}

/**
 * Ingest one source: intake its extracted entities/relations, then write the
 * per-source summary page with a Sources backlink, an entity list, and a
 * connections-to-existing-notes list. Idempotent on the source path.
 */
export function ingestSource(
  vault: string,
  input: IngestSourceInput,
  opts: IngestSourceOptions,
): IngestSourceResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // Before anything is written: an id the checkpoint store cannot use is a
  // resume that will never engage, and the caller has to hear it now rather
  // than discover it from a reconciliation report.
  if (opts.planId !== undefined && opts.planId.length > 0) {
    assertCheckpointId(PLAN_ID_LABEL, opts.planId);
  }
  // The SAME normaliser the trust classifier uses. This used to be a bare
  // `canonicalNotePath`, which left a caller-supplied `[[Articles/x.md]]`
  // wrapped: the summary page then wrote `[[[[Articles/x.md]]]]` and keyed on
  // a different identity hash than the bare spelling of the same source,
  // producing two summary pages for one source against this pipeline's
  // documented idempotency.
  const canonicalSource = normalizeSourceIdentity(input.sourcePath);
  // The page filename keys on the source-identity hash, not just the slug:
  // two distinct non-ASCII / symbol-only source paths can slugify to the same
  // fallback, which would silently clobber one summary with another. A hash
  // suffix keeps distinct sources distinct while staying idempotent (the same
  // source path always yields the same hash, hence the same file). Computed
  // BEFORE the intake so the review disposition (write-side trust, Task 12)
  // can name the exact target a deny refuses before anything is written.
  const sourceHash = sourceIdentityHash([canonicalSource]);
  const absPath = sourcePagePath(vault, `${slugify(canonicalSource)}-${sourceHash.slice(0, 12)}`);
  // A summary page the caller may not read (it inherited a reserved
  // source's visibility) is neither read nor rewritten, and the answer is
  // the one an absent page gets: its path is deterministic, so `created`
  // would otherwise tell the caller the page exists.
  const summaryPath = canonicalNotePath(relative(vault, absPath));
  // Review disposition (write-side trust, Tasks 9 and 12), resolved BEFORE
  // the intake so a refusal lands before ANY write - no entity page, no
  // manifest row, no summary page. With no permissions document the ingest
  // lane's toggle decides (off = publish); with one, the document alone
  // decides and a deny throws WriteRefusedError here, one ledger row behind
  // it. The stage verdict is consumed at the page write below.
  const disposition = resolveWriteDisposition(
    vault,
    REVIEW_LANE.ingest,
    opts.subject ?? (opts.agent !== undefined ? { agent: opts.agent, via: "config" } : undefined),
    { target: summaryPath, ...(opts.now !== undefined ? { now: opts.now } : {}) },
  );
  const preExtract =
    opts.preExtract === true ? runPreExtract(vault, canonicalSource, opts.readable) : undefined;
  const sourceLink = `[[${canonicalSource}]]`;
  const provenance: Provenance = { level: "stated", sources: [sourceLink], premises: [] };

  // The intake classifies the cited source itself and reports the lane back.
  // It used to be classified here as well and handed down as an argument,
  // which meant the same source was read twice and the second answer could be
  // overridden by the caller - see `intake/extract-intake.ts`.
  // The disposition verdict rides along (the intake's disposition contract):
  // on a `stage` verdict the intake stages the entity pages it CREATES into
  // review beside the summary page, so a staged ingest publishes nothing -
  // not the summary, not an entity page, not the manifest row below. The
  // verdict was resolved ONCE above and is only forwarded here, never
  // re-consulted. `refuse` is not expressible at this boundary: a deny threw
  // at the resolution itself, before any write.
  const intake = intakeExtraction(vault, input.extraction, {
    agent: opts.agent,
    now: opts.now,
    provenance,
    ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    ...(disposition.verdict === "stage" ? { disposition: "stage" as const } : {}),
  });
  const trust = intake.trust;
  const captureScope = captureScopeForTrust(trust);
  const connections = intake.entitiesUpdated;
  const allEntities = [...intake.entitiesCreated, ...intake.entitiesUpdated];
  // After the intake, which decided the lane: the derived section reads the
  // source only in the trusted lane and only at the caller's reach.
  const derivation = deriveSourceSection(vault, canonicalSource, trust, opts.readable);
  // The durable archive: the trusted-local branch reads its source ONCE,
  // redacts, and persists the bytes BEFORE the page write, so the stamp in
  // the frontmatter below can only land on a page whose evidence is already
  // on disk.
  const archive = captureTrustedSourceArchive(vault, canonicalSource, trust);

  const withheld = existsSync(absPath) && opts.readable?.(summaryPath) === false;
  const existed = !withheld && existsSync(absPath);
  const stamp = isoSecond(opts.now);
  // Preserve the original created_at and an operator-set visibility on a
  // re-ingest; bump updated_at.
  const kept: KeptFrontmatter = existed
    ? readKeptFrontmatter(absPath, stamp)
    : { createdAt: stamp };

  const meta: FrontmatterMap = {
    kind: BRAIN_SOURCE_KIND,
    source_path: canonicalSource,
    source_hash: sourceHash,
    provenance: provenance.level,
    // Marks the summary page itself when the material behind it came from
    // outside the vault, so the retrieval trust gate excludes it with a
    // reason rather than ranking it beside the operator's own notes. Trusted
    // sources add nothing, keeping their page byte-identical to before.
    ...untrustedSourceFrontmatter(trust),
    // Says how much of the source was captured when it is less than the
    // whole file; a full-local source adds nothing, for the same reason.
    ...captureScopeFrontmatter(captureScope),
    // An HTML, CSV or TSV source read in the trusted lane names its format,
    // the digest of the bytes the section was derived from, and its own
    // keys. Every other source adds nothing.
    ...derivation?.frontmatter,
    // Durable evidence: the digest of the archived (redacted) source bytes
    // and their count, ON SUCCESS ONLY. A page whose source was not archived
    // adds nothing, so an unstamped page still reads as exactly "not
    // captured" - absence is a state, never a failure.
    ...(archive.hash !== undefined
      ? {
          [SOURCE_ARCHIVE_HASH_KEY]: archive.hash,
          [SOURCE_ARCHIVE_BYTES_KEY]: archive.bytes,
        }
      : {}),
    created_at: kept.createdAt,
    updated_at: stamp,
    tags: ["brain", "brain/source"],
    ...visibilityFrontmatter(kept.visibility, derivation?.visibility),
  };

  const body = [
    input.summary.trim(),
    renderProvenanceSection(provenance),
    renderLinkSection("Entities", allEntities),
    renderLinkSection("Connections to existing notes", connections),
    derivation?.section ?? "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  // Idempotent no-op: only rewrite the summary page when its bytes would
  // actually change. A byte-identical rewrite would churn the mtime and wake
  // the index watcher for nothing; skipping it keeps a re-ingest of an
  // unchanged source truly inert.
  const nextContents = formatFrontmatter(meta, body);
  const unchanged = existed && readFileSync(absPath, "utf8") === nextContents;
  // Review gate (write-side trust, Task 9): a FIRST publish of the summary
  // page stages under the ingest lane while registration completes. The
  // disposition itself was resolved BEFORE the intake (Task 12), so a deny
  // refused the whole ingest before any write. A page that already exists
  // was admitted when it was first ingested, so a re-ingest rewrites it
  // directly - the review boundary is entry, not mutation. A withheld page
  // is left exactly as an absent one, staged or not: the caller must not
  // learn a page it cannot read exists.
  let stagedFields: { readonly pendingId: string } | undefined;
  if (!withheld && !unchanged && !existed && disposition.verdict === "stage") {
    // One open entry per publish target (review M13): a re-ingest of a
    // source whose summary is still staged re-renders the same page and
    // used to refuse with a staged-target conflict. The open entry IS the
    // staged summary - it is reused, never duplicated.
    const open = listPendingLane(vault, REVIEW_LANE.ingest).entries.find(
      (entry) => entry.publishTarget === summaryPath,
    );
    stagedFields = {
      pendingId:
        open !== undefined
          ? open.id
          : stageForReview(vault, REVIEW_LANE.ingest, summaryPath, () => nextContents).pendingId,
    };
  }
  if (stagedFields === undefined && !withheld && !unchanged) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFrontmatterAtomic(absPath, meta, body, { overwrite: true });
  }

  // Record the source's CONTENT hash so a future re-ingest can classify it
  // `unchanged` and skip the extraction pass. Only when the source resolves to
  // a real file inside the vault - URL and other identity-only sources have no
  // bytes to hash and must leave the manifest untouched (backward-compatible).
  // The containment predicate is the same one the pre-extract read answers to:
  // an escaping identity must not reach `existsSync` either, or a path outside
  // the vault would be hashed into the content manifest and keyed into a
  // folder-plan checkpoint.
  // Only in the trusted lane, which the intake grants only to a file the
  // caller may read at its reach: a source answered as absent records no
  // digest anywhere, the manifest included.
  // Nor when the page was withheld: the manifest would then record a
  // summary as current that this call did not write.
  // Nor on a `stage` disposition: the manifest row is a registration row of
  // the same logical write as the summary and entity pages, so it owes the
  // verdict they got (the intake's disposition contract) - a staged ingest
  // must not record itself as done while its output awaits review. The row
  // stays unrecorded until a publish arm actually writes; a re-ingest then
  // re-classifies the source as new and re-runs, which is the fail-safe
  // direction.
  let extractionDelta: IngestSourceResult["extractionDelta"];
  if (
    !withheld &&
    disposition.verdict !== "stage" &&
    trust === INTAKE_TRUST.trusted &&
    resolvesInsideVault(vault, canonicalSource) &&
    existsSync(join(vault, canonicalSource))
  ) {
    const sourceAbs = join(vault, canonicalSource);
    // The manifest read sits OUTSIDE the fs-race catch below: a corrupted or
    // unsupported manifest is its own named hard error (`readManifest`'s
    // contract), never a silently skipped stamp.
    const entry = readManifest(vault).entries[canonicalSource];
    const watermark = entry === undefined ? 0 : extractedBytesOf(entry);
    // Record the source's state under the live contract, WITH the extraction
    // watermark. The append proof and the tail read run off ONE descriptor
    // and ONE pass over the bytes (review L2), so a file growing under the
    // reader cannot produce a proof and a delta that describe two versions.
    //
    // The stamp covers exactly the prefix the reported delta announces
    // (review M15): on a proven append the watermark advances to the delta's
    // boundary-safe `toByte` and the recorded digest is the digest of
    // exactly those leading bytes, so the next append's prefix proof
    // verifies against the watermark the delta series actually announced,
    // and an unterminated trailing fragment stays unstamped for the next
    // delta to stitch in. On every other shape - a first ingest, a
    // rewritten source, a shrink, an over-cap append - this run is a
    // whole-source pass and the stamp covers the full current file. Both
    // arms keep ONE invariant: the recorded digest always describes exactly
    // `extracted_bytes` leading bytes of the source.
    //
    // The source can still vanish (ENOENT) or change kind (a directory where
    // the classified file stood) between the existsSync above and this read -
    // after the summary pages were written, where a throw would lose this
    // run's result. Such a read degrades the fail-safe way: no delta is
    // reported and no stamp lands, so the source simply reprocesses fully
    // next time. The ENOENT window and the EISDIR window are the same catch.
    let manifestStamp:
      | { readonly digest: string; readonly wholeDigest: string; readonly bytes: number }
      | undefined;
    let stampFullSize = false;
    try {
      const snapshot = readAppendSnapshot(
        sourceAbs,
        watermark,
        entry === undefined ? "" : extractedDigestOf(entry),
      );
      const delta = appendedDeltaFromSnapshot(watermark, snapshot);
      if (delta !== undefined) extractionDelta = delta;
      if (delta?.kind === "appended") {
        // The decision above already extended the through-watermark hash
        // with exactly the announced bytes: its digest is the digest of the
        // leading `toByte` bytes, computed with no second read.
        manifestStamp = {
          digest: snapshot.hashThroughWatermark.digest("hex"),
          wholeDigest: snapshot.wholeDigest,
          bytes: delta.toByte,
        };
      } else {
        // An over-cap append is a reprocess-scale change (review L3): the
        // run stays a whole-source pass, so its stamp covers the full
        // current file - only the delta TEXT was refused, and the named
        // outcome on the result says so.
        stampFullSize = true;
      }
    } catch {
      // Vanished or changed kind mid-flight: no delta, no stamp - the source
      // reprocesses fully next time.
    }
    if (manifestStamp !== undefined) {
      // The fragment stamp: a digest over exactly the announced prefix,
      // which only this run's snapshot holds, so it pins a precomputed
      // record under the lock. The full-size arms below carry no such
      // precomputed pair; this one keeps the L1 window bounded to the
      // fragment shape - two CONCURRENT ingests of one source, the later
      // snapshot taken before the earlier run's append landed - and the
      // recorded pair stays self-consistent either way.
      // The whole-file digest stays what classification compares, so an
      // unterminated fragment does not re-queue the source on every batch
      // plan; the prefix digest rides beside it for the next append proof.
      updateManifest(vault, [canonicalSource], {
        [canonicalSource]: {
          sha256: manifestStamp.wholeDigest,
          ...(manifestStamp.digest !== manifestStamp.wholeDigest
            ? { extracted_sha256: manifestStamp.digest }
            : {}),
          fingerprint: computeExtractionContractFingerprint(vault),
          extracted_bytes: manifestStamp.bytes,
          extracted_at: isoSecond(opts.now),
        },
      });
    } else if (stampFullSize) {
      // The full-size stamp through the IN-LOCK watermark request (review
      // L1): updateManifest stats and hashes the source itself, under the
      // manifest lock, so no caller-precomputed digest-and-watermark pair
      // exists to go stale against a concurrent append. The recorded values
      // are the ones the whole-source arms always meant: the live full
      // digest at the live full size, under the live contract fingerprint.
      updateManifest(
        vault,
        [canonicalSource],
        {},
        {
          watermarks: { [canonicalSource]: { at: isoSecond(opts.now) } },
        },
      );
    }
    // Record plan-scoped progress so an interrupted batch resumes at the item
    // boundary (t_ba1fa5f6). Only for real vault files - a URL/identity-only
    // source has no place in a folder plan's checkpoint. Best-effort: a
    // checkpoint write failure must never fail the ingest that already landed.
    if (opts.planId !== undefined && opts.planId.length > 0) {
      try {
        recordCompleted(vault, opts.planId, dirname(canonicalSource), [canonicalSource], opts.now);
      } catch {
        // Checkpointing is a resumability optimization, not correctness -
        // and what is tolerated here is now only the TRANSIENT half: a lock
        // this run could not take, a write that failed. The permanent,
        // caller-caused half (an id the store cannot use) was refused at the
        // top of this function, before the ingest wrote anything.
      }
    }
  }

  return {
    summaryPath,
    created: !existed,
    entitiesCreated: intake.entitiesCreated,
    entitiesUpdated: intake.entitiesUpdated,
    connections,
    captureScope,
    ...(archive.hash !== undefined
      ? { sourceArchiveHash: archive.hash, sourceArchiveBytes: archive.bytes }
      : {}),
    ...(archive.refusal !== undefined ? { sourceArchiveRefusal: archive.refusal } : {}),
    ...(stagedFields !== undefined ? { staged: true, pendingId: stagedFields.pendingId } : {}),
    ...(intake.deferredRelations !== undefined
      ? { deferredRelations: intake.deferredRelations }
      : {}),
    ...(extractionDelta !== undefined ? { extractionDelta } : {}),
    ...(preExtract !== undefined ? { preExtract } : {}),
    ...(derivation?.parts !== undefined ? { parts: derivation.parts } : {}),
    ...(derivation?.table !== undefined ? { table: derivation.table } : {}),
  };
}

/**
 * The shared bounded source-read substrate moved to {@link ./source-read.ts}:
 * the open discipline, the named refusal vocabulary, the whole-source bounded
 * read and the shared scale cap. The names re-export here so every existing
 * consumer keeps its import.
 */
export {
  PRE_EXTRACT_MAX_SOURCE_BYTES,
  readSourceBounded,
  SOURCE_UNREAD,
  type SourceUnread,
} from "./source-read.ts";

/** What the trusted-local branch's archive attempt concluded. */
interface ArchiveCapture {
  /** Digest of the persisted (redacted) entry, on success only. */
  readonly hash?: string;
  /** Its UTF-8 byte count, beside the digest. */
  readonly bytes?: number;
  /** The named refusal, when an eligible source could not be archived. */
  readonly refusal?: string;
}

/** May a remote reader read the vault file at this vault-relative path? */
function remotelyReadable(vault: string): (rel: string) => boolean {
  const cache: FrontmatterCache = new Map();
  return (rel) => isPathReadableAtReach(vault, rel, TRANSPORT_REACH.remote, cache);
}

/**
 * The refusal text the capture records. `SourceArchiveError` and
 * `SourceTrustError` carry identifiers and integers only, by contract;
 * anything else reaching this catch is a host fs error whose own message
 * embeds the absolute path the call failed on, so only its errno code (or
 * error class) is kept - the same identifiers-only composition
 * `source-trust`'s refusals use. The refusal rides the ingest result, so
 * it never names a host path.
 */
function archiveRefusalMessage(error: unknown): string {
  if (error instanceof SourceArchiveError || error instanceof SourceTrustError) {
    return error.message;
  }
  return `source archive failed (${errnoCode(error)})`;
}

/**
 * Archive the trusted source's bytes for re-verification, or say why not.
 *
 * Eligibility is the digest's own visibility rule, inherited: a trusted
 * local source whose bytes are withheld from remote readers is never
 * archived, or the archive would make the bytes MORE reachable than the
 * digest that names them (the rule `extract-intake` applies to the content
 * hash). Untrusted and non-local sources are not capture-eligible and
 * behave byte-identically to before this lane existed.
 *
 * The read is the byte-keeping one (`readSourceOrigin`), so the digest and
 * the archived bytes come off ONE descriptor and cannot describe two
 * versions of the source. A capture failure - a past-ceiling refusal, a
 * permission denial, a race with a deleting writer - never fails an ingest
 * that already committed its knowledge: the named refusal is recorded on
 * the result and the page simply stays unstamped.
 */
function captureTrustedSourceArchive(
  vault: string,
  canonicalSource: string,
  trust: IntakeTrust,
): ArchiveCapture {
  if (trust !== INTAKE_TRUST.trusted) return {};
  if (!resolvesInsideVault(vault, canonicalSource)) return {};
  if (isSourceHidden(vault, canonicalSource, remotelyReadable(vault))) return {};
  try {
    const origin = readSourceOrigin(vault, canonicalSource);
    // The silent arm: a vanished source is no longer trusted-local, not a
    // failed capture - so neither stamp nor refusal (absence stays
    // absence; see `sourceArchiveRefusal`'s contract).
    if (origin.bytes === undefined) return {};
    const put = putSourceArchive(vault, origin.bytes);
    return { hash: put.hash, bytes: put.bytes };
  } catch (error) {
    return { refusal: archiveRefusalMessage(error) };
  }
}

/**
 * The appended delta an ingest result reports. `appended` is the proven,
 * boundary-safe range whose text the delta pass read; `appended-over-cap`
 * is a PROVEN append whose tail passed the delta cap - the whole appended
 * range is reported without reading its text, so an append at reprocess
 * scale never answers the same shape a rewrite gets (review L3). Absent
 * for every shape that is not a proven append: a first ingest, a
 * rewritten source, a source with no watermark.
 */
export type AppendedDeltaOutcome =
  | { readonly kind: "appended"; readonly fromByte: number; readonly toByte: number }
  | { readonly kind: "appended-over-cap"; readonly fromByte: number; readonly toByte: number };

/**
 * The largest appended tail the extraction-delta pass reads ({@link ./tail-read.ts}):
 * a tail past this is a reprocess-scale change, not a delta. Starts from
 * {@link PRE_EXTRACT_MAX_SOURCE_BYTES} - the same scale rule the
 * whole-source pre-extract read applies. Exported so the CLI extract
 * preview draws its appended section under exactly this cap and never
 * reports a slice the pipeline itself would refuse.
 */
export const EXTRACTION_DELTA_MAX_BYTES = PRE_EXTRACT_MAX_SOURCE_BYTES;

/** Bytes hashed per positioned read while verifying an append's prefix. */
const PREFIX_HASH_CHUNK_BYTES = 65_536;

/**
 * The appended delta `sourceAbs` grew by since its recorded extraction
 * watermark, when it grew by a PROVABLE pure append: the recorded digest
 * must still describe exactly the leading watermark bytes, or the source was
 * rewritten rather than appended and the honest answer is no delta - the
 * full reprocess the modified classification already triggers. The returned
 * range is boundary-safe ({@link ./tail-read.ts}): it ends at the last
 * complete newline, and it is empty when the append has none yet.
 *
 * Exported because the CLI extract preview reports the same fact (`o2b
 * brain extract`'s appended section): one helper, so the preview can never
 * announce a slice the pipeline's own delta pass would refuse, nor call an
 * append what the prefix proof calls a rewrite.
 */
export function appendedExtractionDelta(
  vault: string,
  sourceAbs: string,
  canonicalSource: string,
): { readonly fromByte: number; readonly toByte: number } | undefined {
  const entry = readManifest(vault).entries[canonicalSource];
  if (entry === undefined) return undefined;
  const watermark = extractedBytesOf(entry);
  if (watermark <= 0) return undefined;
  const snapshot = readAppendSnapshot(sourceAbs, watermark, extractedDigestOf(entry));
  const delta = appendedDeltaFromSnapshot(watermark, snapshot);
  // The preview's contract is unchanged by the named over-cap outcome: a
  // tail past the cap answers without a section, exactly as before (the
  // section's whole value is the text-able slice).
  return delta !== undefined && delta.kind === "appended"
    ? { fromByte: delta.fromByte, toByte: delta.toByte }
    : undefined;
}

/** What ONE descriptor and one sequential pass over the source answered. */
interface AppendSnapshot {
  /** File size at the read; the prefix digest describes exactly this byteset's head. */
  readonly size: number;
  /**
   * True when the leading watermark bytes still hash to the recorded
   * digest: the append the tail reports is a PROVEN pure append, not a
   * rewrite that happens to have grown.
   */
  readonly prefixProven: boolean;
  /**
   * The bytes past the watermark. Within the delta cap the buffer is the
   * COMPLETE tail; past it only the fact is recorded (`overCap`), the bytes
   * never buffered.
   */
  readonly tail: { readonly overCap: true } | { readonly overCap: false; readonly bytes: Buffer };
  /**
   * Hash of exactly the leading watermark bytes. The caller extends it with
   * the announced delta's leading bytes to reach a digest at any boundary
   * the delta series names, computed with no second read (review L2).
   */
  readonly hashThroughWatermark: Hash;
  /**
   * SHA-256 hex of every byte this one pass read: the whole source as the
   * snapshot saw it. Empty when `watermark <= 0` (no pass was made); only
   * the appended arm, which requires a watermark, reads it.
   */
  readonly wholeDigest: string;
}

/**
 * Read `sourceAbs` once - one non-blocking descriptor, each byte read
 * exactly once - and answer everything the append proof and the delta cut
 * need: the prefix proof against `expectedDigest` and the appended tail.
 * The whole-source stamp is NOT answered here: the full-size arms record
 * it through updateManifest's in-lock watermark request (review L1), whose
 * hash is the only one that cannot go stale, so this pass never hashes
 * past the tail. `watermark <= 0` answers without reading a single byte -
 * no proof against nothing is possible and no tail can exist - so a first
 * ingest's only whole-source pass is the in-lock stamp hash itself, which
 * is the first watermark. A source that cannot be opened or is not a
 * regular file throws; the caller answers that fail-safe way.
 */
function readAppendSnapshot(
  sourceAbs: string,
  watermark: number,
  expectedDigest: string,
): AppendSnapshot {
  const fd = openSync(sourceAbs, SOURCE_OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not a regular file: ${sourceAbs}`);
    const size = stat.size;
    if (watermark <= 0) {
      // No watermark: the walk below would read every byte to EOF and
      // compute nothing - no prefix to hash, no tail to collect. The
      // full-size stamp this arm feeds IS the first watermark, recorded
      // through the in-lock request, so the guards above (the ENOENT and
      // not-a-file windows the caller's catch answers) are all this call
      // still owes.
      return {
        size,
        prefixProven: false,
        tail: { overCap: false, bytes: Buffer.alloc(0) },
        hashThroughWatermark: createHash("sha256"),
        wholeDigest: "",
      };
    }
    const hashWhole = createHash("sha256");
    const hashPrefix = createHash("sha256");
    const hashThroughWatermark = createHash("sha256");
    const tailParts: Buffer[] = [];
    let tailFilled = 0;
    const chunk = Buffer.allocUnsafe(PREFIX_HASH_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      const buf = count === chunk.length ? chunk : chunk.subarray(0, count);
      hashWhole.update(buf);
      const prefixEnd = Math.min(watermark - position, count);
      if (prefixEnd > 0) {
        const head = buf.subarray(0, prefixEnd);
        hashPrefix.update(head);
        hashThroughWatermark.update(head);
      }
      if (position + count > watermark && tailFilled <= EXTRACTION_DELTA_MAX_BYTES) {
        // Copied: `chunk` is reused by the next read, so a view into it
        // would be overwritten whenever the tail spans more than one chunk.
        const part = Buffer.from(buf.subarray(Math.max(0, watermark - position)));
        tailParts.push(part);
        tailFilled += part.length;
      }
      position += count;
    }
    return {
      size,
      prefixProven: hashPrefix.digest("hex") === expectedDigest,
      tail:
        tailFilled > EXTRACTION_DELTA_MAX_BYTES
          ? { overCap: true }
          : { overCap: false, bytes: Buffer.concat(tailParts) },
      hashThroughWatermark,
      wholeDigest: hashWhole.digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}
/**
 * The appended delta a snapshot proves, boundary-safe: a pure append within
 * the delta cap cut at the last complete newline. Everything else - no
 * watermark, a rewrite, a shrink, a tail past the cap - answers no delta;
 * the modified classification and its full reprocess are the safe direction.
 *
 * On the proven shape this ALSO extends the snapshot's
 * `hashThroughWatermark` with exactly the announced bytes, so the caller's
 * next `digest()` is the digest of the leading `toByte` bytes - the stamp's
 * prefix, computed with no second read (review L2). Calling it is therefore
 * not idempotent on the snapshot; the CLI preview discards its snapshot and
 * never digests.
 */
function appendedDeltaFromSnapshot(
  watermark: number,
  snapshot: AppendSnapshot,
): AppendedDeltaOutcome | undefined {
  if (watermark <= 0 || !snapshot.prefixProven || snapshot.size <= watermark) return undefined;
  const tail = snapshot.tail;
  if (tail.overCap) {
    // The append is proven but its text is reprocess-scale: name it, and
    // report the whole appended range without reading it - only the range
    // is consumed (review L3).
    return { kind: "appended-over-cap", fromByte: watermark, toByte: snapshot.size };
  }
  const cut = cutAppendedDelta(tail.bytes, watermark);
  snapshot.hashThroughWatermark.update(tail.bytes.subarray(0, cut.toByte - watermark));
  return { kind: "appended", fromByte: cut.fromByte, toByte: cut.toByte };
}

/**
 * Run the code-structure pre-extraction pass over a vault-file source. A source
 * with no readable file bytes (a URL or identity-only source) cannot be parsed,
 * so it is reported as unextracted rather than a fake empty success. A source
 * `readable` refuses is answered the same way, before its bytes are read, so
 * the pass reads no file the intake would treat as having no local bytes.
 */
function runPreExtract(
  vault: string,
  canonicalSource: string,
  readable: ((rel: string) => boolean) | undefined,
): PreExtractResult {
  // The identity is caller-supplied and `..` segments survive normalization,
  // so the read is contained the same way the trust classifier contains its
  // own resolution (`source-trust.ts`): an identity that resolves outside the
  // vault is not this vault's file to read, and is reported as unextracted
  // rather than turned into a host-filesystem read.
  if (!resolvesInsideVault(vault, canonicalSource)) {
    return {
      extracted: false,
      reason: `source does not resolve inside this vault; code-structure pre-extraction skipped: ${canonicalSource}`,
    };
  }
  // A source the pass cannot parse needs neither its bytes nor the manifest:
  // the pass itself reports the unsupported extension, by name.
  if (!isCodeStructureSource(canonicalSource)) {
    return preExtractCodeStructure(canonicalSource, "");
  }
  const noBytes: PreExtractResult = {
    extracted: false,
    reason: `source has no readable file bytes for code-structure pre-extraction: ${canonicalSource}`,
  };
  if (readable !== undefined && !readable(canonicalSource)) return noBytes;
  const tooLarge: PreExtractResult = {
    extracted: false,
    reason: `source is larger than ${PRE_EXTRACT_MAX_SOURCE_BYTES} bytes; code-structure pre-extraction skipped: ${canonicalSource}`,
  };
  let content: string;
  try {
    const read = readSourceBounded(join(vault, canonicalSource), PRE_EXTRACT_MAX_SOURCE_BYTES);
    if (read.text === null) return read.unread === SOURCE_UNREAD.tooLarge ? tooLarge : noBytes;
    content = read.text;
  } catch {
    // A source with no readable file bytes - a URL/identity-only source, a
    // directory, a permission failure, or a deletion race - cannot be parsed,
    // so it is reported as unextracted rather than aborting the whole ingest.
    return noBytes;
  }
  // The manifest's canonical path set is what a relative import specifier
  // may bind to: a specifier probes it and fills the seed's `resolvedTo`
  // only on an exactly-one match. The source's OWN entry is not in the set
  // yet - the manifest is updated after this pass - which is the correct
  // incremental reality: a module cannot have been ingested before it was.
  // Read once, outside the source-read guard: a corrupted or unsupported
  // manifest is its own named error, never "no readable file bytes".
  return preExtractCodeStructure(canonicalSource, content, {
    ingestedFiles: new Set(Object.keys(readManifest(vault).entries)),
  });
}

/**
 * Does this canonical identity resolve to a location this vault owns? The
 * same containment the note-write ladder enforces, applied to the one
 * read path in the ingest pipeline that takes a caller-named identity.
 */
function resolvesInsideVault(vault: string, canonicalSource: string): boolean {
  try {
    ensureInsideVault(join(vault, canonicalSource), vault);
    return true;
  } catch {
    return false;
  }
}

/** The frontmatter a rewrite keeps from the page it replaces. */
interface KeptFrontmatter {
  readonly createdAt: string;
  readonly visibility?: FrontmatterMap[string];
}

/**
 * Read the stable `created_at` and an operator-set `visibility` from an
 * existing summary page; `created_at` falls back to `fallback`.
 */
function readKeptFrontmatter(absPath: string, fallback: string): KeptFrontmatter {
  const [meta] = parseFrontmatter(absPath);
  const value = meta["created_at"];
  const createdAt = typeof value === "string" && value.length > 0 ? value : fallback;
  const visibility = meta[VISIBILITY_FRONTMATTER_KEY];
  return visibility === undefined || visibility === null
    ? { createdAt }
    : { createdAt, visibility };
}

/**
 * The summary page's `visibility`. The page's audience is never wider than
 * the source's or the operator's: when only one side declares tokens, that
 * side's tokens are written (a page with neither gains none); when both do,
 * the page keeps the tokens both allow, and when they share none it gets
 * the reserved token, so it is withheld below local reach rather than
 * widened. The reserved token is kept whenever either side carries it.
 */
function visibilityFrontmatter(
  kept: KeptFrontmatter["visibility"],
  source: readonly string[] | undefined,
): FrontmatterMap {
  if (source === undefined || source.length === 0) {
    return kept !== undefined ? { [VISIBILITY_FRONTMATTER_KEY]: kept } : {};
  }
  let keptTokens: string[] = [];
  if (Array.isArray(kept)) keptTokens = kept.map((k) => normToken(String(k)));
  else if (kept !== undefined) keptTokens = [normToken(String(kept))];
  keptTokens = keptTokens.filter((k) => k.length > 0);
  if (keptTokens.length === 0) return { [VISIBILITY_FRONTMATTER_KEY]: [...source] };
  const merged = source.filter((token) => keptTokens.includes(token));
  const reserved =
    merged.length === 0 ||
    keptTokens.includes(REMOTE_DENY_VISIBILITY_TOKEN) ||
    source.includes(REMOTE_DENY_VISIBILITY_TOKEN);
  if (reserved && !merged.includes(REMOTE_DENY_VISIBILITY_TOKEN)) {
    merged.push(REMOTE_DENY_VISIBILITY_TOKEN);
  }
  return { [VISIBILITY_FRONTMATTER_KEY]: merged };
}

/**
 * Capture-scope detector: active knowledge that rests on url-only sources,
 * and pages whose claimed durable archive is gone or no longer matches.
 *
 * A page whose every cited source has no local bytes behind it rests on a
 * locator that may rot, and nothing on the page says so once the untrusted
 * marker is gone (an entity released from quarantine) or was never written
 * (a research report). This detector names those pages: one `warning` per
 * page, `review` proposed action - deciding whether to capture the source,
 * re-cite a local one or retire the page is an operator call.
 *
 * The archive arm (answer trust) is the second condition, and the sharper
 * one: an ingest summary stamped `source_archive_hash` claims durable
 * evidence behind it, and a stamp whose entry is absent - or present but
 * re-hashing differently - is exactly the rot this detector exists to name,
 * with the difference that the page SAID the evidence was there. It fires
 * however fresh the live source file is: the claim under test is the
 * archive's, not the file's.
 *
 * One finding per page: when both arms fire for the same page (a vanished
 * file whose archive entry went too), the archive finding wins - it
 * subsumes the url-only condition under the stronger statement that claimed
 * evidence is gone - and the per-page finding id stays unique, which the
 * apply plan's selection requires.
 *
 * Inspected: retrievable pages (the retrieval trust gate does not
 * quarantine them) of the four knowledge kinds - distillations, ingest
 * summaries, research reports, and entities in the canonical status scope.
 * A quarantined page is skipped: its untrusted marker already names the
 * condition.
 *
 * Stamp at write, re-derive on read. The scope of every cited identity is
 * re-derived on each sweep from its shape and one `stat` (never a byte
 * read), so a full-local page whose file vanished reports as url-only. A
 * stamped `bounded-local` counts as backing only while the page's excerpt
 * block is present and matches its stored digest; an edited or removed
 * excerpt is no longer a capture. A cited source the filesystem refuses to
 * answer for (permission denied, a symlink loop) is not provably url-only,
 * so it counts as backing: one unreadable citation never aborts the sweep
 * and never hides the other pages' findings. A cited file the caller may not
 * read at its reach counts as url-only, the answer an absent file gives, so
 * a finding never tells a narrower caller that a hidden page exists.
 *
 * The archive arm answers from the store, not from any caller's reach: the
 * verification is a fact about `Brain/.archives/` and the page's own stamp,
 * and the caller who may not read the page never sees the finding (the
 * scan's artifact-reference view withholds it with the page). A stamp that
 * is not a hash names no entry the store could hold, so it verifies as
 * `missing` - the stamp cannot be true.
 *
 * Cited sources are read with the shared source-link readers: the page's
 * `source_path` plus the targets under its `## Sources` heading.
 */

import { existsSync } from "node:fs";
import { join, posix } from "node:path";

import { listVaultNotePaths, parseFrontmatter } from "../../../vault.ts";
import type { FrontmatterMap } from "../../../types.ts";
import {
  BRAIN_DISTILLATIONS_REL,
  BRAIN_ENTITIES_REL,
  BRAIN_REPORTS_REL,
  BRAIN_SOURCES_REL,
} from "../../path-constants.ts";
import { BRAIN_DISTILLATION_KIND } from "../../distill/distill-source.ts";
import { BRAIN_SOURCE_KIND } from "../../ingest/ingest.ts";
import { BRAIN_REPORT_KIND } from "../../research/research.ts";
import { BRAIN_ENTITY_KIND } from "../../entities/types.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../../entities/status-scope.ts";
import { classifyRetrievalTrust } from "../../trust/retrieval-gate.ts";
import {
  CAPTURE_SCOPE,
  CAPTURE_SCOPE_KEY,
  EXCERPT_HASH_KEY,
  excerptDigest,
  isCaptureScope,
  readExcerptSection,
  resolveCaptureScope,
  type CaptureScope,
} from "../../provenance/capture-scope.ts";
import {
  ARCHIVE_VERIFICATION,
  SOURCE_ARCHIVE_HASH_KEY,
  sourceArchiveUncitedHashes,
  verifySourceArchive,
} from "../../provenance/source-archive.ts";
import { SourceTrustError, isSourceHidden } from "../../intake/source-trust.ts";
import { sourcesSectionTargets } from "../../source-links.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneFinding } from "../types.ts";

export const CAPTURE_SCOPE_DETECTOR_ID = "capture-scope" as const;

/** One-line summary every url-only finding of this detector carries. */
export const CAPTURE_SCOPE_FINDING_TITLE = "Active knowledge rests on url-only sources";

/** One-line summary every archive-stamp finding of this detector carries. */
export const CAPTURE_SCOPE_ARCHIVE_FINDING_TITLE =
  "A page's durable source archive is missing or no longer matches its stamp";

/** Frontmatter key holding a single-source page's source identity. */
const SOURCE_PATH_KEY = "source_path";

/** Frontmatter keys the inspection reads. */
const KIND_KEY = "kind";
const STATUS_KEY = "status";

/** Directories the four inspected kinds are written to. */
const INSPECTED_DIRS: ReadonlyArray<string> = Object.freeze([
  BRAIN_DISTILLATIONS_REL,
  BRAIN_SOURCES_REL,
  BRAIN_REPORTS_REL,
  BRAIN_ENTITIES_REL,
]);

/** Page kinds that carry knowledge built from cited sources. */
const INSPECTED_KINDS: ReadonlySet<string> = new Set([
  BRAIN_DISTILLATION_KIND,
  BRAIN_SOURCE_KIND,
  BRAIN_REPORT_KIND,
  BRAIN_ENTITY_KIND,
]);

function stringValue(meta: FrontmatterMap, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Is this page active knowledge a default recall would serve? */
function isRetrievableKnowledge(meta: FrontmatterMap): boolean {
  const kind = stringValue(meta, KIND_KEY);
  if (kind === null || !INSPECTED_KINDS.has(kind)) return false;
  if (kind === BRAIN_ENTITY_KIND) {
    const status = stringValue(meta, STATUS_KEY);
    if (status === null || !entityStatusInScope(status, ENTITY_STATUS_SCOPE.canonical)) {
      return false;
    }
  }
  return !classifyRetrievalTrust(meta).quarantined;
}

/** The page's cited source identities, deduplicated, in reading order. */
function citedSources(meta: FrontmatterMap, body: string): ReadonlyArray<string> {
  const sourcePath = stringValue(meta, SOURCE_PATH_KEY);
  const cited = [...(sourcePath !== null ? [sourcePath] : []), ...sourcesSectionTargets(body)];
  return [...new Set(cited)];
}

/** The page's own `capture_scope` stamp, `null` when absent or not a scope. */
function stampedScope(meta: FrontmatterMap): CaptureScope | null {
  const value = meta[CAPTURE_SCOPE_KEY];
  return isCaptureScope(value) ? value : null;
}

/** Does the page still hold the excerpt its stored digest describes? */
function excerptIntact(meta: FrontmatterMap, body: string): boolean {
  const digest = stringValue(meta, EXCERPT_HASH_KEY);
  if (digest === null) return false;
  const excerpt = readExcerptSection(body);
  return excerpt !== null && excerptDigest(excerpt) === digest;
}

/** May the caller read this vault-relative file? Always, without a predicate. */
type Readable = ((rel: string) => boolean) | undefined;

/**
 * Is this cited source url-only now, as the caller may know it? A refused
 * stat is not proof that it is, unless the caller may not read the file
 * either, which an absent file would answer too; a backing file the caller
 * may not read is.
 */
function isUrlOnly(vault: string, source: string, readable: Readable): boolean {
  try {
    const { scope, backing } = resolveCaptureScope(vault, source);
    if (scope === CAPTURE_SCOPE.urlOnly) return true;
    return backing !== null && readable !== undefined && !readable(backing);
  } catch (err) {
    if (err instanceof SourceTrustError) return isSourceHidden(vault, source, readable);
    throw err;
  }
}

function inspectPage(vault: string, page: string, readable: Readable): HygieneFinding | null {
  const [meta, body] = parseFrontmatter(join(vault, page));
  if (!isRetrievableKnowledge(meta)) return null;

  const sources = citedSources(meta, body);
  // The archive arm first, so a page failing BOTH conditions reports the
  // sharper archive finding once - never two findings with one id.
  const archiveFinding = inspectArchiveStamp(vault, page, meta, sources);
  if (archiveFinding !== null) return archiveFinding;

  if (sources.length === 0) return null;
  const allUrlOnly = sources.every((source) => isUrlOnly(vault, source, readable));
  if (!allUrlOnly) return null;

  const stamped = stampedScope(meta);
  if (stamped === CAPTURE_SCOPE.boundedLocal && excerptIntact(meta, body)) return null;

  const targets = Object.freeze([page]);
  return Object.freeze({
    id: hygieneFindingId(CAPTURE_SCOPE_DETECTOR_ID, targets),
    detector: CAPTURE_SCOPE_DETECTOR_ID,
    severity: "warning" as const,
    title: CAPTURE_SCOPE_FINDING_TITLE,
    targets,
    proposed_action: "review" as const,
    evidence: Object.freeze({ sources: Object.freeze([...sources]), stamped }),
  });
}

/**
 * The archive arm: does the page's claimed durable evidence still hold?
 * `null` for a page with no stamp (absence means "not captured", never a
 * finding) and for a stamp whose entry verifies; otherwise one finding per
 * page carrying the named verification state.
 */
function inspectArchiveStamp(
  vault: string,
  page: string,
  meta: FrontmatterMap,
  sources: ReadonlyArray<string>,
): HygieneFinding | null {
  const hash = stringValue(meta, SOURCE_ARCHIVE_HASH_KEY);
  if (hash === null) return null;
  // A malformed stamp verifies as `missing` - it names no entry the store
  // could hold, which is the state it is in.
  const state = verifySourceArchive(vault, hash).state;
  if (state === ARCHIVE_VERIFICATION.verified) return null;

  const targets = Object.freeze([page]);
  return Object.freeze({
    id: hygieneFindingId(CAPTURE_SCOPE_DETECTOR_ID, targets),
    detector: CAPTURE_SCOPE_DETECTOR_ID,
    severity: "warning" as const,
    title: CAPTURE_SCOPE_ARCHIVE_FINDING_TITLE,
    targets,
    proposed_action: "review" as const,
    evidence: Object.freeze({
      archive: state,
      hash,
      sources: Object.freeze([...sources]),
    }),
  });
}

/**
 * Every finding in the vault. `readable` is the caller's reach (see
 * `HygieneDetectorContext.readable`); a local caller passes nothing.
 */
export function detectCaptureScope(
  vault: string,
  readable?: (rel: string) => boolean,
): ReadonlyArray<HygieneFinding> {
  const pages: string[] = [];
  for (const dir of INSPECTED_DIRS) {
    const abs = join(vault, dir);
    if (!existsSync(abs)) continue;
    for (const rel of listVaultNotePaths(abs)) pages.push(posix.join(dir, rel));
  }
  const findings: HygieneFinding[] = [];
  for (const page of pages.toSorted()) {
    const finding = inspectPage(vault, page, readable);
    if (finding !== null) findings.push(finding);
  }
  return Object.freeze(findings);
}

/** What {@link auditArchiveStamps} counted. */
export interface ArchiveStampAudit {
  /** Stamped pages whose archive entry is absent. */
  readonly missing: number;
  /** Stamped pages whose entry is there but re-hashes differently. */
  readonly mismatched: number;
  /**
   * Store entries NO page cites - the structurally unreachable leftovers
   * the two counts above cannot see: a re-stamped page orphans the entry
   * the old stamp named, and a staged ingest rejected by review leaves
   * its entry behind. Evidence, not scratch, so the audit names them
   * rather than pruning them; release is an operator call made through
   * delete-by-source cleanup.
   */
  readonly uncited: number;
}

/**
 * Count the archive's rot, on both of its populations: the stamped pages
 * whose entry is gone or disagrees, and the store entries no page cites.
 * One walk over `Brain/sources/` for the stamps, one over the stamp roots
 * and the store for the uncited entries. Every stamp counted: unlike the
 * scan's finding list, no page is skipped for quarantine or reach,
 * because the doctor runs locally and reports a count, not a disclosure.
 * Integers, never a page list - recapture and pruning are operator calls
 * made from the hygiene scan's findings, not from these numbers.
 */
export function auditArchiveStamps(vault: string): ArchiveStampAudit {
  const counts = {
    missing: 0,
    mismatched: 0,
    uncited: sourceArchiveUncitedHashes(vault).length,
  };
  const abs = join(vault, BRAIN_SOURCES_REL);
  if (!existsSync(abs)) return counts;
  for (const rel of listVaultNotePaths(abs)) {
    const page = posix.join(BRAIN_SOURCES_REL, rel.split("\\").join("/"));
    const [meta] = parseFrontmatter(join(vault, page));
    const hash = stringValue(meta, SOURCE_ARCHIVE_HASH_KEY);
    if (hash === null) continue;
    const state = verifySourceArchive(vault, hash).state;
    if (state === ARCHIVE_VERIFICATION.missing) counts.missing += 1;
    else if (state === ARCHIVE_VERIFICATION.mismatched) counts.mismatched += 1;
  }
  return counts;
}

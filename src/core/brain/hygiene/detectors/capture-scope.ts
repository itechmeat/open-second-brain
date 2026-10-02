/**
 * Capture-scope detector: active knowledge that rests on url-only sources.
 *
 * A page whose every cited source has no local bytes behind it rests on a
 * locator that may rot, and nothing on the page says so once the untrusted
 * marker is gone (an entity released from quarantine) or was never written
 * (a research report). This detector names those pages: one `warning` per
 * page, `review` proposed action - deciding whether to capture the source,
 * re-cite a local one or retire the page is an operator call.
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
import { SourceTrustError, isSourceHidden } from "../../intake/source-trust.ts";
import { sourcesSectionTargets } from "../../source-links.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneFinding } from "../types.ts";

export const CAPTURE_SCOPE_DETECTOR_ID = "capture-scope" as const;

/** One-line summary every finding of this detector carries. */
export const CAPTURE_SCOPE_FINDING_TITLE = "Active knowledge rests on url-only sources";

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

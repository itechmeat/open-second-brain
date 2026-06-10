/**
 * Source-freshness substrate
 * (continuity-hygiene-freshness suite; kanban t_d9624ef6).
 *
 * Pages derived from on-disk artifacts (session transcripts, ingested
 * documents) record their provenance in frontmatter at derivation
 * time: `source_paths` (vault-relative or absolute paths) and the
 * parallel `source_hashes` (sha256 of each source's content, or the
 * literal `missing` marker). Freshness is then computable on demand -
 * no background jobs, no watcher:
 *
 *   - `fresh`: every recorded source still hashes the same;
 *   - `stale`: at least one source changed (or some, but not all,
 *     disappeared);
 *   - `orphaned`: every recorded source is gone.
 *
 * The truth lives on the page itself, so freshness survives search
 * index rebuilds and stays inspectable in the vault. Pages without the
 * contract are skipped silently; a malformed contract (length
 * mismatch) is reported, never thrown.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { listVaultPages, parseFrontmatter } from "../vault.ts";

/** Hash value recorded for a source that did not exist at derivation. */
export const MISSING_SOURCE_HASH = "missing";
/** Sentinel for a source that exists but cannot be read right now. */
export const UNREADABLE_SOURCE_HASH = "unreadable";

export interface SourceStamp {
  readonly source_paths: ReadonlyArray<string>;
  readonly source_hashes: ReadonlyArray<string>;
}

export type FreshnessStatus = "fresh" | "stale" | "orphaned";

export interface PageFreshness {
  readonly page: string;
  readonly status: FreshnessStatus;
  /** Sources whose current content hash differs from the recorded one. */
  readonly changed_sources: ReadonlyArray<string>;
  /** Recorded sources that no longer exist. */
  readonly missing_sources: ReadonlyArray<string>;
  /** Sources that exist but could not be read (transient I/O). */
  readonly unreadable_sources: ReadonlyArray<string>;
}

export interface FreshnessReport {
  readonly pages_checked: number;
  readonly with_contract: number;
  readonly fresh: number;
  readonly stale: ReadonlyArray<PageFreshness>;
  readonly orphaned: ReadonlyArray<string>;
  /** Pages whose contract is malformed (array length mismatch). */
  readonly invalid_contract: ReadonlyArray<string>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveSourcePath(vault: string, source: string): string {
  return isAbsolute(source) ? source : join(vault, source);
}

function hashSource(vault: string, source: string): string {
  const path = resolveSourcePath(vault, source);
  try {
    if (!existsSync(path)) return MISSING_SOURCE_HASH;
    return sha256(readFileSync(path, "utf8"));
  } catch {
    // A transient permission / I/O failure is NOT a deleted source -
    // it must never feed orphan detection (and the cleanup/archive
    // path behind it).
    return UNREADABLE_SOURCE_HASH;
  }
}

/**
 * Build the provenance stamp a derived-page writer records at
 * derivation time. Missing sources stamp the `missing` marker instead
 * of throwing, so a writer never fails on provenance bookkeeping.
 */
export function computeSourceStamp(vault: string, sources: ReadonlyArray<string>): SourceStamp {
  return Object.freeze({
    source_paths: Object.freeze([...sources]),
    source_hashes: Object.freeze(sources.map((source) => hashSource(vault, source))),
  });
}

/**
 * Render the stamp as frontmatter lines (no surrounding `---`),
 * matching the flat inline-array grammar `parseFrontmatter` reads
 * back. Paths are JSON-quoted so YAML-significant characters in a
 * filename cannot break or inject frontmatter fields.
 */
export function formatSourceStampFrontmatter(stamp: SourceStamp): string {
  const paths = stamp.source_paths.map((p) => JSON.stringify(p)).join(", ");
  const hashes = stamp.source_hashes.map((h) => JSON.stringify(h)).join(", ");
  return `source_paths: [${paths}]\nsource_hashes: [${hashes}]`;
}

function readContract(meta: Record<string, unknown>): SourceStamp | "absent" | "invalid" {
  const paths = meta["source_paths"];
  const hashes = meta["source_hashes"];
  if (paths === undefined && hashes === undefined) return "absent";
  if (!Array.isArray(paths) || !Array.isArray(hashes)) return "invalid";
  if (paths.length === 0 || paths.length !== hashes.length) return "invalid";
  if (![...paths, ...hashes].every((value) => typeof value === "string")) return "invalid";
  return Object.freeze({
    source_paths: Object.freeze(paths as string[]),
    source_hashes: Object.freeze(hashes as string[]),
  });
}

/**
 * Compute one page's freshness from its recorded contract. Returns
 * `null` when the page carries no contract (or a malformed one) -
 * callers that need the distinction use {@link scanFreshness}.
 */
export function checkPageFreshness(vault: string, pagePath: string): PageFreshness | null {
  const [meta] = parseFrontmatter(pagePath);
  const contract = readContract(meta);
  if (contract === "absent" || contract === "invalid") return null;
  return freshnessOf(vault, pagePath, contract);
}

function freshnessOf(vault: string, pagePath: string, contract: SourceStamp): PageFreshness {
  const changed: string[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  for (let i = 0; i < contract.source_paths.length; i++) {
    const source = contract.source_paths[i]!;
    const recorded = contract.source_hashes[i]!;
    const current = hashSource(vault, source);
    if (current === MISSING_SOURCE_HASH) {
      // Gone is gone - even a source that was already missing at
      // derivation leaves the page without a living origin.
      missing.push(source);
      continue;
    }
    if (current === UNREADABLE_SOURCE_HASH) {
      // Cannot verify right now: report it, classify the page stale at
      // worst, and keep it OUT of orphan detection.
      unreadable.push(source);
      continue;
    }
    if (current !== recorded) changed.push(source);
  }
  const status: FreshnessStatus =
    missing.length === contract.source_paths.length
      ? "orphaned"
      : changed.length > 0 || missing.length > 0 || unreadable.length > 0
        ? "stale"
        : "fresh";
  return Object.freeze({
    page: pagePath,
    status,
    changed_sources: Object.freeze(changed),
    missing_sources: Object.freeze(missing),
    unreadable_sources: Object.freeze(unreadable),
  });
}

/**
 * Walk every markdown page in the vault and classify the ones carrying
 * the contract. On-demand and read-only.
 */
export function scanFreshness(vault: string): FreshnessReport {
  const pages = listVaultPages(vault);
  let withContract = 0;
  let fresh = 0;
  const stale: PageFreshness[] = [];
  const orphaned: string[] = [];
  const invalid: string[] = [];
  for (const page of pages) {
    const [meta] = parseFrontmatter(page.path);
    const contract = readContract(meta);
    if (contract === "absent") continue;
    if (contract === "invalid") {
      invalid.push(page.path);
      continue;
    }
    withContract++;
    const freshness = freshnessOf(vault, page.path, contract);
    if (freshness.status === "fresh") fresh++;
    else if (freshness.status === "orphaned") orphaned.push(page.path);
    else stale.push(freshness);
  }
  return Object.freeze({
    pages_checked: pages.length,
    with_contract: withContract,
    fresh,
    stale: Object.freeze(stale),
    orphaned: Object.freeze(orphaned),
    invalid_contract: Object.freeze(invalid),
  });
}

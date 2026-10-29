/**
 * The planted-rows audit planner (lane A, trust-and-responsiveness-hardening,
 * t_c2ac4fc8).
 *
 * The write-time neutralizer keeps third-party text from planting
 * structure; this planner reports the rows that are ALREADY planted - the
 * pages written before the gate existed or while it is off. It is the
 * pure half of the doctor's `planted-structure-rows` counting check (the
 * `planPrivacyMarkerRestamp` shape: planner module, one counting check),
 * so the finding, its count and what enforce mode would change cannot
 * drift apart: both this audit and the neutralizer read the one
 * detection grammar in `text/neutralize-markdown.ts`.
 *
 * The population is split the way authorship actually splits. For the
 * marker and osb-fence families it is EVERY readable page under `Brain/`:
 * no Brain writer ever emits a live `@osb` marker line or a live ```osb
 * fence (the consumed `@osb✓` sentinel is not detection), so a live one
 * anywhere in the derived layer is planted by construction - the same
 * structure the §9 vault scan would harvest into signals from any page
 * it walks. For the wikilink and atx-heading families it stays the
 * third-party lanes keyed off PROVENANCE, because the Brain's own
 * writers render those by design on pages outside the lanes - the
 * manual's section headings, the log's `[[Brain/log/...]]` refs, the
 * digests' links - and reporting them regardless of provenance would
 * report the vault's own structure as planted on every run.
 *
 * The provenance classification therefore also rides along as CONTEXT on
 * each finding ({@link PlantedRowsPage.thirdParty}), and the doctor names
 * lane pages first - a lane page and an operator note with the same rows
 * are equally live, but not equally expected.
 *
 * The scan over each page's body is the neutralizer's own detection, so
 * an inert excerpt inside a fenced code block counts nothing while a
 * planted ```osb fence line does. Staged copies under `Brain/pending/`
 * are deduplicated against their publish targets by content: the pending
 * directory holds a byte-verbatim copy of the page under review, so the
 * same rows would otherwise be reported twice.
 *
 * Read-only by contract: nothing here writes, and a page that cannot be
 * read between the walk and the body scan is skipped rather than thrown
 * - the doctor never throws.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listVaultPages, parseFrontmatter } from "../vault.ts";
import { vaultRelative } from "../path-safety.ts";
import { BRAIN_PENDING_REL, isUnderBrainRoot } from "./path-constants.ts";
import { MAINTENANCE_LANE_REACH } from "../graph/transport-reach.ts";
import { hasUntrustedSourceMarker } from "./trust/untrusted-provenance.ts";
import { BRAIN_CAPTURE_KIND } from "./capture/capture-note.ts";
import { BRAIN_SOURCE_KIND } from "./ingest/ingest.ts";
import { BRAIN_ENTITY_KIND, BRAIN_ENTITY_STATUS } from "./entities/types.ts";
import {
  MARKDOWN_STRUCTURE_KIND,
  detectMarkdownStructure,
  type MarkdownStructureKind,
} from "./text/neutralize-markdown.ts";
import type { FrontmatterMap, VaultPage } from "../types.ts";

/** Where the review queue holds staged copies, `/`-separated and vault-relative. */
const PENDING_DIR = `${BRAIN_PENDING_REL}/`;

/** One page whose body carries live structure rows. */
export interface PlantedRowsPage {
  /** Vault-relative path with `/` separators. */
  readonly path: string;
  /** The structure families planted in the body, sorted, unique. */
  readonly kinds: ReadonlyArray<MarkdownStructureKind>;
  /** How many live rows the fence-masked scan found. */
  readonly count: number;
  /**
   * True when the page sits in a third-party provenance lane (a capture,
   * a source summary, an untrusted-stamped page, a quarantined entity) -
   * the lanes the enforce-mode seams neutralize. Context for the finding,
   * not the population filter: every Brain page is scanned.
   */
  readonly thirdParty: boolean;
}

export interface PlantedRowsPlan {
  /** Pages the population selector admitted. */
  readonly scanned: number;
  /** Pages whose body carries live structure, sorted by path. */
  readonly planted: ReadonlyArray<PlantedRowsPage>;
}

/** A tolerant status read: the scalar as written, trimmed and lowered. */
function entityStatus(meta: FrontmatterMap): string {
  const raw = meta["status"];
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Does this page belong to a lane that receives third-party text? */
function inThirdPartyLane(meta: FrontmatterMap): boolean {
  const kind = typeof meta["kind"] === "string" ? meta["kind"] : "";
  if (kind === BRAIN_CAPTURE_KIND) return true;
  if (kind === BRAIN_SOURCE_KIND) return true;
  if (hasUntrustedSourceMarker(meta)) return true;
  return kind === BRAIN_ENTITY_KIND && entityStatus(meta) === BRAIN_ENTITY_STATUS.quarantine;
}

/**
 * The families no Brain writer ever authors - a live row is planted
 * wherever it sits, so these scan every readable Brain page. The
 * wikilink and heading families are excluded because the Brain's own
 * writers render them by design outside the third-party lanes (see the
 * module docblock); there the lane key IS the authorship signal.
 */
const ALWAYS_PLANTED_KINDS: ReadonlySet<MarkdownStructureKind> = new Set([
  MARKDOWN_STRUCTURE_KIND.osbInline,
  MARKDOWN_STRUCTURE_KIND.osbFence,
]);

/**
 * Scan every readable Brain page for live structure rows. Pure over the
 * vault's bytes: nothing is written, nothing is mutated, and the result
 * is deterministic for a given vault state (paths sorted, kinds sorted).
 */
export function planPlantedRows(vault: string): PlantedRowsPlan {
  const selected = listVaultPages(vault, { reach: MAINTENANCE_LANE_REACH }).filter((page) =>
    isUnderBrainRoot(vaultRelative(page.path, vault)),
  );

  // Staged-vs-published dedupe: a Brain/pending copy is the publish
  // target's bytes verbatim, so when a staged page's content equals a
  // published page's content the publish target is the report and the
  // staged copy is dropped. Published hashes are computed ONCE, not once
  // per staged page, and an UNDEFINED hash - a page that could not be
  // read between the walk and the hash - never enters the set and never
  // matches: two unreadable pages are not the same page, and a staged
  // copy the audit cannot hash is reported, never silently dropped.
  const isStaged = (page: VaultPage): boolean =>
    vaultRelative(page.path, vault).startsWith(PENDING_DIR);
  const staged = selected.filter(isStaged);
  let deduped = selected;
  if (staged.length > 0) {
    const publishedHashes = new Set<string>();
    for (const page of selected) {
      if (isStaged(page)) continue;
      const hash = contentHash(page.path);
      if (hash !== undefined) publishedHashes.add(hash);
    }
    deduped = selected.filter((page) => {
      if (!isStaged(page)) return true;
      const stagedHash = contentHash(page.path);
      return stagedHash === undefined || !publishedHashes.has(stagedHash);
    });
  }

  const planted: PlantedRowsPage[] = [];
  for (const page of deduped) {
    let body: string;
    try {
      [, body] = parseFrontmatter(page.path);
    } catch {
      // Vanished or unreadable between the walk and the read: a page the
      // audit cannot scan is a page it does not name, never a throw.
      continue;
    }
    const matches = detectMarkdownStructure(body);
    const lane = inThirdPartyLane(page.metadata);
    const live = lane ? matches : matches.filter((m) => ALWAYS_PLANTED_KINDS.has(m.kind));
    if (live.length === 0) continue;
    planted.push({
      path: vaultRelative(page.path, vault),
      kinds: [...new Set(live.map((m) => m.kind))].toSorted(),
      count: live.length,
      thirdParty: lane,
    });
  }
  planted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { scanned: selected.length, planted };
}

function contentHash(absPath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return undefined;
  }
}

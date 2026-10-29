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
 * The population is the third-party lanes, keyed off PROVENANCE and never
 * vocabulary - exactly the lanes the enforce-mode seam neutralizes, so a
 * page the gate already cleaned yields no rows here:
 *
 *   - capture pages (`kind: brain-capture`), the Telegram/CLI capture
 *     staging area,
 *   - untrusted-stamped pages (the `untrusted_source` marker), whatever
 *     their kind,
 *   - quarantined entity pages (`kind: brain-entity` with `status:
 *     quarantine`), the records untrusted ingest held back,
 *   - source summaries (`kind: brain-source`), the per-source pages the
 *     ingest pipeline writes.
 *
 * The scan over each selected page's body is the neutralizer's own
 * fence-masked detection, so an inert excerpt inside a fenced code block
 * counts nothing while a planted ```osb fence line does. Staged copies
 * under `Brain/pending/` are deduplicated against their publish targets
 * by content: the pending directory holds a byte-verbatim copy of the
 * page under review, so the same rows would otherwise be reported twice.
 *
 * Read-only by contract: nothing here writes, and a page that cannot be
 * read between the walk and the body scan is skipped rather than thrown
 * - the doctor never throws.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listVaultPages, parseFrontmatter } from "../vault.ts";
import { vaultRelative } from "../path-safety.ts";
import { MAINTENANCE_LANE_REACH } from "../graph/transport-reach.ts";
import { hasUntrustedSourceMarker } from "./trust/untrusted-provenance.ts";
import { BRAIN_CAPTURE_KIND } from "./capture/capture-note.ts";
import { BRAIN_SOURCE_KIND } from "./ingest/ingest.ts";
import { BRAIN_ENTITY_KIND, BRAIN_ENTITY_STATUS } from "./entities/types.ts";
import { detectMarkdownStructure, type MarkdownStructureKind } from "./text/neutralize-markdown.ts";
import type { FrontmatterMap } from "../types.ts";

/** Where the review queue holds staged copies, `/`-separated and vault-relative. */
const PENDING_DIR = "Brain/pending/";

/** One page whose body carries live structure rows. */
export interface PlantedRowsPage {
  /** Vault-relative path with `/` separators. */
  readonly path: string;
  /** The structure families planted in the body, sorted, unique. */
  readonly kinds: ReadonlyArray<MarkdownStructureKind>;
  /** How many live rows the fence-masked scan found. */
  readonly count: number;
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
function inPopulation(meta: FrontmatterMap): boolean {
  const kind = typeof meta["kind"] === "string" ? meta["kind"] : "";
  if (kind === BRAIN_CAPTURE_KIND) return true;
  if (kind === BRAIN_SOURCE_KIND) return true;
  if (hasUntrustedSourceMarker(meta)) return true;
  return kind === BRAIN_ENTITY_KIND && entityStatus(meta) === BRAIN_ENTITY_STATUS.quarantine;
}

/**
 * Scan the third-party lanes for live structure rows. Pure over the
 * vault's bytes: nothing is written, nothing is mutated, and the result
 * is deterministic for a given vault state (paths sorted, kinds sorted).
 */
export function planPlantedRows(vault: string): PlantedRowsPlan {
  const selected = listVaultPages(vault, { reach: MAINTENANCE_LANE_REACH }).filter((page) =>
    inPopulation(page.metadata),
  );

  // Staged-vs-published dedupe: a Brain/pending copy is the publish
  // target's bytes verbatim, so when a staged page's content equals a
  // published page's content the publish target is the report and the
  // staged copy is dropped. Hashes are computed only when a staged page
  // was selected at all, so the common vault pays nothing.
  const staged = selected.filter((page) => vaultRelative(page.path, vault).startsWith(PENDING_DIR));
  const deduped =
    staged.length === 0
      ? selected
      : selected.filter((page) => {
          if (!vaultRelative(page.path, vault).startsWith(PENDING_DIR)) return true;
          const stagedHash = contentHash(page.path);
          return !selected.some(
            (other) =>
              !vaultRelative(other.path, vault).startsWith(PENDING_DIR) &&
              contentHash(other.path) === stagedHash,
          );
        });

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
    if (matches.length === 0) continue;
    planted.push({
      path: vaultRelative(page.path, vault),
      kinds: [...new Set(matches.map((m) => m.kind))].toSorted(),
      count: matches.length,
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

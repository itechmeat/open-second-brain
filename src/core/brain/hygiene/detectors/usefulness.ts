/**
 * Usefulness detector (continuity-hygiene-freshness suite; kanban
 * t_698db8f7).
 *
 * Low-usefulness candidates: preferences that have been around longer
 * than the evidence window yet never appear in any recall-telemetry
 * `top_artifacts` and carry zero applied evidence. The detector only
 * nominates for review - forgetting is an operator decision executed
 * through the apply plan.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "../../paths.ts";
import { memoryFromStore, storePagesIn } from "../../memory-pages.ts";
import { parsePreference, parsePreferenceMeta } from "../../preference.ts";
import type { BrainPreference } from "../../types.ts";
import { listRecallTelemetry } from "../../recall-telemetry.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneDetectorContext, HygieneFinding } from "../types.ts";

/** A preference younger than this many days is not judged. */
export const USEFULNESS_MIN_AGE_DAYS = 45;

const DAY_MS = 24 * 60 * 60 * 1000;

function recalledArtifactIds(vault: string): Set<string> {
  const ids = new Set<string>();
  for (const record of listRecallTelemetry(vault)) {
    const top = record.payload["top_artifacts"];
    if (!Array.isArray(top)) continue;
    for (const artifact of top) {
      if (artifact !== null && typeof artifact === "object") {
        const id = (artifact as { id?: unknown }).id;
        if (typeof id === "string" && id.length > 0) ids.add(id);
      }
    }
  }
  return ids;
}

export function detectUsefulness(
  vault: string,
  ctx: HygieneDetectorContext,
): ReadonlyArray<HygieneFinding> {
  const dir = brainDirs(vault).preferences;
  // Store-only (task 2.10): the fold's records by their page, in name order.
  const fromStore = memoryFromStore(vault);
  if (!fromStore && !existsSync(dir)) return Object.freeze([]);
  const reads: ReadonlyArray<() => BrainPreference> = fromStore
    ? storePagesIn(vault, dir).map((page) => () => parsePreferenceMeta(page.meta, page.path))
    : readdirSync(dir)
        .toSorted()
        .filter((name) => name.endsWith(".md"))
        .map((name) => () => parsePreference(join(dir, name)));
  const recalled = recalledArtifactIds(vault);
  const cutoffMs = ctx.now.getTime() - USEFULNESS_MIN_AGE_DAYS * DAY_MS;
  const findings: HygieneFinding[] = [];
  for (const read of reads) {
    let pref;
    try {
      pref = read();
    } catch {
      continue; // malformed preferences belong to doctor, not hygiene
    }
    if (recalled.has(pref.id)) continue;
    if (pref.applied_count > 0) continue;
    const createdMs = Date.parse(pref.created_at);
    if (!Number.isFinite(createdMs) || createdMs > cutoffMs) continue;
    findings.push(
      Object.freeze({
        id: hygieneFindingId("usefulness", [pref.id]),
        detector: "usefulness" as const,
        severity: "info" as const,
        title: `Preference ${pref.id} has no recall or applied evidence since creation`,
        targets: Object.freeze([pref.id]),
        proposed_action: "review" as const,
        evidence: Object.freeze({
          created_at: pref.created_at,
          status: pref.status,
          applied_count: pref.applied_count,
          min_age_days: USEFULNESS_MIN_AGE_DAYS,
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

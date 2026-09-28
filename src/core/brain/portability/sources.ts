/**
 * Sources dashboard projection (Vault portability suite, Feature 2).
 *
 * A pure, read-only aggregation over the brain's signals (inbox,
 * processed and archived), grouped by (agent, source_type) with
 * active/processed/archived and distinct-topic counts. No new store, no writes; deterministic ordering.
 *
 * (The parallel multi-source sync worker pool + connection-budget warning
 * from the upstream inspiration are intentionally out of scope - only this
 * read-only dashboard ships.)
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "../paths.ts";
import { parseSignal } from "../signal.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "../types.ts";

export interface SourceRow {
  readonly agent: string;
  readonly source_type: string;
  readonly active: number;
  readonly processed: number;
  /** Signals in `inbox/archived/`: left the contradiction window unconsumed. */
  readonly archived: number;
  readonly distinct_topics: number;
}

export interface SourcesReport {
  readonly sources: ReadonlyArray<SourceRow>;
  readonly total_active: number;
  readonly total_processed: number;
  readonly total_archived: number;
}

interface Bucket {
  agent: string;
  source_type: string;
  active: number;
  processed: number;
  archived: number;
  topics: Set<string>;
}

type SignalDirKind = "active" | "processed" | "archived";

function scanDir(dir: string, kind: SignalDirKind, buckets: Map<string, Bucket>): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    let sig;
    try {
      sig = parseSignal(join(dir, name));
    } catch {
      continue;
    }
    const agent = sig.agent || "unknown";
    // Absent source_type is semantically `live` (never inject a default
    // into the signal itself; only bucket it here).
    const sourceType = sig.source_type ?? BRAIN_SIGNAL_SOURCE_TYPE.live;
    const key = JSON.stringify([agent, sourceType]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        agent,
        source_type: sourceType,
        active: 0,
        processed: 0,
        archived: 0,
        topics: new Set(),
      };
      buckets.set(key, bucket);
    }
    bucket[kind] += 1;
    bucket.topics.add(sig.topic);
  }
}

/**
 * Aggregate the brain's signals into a per-source dashboard. Read-only.
 */
export function aggregateSources(vault: string): SourcesReport {
  const dirs = brainDirs(vault);
  const buckets = new Map<string, Bucket>();
  scanDir(dirs.inbox, "active", buckets);
  scanDir(dirs.processed, "processed", buckets);
  scanDir(dirs.archived, "archived", buckets);

  const sources = [...buckets.values()]
    .map((b) => ({
      agent: b.agent,
      source_type: b.source_type,
      active: b.active,
      processed: b.processed,
      archived: b.archived,
      distinct_topics: b.topics.size,
    }))
    .toSorted((a, b) =>
      a.agent !== b.agent
        ? a.agent < b.agent
          ? -1
          : 1
        : a.source_type < b.source_type
          ? -1
          : a.source_type > b.source_type
            ? 1
            : 0,
    );

  return {
    sources,
    total_active: sources.reduce((n, s) => n + s.active, 0),
    total_processed: sources.reduce((n, s) => n + s.processed, 0),
    total_archived: sources.reduce((n, s) => n + s.archived, 0),
  };
}

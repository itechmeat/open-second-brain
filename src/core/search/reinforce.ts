/**
 * Self-tuning reinforce ledger (Search & Recall Quality Suite).
 *
 * Reinforcement is an EXPLICIT signal: a caller (operator or downstream
 * agent) naming a memory that proved useful. It is never inferred from a
 * memory merely being surfaced - surfaced-only frequency carries no
 * positive signal, by design, so popularity can never snowball.
 *
 * Each reinforce event is one small JSON file under
 * `Brain/search/reinforce/` - the same conflict-free one-file-per-signal
 * pattern `Brain/inbox/` and the feedback ledger use, so multi-device
 * vaults never produce sync conflicts on a shared append-only file. The
 * per-path strength is a PURE FOLD over the event set (count of distinct
 * events naming the path, normalized and bounded), so it is replayable
 * and resettable: deleting the derived view loses nothing.
 *
 * The boost is bounded ({@link REINFORCE_BOOST_CAP}) and applied before
 * the top_k cut, so a reinforced memory is lifted into the window without
 * ever floating an irrelevant chunk.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { fnv1aHex } from "./feedback.ts";
import type { BrainSearchResult } from "./types.ts";

/** Maximum additive boost a fully-reinforced path receives. */
export const REINFORCE_BOOST_CAP = 0.05;
/** Event count at which a path reaches full reinforcement strength. */
export const REINFORCE_SATURATION = 5;

export interface ReinforceEvent {
  /** Unix-ms timestamp the reinforcement was recorded. */
  readonly ts: number;
  /** Vault-relative paths reinforced in this event. */
  readonly paths: ReadonlyArray<string>;
}

export interface RecordReinforceOptions {
  /** Injected clock for deterministic tests. Defaults to Date.now(). */
  readonly nowMs?: number;
}

export function reinforceDir(vault: string): string {
  return join(vault, "Brain", "search", "reinforce");
}

/**
 * Record one reinforce event as its own file. The filename derives from
 * the timestamp plus a content hash, so recording the identical event
 * (same timestamp and paths) twice is idempotent. Empty path lists are a
 * no-op.
 */
export function recordReinforce(
  vault: string,
  paths: ReadonlyArray<string>,
  opts: RecordReinforceOptions = {},
): string | null {
  const cleaned = [...new Set(paths.filter((p) => p.length > 0))].toSorted();
  if (cleaned.length === 0) return null;
  const dir = reinforceDir(vault);
  mkdirSync(dir, { recursive: true });
  const event: ReinforceEvent = Object.freeze({ ts: opts.nowMs ?? Date.now(), paths: cleaned });
  const body = JSON.stringify(event, null, 2) + "\n";
  const file = join(dir, `${event.ts}-${fnv1aHex(body)}.json`);
  writeFileSync(file, body);
  return file;
}

/** Load all reinforce events, sorted by timestamp (stable). */
export function loadReinforceEvents(vault: string): ReinforceEvent[] {
  let files: string[];
  try {
    files = readdirSync(reinforceDir(vault)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ReinforceEvent[] = [];
  for (const f of files.toSorted()) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(reinforceDir(vault), f), "utf8"),
      ) as ReinforceEvent;
      if (
        typeof parsed.ts === "number" &&
        Array.isArray(parsed.paths) &&
        parsed.paths.every((p) => typeof p === "string")
      ) {
        out.push(parsed);
      }
    } catch {
      // One malformed file never breaks the fold.
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Pure fold: per-path strength in [0, 1], the count of distinct events
 * naming the path normalized by {@link REINFORCE_SATURATION} and capped
 * at 1. Order-insensitive by construction.
 */
export function loadReinforceStrengths(vault: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of loadReinforceEvents(vault)) {
    for (const path of new Set(event.paths)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const strengths = new Map<string, number>();
  for (const [path, count] of counts) {
    strengths.set(path, Math.min(1, count / REINFORCE_SATURATION));
  }
  return strengths;
}

/** Delete the reinforce ledger. The fold replays as empty afterwards. */
export function resetReinforce(vault: string): void {
  rmSync(reinforceDir(vault), { recursive: true, force: true });
}

/**
 * Stable fingerprint of the ledger state for the query-cache key: "off"
 * when no ledger exists, else a hash of the sorted event filenames (the
 * filenames already encode ts + content hash, so they change iff the
 * ledger does).
 */
export function reinforceFingerprint(vault: string): string {
  const dir = reinforceDir(vault);
  if (!existsSync(dir)) return "off";
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .toSorted();
    if (files.length === 0) return "off";
    return fnv1aHex(files.join("|"));
  } catch {
    return "off";
  }
}

function fmt(x: number): string {
  return x.toFixed(3);
}

/**
 * Apply the bounded reinforcement boost to a ranked pool and re-sort.
 * A result whose path carries ledger strength gets `CAP * strength` added
 * to its score (clamped to 1) and a `reinforce:` reason; everything else
 * is untouched. Pure: returns a new array, never mutates the input. The
 * tie-break matches the ranker family (score desc, keywordScore desc,
 * chunkId asc) so the ordering stays deterministic.
 */
export function applyReinforceBoost(
  results: ReadonlyArray<BrainSearchResult>,
  strengthByPath: ReadonlyMap<string, number>,
): BrainSearchResult[] {
  if (strengthByPath.size === 0) return results.slice();
  const boosted = results.map((r) => {
    const strength = strengthByPath.get(r.path);
    if (strength === undefined || strength <= 0) return r;
    const boost = REINFORCE_BOOST_CAP * Math.min(1, strength);
    return Object.freeze({
      ...r,
      score: Math.min(1, r.score + boost),
      reasons: Object.freeze([...r.reasons, `reinforce: +${fmt(boost)}`]),
    });
  });
  return boosted.toSorted((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return a.chunkId - b.chunkId;
  });
}

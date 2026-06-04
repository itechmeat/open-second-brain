/**
 * Activation event store (Time-Aware Recall & Activation Suite,
 * t_2bc79017 + t_c5ef25a3).
 *
 * Storage follows the `feedback.ts` convention exactly: one small JSON
 * file per recorded access under `Brain/search/activation/` (the
 * conflict-free one-file-per-signal pattern), and a derived
 * `Brain/search/activation-state.json` that is a PURE FOLD over the
 * retained events - deterministic, order-insensitive, replayable, and
 * safe to delete.
 *
 * Sweep semantics are part of the activation model, not an
 * afterthought: activation decays toward the type floor anyway, so
 * dropping events older than the retention window (or beyond the
 * newest-N cap) approximates the limit instead of corrupting it.
 *
 * Privacy: events carry an FNV-1a hash of the query, never raw text.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { fnv1aHex } from "../feedback.ts";
import { bumpStrength } from "./decay.ts";
import type {
  ActivationAccessEvent,
  ActivationPathState,
  ActivationState,
  ActivationSweepOutcome,
  CoAccessPair,
} from "./types.ts";

/** Cap on surfaced paths stored per access event. */
export const ACCESS_EVENT_PATHS_CAP = 10;
/** Default retention window for access events, in days. */
export const ACCESS_EVENT_RETENTION_DAYS = 90;
/** Default cap on retained access events. */
export const ACCESS_EVENT_MAX_COUNT = 5000;
/** Cap on co-access pairs kept in the derived state. */
export const CO_ACCESS_MAX_PAIRS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export function activationDir(vault: string): string {
  return join(vault, "Brain", "search", "activation");
}

export function activationStatePath(vault: string): string {
  return join(vault, "Brain", "search", "activation-state.json");
}

/**
 * Record one access event as its own file and refresh the derived
 * state. The filename derives from the timestamp plus a content hash,
 * so recording the identical event twice is idempotent.
 */
export function recordAccessEvent(vault: string, event: ActivationAccessEvent): string {
  const dir = activationDir(vault);
  mkdirSync(dir, { recursive: true });
  const bounded: ActivationAccessEvent = {
    ts: event.ts,
    queryHash: event.queryHash,
    paths: event.paths.slice(0, ACCESS_EVENT_PATHS_CAP),
  };
  const body = JSON.stringify(bounded, null, 2) + "\n";
  const file = join(dir, `${bounded.ts}-${fnv1aHex(body)}.json`);
  writeFileSync(file, body);
  writeActivationState(vault, computeActivationState(loadAccessEvents(vault)));
  return file;
}

/** Load all retained access events, sorted by ts then filename. */
export function loadAccessEvents(vault: string): ActivationAccessEvent[] {
  const dir = activationDir(vault);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ActivationAccessEvent[] = [];
  for (const f of files.toSorted()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as ActivationAccessEvent;
      const pathsValid =
        Array.isArray(parsed.paths) && parsed.paths.every((p) => typeof p === "string");
      if (
        typeof parsed.ts === "number" &&
        Number.isFinite(parsed.ts) &&
        typeof parsed.queryHash === "string" &&
        pathsValid
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
 * The deterministic fold. Per path: strength is `bumpStrength` applied
 * once per access (a pure function of the access COUNT, so the fold is
 * order-insensitive by construction), `lastAccessAt` is the max ts.
 * Co-access pairs count events that surfaced both paths together,
 * bounded to the top {@link CO_ACCESS_MAX_PAIRS} by count then key.
 */
export function computeActivationState(
  events: ReadonlyArray<ActivationAccessEvent>,
): ActivationState {
  const counts = new Map<string, { count: number; lastAccessAt: number }>();
  const pairCounts = new Map<string, number>();
  let latestTs = 0;

  for (const e of events) {
    if (e.ts > latestTs) latestTs = e.ts;
    const unique = Array.from(new Set(e.paths)).toSorted();
    for (const p of unique) {
      const row = counts.get(p) ?? { count: 0, lastAccessAt: 0 };
      row.count++;
      if (e.ts > row.lastAccessAt) row.lastAccessAt = e.ts;
      counts.set(p, row);
    }
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]}\n${unique[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const paths: Record<string, ActivationPathState> = {};
  for (const p of Array.from(counts.keys()).toSorted()) {
    const row = counts.get(p)!;
    let strength = 0;
    for (let i = 0; i < row.count; i++) strength = bumpStrength(strength);
    paths[p] = Object.freeze({
      strength: Math.round(strength * 1e6) / 1e6,
      lastAccessAt: row.lastAccessAt,
      accessCount: row.count,
    });
  }

  const coAccess: CoAccessPair[] = Array.from(pairCounts.entries())
    .map(([key, count]) => {
      const [a, b] = key.split("\n") as [string, string];
      return Object.freeze({ a, b, count });
    })
    .toSorted((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .slice(0, CO_ACCESS_MAX_PAIRS);

  return Object.freeze({
    version: 1,
    events: events.length,
    updatedAt: latestTs > 0 ? new Date(latestTs).toISOString() : null,
    paths: Object.freeze(paths),
    coAccess: Object.freeze(coAccess),
  });
}

export function writeActivationState(vault: string, state: ActivationState): void {
  mkdirSync(join(vault, "Brain", "search"), { recursive: true });
  writeFileSync(activationStatePath(vault), JSON.stringify(state, null, 2) + "\n");
}

/** Read the derived state; structurally invalid content reads as null. */
export function readActivationState(vault: string): ActivationState | null {
  try {
    const parsed = JSON.parse(readFileSync(activationStatePath(vault), "utf8")) as ActivationState;
    if (parsed.version !== 1) return null;
    if (typeof parsed.events !== "number") return null;
    if (parsed.paths === null || typeof parsed.paths !== "object") return null;
    if (!Array.isArray(parsed.coAccess)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Stable fingerprint of the activation state for the query-cache key:
 * "off" when no derived file exists, else a hash of its content.
 */
export function activationStateFingerprint(vault: string): string {
  const path = activationStatePath(vault);
  if (!existsSync(path)) return "off";
  try {
    return fnv1aHex(readFileSync(path, "utf8"));
  } catch {
    return "off";
  }
}

export interface ActivationSweepOptions {
  /** Injected clock (unix ms). */
  readonly nowMs: number;
  /** Events older than this many days are dropped. */
  readonly retentionDays?: number;
  /** At most this many newest events are kept. */
  readonly maxEvents?: number;
}

/**
 * Drop events outside the retention window or beyond the newest-N cap,
 * then refold the derived state from what remains.
 */
export function sweepActivationEvents(
  vault: string,
  opts: ActivationSweepOptions,
): ActivationSweepOutcome {
  const retentionDays = opts.retentionDays ?? ACCESS_EVENT_RETENTION_DAYS;
  const maxEvents = opts.maxEvents ?? ACCESS_EVENT_MAX_COUNT;
  const cutoff = opts.nowMs - retentionDays * DAY_MS;

  const dir = activationDir(vault);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .toSorted();
  } catch {
    return Object.freeze({ removed: 0, kept: 0 });
  }

  // Filename prefix is the event ts; malformed names parse as NaN and
  // are treated as expired so junk never survives a sweep.
  const withTs = files.map((f) => ({ f, ts: Number(f.split("-")[0]) }));
  const fresh = withTs.filter((x) => Number.isFinite(x.ts) && x.ts >= cutoff);
  const expired = withTs.filter((x) => !Number.isFinite(x.ts) || x.ts < cutoff);

  fresh.sort((a, b) => a.ts - b.ts || a.f.localeCompare(b.f));
  const overflow = fresh.length > maxEvents ? fresh.slice(0, fresh.length - maxEvents) : [];
  const keep = fresh.slice(Math.max(0, fresh.length - maxEvents));

  for (const x of [...expired, ...overflow]) {
    rmSync(join(dir, x.f), { force: true });
  }
  writeActivationState(vault, computeActivationState(loadAccessEvents(vault)));
  return Object.freeze({ removed: expired.length + overflow.length, kept: keep.length });
}

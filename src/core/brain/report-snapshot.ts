/**
 * Dual-output reports (t_00eece5d, article: Hermes as an Onchain
 * Analyst): digest/brief surfaces persist a machine-diffable JSON
 * snapshot per run so the NEXT run can report "what changed since
 * last time" deterministically - the run-over-run continuation of the
 * dashboard-ready `Brain/metrics/` contract from v0.45.0.
 *
 * Layout: `Brain/reports/<surface>/<ISO-date>.json`, schema
 * `o2b.report-snapshot.v1`, atomic single-file writes, fail-soft
 * reader (a torn prior snapshot reads as none - the delta degrades to
 * "no prior", never to a crash).
 *
 * The diff keys on STABLE identities, not array order:
 *
 *   - objects flatten by key path (`counts/events`);
 *   - arrays of objects key each element by its `id` / `topic` /
 *     `path` / `slug` field when one exists (index as last resort);
 *   - arrays of primitives compare as sets (`topics[gamma]` added).
 *
 * Opt-in: `report_snapshots_enabled` config key, env mirror
 * `OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS`. A vault that enables nothing
 * writes nothing and renders byte-identically.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { discoverConfig } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";

export const REPORT_SNAPSHOT_SCHEMA_VERSION = "o2b.report-snapshot.v1";

/** Fields stripped before snapshotting: volatile per-render decoration. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "generated_at",
  // CLI surfaces snapshot raw core envelopes whose render stamp is
  // camelCase - both spellings are per-render decoration.
  "generatedAt",
  "run_id",
  "local_time",
  "timezone",
  "delta",
]);

/** Identity fields tried (in order) to key array-of-object elements. */
const IDENTITY_KEYS = ["id", "pref_id", "topic", "path", "slug", "date"] as const;

export interface ReportChange {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface ReportDelta {
  /** Date of the prior snapshot the delta is computed against. */
  readonly prior_date: string | null;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<ReportChange>;
}

export interface LoadedReportSnapshot {
  readonly date: string;
  readonly payload: unknown;
}

export function reportSnapshotsEnabled(configPath?: string): boolean {
  const env = process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"];
  if (env === "true" || env === "1") return true;
  if (env === "false" || env === "0") return false;
  try {
    const value = discoverConfig(configPath).data["report_snapshots_enabled"];
    return value === "true" || value === "1";
  } catch {
    return false;
  }
}

function reportsDir(vault: string, surface: string): string {
  return join(vault, "Brain", "reports", surface);
}

/** Strip volatile decoration recursively before persisting/diffing. */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

/** Flatten one payload into stable-identity leaf paths. */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    const allPrimitive = value.every((v) => v === null || typeof v !== "object");
    if (allPrimitive) {
      // Set semantics: membership is the identity.
      for (const item of value) out.set(`${prefix}[${String(item)}]`, "present");
      return;
    }
    value.forEach((item, index) => {
      let key = String(index);
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        for (const idKey of IDENTITY_KEYS) {
          const candidate = (item as Record<string, unknown>)[idKey];
          if (typeof candidate === "string" && candidate !== "") {
            key = candidate;
            break;
          }
        }
      }
      flatten(item, prefix === "" ? key : `${prefix}/${key}`, out);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix === "" ? k : `${prefix}/${k}`, out);
    }
    return;
  }
  out.set(prefix, JSON.stringify(value) ?? "undefined");
}

/** Deterministic keyed diff between two report payloads. */
export function diffReportPayloads(
  before: unknown,
  after: unknown,
): Pick<ReportDelta, "added" | "removed" | "changed"> {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(stripVolatile(before), "", a);
  flatten(stripVolatile(after), "", b);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ReportChange[] = [];
  for (const [path, value] of b) {
    if (!a.has(path)) added.push(path);
    else if (a.get(path) !== value) changed.push({ path, before: a.get(path)!, after: value });
  }
  for (const path of a.keys()) {
    if (!b.has(path)) removed.push(path);
  }
  return {
    added: Object.freeze(added.toSorted()),
    removed: Object.freeze(removed.toSorted()),
    changed: Object.freeze(changed.toSorted((x, y) => (x.path < y.path ? -1 : 1))),
  };
}

/** Persist one surface snapshot (atomic; same-date overwrite is fine). */
export function writeReportSnapshot(
  vault: string,
  surface: string,
  date: string,
  payload: unknown,
): string {
  const dir = reportsDir(vault, surface);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.json`);
  atomicWriteFileSync(
    path,
    JSON.stringify(
      { schema: REPORT_SNAPSHOT_SCHEMA_VERSION, surface, date, payload: stripVolatile(payload) },
      null,
      2,
    ) + "\n",
  );
  return path;
}

/** Newest snapshot strictly before `beforeDate`. Fail-soft null. */
export function loadLatestReportSnapshot(
  vault: string,
  surface: string,
  beforeDate: string,
): LoadedReportSnapshot | null {
  const dir = reportsDir(vault, surface);
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const dates = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .filter((d) => d < beforeDate)
    .toSorted();
  for (let i = dates.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, `${dates[i]}.json`), "utf8"));
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (record["schema"] !== REPORT_SNAPSHOT_SCHEMA_VERSION) continue;
      return { date: dates[i]!, payload: record["payload"] };
    } catch {
      // Torn snapshot: skip to the next-older one.
    }
  }
  return null;
}

/**
 * The one call surfaces make: when snapshots are enabled, persist the
 * current payload and return the delta against the latest prior
 * snapshot (no prior -> empty delta with `prior_date: null`). When
 * disabled, returns null and touches nothing.
 */
export function captureReportDelta(
  vault: string,
  surface: string,
  date: string,
  payload: unknown,
  opts: { configPath?: string } = {},
): ReportDelta | null {
  if (!reportSnapshotsEnabled(opts.configPath)) return null;
  const prior = loadLatestReportSnapshot(vault, surface, date);
  writeReportSnapshot(vault, surface, date, payload);
  if (prior === null) {
    return Object.freeze({
      prior_date: null,
      added: Object.freeze([]),
      removed: Object.freeze([]),
      changed: Object.freeze([]),
    });
  }
  return Object.freeze({ prior_date: prior.date, ...diffReportPayloads(prior.payload, payload) });
}

/** Human-readable "Since last run" block for markdown/text output. */
export function renderReportDelta(delta: ReportDelta): string {
  if (delta.prior_date === null) {
    return "Since last run: first snapshot - nothing to compare yet.";
  }
  if (delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0) {
    return `Since last run (${delta.prior_date}): no changes.`;
  }
  const lines = [`Since last run (${delta.prior_date}):`];
  for (const path of delta.added) lines.push(`  + ${path}`);
  for (const path of delta.removed) lines.push(`  - ${path}`);
  for (const change of delta.changed) {
    lines.push(`  ~ ${change.path}: ${change.before} -> ${change.after}`);
  }
  return lines.join("\n");
}

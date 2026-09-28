/**
 * `o2b decision-model report --use dedup|tension` metrics (issue #213,
 * Part 5).
 *
 * Joins each recorded pair verdict to what the operator did with the
 * proposal afterwards, read from the vault as it is now:
 *
 *   - preference pairs (`dedup`): `merged` once either preference was
 *     retired (a hygiene `apply` merge retires the dropped one), `open`
 *     while both are active, `missing` otherwise;
 *   - entity pairs (`dedup`): `merged` once either entity left the
 *     canonical read scope (archived) or is gone, or one lists the other's name as an alias; else `open`;
 *   - tensions (`tension`): the tension's current status (`resolved`,
 *     `dismissed`, `confirmed`, `open`), or `missing`.
 *
 * Verdicts are grouped into bands by verdict and probability (`high` at
 * or above 0.9, `mid` at or above 0.6, else `low`), so the precision of
 * each band against the operator's own decisions can be read off
 * directly. Only ordinary calls count: eval and ping records, degraded
 * calls and pairs without a verdict are left out, and when a pair was
 * verdicted more than once the latest verdict is used.
 *
 * Read-only.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { normalizeEntityName } from "../../brain/entities/canonical.ts";
import { buildEntityIndex } from "../../brain/entities/index-builder.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../../brain/entities/status-scope.ts";
import type { BrainEntity } from "../../brain/entities/types.ts";
import { brainDirs } from "../../brain/paths.ts";
import { showTension } from "../../brain/tensions.ts";
import type { ContinuityRecord } from "../../brain/continuity/types.ts";
import { listDecisionModelCalls } from "../record.ts";

export type PairOutcome = "merged" | "resolved" | "dismissed" | "confirmed" | "open" | "missing";

export interface PairVerdictBand {
  readonly band: string;
  readonly pairs: number;
  readonly outcomes: Readonly<Record<PairOutcome, number>>;
}

export interface PairVerdictUseReport {
  readonly use: "dedup" | "tension";
  readonly pairs: number;
  readonly bands: ReadonlyArray<PairVerdictBand>;
}

interface RecordedPair {
  readonly createdAt: string;
  readonly id: string;
  readonly kind: string;
  readonly a: string;
  readonly b: string;
  readonly verdict: string;
  readonly probability: number;
}

function band(verdict: string, p: number): string {
  const level = p >= 0.9 ? "high" : p >= 0.6 ? "mid" : "low";
  return `${verdict}:${level}`;
}

function recordedPairs(record: ContinuityRecord): RecordedPair[] {
  const p = record.payload;
  if (p["outcome"] !== "ok" || p["origin"] !== undefined) return [];
  const kind = typeof p["pair_kind"] === "string" ? p["pair_kind"] : "";
  const list = Array.isArray(p["pairs"]) ? p["pairs"] : [];
  const out: RecordedPair[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r["id"] !== "string" ||
      typeof r["a"] !== "string" ||
      typeof r["b"] !== "string" ||
      typeof r["verdict"] !== "string" ||
      typeof r["probability"] !== "number"
    ) {
      continue;
    }
    out.push({
      createdAt: record.createdAt,
      id: r["id"],
      kind,
      a: r["a"],
      b: r["b"],
      verdict: r["verdict"],
      probability: r["probability"],
    });
  }
  return out;
}

function preferenceState(vault: string, id: string): "active" | "retired" | "missing" {
  if (!/^pref-[A-Za-z0-9._-]+$/u.test(id) || id.includes("..")) return "missing";
  const dirs = brainDirs(vault);
  if (existsSync(join(dirs.preferences, `${id}.md`))) return "active";
  if (existsSync(join(dirs.retired, `ret-${id.slice("pref-".length)}.md`))) return "retired";
  return "missing";
}

function preferenceOutcome(vault: string, pair: RecordedPair): PairOutcome {
  const a = preferenceState(vault, pair.a);
  const b = preferenceState(vault, pair.b);
  if (a === "retired" || b === "retired") return "merged";
  if (a === "active" && b === "active") return "open";
  return "missing";
}

function canonical(e: BrainEntity): boolean {
  return entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical);
}

function aliasOf(e: BrainEntity, other: BrainEntity): boolean {
  return e.aliases.some((alias) => normalizeEntityName(alias) === normalizeEntityName(other.name));
}

function entityOutcome(entities: Map<string, BrainEntity>, pair: RecordedPair): PairOutcome {
  const a = entities.get(pair.a);
  const b = entities.get(pair.b);
  if (a === undefined || b === undefined) return "merged";
  if (!canonical(a) || !canonical(b)) return "merged";
  return aliasOf(a, b) || aliasOf(b, a) ? "merged" : "open";
}

function tensionOutcome(vault: string, pair: RecordedPair): PairOutcome {
  let status: string | null;
  try {
    status = showTension(vault, pair.id)?.status ?? null;
  } catch {
    status = null;
  }
  if (status === "resolved" || status === "dismissed" || status === "confirmed") return status;
  if (status === "open") return "open";
  return "missing";
}

function emptyOutcomes(): Record<PairOutcome, number> {
  return { merged: 0, resolved: 0, dismissed: 0, confirmed: 0, open: 0, missing: 0 };
}

/** Per-band operator outcomes for the `dedup` or `tension` use. */
export function buildPairVerdictReport(
  vault: string,
  use: "dedup" | "tension",
  opts: { readonly since?: string } = {},
): PairVerdictUseReport {
  const latest = new Map<string, RecordedPair>();
  for (const record of listDecisionModelCalls(vault, opts.since)) {
    if (record.payload["use"] !== use) continue;
    for (const pair of recordedPairs(record)) {
      // By timestamp, not log order: records of the same millisecond are
      // not kept in append order.
      const key = `${pair.kind}\u0000${pair.id}`;
      const seen = latest.get(key);
      if (seen === undefined || seen.createdAt <= pair.createdAt) latest.set(key, pair);
    }
  }
  let entities: Map<string, BrainEntity> | null = null;
  const bands = new Map<string, Record<PairOutcome, number>>();
  for (const pair of latest.values()) {
    let outcome: PairOutcome;
    if (pair.kind === "tension") outcome = tensionOutcome(vault, pair);
    else if (pair.kind === "entity") {
      entities ??= new Map(buildEntityIndex(vault).entities.map((e) => [e.id, e]));
      outcome = entityOutcome(entities, pair);
    } else outcome = preferenceOutcome(vault, pair);
    const key = band(pair.verdict, pair.probability);
    const counts = bands.get(key) ?? emptyOutcomes();
    counts[outcome]++;
    bands.set(key, counts);
  }
  return {
    use,
    pairs: latest.size,
    bands: [...bands]
      .toSorted((x, y) => x[0].localeCompare(y[0]))
      .map(([name, outcomes]) => ({
        band: name,
        pairs: Object.values(outcomes).reduce((s, n) => s + n, 0),
        outcomes,
      })),
  };
}

export function renderPairVerdictReport(report: PairVerdictUseReport): string {
  const lines = [`  ${report.use}: ${report.pairs} verdicted pair(s)`];
  for (const b of report.bands) {
    const outcomes = Object.entries(b.outcomes)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    lines.push(`    ${b.band}: ${b.pairs} (${outcomes})`);
  }
  return lines.join("\n");
}

/**
 * `o2b decision-model report --use answerable` (issue #213, Part 8).
 *
 * The signal is advisory, so the report compares it with the level it
 * annotates rather than measuring a change it never makes:
 *
 *   - `signal`: how many rerank records carried an `answerable`
 *     probability, by band (low below `ANSWERABLE_LOW`, high above
 *     `ANSWERABLE_HIGH`, mid in between, edges included in mid);
 *   - `confusion`: deterministic level (`sufficient`, `weak`,
 *     `insufficient`) against the advisory band, over every gate call and
 *     context-pack receipt that carried `decision_answerable` (gate
 *     records exist only while `recall_gate_telemetry` is on, receipts only
 *     when the pack asked for one);
 *   - `outcomes`: for receipts with a `brain_context_pack_outcome` row on
 *     the same sample id, how often the outcome was poor (not a first-pass
 *     success, or a repair was required) when the signal disagreed with the
 *     level versus when it agreed. A higher poor rate on disagreements is
 *     the evidence a follow-up would need before the signal may change a
 *     level.
 *
 * Reads numbers, closed values and ids only; no record carries text.
 */

import { listContextPackOutcomes } from "../../brain/context-pack-outcome.ts";
import { listContextReceipts } from "../../brain/context-receipts.ts";
import type { ContinuityRecord } from "../../brain/continuity/types.ts";
import { listGateTelemetry } from "../../brain/gate-telemetry.ts";
import { answerableBand, type AnswerableBand } from "../answerable.ts";
import { DECISION_MODEL_CALL_KIND, listDecisionModelCalls } from "../record.ts";

const LEVELS = ["sufficient", "weak", "insufficient"] as const;
const BANDS: ReadonlyArray<AnswerableBand> = ["low", "mid", "high"];

type Level = (typeof LEVELS)[number];
type BandCounts = Record<AnswerableBand, number>;

export interface AnswerableOutcomeSplit {
  /** Receipts with an outcome row. */
  readonly joined: number;
  readonly disagreeing: { readonly total: number; readonly poor: number };
  readonly agreeing: { readonly total: number; readonly poor: number };
  /** Poor-outcome rate among disagreements; null when there were none. */
  readonly disagree_poor_rate: number | null;
  /** Poor-outcome rate among agreements; null when there were none. */
  readonly agree_poor_rate: number | null;
}

export interface AnswerableReport {
  readonly since: string | null;
  /** Rerank records that carried an answerable probability, by band. */
  readonly signal: { readonly total: number; readonly bands: BandCounts };
  /** Annotated gate calls and receipts: level x band. */
  readonly confusion: {
    readonly total: number;
    readonly disagreements: number;
    readonly rows: Readonly<Record<Level, BandCounts>>;
  };
  readonly outcomes: AnswerableOutcomeSplit;
}

function emptyBands(): BandCounts {
  return { low: 0, mid: 0, high: 0 };
}

function annotation(
  value: unknown,
): { readonly probability: number; readonly disagrees: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const p = record["probability"];
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return { probability: p, disagrees: record["disagrees"] === true };
}

function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as ReadonlyArray<string>).includes(value);
}

function isPoorOutcome(record: ContinuityRecord): boolean {
  return (
    record.payload["first_pass_success"] !== true || record.payload["repair_required"] === true
  );
}

function rate(poor: number, total: number): number | null {
  return total === 0 ? null : poor / total;
}

export function buildAnswerableReport(
  vault: string,
  opts: { readonly since?: string } = {},
): AnswerableReport {
  const since = opts.since;
  const signalBands = emptyBands();
  let signalTotal = 0;
  for (const record of listDecisionModelCalls(vault, since)) {
    if (record.kind !== DECISION_MODEL_CALL_KIND || record.payload["use"] !== "rerank") continue;
    const p = record.payload["answerable_probability"];
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    signalTotal++;
    signalBands[answerableBand(p)]++;
  }

  const rows: Record<Level, BandCounts> = {
    sufficient: emptyBands(),
    weak: emptyBands(),
    insufficient: emptyBands(),
  };
  let total = 0;
  let disagreements = 0;
  const count = (level: Level, probability: number, disagrees: boolean): void => {
    rows[level][answerableBand(probability)]++;
    total++;
    if (disagrees) disagreements++;
  };

  for (const record of listGateTelemetry(vault, since !== undefined ? { since } : {})) {
    const ann = annotation(record.payload["decision_answerable"]);
    const level = record.payload["adequacy_level"];
    if (ann === null || !isLevel(level)) continue;
    count(level, ann.probability, ann.disagrees);
  }

  // Latest outcome per sample id (the list is newest first).
  const outcomeBySample = new Map<string, ContinuityRecord>();
  for (const record of listContextPackOutcomes(vault)) {
    const sample = record.payload["sample_id"];
    if (typeof sample === "string" && !outcomeBySample.has(sample)) {
      outcomeBySample.set(sample, record);
    }
  }
  const split = {
    joined: 0,
    disagreeing: { total: 0, poor: 0 },
    agreeing: { total: 0, poor: 0 },
  };
  for (const record of listContextReceipts(vault)) {
    if (since !== undefined && record.createdAt < since) continue;
    const ann = annotation(record.payload["decision_answerable"]);
    const adequacy = record.payload["adequacy"];
    const level =
      typeof adequacy === "object" && adequacy !== null
        ? (adequacy as Record<string, unknown>)["level"]
        : undefined;
    if (ann === null || !isLevel(level)) continue;
    count(level, ann.probability, ann.disagrees);
    const outcome = outcomeBySample.get(record.id);
    if (outcome === undefined) continue;
    split.joined++;
    const bucket = ann.disagrees ? split.disagreeing : split.agreeing;
    bucket.total++;
    if (isPoorOutcome(outcome)) bucket.poor++;
  }

  return {
    since: since ?? null,
    signal: { total: signalTotal, bands: signalBands },
    confusion: { total, disagreements, rows },
    outcomes: {
      ...split,
      disagree_poor_rate: rate(split.disagreeing.poor, split.disagreeing.total),
      agree_poor_rate: rate(split.agreeing.poor, split.agreeing.total),
    },
  };
}

function percent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

export function renderAnswerableReport(report: AnswerableReport): string {
  const lines: string[] = [];
  const b = report.signal.bands;
  lines.push(
    `answerable signal: ${report.signal.total} rerank record(s)` +
      (report.since !== null ? ` since ${report.since}` : "") +
      ` (low ${b.low}, mid ${b.mid}, high ${b.high})`,
  );
  lines.push(
    `level vs band over ${report.confusion.total} annotated verdict(s), ` +
      `${report.confusion.disagreements} disagreement(s):`,
  );
  lines.push(`  ${"level".padEnd(13)}${BANDS.map((band) => band.padStart(6)).join("")}`);
  for (const level of LEVELS) {
    const row = report.confusion.rows[level];
    lines.push(
      `  ${level.padEnd(13)}${BANDS.map((band) => String(row[band]).padStart(6)).join("")}`,
    );
  }
  const o = report.outcomes;
  lines.push(
    `outcomes joined: ${o.joined}; poor when disagreeing ${o.disagreeing.poor}/` +
      `${o.disagreeing.total} (${percent(o.disagree_poor_rate)}), when agreeing ` +
      `${o.agreeing.poor}/${o.agreeing.total} (${percent(o.agree_poor_rate)})`,
  );
  return lines.join("\n");
}

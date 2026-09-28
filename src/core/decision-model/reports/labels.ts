/**
 * `o2b decision-model report --use labels` metrics (issue #213, Part 6).
 *
 * Joins every recorded label suggestion to what the note carries now,
 * per note and dimension. `assign` writes the label into the note's
 * frontmatter and nothing else records it, so the note itself is the
 * log of the operator's later `assign` operations:
 *
 *   - `accepted`: the dimension now holds the suggested value, and it did
 *     not hold it when the suggestion was made;
 *   - `overridden`: the dimension changed since, to another value or to
 *     none;
 *   - `unchanged`: the dimension still holds what it held then;
 *   - `already`: the suggestion equalled the value the note already had
 *     (no action to measure);
 *   - `missing`: the note is gone or unreadable.
 *
 * Suggestions are the would-be suggestions of both modes (shadow records
 * them too, although shadow returns null to the host), so shadow data can
 * be evaluated before `enforce`. When a note and dimension were suggested
 * more than once, the latest record is used. Eval and ping records and
 * degraded calls are left out. Read-only.
 */

import { readLabels } from "../../brain/labels.ts";
import { resolveNotePath } from "../../brain/note-path.ts";
import { parseFrontmatter } from "../../vault.ts";
import { listDecisionModelCalls } from "../record.ts";

export type LabelOutcome = "accepted" | "overridden" | "unchanged" | "already" | "missing";

export interface LabelsModeSummary {
  readonly mode: string;
  readonly suggestions: number;
  readonly outcomes: Readonly<Record<LabelOutcome, number>>;
  /** accepted / (accepted + overridden); null when neither happened. */
  readonly acceptance: number | null;
}

export interface LabelsReport {
  readonly use: "labels";
  /** Suggestions with a non-null value, latest per note and dimension. */
  readonly suggestions: number;
  /** Dimensions the model answered `none` or below the threshold. */
  readonly no_suggestion: number;
  readonly by_mode: ReadonlyArray<LabelsModeSummary>;
}

interface Suggested {
  readonly createdAt: string;
  readonly mode: string;
  readonly path: string;
  readonly dimension: string;
  readonly current: string | null;
  readonly suggested: string | null;
}

function emptyOutcomes(): Record<LabelOutcome, number> {
  return { accepted: 0, overridden: 0, unchanged: 0, already: 0, missing: 0 };
}

function nowValue(
  vault: string,
  path: string,
  dimension: string,
  cache: Map<string, ReadonlyArray<string> | null>,
): { readonly value: string | null } | null {
  let labels = cache.get(path);
  if (labels === undefined) {
    try {
      labels = readLabels(parseFrontmatter(resolveNotePath(vault, path))[0]);
    } catch {
      labels = null;
    }
    cache.set(path, labels);
  }
  if (labels === null) return null;
  const token = labels.find((t) => t.startsWith(`${dimension}/`));
  return { value: token === undefined ? null : token.slice(dimension.length + 1) };
}

export function buildLabelsReport(
  vault: string,
  opts: { readonly since?: string } = {},
): LabelsReport {
  const latest = new Map<string, Suggested>();
  for (const record of listDecisionModelCalls(vault, opts.since)) {
    const p = record.payload;
    if (p["use"] !== "labels" || p["outcome"] !== "ok" || p["origin"] !== undefined) continue;
    const path = p["note_path"];
    const mode = typeof p["mode"] === "string" ? p["mode"] : "unknown";
    if (typeof path !== "string" || !Array.isArray(p["dimensions"])) continue;
    for (const raw of p["dimensions"]) {
      if (raw === null || typeof raw !== "object") continue;
      const d = raw as Record<string, unknown>;
      if (typeof d["dimension"] !== "string") continue;
      const key = `${path}\u0000${d["dimension"]}`;
      const seen = latest.get(key);
      // By timestamp, not log order (same-millisecond records are unordered).
      if (seen !== undefined && seen.createdAt > record.createdAt) continue;
      latest.set(key, {
        createdAt: record.createdAt,
        mode,
        path,
        dimension: d["dimension"],
        current: typeof d["current"] === "string" ? d["current"] : null,
        suggested: typeof d["suggested"] === "string" ? d["suggested"] : null,
      });
    }
  }
  const cache = new Map<string, ReadonlyArray<string> | null>();
  const byMode = new Map<string, Record<LabelOutcome, number>>();
  let suggestions = 0;
  let none = 0;
  for (const s of latest.values()) {
    if (s.suggested === null) {
      none++;
      continue;
    }
    suggestions++;
    const now = nowValue(vault, s.path, s.dimension, cache);
    let outcome: LabelOutcome;
    if (now === null) outcome = "missing";
    else if (s.suggested === s.current) outcome = "already";
    else if (now.value === s.current) outcome = "unchanged";
    else if (now.value === s.suggested) outcome = "accepted";
    else outcome = "overridden";
    const counts = byMode.get(s.mode) ?? emptyOutcomes();
    counts[outcome]++;
    byMode.set(s.mode, counts);
  }
  return {
    use: "labels",
    suggestions,
    no_suggestion: none,
    by_mode: [...byMode]
      .toSorted((x, y) => x[0].localeCompare(y[0]))
      .map(([mode, outcomes]) => {
        const decided = outcomes.accepted + outcomes.overridden;
        return {
          mode,
          suggestions: Object.values(outcomes).reduce((a, n) => a + n, 0),
          outcomes,
          acceptance: decided === 0 ? null : outcomes.accepted / decided,
        };
      }),
  };
}

export function renderLabelsReport(report: LabelsReport): string {
  const lines = [
    `  labels: ${report.suggestions} suggestion(s), ${report.no_suggestion} without a suggestion`,
  ];
  for (const m of report.by_mode) {
    const outcomes = Object.entries(m.outcomes)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    const acceptance = m.acceptance === null ? "-" : `${(m.acceptance * 100).toFixed(1)}%`;
    lines.push(`    ${m.mode}: ${m.suggestions} (${outcomes}); acceptance ${acceptance}`);
  }
  return lines.join("\n");
}

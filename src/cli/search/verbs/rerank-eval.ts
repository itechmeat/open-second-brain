/**
 * `o2b search rerank-eval` - the operator entry point for the rerank eval
 * gate (issue #213, Part 2).
 *
 * Runs the recall benchmark over a labelled dataset twice, rerank OFF and
 * ON with the chosen kind, and reports hit@k and MRR for both plus the
 * deltas and the gate's recommendation. `--compare-local` adds the bundled
 * offline reranker as a third arm. For `--kind decision-model` the ON arm
 * always runs the `rerank` use in enforce (a shadow arm would measure
 * nothing), and it needs an active decision-model config: every query
 * sends its top candidates to the configured endpoint.
 *
 * Read-only for the vault's notes; with the decision-model kind it appends
 * one `decision_model_call` record per query, as any rerank would, tagged
 * `origin: "eval"`. Beside the gate's recommendation it reports hit@1/3/5/10
 * (up to k), per-query wins, losses and ties against off, and for the
 * decision-model kind the run's records by outcome, cost and latency, so
 * an arm whose every call failed (and so equals off) is visible as such.
 */

import { readFileSync } from "node:fs";

import { discoverConfig } from "../../../core/config.ts";
import { resolveDecisionModelConfig } from "../../../core/decision-model/config.ts";
import {
  buildDecisionModelReport,
  type DecisionModelUseSummary,
} from "../../../core/decision-model/diagnostics.ts";
import type { RecallBenchmarkReport } from "../../../core/search/benchmark.ts";
import { parseRecallBenchmarkDataset } from "../../../core/search/benchmark.ts";
import {
  runRerankEvalGate,
  type RerankEvalGateResult,
} from "../../../core/search/rerank-eval-gate.ts";
import type { ResolvedRerankConfig } from "../../../core/search/types.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  isIntegerWithin,
  parseFlags,
  resolveConfig,
  resolveConfigPath,
  VAULT_FLAGS,
} from "../helpers.ts";

const KINDS: ReadonlyArray<ResolvedRerankConfig["kind"]> = [
  "local",
  "decision-model",
  "openai-compat",
];

function isKind(value: string): value is ResolvedRerankConfig["kind"] {
  return (KINDS as ReadonlyArray<string>).includes(value);
}

const HIT_DEPTHS = [1, 3, 5, 10] as const;

/** hit@n for each depth the run measured (n <= k). */
function hitsAt(report: RecallBenchmarkReport): Record<string, number> {
  const out: Record<string, number> = {};
  const total = Math.max(1, report.perQuery.length);
  for (const n of HIT_DEPTHS) {
    if (n > report.k) continue;
    out[`hit_at_${n}`] =
      report.perQuery.filter((q) => q.rank !== null && q.rank <= n).length / total;
  }
  return out;
}

/** Per-query comparison against off, by reciprocal rank. */
function versusOff(
  baseline: RecallBenchmarkReport,
  reranked: RecallBenchmarkReport,
): { wins: number; losses: number; ties: number } {
  const base = new Map(baseline.perQuery.map((q) => [q.id, q.reciprocalRank]));
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const q of reranked.perQuery) {
    const before = base.get(q.id) ?? 0;
    if (q.reciprocalRank > before) wins++;
    else if (q.reciprocalRank < before) losses++;
    else ties++;
  }
  return { wins, losses, ties };
}

function arm(result: RerankEvalGateResult): Record<string, unknown> {
  return {
    hit_at_k: result.reranked.hitAtK,
    mrr: result.reranked.mrr,
    ...hitsAt(result.reranked),
    delta_hit_at_k: result.deltas.hitAtK,
    delta_mrr: result.deltas.mrr,
    versus_off: versusOff(result.baseline, result.reranked),
    recommendation: result.recommendation,
  };
}

function callsOf(summary: DecisionModelUseSummary | undefined): Record<string, unknown> {
  return {
    total: summary?.calls ?? 0,
    outcomes: summary?.outcomes ?? {},
    cost_usd: summary?.cost_usd ?? 0,
    unknown_cost_calls: summary?.unknown_cost_calls ?? 0,
    latency_p50_ms: summary?.latency_p50_ms ?? null,
    latency_p95_ms: summary?.latency_p95_ms ?? null,
  };
}

function renderHits(report: RecallBenchmarkReport): string {
  return Object.entries(hitsAt(report))
    .map(([key, value]) => `${key.replace("hit_at_", "hit@")} ${fmt(value)}`)
    .join("  ");
}

function fmt(x: number): string {
  return x.toFixed(4);
}

function signed(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;
}

export async function cmdSearchRerankEval(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    dataset: { type: "string" },
    kind: { type: "string" },
    k: { type: "string" },
    "compare-local": { type: "boolean" },
    json: { type: "boolean" },
  });
  const datasetPath = flagString(flags, "dataset");
  if (datasetPath === undefined) throw new CliError("--dataset <path> is required");
  const kindFlag = flagString(flags, "kind") ?? "local";
  if (!isKind(kindFlag)) {
    throw new CliError(`--kind must be one of ${KINDS.join(", ")}, got '${kindFlag}'`);
  }
  const kFlag = flagString(flags, "k");
  const k = kFlag !== undefined ? Number(kFlag) : undefined;
  if (k !== undefined && !isIntegerWithin(k, { min: 1 })) {
    throw new CliError(`--k must be a positive integer, got '${kFlag}'`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(datasetPath, "utf8"));
  } catch (e) {
    throw new CliError(`--dataset could not be read as JSON: ${(e as Error).message}`);
  }
  const dataset = parseRecallBenchmarkDataset(raw);
  const cfg = resolveConfig(flags);
  const decisionModel =
    kindFlag === "decision-model"
      ? (cfg.rerank.decisionModel ??
        resolveDecisionModelConfig({
          config: discoverConfig(resolveConfigPath(flags)).data,
          vault: cfg.vault,
        }))
      : undefined;

  const started = new Date().toISOString();
  const gate = await runRerankEvalGate(cfg, dataset, {
    kind: kindFlag,
    ...(k !== undefined ? { k } : {}),
    ...(decisionModel !== undefined ? { decisionModel } : {}),
  });
  const local =
    flagBoolean(flags, "compare-local") && kindFlag !== "local"
      ? await runRerankEvalGate(cfg, dataset, { kind: "local", ...(k !== undefined ? { k } : {}) })
      : null;

  // The decision-model arm's own records: every call this run made.
  const calls =
    kindFlag === "decision-model"
      ? callsOf(
          buildDecisionModelReport(cfg.vault, {
            since: started,
            use: "rerank",
            origin: "eval",
          }).uses[0],
        )
      : null;

  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        queries: gate.baseline.total,
        k: gate.baseline.k,
        baseline: {
          hit_at_k: gate.baseline.hitAtK,
          mrr: gate.baseline.mrr,
          ...hitsAt(gate.baseline),
        },
        [kindFlag]: { ...arm(gate), ...(calls !== null ? { calls } : {}) },
        ...(local !== null ? { local: arm(local) } : {}),
      }) + "\n",
    );
    return 0;
  }
  const line = (name: string, r: RerankEvalGateResult): string => {
    const vs = versusOff(r.baseline, r.reranked);
    return (
      `  ${name.padEnd(15)} ${renderHits(r.reranked)}  MRR ${fmt(r.reranked.mrr)}` +
      `  (hit@k ${signed(r.deltas.hitAtK)}, MRR ${signed(r.deltas.mrr)}; ` +
      `vs off ${vs.wins} win(s), ${vs.losses} loss(es), ${vs.ties} tie(s)) -> ${r.recommendation}\n`
    );
  };
  let text =
    `rerank eval over ${gate.baseline.total} query(ies), k=${gate.baseline.k}\n` +
    `  ${"off:".padEnd(15)} ${renderHits(gate.baseline)}  MRR ${fmt(gate.baseline.mrr)}\n` +
    line(kindFlag, gate);
  if (calls !== null) {
    const outcomes = Object.entries(calls["outcomes"] as Record<string, number>)
      .map(([outcome, n]) => `${outcome} ${n}`)
      .join(", ");
    const p50 = calls["latency_p50_ms"];
    const p95 = calls["latency_p95_ms"];
    text +=
      `    decision calls: ${String(calls["total"])} (${outcomes || "none"}); ` +
      `cost $${(calls["cost_usd"] as number).toFixed(6)}; ` +
      `latency p50 ${p50 === null ? "-" : String(p50)}ms, p95 ${p95 === null ? "-" : String(p95)}ms\n`;
  }
  if (local !== null) text += line("local", local);
  process.stdout.write(text);
  return 0;
}

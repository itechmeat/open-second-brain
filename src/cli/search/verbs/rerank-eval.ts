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
 * one `decision_model_call` record per query, as any rerank would.
 */

import { readFileSync } from "node:fs";

import { discoverConfig } from "../../../core/config.ts";
import { resolveDecisionModelConfig } from "../../../core/decision-model/config.ts";
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

function arm(result: RerankEvalGateResult): Record<string, unknown> {
  return {
    hit_at_k: result.reranked.hitAtK,
    mrr: result.reranked.mrr,
    delta_hit_at_k: result.deltas.hitAtK,
    delta_mrr: result.deltas.mrr,
    recommendation: result.recommendation,
  };
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

  const gate = await runRerankEvalGate(cfg, dataset, {
    kind: kindFlag,
    ...(k !== undefined ? { k } : {}),
    ...(decisionModel !== undefined ? { decisionModel } : {}),
  });
  const local =
    flagBoolean(flags, "compare-local") && kindFlag !== "local"
      ? await runRerankEvalGate(cfg, dataset, { kind: "local", ...(k !== undefined ? { k } : {}) })
      : null;

  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        queries: gate.baseline.total,
        k: gate.baseline.k,
        baseline: { hit_at_k: gate.baseline.hitAtK, mrr: gate.baseline.mrr },
        [kindFlag]: arm(gate),
        ...(local !== null ? { local: arm(local) } : {}),
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    `rerank eval over ${gate.baseline.total} query(ies), k=${gate.baseline.k}\n` +
      `  off:            hit@k ${fmt(gate.baseline.hitAtK)}  MRR ${fmt(gate.baseline.mrr)}\n` +
      `  ${kindFlag.padEnd(15)} hit@k ${fmt(gate.reranked.hitAtK)}  MRR ${fmt(gate.reranked.mrr)}` +
      `  (hit@k ${signed(gate.deltas.hitAtK)}, MRR ${signed(gate.deltas.mrr)}) -> ${gate.recommendation}\n`,
  );
  if (local !== null) {
    process.stdout.write(
      `  ${"local".padEnd(15)} hit@k ${fmt(local.reranked.hitAtK)}  MRR ${fmt(local.reranked.mrr)}` +
        `  (hit@k ${signed(local.deltas.hitAtK)}, MRR ${signed(local.deltas.mrr)}) -> ${local.recommendation}\n`,
    );
  }
  return 0;
}

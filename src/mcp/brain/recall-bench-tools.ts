/**
 * The recall-quality tools (task 3.19): `brain_benchmark`, `brain_tune`
 * and `brain_recall_telemetry`, answered through the telemetry filters
 * and coercers the economics tools share. Split from `recall-tools.ts`;
 * registration happens through that module's registry, which preserves
 * the public RECALL_TOOLS surface.
 */

import { resolveSearchConfig } from "../../core/search/index.ts";
import { appendMetric } from "../../core/brain/metrics.ts";
import { parseRecallBenchmarkDataset, runRecallBenchmark } from "../../core/search/benchmark.ts";
import { tuneRecall } from "../../core/search/tuning.ts";
import { loadTunedParameters, resetTuning } from "../../core/search/tuning-store.ts";
import { listGateTelemetry, summarizeGateTelemetry } from "../../core/brain/gate-telemetry.ts";
import { computeMemoryCostMeter } from "../../core/brain/memory-cost-meter.ts";
import { observedReuseRates } from "../../core/brain/observed-use.ts";
import { computeDeadWeight, DEAD_WEIGHT_MAX_LIMIT } from "../../core/brain/dead-weight.ts";
import { everyArtifactRefView } from "../../core/brain/artifact-ref-view.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import {
  listRecallTelemetry,
  summarizeRecallTelemetry,
} from "../../core/brain/recall-telemetry.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import { requestRefView } from "./reach-events.ts";
import type { ServerContext } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { optionalStringArg } from "./shared.ts";
import { unknownOperationError } from "../coerce.ts";
import { coerceNonNegativeNumber, recallTelemetryFilter } from "./recall-coerce-tools.ts";

/** Recall-quality benchmark over an inline dataset. */
export async function toolBrainBenchmark(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run") {
    throw unknownOperationError("brain_benchmark: operation must be run");
  }
  const k = args["k"];
  if (k !== undefined && (!Number.isInteger(k) || (k as number) < 1)) {
    throw new MCPError(INVALID_PARAMS, "brain_benchmark run: k must be a positive integer");
  }
  let dataset;
  try {
    dataset = parseRecallBenchmarkDataset(args["dataset"]);
  } catch (exc) {
    throw new MCPError(INVALID_PARAMS, `brain_benchmark run: ${(exc as Error).message}`);
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  const now = new Date();
  const report = await runRecallBenchmark(searchConfig, dataset, {
    ...(k !== undefined ? { k: k as number } : {}),
    expand: args["expand"] === true,
    // The dataset is the caller's, and so is the reach it is scored at:
    // `hit` / `rank` / `expectedFound` for caller-named paths is an
    // existence oracle over any corpus the caller did not earn.
    transportReach: contextReach(ctx),
  });
  try {
    appendMetric(ctx.vault, {
      surface: "recall_benchmark",
      runAt: isoSecond(now),
      payload: {
        total: report.total,
        k: report.k,
        expand: report.expand,
        hit_at_k: report.hitAtK,
        mrr: report.mrr,
        misses: report.perQuery.filter((q) => !q.hit).map((q) => q.id),
      },
    });
  } catch {
    // Metrics are observability, not correctness.
  }
  return {
    total: report.total,
    k: report.k,
    expand: report.expand,
    hit_at_k: report.hitAtK,
    mrr: report.mrr,
    // A degraded run measured a smaller system than the configured one.
    ...(report.degraded.length > 0 ? { degraded: report.degraded } : {}),
    per_query: report.perQuery,
  };
}

// ----- brain_tune (t_ae973491) -------------------------------------------------

/** Opt-in self-tuning recall: run the grid, inspect, or reset. */
export async function toolBrainTune(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "status" && op !== "reset") {
    throw unknownOperationError("brain_tune: operation must be run|status|reset");
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  if (op === "status") {
    return {
      enabled: searchConfig.recall.selfTuningEnabled,
      tuned: loadTunedParameters(ctx.vault),
    };
  }
  if (op === "reset") {
    return { removed: resetTuning(ctx.vault) };
  }
  const k = args["k"];
  if (k !== undefined && (!Number.isInteger(k) || (k as number) < 1)) {
    throw new MCPError(INVALID_PARAMS, "brain_tune run: k must be a positive integer");
  }
  let dataset;
  try {
    dataset = parseRecallBenchmarkDataset(args["dataset"]);
  } catch (exc) {
    throw new MCPError(INVALID_PARAMS, `brain_tune run: ${(exc as Error).message}`);
  }
  const now = new Date();
  const report = await tuneRecall(searchConfig, dataset, {
    ...(k !== undefined ? { k: k as number } : {}),
    now,
    // Same reasoning as `brain_benchmark`: the grid is scored with the
    // benchmark, so every cell inherits whatever reach is passed here.
    transportReach: contextReach(ctx),
  });
  try {
    appendMetric(ctx.vault, {
      surface: "self_tuning",
      runAt: isoSecond(now),
      payload: {
        chosen: report.chosen,
        evaluated: report.evaluated.length,
        best_mrr: Math.max(...report.evaluated.map((e) => e.mrr)),
        dataset_hash: report.datasetHash,
      },
    });
  } catch {
    // Metrics are observability, not correctness.
  }
  return {
    chosen: report.chosen,
    evaluated: report.evaluated.map((e) => ({
      params: e.params,
      mrr: e.mrr,
      hit_at_k: e.hitAtK,
      ...(e.degraded.length > 0 ? { degraded: e.degraded } : {}),
    })),
    dataset_hash: report.datasetHash,
    ...(report.degraded.length > 0 ? { degraded: report.degraded } : {}),
  };
}

// ----- brain_dead_ends (t_be62c62d) -----------------------------------------

export async function toolBrainRecallTelemetry(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_recall_telemetry", args, "operation");
  const filter = recallTelemetryFilter(args);

  if (operation === "list") {
    const records = listRecallTelemetry(ctx.vault, filter);
    return { vault_path: vaultPathField(ctx), total: records.length, records };
  }
  if (operation === "summary") {
    const summary = summarizeRecallTelemetry(ctx.vault, filter);
    return { ...summary };
  }
  // Gate-decision telemetry (Workspace Insight Suite, t_65036e02):
  // records emitted by brain_recall_gate when recall_gate_telemetry is on.
  if (operation === "gate_list") {
    const records = listGateTelemetry(ctx.vault, {
      ...(filter.host !== undefined ? { host: filter.host } : {}),
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
    });
    return { vault_path: vaultPathField(ctx), total: records.length, records };
  }
  if (operation === "gate_summary") {
    const summary = summarizeGateTelemetry(ctx.vault, {
      ...(filter.host !== undefined ? { host: filter.host } : {}),
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
    });
    return { ...summary };
  }
  // Observed-use blend (t_65588d8b): the folded per-artifact
  // USED/IGNORED/CONTRADICTED reuse signal that recall ranking prefers over
  // predicted importance. Exposed here so the blend is inspectable.
  if (operation === "observed_reuse") {
    // The keys are artifact references - a vault-relative path or a bare
    // Brain id - so the request's reach/ownership view filters them, the
    // same view the dead_weight branch applies. A key the caller cannot
    // see is dropped BEFORE `total`, per the views' identical-to-absent
    // rule: a total that still counted it would leak its number.
    const refs = everyArtifactRefView(
      requestRefView(ctx),
      gatedOwnerScopeView(ctx.vault, ctx.agentName),
    );
    const rates = [...observedReuseRates(ctx.vault).entries()];
    const artifacts = (refs.filtersNothing ? rates : rates.filter(([key]) => refs.visible(key)))
      .map(([key, r]) => ({ key, ...r }))
      .toSorted((a, b) => (a.score !== b.score ? b.score - a.score : a.key < b.key ? -1 : 1));
    return { vault_path: vaultPathField(ctx), total: artifacts.length, artifacts };
  }
  // Write-vs-read cost meter (memory cost meter): folds write volume
  // against the read telemetry above. Period-based; mode/status/host/limit
  // do not apply to the write side, so reject them to mirror the CLI's
  // fail-closed behavior (recall-telemetry.ts costMeter) rather than
  // silently ignoring and looking like a valid filtered result.
  if (operation === "cost") {
    for (const name of ["mode", "status", "host", "limit"] as const) {
      if (args[name] !== undefined) {
        throw new MCPError(
          INVALID_PARAMS,
          `brain_recall_telemetry: ${name} is not supported for the cost meter`,
        );
      }
    }
    const writeCost = coerceNonNegativeNumber("write_cost", args["write_cost"]);
    const readCost = coerceNonNegativeNumber("read_cost", args["read_cost"]);
    const writeHeavyRatio = coerceNonNegativeNumber("write_heavy_ratio", args["write_heavy_ratio"]);
    const meter = computeMemoryCostMeter(ctx.vault, {
      withholdsPrivate: contextReach(ctx) !== TRANSPORT_REACH.local,
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
      ...(writeCost !== undefined || readCost !== undefined
        ? {
            weights: {
              ...(writeCost !== undefined ? { write: writeCost } : {}),
              ...(readCost !== undefined ? { read: readCost } : {}),
            },
          }
        : {}),
      ...(writeHeavyRatio !== undefined ? { writeHeavyRatio } : {}),
    });
    return { vault_path: vaultPathField(ctx), ...meter };
  }
  // Dead weight (recall-quality, t_1ee67e5b): the complement fold over
  // the vault's live in-scope pages and every path recorded recall ever
  // surfaced (telemetry top artifacts + observed-use source refs). The
  // seventh operation on this tool - an operation, never a new tool, so
  // the tool-count pin does not move.
  if (operation === "dead_weight") {
    // Record-only filters (mode/status/channel/host) have no meaning for
    // the complement; reject them rather than silently ignore, mirroring
    // the cost op and the CLI's fail-closed verb. `limit` is the one
    // exception (PR #248 review L10): it bounds the dead preview, which
    // is otherwise pinned at the fold's 50-row default, clamped to the
    // shared maximum so the full list is reachable in bounded pages.
    for (const name of ["mode", "status", "channel", "host"] as const) {
      if (args[name] !== undefined) {
        throw new MCPError(
          INVALID_PARAMS,
          `brain_recall_telemetry: ${name} is not supported for dead_weight`,
        );
      }
    }
    // Hidden rows are dropped BEFORE total: the request's reach/ownership
    // boundary is applied to the FULL SET, so `pages_total`, `dead` and
    // every count answer only what this caller may see - a total that
    // still included the hidden rows would leak their number (the
    // analytics rule). A local caller filters nothing, by construction.
    const refs = everyArtifactRefView(
      requestRefView(ctx),
      gatedOwnerScopeView(ctx.vault, ctx.agentName),
    );
    const report = computeDeadWeight(ctx.vault, {
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
      ...(filter.limit !== undefined
        ? { deadLimit: Math.min(filter.limit, DEAD_WEIGHT_MAX_LIMIT) }
        : {}),
      ...(refs.filtersNothing ? {} : { includePath: (rel: string) => refs.visible(rel) }),
    });
    return { vault_path: vaultPathField(ctx), ...report };
  }
  throw unknownOperationError(
    "brain_recall_telemetry: operation must be list, summary, gate_list, gate_summary, observed_reuse, cost, or dead_weight",
  );
}

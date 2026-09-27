/**
 * Operator diagnostics for the decision-model feature: the data behind
 * `o2b decision-model check`, `o2b decision-model report` and the doctor
 * readiness line.
 *
 * These are the ONLY surfaces that say anything about a missing key or an
 * incomplete configuration. Every other surface behaves exactly as it does
 * without the feature. Nothing here ever prints a key value: the check
 * names the variable and says whether it is set.
 */

import { DECISION_MODEL_USES, type DecisionModelUse } from "./contract.ts";
import { resolveDecisionModelConfig, type ResolvedDecisionModelConfig } from "./config.ts";
import { makeDecisionProvider } from "./provider.ts";
import {
  DECISION_MODEL_CALL_KIND,
  emitDecisionModelCall,
  listDecisionModelCalls,
  todaySpendUsd,
} from "./record.ts";
import type { ContinuityRecord } from "../brain/continuity/types.ts";

/**
 * Warnings the vault's `_brain.yaml` parser raised about its
 * `decision_model:` block (for example `enabled: true`, which a vault may
 * not set). Empty when there is no vault or no such warning.
 */
export function vaultDecisionModelWarnings(vault: string | null): string[] {
  if (vault === null) return [];
  // Lazy, as in the config resolver: the policy loader is large.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const policy = require("../brain/policy.ts") as typeof import("../brain/policy.ts");
  try {
    return policy
      .loadBrainConfigDetailed(vault)
      .warnings.map((w) => w.message)
      .filter((m) => m.startsWith("decision_model"));
  } catch {
    return [];
  }
}

export interface DecisionModelCheckReport {
  readonly enabled: boolean;
  readonly status: ResolvedDecisionModelConfig["status"];
  readonly provider: string | null;
  readonly base_url: string | null;
  readonly model: string | null;
  /** NAME of the key variable, never its value. */
  readonly env_key: string | null;
  readonly key_set: boolean;
  /**
   * The uses as configured. While the feature is not active every use
   * runs `off` whatever this says; `status` tells which applies.
   */
  readonly uses: Readonly<Record<DecisionModelUse, string>>;
  /** True when some use is in shadow or enforce: requests carry vault text. */
  readonly sends_data: boolean;
  readonly vault: string | null;
  readonly vault_opt_out: boolean;
  readonly timeout_ms: number;
  readonly max_state_tokens: number;
  readonly cost_gate_usd: number;
  readonly today_spend_usd: number | null;
  readonly input_price_usd_per_mtok: number | null;
  readonly processor: string | null;
  readonly rerank: {
    readonly kind_configured: boolean;
    /** `search_rerank_*` endpoint keys that are set but ignored for this kind. */
    readonly ignored_keys: ReadonlyArray<string>;
  };
  readonly errors: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** How to proceed, when something is missing. */
  readonly hint: string | null;
  readonly ping?: {
    readonly ok: boolean;
    readonly model?: string;
    readonly latency_ms?: number;
    readonly reason?: string;
  };
}

export interface DecisionModelCheckOptions {
  readonly config: Readonly<Record<string, string>>;
  readonly vault: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly ping?: boolean;
  readonly now?: Date;
}

const RERANK_ENDPOINT_KEYS = [
  "search_rerank_base_url",
  "search_rerank_model",
  "search_rerank_env_key",
] as const;

function hintFor(cfg: ResolvedDecisionModelConfig): string | null {
  switch (cfg.status) {
    case "disabled": {
      // Name only what is missing.
      const missing = ['decision_model_enabled: "true"'];
      if (cfg.provider === null) missing.push("a decision_model_provider");
      if (DECISION_MODEL_USES.every((use) => cfg.configuredUses[use] === "off")) {
        missing.push('one use in shadow (for example decision_model_uses: "rerank:shadow")');
      }
      const list =
        missing.length === 1
          ? missing[0]!
          : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]!}`;
      return `the feature is off; to try it, set ${list} in the machine config`;
    }
    case "no_key":
      return cfg.envKey === null
        ? "no key variable is named: set decision_model_env_key to the NAME of an " +
            "environment variable that holds the key"
        : `set the environment variable ${cfg.envKey} to the key in the environment that runs ` +
            "Open Second Brain (the config holds only the variable's name, never the key)";
    case "disabled_by_vault":
      return "this vault opted out in Brain/_brain.yaml (decision_model: { enabled: false })";
    case "invalid":
      return "fix the config errors above; until then every use stays off";
    case "active":
      return null;
  }
}

export async function buildDecisionModelCheck(
  opts: DecisionModelCheckOptions,
): Promise<DecisionModelCheckReport> {
  const env = opts.env ?? process.env;
  const cfg = resolveDecisionModelConfig({ env, config: opts.config, vault: opts.vault });
  const warnings: string[] = [];
  const sendsData = DECISION_MODEL_USES.some((use) => cfg.uses[use] !== "off");
  if (cfg.enabled && sendsData) {
    warnings.push(
      "shadow and enforce both send data: each request carries the masked, clipped, " +
        "redacted text of the candidates to the processor named above",
    );
  }
  if (!cfg.enabled && DECISION_MODEL_USES.some((use) => cfg.configuredUses[use] !== "off")) {
    warnings.push("decision_model_enabled is not true, so every use listed above runs off");
  }
  for (const w of vaultDecisionModelWarnings(opts.vault)) warnings.push(`vault: ${w}`);
  if (cfg.enabled && !sendsData) {
    warnings.push("no use is in shadow or enforce, so nothing is ever sent");
  }
  let todaySpend: number | null = null;
  if (cfg.enabled && opts.vault !== null) {
    try {
      todaySpend = todaySpendUsd(opts.vault, opts.now ?? new Date());
    } catch {
      todaySpend = null;
    }
  }
  if (cfg.enabled && cfg.inputPriceUsdPerMtok === null) {
    warnings.push(
      "no input price is known for this provider, so the daily cost gate applies only to " +
        "routes that report cost; set decision_model_input_price_usd_per_mtok",
    );
  }

  const kindRaw = env["OPEN_SECOND_BRAIN_SEARCH_RERANK_KIND"] || opts.config["search_rerank_kind"];
  const kindConfigured = kindRaw === "decision-model";
  const ignored = kindConfigured
    ? RERANK_ENDPOINT_KEYS.filter((key) => {
        const value = opts.config[key];
        return value !== undefined && value !== "";
      })
    : [];

  const report: DecisionModelCheckReport = {
    enabled: cfg.enabled,
    status: cfg.status,
    provider: cfg.provider,
    base_url: cfg.baseUrl,
    model: cfg.model,
    env_key: cfg.envKey,
    key_set: cfg.keyPresent,
    uses: cfg.configuredUses,
    sends_data: cfg.status === "active" && sendsData,
    vault: opts.vault,
    vault_opt_out: cfg.status === "disabled_by_vault",
    timeout_ms: cfg.timeoutMs,
    max_state_tokens: cfg.maxStateTokens,
    cost_gate_usd: cfg.dailyCostGateUsd,
    today_spend_usd: todaySpend,
    input_price_usd_per_mtok: cfg.inputPriceUsdPerMtok,
    processor: cfg.processor,
    rerank: { kind_configured: kindConfigured, ignored_keys: ignored },
    errors: cfg.errors,
    notes: cfg.notes,
    warnings,
    hint: hintFor(cfg),
  };

  if (opts.ping !== true) return report;
  const provider = makeDecisionProvider(cfg, env);
  if (provider === null) {
    return { ...report, ping: { ok: false, reason: `not sent: status ${cfg.status}` } };
  }
  const pong = await provider.ping();
  // A ping is a real request: record it (origin `ping`), so it counts
  // toward the daily gate and shows in the report.
  emitDecisionModelCall(cfg.vault, {
    use: "ping",
    mode: "shadow",
    provider: provider.name,
    model: pong.model ?? provider.model,
    calibrated: provider.calibrated,
    questionCount: 1,
    candidateCount: 0,
    ...(pong.usage !== undefined ? { usage: pong.usage } : {}),
    inputPriceUsdPerMtok: cfg.inputPriceUsdPerMtok,
    latencyMs: pong.latencyMs ?? 0,
    outcome: pong.ok ? "ok" : (pong.reason ?? "network"),
    origin: "ping",
    ...(opts.now !== undefined ? { createdAt: opts.now.toISOString() } : {}),
  });
  return {
    ...report,
    ping: {
      ok: pong.ok,
      ...(pong.model !== undefined ? { model: pong.model } : {}),
      ...(pong.latencyMs !== undefined ? { latency_ms: pong.latencyMs } : {}),
      ...(pong.reason !== undefined ? { reason: pong.reason } : {}),
    },
  };
}

/** Non-zero only for a broken configured provider. */
export function decisionModelCheckExitCode(report: DecisionModelCheckReport): number {
  if (report.status === "invalid") return 1;
  if (report.ping !== undefined && report.status === "active" && !report.ping.ok) return 1;
  return 0;
}

export function renderDecisionModelCheck(report: DecisionModelCheckReport): string {
  const lines: string[] = [];
  lines.push(`decision model: ${report.status}`);
  lines.push(`  enabled: ${report.enabled}`);
  lines.push(`  provider: ${report.provider ?? "(not set)"}`);
  lines.push(`  base url: ${report.base_url ?? "(not set)"}`);
  lines.push(`  model: ${report.model ?? "(not set)"}`);
  lines.push(
    report.env_key === null
      ? "  key variable: (not named)"
      : `  key variable: ${report.env_key} (${report.key_set ? "set" : "not set"})`,
  );
  const uses = DECISION_MODEL_USES.map((use) => `${use}:${report.uses[use]}`).join(", ");
  lines.push(`  uses: ${uses}`);
  lines.push(`  vault opt-out: ${report.vault_opt_out ? "yes" : "no"}`);
  lines.push(`  timeout: ${report.timeout_ms}ms, max state: ${report.max_state_tokens} tokens`);
  const spend =
    report.today_spend_usd === null ? "unknown" : `$${report.today_spend_usd.toFixed(6)}`;
  const gate = report.cost_gate_usd > 0 ? `$${report.cost_gate_usd}` : "off";
  lines.push(`  daily cost gate: ${gate}; today (UTC): ${spend}`);
  if (report.processor !== null) lines.push(`  processor: ${report.processor}`);
  if (report.rerank.kind_configured) {
    lines.push(
      "  rerank: search_rerank_kind is decision-model and uses this config " +
        "(pays off with a semantic lane and search_rerank_top_k around 30)",
    );
    if (report.rerank.ignored_keys.length > 0) {
      lines.push(`    ignored for this kind: ${report.rerank.ignored_keys.join(", ")}`);
    }
  }
  for (const error of report.errors) lines.push(`  error: ${error}`);
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  if (report.hint !== null) lines.push(`  hint: ${report.hint}`);
  if (report.ping !== undefined) {
    lines.push(
      report.ping.ok
        ? `  ping: ok, answered by ${report.ping.model ?? "?"} in ${report.ping.latency_ms ?? 0}ms`
        : `  ping: failed (${report.ping.reason ?? "unknown"})`,
    );
  }
  return lines.join("\n");
}

// ----- report -----------------------------------------------------------------

export interface DecisionModelUseSummary {
  readonly use: string;
  readonly calls: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly latency_p50_ms: number | null;
  readonly latency_p95_ms: number | null;
  readonly input_tokens: number;
  readonly cost_usd: number;
  readonly unknown_cost_calls: number;
  /**
   * Rerank only: agreement between decision and heuristic order over the
   * shadow records of ordinary searches (eval and ping records excluded).
   */
  readonly agreement?: {
    readonly compared: number;
    readonly top1_agreement: number;
    readonly top5_overlap: number;
  };
}

export interface DecisionModelReport {
  readonly since: string | null;
  readonly total: number;
  readonly uses: ReadonlyArray<DecisionModelUseSummary>;
}

function percentile(sorted: ReadonlyArray<number>, p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : null;
}

function agreementOf(
  records: ReadonlyArray<ContinuityRecord>,
): DecisionModelUseSummary["agreement"] {
  let compared = 0;
  let top1 = 0;
  let overlapSum = 0;
  for (const record of records) {
    if (record.payload["mode"] !== "shadow" || record.payload["origin"] !== undefined) continue;
    const heuristic = stringArray(record.payload["heuristic_order"]);
    const decision = stringArray(record.payload["decision_order"]);
    if (heuristic === null || decision === null || heuristic.length === 0) continue;
    compared++;
    if (heuristic[0] === decision[0]) top1++;
    const k = Math.min(5, heuristic.length);
    const a = new Set(heuristic.slice(0, k));
    const shared = decision.slice(0, k).filter((p) => a.has(p)).length;
    overlapSum += shared / k;
  }
  if (compared === 0) return undefined;
  return { compared, top1_agreement: top1 / compared, top5_overlap: overlapSum / compared };
}

export function buildDecisionModelReport(
  vault: string,
  opts: { readonly since?: string; readonly use?: string; readonly origin?: string } = {},
): DecisionModelReport {
  const records = listDecisionModelCalls(vault, opts.since).filter(
    (r) =>
      r.kind === DECISION_MODEL_CALL_KIND &&
      (opts.use === undefined || r.payload["use"] === opts.use) &&
      (opts.origin === undefined || r.payload["origin"] === opts.origin),
  );
  const byUse = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    const use = typeof record.payload["use"] === "string" ? record.payload["use"] : "unknown";
    const list = byUse.get(use) ?? [];
    list.push(record);
    byUse.set(use, list);
  }
  const uses: DecisionModelUseSummary[] = [];
  for (const [use, list] of [...byUse].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const outcomes: Record<string, number> = {};
    const latencies: number[] = [];
    let inputTokens = 0;
    let cost = 0;
    let unknownCost = 0;
    for (const record of list) {
      const p = record.payload;
      const outcome = typeof p["outcome"] === "string" ? p["outcome"] : "unknown";
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (typeof p["latency_ms"] === "number" && outcome !== "cost_gate" && outcome !== "budget") {
        latencies.push(p["latency_ms"]);
      }
      if (typeof p["input_tokens"] === "number") inputTokens += p["input_tokens"];
      if (typeof p["cost_usd"] === "number") cost += p["cost_usd"];
      else if (outcome === "ok") unknownCost++;
    }
    latencies.sort((a, b) => a - b);
    const agreement = use === "rerank" ? agreementOf(list) : undefined;
    uses.push({
      use,
      calls: list.length,
      outcomes,
      latency_p50_ms: percentile(latencies, 0.5),
      latency_p95_ms: percentile(latencies, 0.95),
      input_tokens: inputTokens,
      cost_usd: cost,
      unknown_cost_calls: unknownCost,
      ...(agreement !== undefined ? { agreement } : {}),
    });
  }
  return { since: opts.since ?? null, total: records.length, uses };
}

export function renderDecisionModelReport(report: DecisionModelReport): string {
  const lines: string[] = [];
  lines.push(
    `decision model calls: ${report.total}${report.since !== null ? ` since ${report.since}` : ""}`,
  );
  for (const u of report.uses) {
    const outcomes = Object.entries(u.outcomes)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    lines.push(`  ${u.use}: ${u.calls} call(s) (${outcomes})`);
    lines.push(
      `    latency p50 ${u.latency_p50_ms ?? "-"}ms, p95 ${u.latency_p95_ms ?? "-"}ms; ` +
        `input tokens ${u.input_tokens}; cost $${u.cost_usd.toFixed(6)}` +
        (u.unknown_cost_calls > 0 ? ` (+${u.unknown_cost_calls} call(s) of unknown cost)` : ""),
    );
    if (u.agreement !== undefined) {
      lines.push(
        `    shadow agreement over ${u.agreement.compared}: top-1 ` +
          `${(u.agreement.top1_agreement * 100).toFixed(1)}%, top-5 overlap ` +
          `${(u.agreement.top5_overlap * 100).toFixed(1)}%`,
      );
    }
  }
  return lines.join("\n");
}

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

import { CHOICE_MAX_OPTIONS } from "./answers.ts";
import { DECISION_MODEL_USES, isDecisionModelUse, type DecisionModelUse } from "./contract.ts";
import { resolveDecisionModelConfig, type ResolvedDecisionModelConfig } from "./config.ts";
import { makeDecisionProvider } from "./provider.ts";
import { DECISION_MODEL_UNPRICED_ADAPTERS } from "./presets.ts";
import type { DecisionProvider } from "./contract.ts";
import { SecretReferenceError } from "../secret-ref.ts";
import {
  SecretStoreKeyfileMissingError,
  SecretStoreLockedError,
} from "../brain/secrets/envelope.ts";
import {
  DECISION_MODEL_CALL_KIND,
  emitDecisionModelCall,
  listDecisionModelCalls,
  listDecisionModelEvalGrades,
  todaySpendUsd,
  type DecisionEvalGrade,
} from "./record.ts";
import type { ContinuityRecord } from "../brain/continuity/types.ts";
import { DECISION_THRESHOLD_PROFILES, isDecisionThresholdProfile } from "./questions.ts";
import { decisionEvalSpecFor, decisionEvalSpecHash, type DecisionEvalSpec } from "./eval-spec.ts";
import { validatedTuningMark } from "./eval/mark.ts";
import { processDirsEnv, type PlatformDirsEnv } from "../platform-dirs.ts";
import { USE_REPORTS } from "./reports/index.ts";

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
  /**
   * The adapter the preset names (`systemone`, `vercel-evaluate`,
   * `llm-emulation`, `converse`).
   */
  readonly adapter: string;
  readonly base_url: string | null;
  readonly model: string | null;
  /** NAME of the key variable, never its value. */
  readonly env_key: string | null;
  readonly key_set: boolean;
  /** False only for a loopback self-hosted server, which may run without a key. */
  readonly key_required: boolean;
  /** Whether the provider's probabilities are calibrated. */
  readonly calibrated: boolean;
  /** The threshold profile answers are held to; null when unknown (no use enforces). */
  readonly threshold_profile: string | null;
  /** Uses configured `enforce` that run as `shadow` for want of tuned thresholds. */
  readonly shadow_only_uses: ReadonlyArray<DecisionModelUse>;
  /**
   * The measured tuning state of the resolved threshold profile: what the
   * source table claims, and which (profile, use) pairs a valid
   * machine-side mark covers (`eval/mark.ts`).
   */
  readonly tuning: MeasuredTuning;
  /** Cached preregistered-eval verdicts, per use, with the skip notes. */
  readonly eval_grades: {
    readonly total: number;
    readonly skipped: ReadonlyArray<string>;
    readonly uses: ReadonlyArray<{
      readonly use: string;
      readonly runs: number;
      readonly last_verdict: string | null;
      readonly last_at: string | null;
      readonly last_spec_hash: string | null;
    }>;
  };
  /** Most options one `choice` question may carry on this route. */
  readonly max_choice_options: number;
  readonly output_price_usd_per_mtok: number | null;
  /** A model licence restriction, when the route's licence has one. */
  readonly licence_note: string | null;
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
  /**
   * Where the machine-side tuning marks are read from. Defaults to the
   * running process's platform dirs; tests inject a state root.
   */
  readonly markSource?: PlatformDirsEnv | null;
}

const RERANK_ENDPOINT_KEYS = [
  "search_rerank_base_url",
  "search_rerank_model",
  "search_rerank_env_key",
] as const;

// ----- the measured tuning state ----------------------------------------------

/** One (use, spec hash) pair a valid tuning mark covers. */
export interface MarkedUse {
  readonly use: DecisionModelUse;
  readonly spec_hash: string;
}

export interface MeasuredTuning {
  /** The resolved threshold profile; null when none resolves. */
  readonly profile: string | null;
  /**
   * `none`: no profile. `baseline`: the profile ships tuned for every
   * use. `hand`: the source table carries hand-registered uses.
   * `measured`: at least one pair carries a valid machine-side mark.
   * `measured_elsewhere`: a mark exists but is bound to another endpoint,
   * so enforce holds as shadow here. `untuned`: nothing tuned, so
   * enforce holds as shadow.
   */
  readonly state: "none" | "baseline" | "hand" | "measured" | "measured_elsewhere" | "untuned";
  readonly marked_uses: ReadonlyArray<MarkedUse>;
  /**
   * Pairs whose mark passes every acceptance axis but is bound to a
   * different endpoint (provider, model or base URL): the gate holds
   * them shadow on this one. Never armed, and never counted in
   * {@link marked_uses}.
   */
  readonly elsewhere_uses: ReadonlyArray<MarkedUse>;
}

/**
 * The measured tuning state of the resolved profile: the source table
 * decides first (baseline, or a hand-registered list), and only the
 * pairs the table leaves untuned can be carried by a valid machine-side
 * mark. Marks are checked against THIS config's endpoint - the same
 * provider, model and base URL the resolver's gate reader binds - so a
 * promote measured on one model never reads as measured for another.
 * The same vocabulary and the same short spec hash render into
 * `check`, the report and the doctor probe, so the surfaces cannot
 * disagree about what "tuned" means here.
 */
export function measuredTuning(
  cfg: ResolvedDecisionModelConfig,
  source: PlatformDirsEnv = processDirsEnv(),
): MeasuredTuning {
  const profile = cfg.thresholdProfile ?? null;
  if (profile === null || !isDecisionThresholdProfile(profile)) {
    return { profile, state: "none", marked_uses: [], elsewhere_uses: [] };
  }
  const tuned = DECISION_THRESHOLD_PROFILES[profile]?.tuned ?? [];
  if (tuned === "baseline") {
    return { profile, state: "baseline", marked_uses: [], elsewhere_uses: [] };
  }
  // The same endpoint shape the resolver's gate reader binds
  // (config.ts): a mark measured elsewhere never arms enforce here, so
  // it must never read as measured here either.
  const endpoint = { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl };
  const marked: MarkedUse[] = [];
  const elsewhere: MarkedUse[] = [];
  for (const use of DECISION_MODEL_USES) {
    const spec: DecisionEvalSpec | null = decisionEvalSpecFor(use);
    if (spec === null) continue;
    if (validatedTuningMark(profile, use, source, spec, Date.now(), endpoint) !== null) {
      marked.push({ use, spec_hash: decisionEvalSpecHash(spec) });
    } else if (validatedTuningMark(profile, use, source, spec) !== null) {
      // Passes every axis but the endpoint: measured, but not here.
      elsewhere.push({ use, spec_hash: decisionEvalSpecHash(spec) });
    }
  }
  if (marked.length > 0) {
    return { profile, state: "measured", marked_uses: marked, elsewhere_uses: elsewhere };
  }
  if (elsewhere.length > 0) {
    return { profile, state: "measured_elsewhere", marked_uses: [], elsewhere_uses: elsewhere };
  }
  if (Array.isArray(tuned) && tuned.length > 0) {
    return { profile, state: "hand", marked_uses: [], elsewhere_uses: [] };
  }
  return { profile, state: "untuned", marked_uses: [], elsewhere_uses: [] };
}

/** The short form the prose surfaces print: first twelve hex characters. */
export function shortSpecHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

/** The one tuning sentence `check`, `report` and the doctor probe share. */
export function measuredTuningSummary(measured: MeasuredTuning): string {
  switch (measured.state) {
    case "none":
      return "no threshold profile resolves, so the source table alone gates enforce";
    case "baseline":
      return `profile '${measured.profile}' is the baseline`;
    case "hand":
      return `profile '${measured.profile}' carries hand-registered tuned uses`;
    case "measured": {
      const parts = measured.marked_uses
        .map((m) => `${shortSpecHash(m.spec_hash)} (${m.use})`)
        .join(", ");
      const sentence = `profile '${measured.profile}' measured under spec hash ${parts}`;
      if (measured.elsewhere_uses.length === 0) return sentence;
      const other = measured.elsewhere_uses
        .map((m) => `${shortSpecHash(m.spec_hash)} (${m.use})`)
        .join(", ");
      return (
        sentence +
        `; a mark for ${other} was measured on another endpoint ` +
        "(provider, model or base-url mismatch) and holds shadow here"
      );
    }
    case "measured_elsewhere": {
      const parts = measured.elsewhere_uses
        .map((m) => `${shortSpecHash(m.spec_hash)} (${m.use})`)
        .join(", ");
      return (
        `profile '${measured.profile}' measured under spec hash ${parts} on another ` +
        "endpoint (provider, model or base-url mismatch); enforce holds as shadow"
      );
    }
    case "untuned":
      return (
        `profile '${measured.profile}' is untuned; enforce holds as shadow ` +
        "(o2b decision-model eval run can measure a use)"
      );
  }
}

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
  // The vault's own custody store backs a `$secret:` reference in the key
  // value: without this thread the check reported `active` for a reference
  // it could not resolve, deferring the failure to the use site - and the
  // ping below built a provider whose Bearer key was the raw `$secret:`
  // literal.
  const cfg = resolveDecisionModelConfig({
    env,
    config: opts.config,
    vault: opts.vault,
    secretsVault: opts.vault ?? undefined,
  });
  const warnings: string[] = [];
  const notes: string[] = [];
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
  // The one place an enforce that runs as shadow is reported: hot paths
  // stay silent. Printed once per check.
  const shadowOnly = cfg.shadowOnlyUses ?? [];
  if (cfg.enabled && shadowOnly.length > 0) {
    warnings.push(
      `enforce runs as shadow for ${shadowOnly.join(", ")}: threshold profile ` +
        `'${cfg.thresholdProfile ?? "unknown"}' has no tuned thresholds for ` +
        (shadowOnly.length === 1 ? "it" : "them") +
        (cfg.thresholdProfile === null || cfg.thresholdProfile === undefined
          ? "; for a compatible server of a known family set decision_model_threshold_profile"
          : ""),
    );
  }
  if (cfg.enabled && !cfg.calibrated) {
    warnings.push(
      `provider '${cfg.provider ?? "?"}' is uncalibrated: a generative model reports its own ` +
        "probabilities, every record carries calibrated: false, and each request costs far " +
        "more than a decision model; use it for shadow evaluation only",
    );
  }
  if (cfg.enabled && cfg.keyRequired === false && !cfg.keyPresent) {
    notes.push("no key is set; requests to this loopback server carry no authorization header");
  }
  // The routes whose presets publish no price (see
  // DECISION_MODEL_UNPRICED_ADAPTERS): until the operator sets one, the
  // gate records nothing for the route's calls - a stronger under-count
  // than the generic unknown-price warning below describes. Both
  // chat-shaped routes read an output price too, so each warning names
  // both settings; `llm-emulation` alone may still volunteer a cost, so
  // its wording keeps the reported-cost escape hatch.
  const unpricedRoute = DECISION_MODEL_UNPRICED_ADAPTERS.includes(cfg.adapter);
  if (cfg.enabled && cfg.inputPriceUsdPerMtok === null && unpricedRoute) {
    warnings.push(
      cfg.adapter === "converse"
        ? "the daily cost gate counts none of converse's calls (the gateway's cost field is not " +
            "trusted) until both prices are set: decision_model_input_price_usd_per_mtok and " +
            "decision_model_output_price_usd_per_mtok"
        : "no prices are set for llm-emulation, so the daily cost gate counts only requests whose " +
            "route reports a cost; set decision_model_input_price_usd_per_mtok and " +
            "decision_model_output_price_usd_per_mtok",
    );
  }
  if (cfg.enabled && cfg.inputPriceUsdPerMtok === null && !unpricedRoute) {
    warnings.push(
      "no input price is known for this provider, so the daily cost gate applies only to " +
        "routes that report cost; set decision_model_input_price_usd_per_mtok",
    );
  }

  // The measured tuning state: read only when the feature is enabled and
  // a profile resolves - the same condition under which the resolver
  // consulted the marks - so a disabled install pays no file reads.
  const tuning = cfg.enabled
    ? measuredTuning(
        cfg,
        opts.markSource === null ? processDirsEnv() : (opts.markSource ?? processDirsEnv()),
      )
    : {
        profile: cfg.thresholdProfile ?? null,
        state: "none" as const,
        marked_uses: [],
        elsewhere_uses: [],
      };

  // The cached eval verdicts are review evidence for the mark; a check
  // that named the measured state without them would be unauditable.
  const gradeUses: {
    use: string;
    runs: number;
    last_verdict: string | null;
    last_at: string | null;
    last_spec_hash: string | null;
  }[] = [];
  let gradeTotal = 0;
  const gradeSkipped: string[] = [];
  if (cfg.enabled && opts.vault !== null) {
    try {
      const { grades, skipped } = listDecisionModelEvalGrades(opts.vault);
      gradeTotal = grades.length;
      gradeSkipped.push(...skipped);
      const byUse = new Map<string, DecisionEvalGrade[]>();
      for (const grade of grades) {
        const list = byUse.get(grade.use) ?? [];
        list.push(grade);
        byUse.set(grade.use, list);
      }
      for (const [use, list] of [...byUse].toSorted((a, b) => a[0].localeCompare(b[0]))) {
        const last = list[list.length - 1]!;
        gradeUses.push({
          use,
          runs: list.length,
          last_verdict: last.verdict,
          last_at: last.createdAt,
          last_spec_hash: last.specHash,
        });
      }
    } catch {
      // An unreadable log is reported as no cached grades, the same
      // fail-soft direction the spend probe above takes.
    }
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
    adapter: cfg.adapter,
    base_url: cfg.baseUrl,
    model: cfg.model,
    env_key: cfg.envKey,
    key_set: cfg.keyPresent,
    key_required: cfg.keyRequired !== false,
    calibrated: cfg.calibrated,
    threshold_profile: cfg.thresholdProfile ?? null,
    shadow_only_uses: shadowOnly,
    tuning,
    eval_grades: { total: gradeTotal, skipped: gradeSkipped, uses: gradeUses },
    max_choice_options: cfg.maxChoiceOptions ?? CHOICE_MAX_OPTIONS,
    output_price_usd_per_mtok: cfg.outputPriceUsdPerMtok ?? null,
    licence_note: cfg.licenceNote ?? null,
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
    notes: [...cfg.notes, ...notes],
    warnings,
    hint: hintFor(cfg),
  };

  if (opts.ping !== true) return report;
  // The ping resolves the key the way the real request path does (the
  // factory re-resolves at call time). A store that locks between the
  // config probe and here - or whose keyfile is missing while entries
  // survive - raises the named refusal, degraded into the ping's reason,
  // never sent as a Bearer key and never left to escape the check as an
  // exception.
  let provider: DecisionProvider | null;
  try {
    provider = makeDecisionProvider(cfg, env, opts.vault ?? undefined);
  } catch (err) {
    if (
      err instanceof SecretStoreLockedError ||
      err instanceof SecretStoreKeyfileMissingError ||
      err instanceof SecretReferenceError
    ) {
      return { ...report, ping: { ok: false, reason: `not sent: ${err.message}` } };
    }
    throw err;
  }
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
    ...(cfg.outputPriceUsdPerMtok !== undefined && cfg.outputPriceUsdPerMtok !== null
      ? { outputPriceUsdPerMtok: cfg.outputPriceUsdPerMtok }
      : {}),
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
  lines.push(
    `  provider: ${report.provider ?? "(not set)"} (adapter ${report.adapter}` +
      `${report.calibrated ? "" : ", uncalibrated"})`,
  );
  lines.push(`  base url: ${report.base_url ?? "(not set)"}`);
  lines.push(`  model: ${report.model ?? "(not set)"}`);
  const optional = report.key_required ? "" : ", optional on this loopback server";
  lines.push(
    report.env_key === null
      ? `  key variable: (not named${optional})`
      : `  key variable: ${report.env_key} (${report.key_set ? "set" : "not set"}${optional})`,
  );
  const uses = DECISION_MODEL_USES.map((use) => `${use}:${report.uses[use]}`).join(", ");
  lines.push(`  uses: ${uses}`);
  lines.push(`  vault opt-out: ${report.vault_opt_out ? "yes" : "no"}`);
  lines.push(`  timeout: ${report.timeout_ms}ms, max state: ${report.max_state_tokens} tokens`);
  lines.push(
    `  threshold profile: ${report.threshold_profile ?? "(unknown: no use enforces)"}; ` +
      `max choice options: ${report.max_choice_options}`,
  );
  lines.push(`  tuning: ${measuredTuningSummary(report.tuning)}`);
  const gradeUse = report.eval_grades.uses
    .map((u) => {
      const at = u.last_at === null ? "" : ` at ${u.last_at}`;
      const spec = u.last_spec_hash === null ? "" : ` under ${shortSpecHash(u.last_spec_hash)}`;
      return `${u.use}: ${u.runs} run(s), last ${u.last_verdict ?? "?"}${spec}${at}`;
    })
    .join("; ");
  lines.push(
    report.eval_grades.total === 0
      ? "  eval grades: none cached"
      : `  eval grades: ${report.eval_grades.total} record(s) (${gradeUse})` +
          (report.eval_grades.skipped.length > 0
            ? `, ${report.eval_grades.skipped.length} skipped`
            : ""),
  );
  const spend =
    report.today_spend_usd === null ? "unknown" : `$${report.today_spend_usd.toFixed(6)}`;
  const gate = report.cost_gate_usd > 0 ? `$${report.cost_gate_usd}` : "off";
  lines.push(`  daily cost gate: ${gate}; today (UTC): ${spend}`);
  if (report.processor !== null) lines.push(`  processor: ${report.processor}`);
  if (report.licence_note !== null) lines.push(`  licence: ${report.licence_note}`);
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
  /**
   * With `--use`, the use's own evaluation report (`reports/index.ts`);
   * absent for `rerank`, whose metric is the summary's shadow agreement.
   */
  readonly use_report?: { readonly use: DecisionModelUse; readonly report: unknown };
  /**
   * The cached verdict sets of the preregistered evaluation
   * (`eval/grade.ts`), oldest first, with the named skip notes. Present
   * whenever the vault holds at least one, so a vault with none renders
   * no eval section at all rather than an empty one.
   */
  readonly eval?: {
    readonly grades: ReadonlyArray<DecisionEvalGradeLine>;
    readonly skipped: ReadonlyArray<string>;
  };
}

/** One cached eval grade, as the prose and JSON surfaces print it. */
export interface DecisionEvalGradeLine {
  readonly record_id: string;
  readonly created_at: string;
  readonly use: string;
  readonly profile: string | null;
  readonly verdict: string;
  readonly spec_hash: string;
  readonly counted_n: number;
  readonly counted_error: number | null;
  readonly baseline_error: number | null;
  readonly dev_error: number | null;
}

/** The one-line prose form of a cached eval grade, shared by the surfaces. */
export function renderEvalGradeLine(grade: DecisionEvalGradeLine): string {
  const num = (v: number | null): string => (v === null ? "-" : v.toFixed(3));
  return (
    `${grade.created_at} ${grade.use} (${grade.profile ?? "no profile"}) ${grade.verdict}: ` +
    `counted error ${num(grade.counted_error)} over n=${grade.counted_n}, ` +
    `baseline ${num(grade.baseline_error)}, dev ${num(grade.dev_error)}, ` +
    `spec ${shortSpecHash(grade.spec_hash)}`
  );
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
  opts: {
    readonly since?: string;
    readonly use?: string;
    readonly origin?: string;
    /** Attach the use's own report when `use` names one (default true). */
    readonly useReport?: boolean;
  } = {},
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
  const summary: DecisionModelReport = { since: opts.since ?? null, total: records.length, uses };
  // The eval section is built for every report: `o2b decision-model
  // report` is the audit surface for the grades a mark was written from.
  const { grades, skipped } = listDecisionModelEvalGrades(vault, opts.since);
  const evalSection =
    grades.length > 0 || skipped.length > 0
      ? {
          grades: grades.map((g): DecisionEvalGradeLine => ({
            record_id: g.recordId,
            created_at: g.createdAt,
            use: g.use,
            profile: g.profile,
            verdict: g.verdict,
            spec_hash: g.specHash,
            counted_n: g.countedN,
            counted_error: g.countedError,
            baseline_error: g.baselineError,
            dev_error: g.devError,
          })),
          skipped,
        }
      : undefined;
  if (opts.use === undefined || opts.useReport === false || !isDecisionModelUse(opts.use)) {
    return evalSection === undefined ? summary : { ...summary, eval: evalSection };
  }
  const entry = USE_REPORTS[opts.use];
  if (entry === null) {
    return evalSection === undefined ? summary : { ...summary, eval: evalSection };
  }
  const since = opts.since !== undefined ? { since: opts.since } : {};
  return {
    ...summary,
    ...(evalSection !== undefined ? { eval: evalSection } : {}),
    use_report: { use: opts.use, report: entry.build(vault, since) },
  };
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
  if (report.eval !== undefined) {
    lines.push(
      `decision model eval grades: ${report.eval.grades.length} record(s)` +
        (report.eval.skipped.length > 0 ? `, ${report.eval.skipped.length} skipped` : ""),
    );
    for (const grade of report.eval.grades) lines.push(`  ${renderEvalGradeLine(grade)}`);
    for (const note of report.eval.skipped) lines.push(`  skipped: ${note}`);
  }
  if (report.use_report !== undefined) {
    const entry = USE_REPORTS[report.use_report.use];
    if (entry !== null) lines.push(entry.render(report.use_report.report));
  }
  return lines.join("\n");
}

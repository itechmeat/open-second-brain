/**
 * Decision-model configuration: flat `decision_model_*` keys in the
 * operator's machine config (never the vault), each with an
 * `OPEN_SECOND_BRAIN_DECISION_MODEL_*` environment override.
 *
 * The feature is ACTIVE only when both of these hold at once:
 *   1. the operator explicitly set `decision_model_enabled: "true"`, and
 *   2. the environment variable named by `decision_model_env_key` (or the
 *      preset's default name) is set to a non-empty value. The one
 *      exception is a self-hosted server on a loopback host whose preset
 *      makes the key optional (`laya`, `openjev`): nothing
 *      leaves the machine, so no key is needed.
 * Everything else is off.
 *
 * Per-use modes are held to the provider's threshold profile
 * (`questions.ts`): an `enforce` setting on a use without tuned
 * thresholds for that profile runs as `shadow`, and only the diagnostics
 * say so. A missing key is a normal state rather than an
 * error: it is reported only by the explicit diagnostics
 * (`o2b decision-model check`, the doctor readiness line), and every other
 * surface behaves exactly as it does without the feature.
 *
 * The key itself is never stored. The resolved config carries only the
 * variable's NAME and whether it is set; the adapter reads the value at
 * call time.
 *
 * Resolution never throws. Invalid values are collected into `errors`
 * (each naming its key) and the status becomes `invalid`, which every hot
 * path treats as off and the diagnostics report with a non-zero exit.
 */

import { assertHttpEgressEndpoint } from "../search/embeddings/http-util.ts";
import { envOrConfig } from "../validate.ts";
import {
  DECISION_MODEL_USES,
  isDecisionModelMode,
  isDecisionModelUse,
  type DecisionModelMode,
  type DecisionModelUse,
} from "./contract.ts";
import {
  DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
  DECISION_MODEL_PRESET_NAMES,
  DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
  decisionModelPreset,
} from "./presets.ts";
import {
  DECISION_THRESHOLD_PROFILE_NAMES,
  isDecisionThresholdProfile,
  thresholdsTunedFor,
} from "./questions.ts";

export const DECISION_MODEL_DEFAULTS = Object.freeze({
  timeoutMs: 3000,
  hookBudgetMs: 700,
  dailyCostGateUsd: 0.5,
});

export type {
  DecisionModelStatus,
  DecisionModelUses,
  ResolvedDecisionModelConfig,
} from "./config-types.ts";
import type {
  DecisionModelStatus,
  DecisionModelUses,
  ResolvedDecisionModelConfig,
} from "./config-types.ts";

const ENV_PREFIX = "OPEN_SECOND_BRAIN_DECISION_MODEL_";

/**
 * What `decision_model_env_key` must look like: an environment variable
 * NAME (the same rule the secrets store applies). Anything else, such as a
 * key pasted where its variable's name belongs, is an invalid config, and
 * the value is never repeated in a message.
 */
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The base URL without any `user:password@` part, and whether it had one.
 * Credentials never belong in the URL (the key travels in a header), and
 * a URL that carries them is never printed as is.
 */
function withoutUserinfo(raw: string): { readonly url: string; readonly hadUserinfo: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw, hadUserinfo: false };
  }
  if (parsed.username === "" && parsed.password === "") return { url: raw, hadUserinfo: false };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString().replace(/\/+$/, ""), hadUserinfo: true };
}

/** Hosts where a self-hosted server runs on this machine. */
function isLoopbackUrl(raw: string | null): boolean {
  if (raw === null) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * The modes the uses actually run in: `enforce` becomes `shadow` for every
 * use whose thresholds are not tuned for `profile`.
 */
function holdToProfile(
  uses: DecisionModelUses,
  profile: string | null,
): { readonly uses: DecisionModelUses; readonly shadowOnly: ReadonlyArray<DecisionModelUse> } {
  const shadowOnly = DECISION_MODEL_USES.filter(
    (use) => uses[use] === "enforce" && !thresholdsTunedFor(profile, use),
  );
  if (shadowOnly.length === 0) return { uses, shadowOnly: Object.freeze([]) };
  const out: Record<DecisionModelUse, DecisionModelMode> = { ...uses };
  for (const use of shadowOnly) out[use] = "shadow";
  return { uses: Object.freeze(out), shadowOnly: Object.freeze(shadowOnly) };
}

function setting(
  env: NodeJS.ProcessEnv,
  config: Readonly<Record<string, string>>,
  suffix: string,
): string | null {
  const key = `decision_model_${suffix}`;
  return envOrConfig(env, config, `${ENV_PREFIX}${suffix.toUpperCase()}`, key);
}

const ALL_OFF: DecisionModelUses = Object.freeze(
  Object.fromEntries(DECISION_MODEL_USES.map((use) => [use, "off"])) as Record<
    DecisionModelUse,
    DecisionModelMode
  >,
);

/**
 * Parse `decision_model_uses` (`use:mode` comma list). Unknown uses or
 * modes are errors naming the key.
 */
export function parseDecisionModelUses(raw: string | null, errors: string[]): DecisionModelUses {
  if (raw === null || raw.trim() === "") return ALL_OFF;
  const out: Record<DecisionModelUse, DecisionModelMode> = { ...ALL_OFF };
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const sep = entry.indexOf(":");
    const use = (sep < 0 ? entry : entry.slice(0, sep)).trim();
    const mode = sep < 0 ? "" : entry.slice(sep + 1).trim();
    if (!isDecisionModelUse(use)) {
      errors.push(
        `decision_model_uses: unknown use '${use}' (expected one of ${DECISION_MODEL_USES.join(", ")})`,
      );
      continue;
    }
    if (!isDecisionModelMode(mode)) {
      errors.push(
        `decision_model_uses: use '${use}' needs a mode off, shadow or enforce, got '${mode}'`,
      );
      continue;
    }
    if (seen.has(use)) {
      errors.push(`decision_model_uses: use '${use}' is listed more than once`);
      continue;
    }
    seen.add(use);
    out[use] = mode;
  }
  return Object.freeze(out);
}

function parseBoolSetting(raw: string | null, key: string, errors: string[]): boolean {
  if (raw === null) return false;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  errors.push(`${key} must be 'true' or 'false', got '${raw}'`);
  return false;
}

function parseIntSetting(
  raw: string | null,
  fallback: number,
  key: string,
  errors: string[],
): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    errors.push(`${key} must be a positive integer, got '${raw}'`);
    return fallback;
  }
  return n;
}

function parseNonNegativeSetting(
  raw: string | null,
  fallback: number | null,
  key: string,
  errors: string[],
): number | null {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${key} must be a number >= 0, got '${raw}'`);
    return fallback;
  }
  return n;
}

export interface ResolveDecisionModelOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** The operator's flat machine config (already discovered and parsed). */
  readonly config: Readonly<Record<string, string>>;
  /** Vault whose `_brain.yaml` may opt out; null when there is none. */
  readonly vault: string | null;
  /**
   * Reads the vault opt-out. Injected so this module never imports the
   * whole policy loader at startup; defaults to the real loader.
   */
  readonly vaultOptOut?: (vault: string) => boolean;
}

function defaultVaultOptOut(vault: string): boolean {
  // Lazy: only reached when the feature is enabled AND a key is set.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const policy = require("../brain/policy.ts") as typeof import("../brain/policy.ts");
  try {
    return policy.decisionModelDisabledByVault(policy.loadBrainConfig(vault));
  } catch {
    // Absent config: no opt-out. Present but unreadable: the vault's wish
    // cannot be known, so the feature stays off for it (fail closed for
    // egress).
    return policy.brainConfigReadFailure(vault) !== null;
  }
}

/**
 * Resolve the decision-model configuration. Never throws; see the module
 * header for the status rules.
 */
export function resolveDecisionModelConfig(
  opts: ResolveDecisionModelOptions,
): ResolvedDecisionModelConfig {
  const env = opts.env ?? process.env;
  const config = opts.config;
  const notes: string[] = [];
  const errors: string[] = [];

  const enabledRaw = setting(env, config, "enabled");
  const enabled = enabledRaw === "true" || enabledRaw === "1";
  if (enabledRaw !== null && !enabled && enabledRaw !== "false" && enabledRaw !== "0") {
    notes.push(`decision_model_enabled '${enabledRaw}' is not 'true', so the feature is off`);
  }

  const providerRaw = setting(env, config, "provider");
  const preset = providerRaw !== null ? decisionModelPreset(providerRaw) : null;
  const explicitBaseUrl = setting(env, config, "base_url");
  const baseUrlRaw = explicitBaseUrl ?? preset?.baseUrl ?? null;
  const cleanedUrl = baseUrlRaw !== null ? withoutUserinfo(baseUrlRaw.replace(/\/+$/, "")) : null;
  const baseUrl = cleanedUrl?.url ?? null;
  const model = setting(env, config, "id") ?? preset?.model ?? null;
  const envKeyRaw = setting(env, config, "env_key") ?? preset?.envKey ?? null;
  const envKeyValid = envKeyRaw === null || ENV_VAR_NAME_RE.test(envKeyRaw);
  // An invalid name is never looked up and never reported back.
  const envKey = envKeyValid ? envKeyRaw : null;
  const keyValue = envKey !== null ? env[envKey] : undefined;
  const keyPresent = typeof keyValue === "string" && keyValue.trim() !== "";
  const configuredUses = parseDecisionModelUses(setting(env, config, "uses"), []);

  if (!enabled) {
    return Object.freeze({
      status: "disabled",
      errors: Object.freeze([]),
      notes: Object.freeze(notes),
      enabled: false,
      provider: providerRaw,
      adapter: preset?.adapter ?? "systemone",
      baseUrl,
      model,
      envKey,
      keyPresent,
      keyRequired: true,
      allowInsecureHttp: false,
      timeoutMs: DECISION_MODEL_DEFAULTS.timeoutMs,
      hookBudgetMs: DECISION_MODEL_DEFAULTS.hookBudgetMs,
      maxStateTokens:
        preset?.defaultStateTokens ??
        preset?.maxStateTokens ??
        DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
      maxChoiceOptions: preset?.maxChoiceOptions ?? DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
      uses: ALL_OFF,
      configuredUses,
      dailyCostGateUsd: DECISION_MODEL_DEFAULTS.dailyCostGateUsd,
      inputPriceUsdPerMtok: preset?.inputPriceUsdPerMtok ?? null,
      outputPriceUsdPerMtok: null,
      allowUncalibrated: false,
      calibrated: preset?.calibrated ?? true,
      thresholdProfile: preset?.thresholdProfile ?? null,
      shadowOnlyUses: Object.freeze([]),
      licenceNote: preset?.licenceNote ?? null,
      processor: preset?.processor ?? null,
      vault: opts.vault,
    });
  }

  if (providerRaw === null) {
    errors.push(
      `decision_model_provider is required when decision_model_enabled is true ` +
        `(one of ${DECISION_MODEL_PRESET_NAMES.join(", ")})`,
    );
  } else if (preset === null) {
    errors.push(
      `decision_model_provider must be one of ${DECISION_MODEL_PRESET_NAMES.join(", ")}, ` +
        `got '${providerRaw}'`,
    );
  }
  if (preset !== null && baseUrl === null) {
    errors.push(`decision_model_base_url is required for provider '${preset.name}'`);
  }
  if (preset !== null && model === null) {
    errors.push(`decision_model_id is required for provider '${preset.name}'`);
  }
  if (model !== null && /(^|[-/])latest$/i.test(model)) {
    errors.push(`decision_model_id must pin a model version, not a moving alias ('${model}')`);
  }

  if (!envKeyValid) {
    errors.push(
      "decision_model_env_key must be the NAME of an environment variable " +
        "(A-Z, 0-9 and _), not the key itself; the value is not shown",
    );
  }
  if (cleanedUrl?.hadUserinfo === true) {
    errors.push(
      "decision_model_base_url must not carry user:password@ credentials; " +
        "the key is sent in a header from decision_model_env_key",
    );
  }

  const allowInsecureHttp = parseBoolSetting(
    setting(env, config, "allow_insecure_http"),
    "decision_model_allow_insecure_http",
    errors,
  );
  if (baseUrl !== null && cleanedUrl?.hadUserinfo !== true) {
    try {
      assertHttpEgressEndpoint(baseUrl, "decision_model_base_url", {
        allowInsecureHttp,
        key: "decision_model_allow_insecure_http",
      });
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  const timeoutMs = parseIntSetting(
    setting(env, config, "timeout_ms"),
    DECISION_MODEL_DEFAULTS.timeoutMs,
    "decision_model_timeout_ms",
    errors,
  );
  const hookBudgetMs = parseIntSetting(
    setting(env, config, "hook_budget_ms"),
    DECISION_MODEL_DEFAULTS.hookBudgetMs,
    "decision_model_hook_budget_ms",
    errors,
  );
  const presetMax = preset?.maxStateTokens ?? DECISION_MODEL_HOSTED_MAX_STATE_TOKENS;
  const maxStateRequested = parseIntSetting(
    setting(env, config, "max_state_tokens"),
    preset?.defaultStateTokens ?? presetMax,
    "decision_model_max_state_tokens",
    errors,
  );
  if (maxStateRequested > presetMax) {
    notes.push(
      `decision_model_max_state_tokens ${maxStateRequested} is above the preset maximum ` +
        `${presetMax}; clamped`,
    );
  }
  const maxStateTokens = Math.min(maxStateRequested, presetMax);
  const configured = parseDecisionModelUses(setting(env, config, "uses"), errors);
  const dailyCostGateUsd =
    parseNonNegativeSetting(
      setting(env, config, "cost_gate_usd"),
      DECISION_MODEL_DEFAULTS.dailyCostGateUsd,
      "decision_model_cost_gate_usd",
      errors,
    ) ?? DECISION_MODEL_DEFAULTS.dailyCostGateUsd;
  const inputPriceConfigured = parseNonNegativeSetting(
    setting(env, config, "input_price_usd_per_mtok"),
    preset?.inputPriceUsdPerMtok ?? null,
    "decision_model_input_price_usd_per_mtok",
    errors,
  );
  const outputPriceRaw = parseNonNegativeSetting(
    setting(env, config, "output_price_usd_per_mtok"),
    null,
    "decision_model_output_price_usd_per_mtok",
    errors,
  );
  const emulated = preset?.adapter === "llm-emulation";
  if (!emulated && outputPriceRaw !== null) {
    notes.push(
      "decision_model_output_price_usd_per_mtok is read only for provider 'llm-emulation'; " +
        "other routes do not bill output, so it is ignored",
    );
  }
  // A chat model bills output too: with either price unknown, so is the cost.
  const inputPriceUsdPerMtok =
    emulated && (inputPriceConfigured === null || outputPriceRaw === null)
      ? null
      : inputPriceConfigured;
  const outputPriceUsdPerMtok = emulated ? outputPriceRaw : null;
  if (emulated && inputPriceUsdPerMtok === null) {
    notes.push(
      "llm-emulation cost is unknown (cost_source: unknown) unless the route reports it or both " +
        "decision_model_input_price_usd_per_mtok and decision_model_output_price_usd_per_mtok are set",
    );
  }
  const allowUncalibrated = parseBoolSetting(
    setting(env, config, "allow_uncalibrated"),
    "decision_model_allow_uncalibrated",
    errors,
  );
  const calibrated = preset?.calibrated ?? true;
  if (!calibrated && !allowUncalibrated) {
    const enforced = DECISION_MODEL_USES.filter((use) => configured[use] === "enforce");
    if (enforced.length > 0) {
      errors.push(
        `decision_model_uses: enforce (${enforced.join(", ")}) needs a calibrated provider; ` +
          `set decision_model_allow_uncalibrated: true to allow provider '${providerRaw}'`,
      );
    }
  }

  // The threshold profile. Only a `compatible` server may name one, since
  // only the operator knows which model family it serves; every other
  // preset carries its own, and an uncalibrated route never borrows a
  // calibrated family's thresholds.
  const profileRaw = setting(env, config, "threshold_profile");
  let thresholdProfile = preset?.thresholdProfile ?? null;
  if (profileRaw !== null && profileRaw !== "") {
    if (!isDecisionThresholdProfile(profileRaw)) {
      errors.push(
        `decision_model_threshold_profile must be one of ` +
          `${DECISION_THRESHOLD_PROFILE_NAMES.join(", ")}, got '${profileRaw}'`,
      );
    } else if (preset?.name === "compatible") {
      thresholdProfile = profileRaw;
    } else if (profileRaw !== thresholdProfile) {
      notes.push(
        `decision_model_threshold_profile is read only for provider 'compatible'; ` +
          `provider '${providerRaw}' keeps its own profile (${thresholdProfile ?? "none"})`,
      );
    }
  }
  const held = holdToProfile(configured, thresholdProfile);
  const uses = held.uses;

  // A self-hosted server on this machine needs no key; anything that leaves
  // the machine does.
  const keyRequired = !(preset?.keyOptionalOnLoopback === true && isLoopbackUrl(baseUrl));

  let status: DecisionModelStatus;
  if (errors.length > 0) status = "invalid";
  else if (!keyPresent && keyRequired) status = "no_key";
  else if (opts.vault !== null && (opts.vaultOptOut ?? defaultVaultOptOut)(opts.vault)) {
    status = "disabled_by_vault";
  } else status = "active";

  return Object.freeze({
    status,
    errors: Object.freeze(errors),
    notes: Object.freeze(notes),
    enabled: true,
    provider: providerRaw,
    adapter: preset?.adapter ?? "systemone",
    baseUrl,
    model,
    envKey,
    keyPresent,
    keyRequired,
    allowInsecureHttp,
    timeoutMs,
    hookBudgetMs,
    maxStateTokens,
    maxChoiceOptions: preset?.maxChoiceOptions ?? DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    uses,
    configuredUses: configured,
    dailyCostGateUsd,
    inputPriceUsdPerMtok,
    outputPriceUsdPerMtok,
    allowUncalibrated,
    calibrated,
    thresholdProfile,
    shadowOnlyUses: held.shadowOnly,
    licenceNote: preset?.licenceNote ?? null,
    processor: preset?.processor ?? null,
    vault: opts.vault,
  });
}

/**
 * The mode a use runs in. Anything but an `active` configuration is `off`,
 * whatever `decision_model_uses` says.
 */
export function decisionModelModeFor(
  cfg: ResolvedDecisionModelConfig | null | undefined,
  use: DecisionModelUse,
): DecisionModelMode {
  if (cfg === null || cfg === undefined || cfg.status !== "active") return "off";
  return cfg.uses[use];
}

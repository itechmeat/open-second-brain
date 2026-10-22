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
import {
  SecretStoreKeyfileMissingError,
  SecretStoreLockedError,
} from "../brain/secrets/envelope.ts";
import { SecretReferenceError } from "../secret-ref.ts";
import { isSecretReferenceValue, resolveNamedSecret } from "../secret-resolver.ts";
import { envOrConfig } from "../validate.ts";
import {
  DECISION_MODEL_USES,
  isDecisionModelMode,
  isDecisionModelUse,
  type DecisionModelMode,
  type DecisionModelUse,
} from "./contract.ts";
import {
  DECISION_MODEL_CHAT_SHAPED_ADAPTERS,
  DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
  DECISION_MODEL_PRESET_NAMES,
  DECISION_MODEL_PRESETS,
  DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
  decisionModelPreset,
} from "./presets.ts";
import { machineTunedMarkReader } from "./eval/mark.ts";
import {
  DECISION_THRESHOLD_PROFILE_NAMES,
  isDecisionThresholdProfile,
  thresholdsTunedFor,
} from "./questions.ts";
import {
  decisionThresholdsPath,
  EMPTY_THRESHOLD_STORE,
  readThresholdsStore,
  storedThresholdEntry,
  type DecisionThresholdsStore,
} from "./thresholds.ts";

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
export type { ResolvedDecisionProvider } from "./config-types.ts";
import type {
  DecisionModelStatus,
  DecisionModelUses,
  ResolvedDecisionModelConfig,
  ResolvedDecisionProvider,
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
 * use the `tunedFor` gate refuses. The gate (see {@link entryTunedGate})
 * is the source table, the local thresholds store and the injected
 * measured reader (the machine-side tuning mark, `eval/mark.ts`) OR-ed
 * per use.
 */
function holdToProfile(
  uses: DecisionModelUses,
  tunedFor: (use: DecisionModelUse) => boolean,
): { readonly uses: DecisionModelUses; readonly shadowOnly: ReadonlyArray<DecisionModelUse> } {
  const shadowOnly = DECISION_MODEL_USES.filter((use) => uses[use] === "enforce" && !tunedFor(use));
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

/**
 * The key value for presence, with reference routing. A value written as
 * a `$secret:NAME` reference resolves through the custody store of
 * `secretsVault` (store first, env fallback); an unresolvable reference, a
 * store-held name under a locked envelope, or a store whose keyfile is
 * missing while entries survive lands in `errors` as the named refusal -
 * with the status turning `invalid` - never as a silent empty key.
 * Without a vault the value is taken as-is, exactly as before the routing
 * existed, and resolution still never throws.
 */
function resolveKeyValue(
  raw: string | undefined,
  secretsVault: string | null | undefined,
  errors: string[],
): string | undefined {
  if (typeof raw !== "string" || secretsVault === null || secretsVault === undefined) return raw;
  if (!isSecretReferenceValue(raw)) return raw;
  try {
    return resolveNamedSecret(secretsVault, raw.trim());
  } catch (err) {
    if (
      err instanceof SecretReferenceError ||
      err instanceof SecretStoreLockedError ||
      err instanceof SecretStoreKeyfileMissingError
    ) {
      errors.push(err.message);
      return undefined;
    }
    throw err;
  }
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
   * Vault whose custody store backs `$secret:` references in the key
   * value; absent, a reference-shaped key value is taken as-is, exactly
   * as before the resolver routing existed.
   */
  readonly secretsVault?: string | null;
  /**
   * Reads the vault opt-out. Injected so this module never imports the
   * whole policy loader at startup; defaults to the real loader.
   */
  readonly vaultOptOut?: (vault: string) => boolean;
  /**
   * The measured-tune reader: consulted only when the source table says
   * a use is untuned for the resolved profile. Undefined (the default)
   * reads the machine-side tuning marks under the platform state root -
   * one TTL-cached file read per untuned pair per minute; null disables
   * the measured path entirely, which is the behavior every hand-edit
   * test pins.
   */
  readonly measuredTunedMark?: ((profile: string | null, use: DecisionModelUse) => boolean) | null;
  /**
   * Where the local thresholds store (`decision-thresholds.json`,
   * `thresholds.ts`) lives. Undefined reads the file beside the default
   * config path - the production behavior; a path reads that file (the
   * CLI passes the `--config` sibling); null disables the store, which
   * is the behavior the hand-edit tests pin.
   */
  readonly thresholdsPath?: string | null;
}

/**
 * The thresholds store this resolution gates against, read lazily (only
 * an enforce hold that the table refuses consults it) and TTL-cached
 * inside the store module. `null` (the option set to null) disables the
 * store: the empty store tunes nothing.
 */
function thresholdsStoreFor(opts: ResolveDecisionModelOptions): DecisionThresholdsStore {
  if (opts.thresholdsPath === null) return EMPTY_THRESHOLD_STORE;
  if (opts.thresholdsPath !== undefined) return readThresholdsStore(opts.thresholdsPath);
  // The file beside the config path this process resolves: an explicit
  // OPEN_SECOND_BRAIN_CONFIG in the resolution's environment names it, as
  // it does for every other config read; otherwise the process's default
  // discovery (env, XDG, home) applies. Lazy, as in the policy require
  // above: core/config is a large module and only this store read needs
  // its discovery chain.
  const env = opts.env ?? process.env;
  const explicit = env["OPEN_SECOND_BRAIN_CONFIG"];
  const coreConfig = require("../config.ts") as typeof import("../config.ts");
  const configPath =
    typeof explicit === "string" && explicit !== "" ? explicit : coreConfig.defaultConfigPath();
  return readThresholdsStore(decisionThresholdsPath(configPath));
}

/**
 * The tuned gate for one chain entry: the source table (baseline or a
 * hand-registered list) OR the local store entry for THIS entry's model
 * id, keyed by the model the server reports - never the preset - OR the
 * measured mark. The store is consulted only when the table refuses, so
 * a baseline model pays no store read.
 */
function entryTunedGate(
  store: DecisionThresholdsStore,
  profile: string | null,
  model: string | null,
  vault: string | null,
  measuredTuned: ((use: DecisionModelUse) => boolean) | null,
): (use: DecisionModelUse) => boolean {
  return (use) =>
    thresholdsTunedFor(profile, use, measuredTuned === null ? null : () => measuredTuned(use)) ||
    storedThresholdEntry(store, model, use, vault) !== null;
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

  // The ordered provider chain (`decision_model_providers`, issue #264).
  // `decision_model_provider` stays the one-element form; when both are
  // set the list wins and a note says so. Parsing collects errors naming
  // the key; the list is only non-empty when every entry parsed.
  const providersRaw = setting(env, config, "providers");
  const providerRaw = setting(env, config, "provider");
  const chainNames: string[] = [];
  if (providersRaw !== null) {
    const seen = new Set<string>();
    for (const part of providersRaw.split(",")) {
      const name = part.trim();
      if (name === "") continue;
      if (!Object.hasOwn(DECISION_MODEL_PRESETS, name)) {
        errors.push(
          `decision_model_providers must be one of ${DECISION_MODEL_PRESET_NAMES.join(", ")}, ` +
            `got '${name}'`,
        );
      } else if (seen.has(name)) {
        errors.push(`decision_model_providers: provider '${name}' is listed more than once`);
      } else {
        seen.add(name);
        chainNames.push(name);
      }
    }
    if (chainNames.length === 0) {
      errors.push(
        `decision_model_providers must name at least one provider preset ` +
          `(one of ${DECISION_MODEL_PRESET_NAMES.join(", ")})`,
      );
    }
    if (providerRaw !== null && providerRaw !== (chainNames[0] ?? null)) {
      notes.push(
        `decision_model_provider '${providerRaw}' is ignored while decision_model_providers ` +
          "is set; the list decides the order",
      );
    }
  }
  const primaryName = chainNames[0] ?? providerRaw;

  // Per-entry endpoint overrides (`decision_model_providers_<preset>
  // _base_url|_id|_env_key`): any entry can name its own endpoint, so a
  // preset without one (compatible) can sit anywhere in the chain and a
  // preset with a default (typesafe, laya) can be pointed elsewhere.
  // Config only: the chain is a deployment fact, so these keys have no
  // environment override.
  const entryOverride = (name: string, suffix: string): string | null => {
    const value = config[`decision_model_providers_${name}_${suffix}`];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const primaryBaseOverride = primaryName !== null ? entryOverride(primaryName, "base_url") : null;
  const primaryIdOverride = primaryName !== null ? entryOverride(primaryName, "id") : null;
  const primaryEnvOverride = primaryName !== null ? entryOverride(primaryName, "env_key") : null;

  const preset = primaryName !== null ? decisionModelPreset(primaryName) : null;
  const explicitBaseUrl = primaryBaseOverride ?? setting(env, config, "base_url");
  const baseUrlRaw = explicitBaseUrl ?? preset?.baseUrl ?? null;
  const cleanedUrl = baseUrlRaw !== null ? withoutUserinfo(baseUrlRaw.replace(/\/+$/, "")) : null;
  const baseUrl = cleanedUrl?.url ?? null;
  const model = primaryIdOverride ?? setting(env, config, "id") ?? preset?.model ?? null;
  const envKeyRaw = primaryEnvOverride ?? setting(env, config, "env_key") ?? preset?.envKey ?? null;
  const envKeyValid = envKeyRaw === null || ENV_VAR_NAME_RE.test(envKeyRaw);
  // An invalid name is never looked up and never reported back.
  const envKey = envKeyValid ? envKeyRaw : null;
  const keyValue = resolveKeyValue(
    envKey !== null ? env[envKey] : undefined,
    opts.secretsVault,
    errors,
  );
  const keyPresent = typeof keyValue === "string" && keyValue.trim() !== "";
  const configuredUses = parseDecisionModelUses(setting(env, config, "uses"), []);

  if (!enabled) {
    return Object.freeze({
      status: "disabled",
      errors: Object.freeze([]),
      notes: Object.freeze(notes),
      enabled: false,
      provider: primaryName,
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

  if (providersRaw === null) {
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
  }
  // The first entry's endpoint keys: the single form's messages stay
  // byte-identical; the list form names the per-entry key beside the
  // global one, since both configure this entry.
  if (preset !== null && baseUrl === null) {
    if (providersRaw === null) {
      errors.push(`decision_model_base_url is required for provider '${preset.name}'`);
    } else {
      errors.push(
        `decision_model_providers: provider '${preset.name}' needs an endpoint: set ` +
          `decision_model_providers_${preset.name}_base_url (or decision_model_base_url, ` +
          "which the first provider reads)",
      );
    }
  }
  if (preset !== null && model === null) {
    if (providersRaw === null) {
      errors.push(`decision_model_id is required for provider '${preset.name}'`);
    } else {
      errors.push(
        `decision_model_providers: provider '${preset.name}' needs a pinned model: set ` +
          `decision_model_providers_${preset.name}_id (or decision_model_id, which the ` +
          "first provider reads)",
      );
    }
  }
  if (model !== null && /(^|[-/])latest$/i.test(model)) {
    errors.push(`decision_model_id must pin a model version, not a moving alias ('${model}')`);
  }

  if (!envKeyValid) {
    const perEntryKey =
      primaryName !== null &&
      primaryEnvOverride !== null &&
      !ENV_VAR_NAME_RE.test(primaryEnvOverride)
        ? `decision_model_providers_${primaryName}_env_key`
        : null;
    errors.push(
      (perEntryKey ?? "decision_model_env_key") +
        " must be the NAME of an environment variable " +
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
  // A chat-shaped route (DECISION_MODEL_CHAT_SHAPED_ADAPTERS, derived from
  // the preset table) asks a generative model to write the answer as text,
  // so the request bills output tokens like input ones; any other route's
  // published price covers the reply.
  const chatShaped =
    preset !== null && DECISION_MODEL_CHAT_SHAPED_ADAPTERS.includes(preset.adapter);
  if (!chatShaped && outputPriceRaw !== null) {
    notes.push(
      "decision_model_output_price_usd_per_mtok is read only for chat-shaped routes, where a " +
        "generative model bills output; other routes do not bill output, so it is ignored",
    );
  }
  // A chat model bills output too: with either price unknown, so is the cost.
  const inputPriceUsdPerMtok =
    chatShaped && (inputPriceConfigured === null || outputPriceRaw === null)
      ? null
      : inputPriceConfigured;
  const outputPriceUsdPerMtok = chatShaped ? outputPriceRaw : null;
  if (chatShaped && inputPriceUsdPerMtok === null) {
    notes.push(
      "this chat-shaped route's cost is unknown (cost_source: unknown) unless the route reports " +
        "it or both decision_model_input_price_usd_per_mtok and " +
        "decision_model_output_price_usd_per_mtok are set",
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
          `set decision_model_allow_uncalibrated: true to allow provider '${primaryName}'`,
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
          `provider '${primaryName}' keeps its own profile (${thresholdProfile ?? "none"})`,
      );
    }
  }
  // The measured-mark reader bound to one entry's endpoint. Disabled
  // reader (null): the table alone decides. Default (undefined): the
  // machine-side marks, TTL-cached inside the mark module, bound to THIS
  // entry's endpoint - a mark earned by another provider, model or base
  // URL never arms enforce here.
  const markReaderFor = (
    endpoint: {
      readonly provider: string | null;
      readonly model: string | null;
      readonly baseUrl: string | null;
    },
    profile: string | null,
  ): ((use: DecisionModelUse) => boolean) | null => {
    if (profile === null) return null;
    return (use) => {
      if (opts.measuredTunedMark === null) return false;
      const reader = opts.measuredTunedMark ?? machineTunedMarkReader(endpoint);
      return reader(profile, use);
    };
  };

  // The store is read only when a use is configured enforce: shadow and
  // off installs pay no file read at all.
  const needsGate = DECISION_MODEL_USES.some((use) => configured[use] === "enforce");
  let storeCache: DecisionThresholdsStore | null = null;
  const store = (): DecisionThresholdsStore => {
    if (storeCache === null) storeCache = thresholdsStoreFor(opts);
    return storeCache;
  };
  const held = holdToProfile(
    configured,
    needsGate
      ? entryTunedGate(
          store(),
          thresholdProfile,
          model,
          opts.vault,
          markReaderFor({ provider: primaryName, model, baseUrl }, thresholdProfile),
        )
      : () => true,
  );
  const uses = held.uses;

  // A self-hosted server on this machine needs no key; anything that leaves
  // the machine does.
  const keyRequired = !(preset?.keyOptionalOnLoopback === true && isLoopbackUrl(baseUrl));

  // The first chain entry, as resolved above from the preset plus the
  // endpoint override keys. Its fields mirror the config's top level, so
  // every reader written for the single-provider era keeps working.
  const firstEntry: ResolvedDecisionProvider = {
    name: primaryName ?? "unknown",
    adapter: preset?.adapter ?? "systemone",
    baseUrl,
    model,
    envKey,
    keyPresent,
    keyRequired,
    maxStateTokens,
    maxChoiceOptions: preset?.maxChoiceOptions ?? DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    calibrated,
    inputPriceUsdPerMtok,
    outputPriceUsdPerMtok: outputPriceUsdPerMtok ?? null,
    thresholdProfile,
    licenceNote: preset?.licenceNote ?? null,
    processor: preset?.processor ?? null,
    uses,
    shadowOnlyUses: held.shadowOnly,
  };

  // Entries after the first resolve like the first one, minus the global
  // endpoint keys: preset defaults, overridden per entry by
  // `decision_model_providers_<preset>_*`. An entry that cannot resolve
  // an endpoint is a config error naming its key - a silently skipped
  // fallback would hide the typo.
  const laterEntries: ResolvedDecisionProvider[] = [];
  for (const [index, name] of chainNames.entries()) {
    if (index === 0) continue;
    const laterPreset = DECISION_MODEL_PRESETS[name];
    if (laterPreset === undefined) continue;
    const laterUrlRaw = entryOverride(name, "base_url") ?? laterPreset.baseUrl;
    const laterModel = entryOverride(name, "id") ?? laterPreset.model;
    const laterEnvKeyRaw = entryOverride(name, "env_key") ?? laterPreset.envKey;
    if (laterUrlRaw === null) {
      errors.push(
        `decision_model_providers: provider '${name}' needs an endpoint: set ` +
          `decision_model_providers_${name}_base_url (its preset carries none)`,
      );
      continue;
    }
    if (laterModel === null) {
      errors.push(
        `decision_model_providers: provider '${name}' needs a pinned model: set ` +
          `decision_model_providers_${name}_id`,
      );
      continue;
    }
    if (/(^|[-/])latest$/i.test(laterModel)) {
      errors.push(
        `decision_model_providers_${name}_id must pin a model version, ` +
          `not a moving alias ('${laterModel}')`,
      );
      continue;
    }
    const laterEnvKeyValid = laterEnvKeyRaw === null || ENV_VAR_NAME_RE.test(laterEnvKeyRaw);
    if (!laterEnvKeyValid) {
      errors.push(
        `decision_model_providers_${name}_env_key must be the NAME of an environment ` +
          "variable (A-Z, 0-9 and _), not the key itself; the value is not shown",
      );
      continue;
    }
    const laterCleaned = withoutUserinfo(laterUrlRaw.replace(/\/+$/, ""));
    if (laterCleaned.hadUserinfo) {
      errors.push(
        `decision_model_providers_${name}_base_url must not carry user:password@ ` +
          "credentials; the key is sent in a header from its env_key",
      );
      continue;
    }
    try {
      assertHttpEgressEndpoint(laterCleaned.url, `decision_model_providers_${name}_base_url`, {
        allowInsecureHttp,
        key: "decision_model_allow_insecure_http",
      });
    } catch (err) {
      errors.push((err as Error).message);
      continue;
    }
    const laterKeyValue = resolveKeyValue(
      laterEnvKeyRaw !== null ? env[laterEnvKeyRaw] : undefined,
      opts.secretsVault,
      errors,
    );
    const laterKeyPresent = typeof laterKeyValue === "string" && laterKeyValue.trim() !== "";
    const laterKeyRequired = !(
      laterPreset.keyOptionalOnLoopback === true && isLoopbackUrl(laterCleaned.url)
    );
    const laterHeld = holdToProfile(
      configured,
      entryTunedGate(
        store(),
        laterPreset.thresholdProfile,
        laterModel,
        opts.vault,
        markReaderFor(
          { provider: laterPreset.name, model: laterModel, baseUrl: laterCleaned.url },
          laterPreset.thresholdProfile,
        ),
      ),
    );
    laterEntries.push({
      name: laterPreset.name,
      adapter: laterPreset.adapter,
      baseUrl: laterCleaned.url,
      model: laterModel,
      envKey: laterEnvKeyValid ? laterEnvKeyRaw : null,
      keyPresent: laterKeyPresent,
      keyRequired: laterKeyRequired,
      maxStateTokens: laterPreset.defaultStateTokens ?? laterPreset.maxStateTokens,
      maxChoiceOptions: laterPreset.maxChoiceOptions,
      calibrated: laterPreset.calibrated,
      inputPriceUsdPerMtok: laterPreset.inputPriceUsdPerMtok,
      outputPriceUsdPerMtok: null,
      thresholdProfile: laterPreset.thresholdProfile,
      licenceNote: laterPreset.licenceNote,
      processor: laterPreset.processor,
      uses: laterHeld.uses,
      shadowOnlyUses: laterHeld.shadowOnly,
    });
  }

  const providers = Object.freeze([firstEntry, ...laterEntries]);
  // An entry without its key is not configured: it is skipped at call
  // time, and the feature is only off when NO entry is configured.
  const anyConfigured = providers.some((p) => p.keyPresent || !p.keyRequired);
  if (anyConfigured) {
    for (const p of providers) {
      if (!p.keyPresent && p.keyRequired) {
        notes.push(
          `decision_model_providers: provider '${p.name}' has no key in ` +
            `${p.envKey ?? "its key variable"}; it is skipped until the variable is set`,
        );
      }
    }
  }

  let status: DecisionModelStatus;
  if (errors.length > 0) status = "invalid";
  else if (!anyConfigured) status = "no_key";
  else if (opts.vault !== null && (opts.vaultOptOut ?? defaultVaultOptOut)(opts.vault)) {
    status = "disabled_by_vault";
  } else status = "active";

  return Object.freeze({
    status,
    errors: Object.freeze(errors),
    notes: Object.freeze(notes),
    enabled: true,
    provider: primaryName,
    providers,
    adapter: firstEntry.adapter,
    baseUrl,
    model,
    envKey,
    keyPresent,
    keyRequired,
    allowInsecureHttp,
    timeoutMs,
    hookBudgetMs,
    maxStateTokens,
    maxChoiceOptions: firstEntry.maxChoiceOptions,
    uses,
    configuredUses: configured,
    dailyCostGateUsd,
    inputPriceUsdPerMtok,
    outputPriceUsdPerMtok,
    allowUncalibrated,
    calibrated,
    thresholdProfile,
    shadowOnlyUses: held.shadowOnly,
    licenceNote: firstEntry.licenceNote,
    processor: firstEntry.processor,
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

/**
 * The provider chain of a resolved config, first entry first. A config
 * resolved from `decision_model_providers` carries its entries; a config
 * built before the chain existed (hand-built test configs, older stored
 * objects) derives the single implied entry from its top-level fields, so
 * the callers of the chain behave identically on both shapes.
 */
export function resolvedProviderEntries(
  cfg: ResolvedDecisionModelConfig,
): ReadonlyArray<ResolvedDecisionProvider> {
  if (cfg.providers !== undefined && cfg.providers.length > 0) return cfg.providers;
  return Object.freeze([
    {
      name: cfg.provider ?? "unknown",
      adapter: cfg.adapter,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      envKey: cfg.envKey,
      keyPresent: cfg.keyPresent,
      keyRequired: cfg.keyRequired !== false,
      maxStateTokens: cfg.maxStateTokens,
      maxChoiceOptions: cfg.maxChoiceOptions ?? DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
      calibrated: cfg.calibrated,
      inputPriceUsdPerMtok: cfg.inputPriceUsdPerMtok,
      outputPriceUsdPerMtok: cfg.outputPriceUsdPerMtok ?? null,
      thresholdProfile: cfg.thresholdProfile ?? null,
      licenceNote: cfg.licenceNote ?? null,
      processor: cfg.processor,
      uses: cfg.uses,
      shadowOnlyUses: cfg.shadowOnlyUses ?? Object.freeze([]),
    },
  ]);
}

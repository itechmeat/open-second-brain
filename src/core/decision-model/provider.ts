/**
 * Decision-provider factory.
 *
 * Returns `null` unless the configuration is `active` (explicitly enabled
 * AND the named key variable set, or a keyless loopback server, AND not
 * opted out by the vault). Adapters are required lazily, as in
 * `search/rerank/provider.ts`, so a process that never enables the
 * feature never loads an HTTP adapter.
 *
 * The adapter is the one the configured preset names. With an ordered
 * chain (`decision_model_providers`) every entry is built from its own
 * resolved fields; the run (`run.ts`) owns the order and the fallback,
 * and `llm-emulation` in particular is never a fallback picked here.
 *
 * The key is read here, from the environment, at call time. It is handed
 * to the adapter instance and never stored in any config object. When the
 * caller passes `secretsVault`, a key value written as a `$secret:NAME`
 * reference resolves through that vault's custody store at this use site
 * (store first, env fallback) - the config resolver only probes the
 * reference for presence, so the factory must resolve the value it
 * actually sends. Without a vault, or with a plain value, the raw value
 * is taken exactly as before. An unresolvable reference or a store-held
 * name under a locked envelope raises the named resolver error rather
 * than silently reading as no key (the same refusal `research.ts` makes).
 */

import { resolveNamedSecret } from "../secret-resolver.ts";
import type { DecisionProvider } from "./contract.ts";
import { resolvedProviderEntries, type ResolvedDecisionModelConfig } from "./config.ts";
import type { ResolvedDecisionProvider } from "./config-types.ts";

/**
 * The transport settings shared by every entry of a chain: the network
 * trust statement and the request budget are properties of the
 * installation, not of one route.
 */
export interface EntryTransportSettings {
  readonly allowInsecureHttp: boolean;
  readonly timeoutMs: number;
}

/**
 * Build one chain entry's adapter, or null when the entry is not
 * configured (no endpoint, or a required key missing). Never consults
 * any other entry: the fallback order is the caller's decision.
 */
export function makeEntryDecisionProvider(
  entry: ResolvedDecisionProvider,
  shared: EntryTransportSettings,
  env: Readonly<Record<string, string | undefined>> = process.env,
  secretsVault?: string | null,
): DecisionProvider | null {
  if (entry.baseUrl === null || entry.model === null) return null;
  const raw = entry.envKey !== null ? env[entry.envKey] : undefined;
  // Reference-shaped values resolve through the custody store; `null`
  // (no vault) and plain values pass through untouched, byte-identical
  // to the pre-routing factory.
  const keyValue =
    secretsVault !== undefined && secretsVault !== null && typeof raw === "string"
      ? resolveNamedSecret(secretsVault, raw.trim())
      : raw;
  const apiKey = typeof keyValue === "string" && keyValue.trim() !== "" ? keyValue.trim() : null;
  // Only a loopback server whose preset allows it runs without a key.
  if (apiKey === null && entry.keyRequired !== false) return null;
  const common = {
    name: entry.name,
    baseUrl: entry.baseUrl,
    model: entry.model,
    envKey: entry.envKey,
    allowInsecureHttp: shared.allowInsecureHttp,
    timeoutMs: shared.timeoutMs,
    ...(entry.maxChoiceOptions !== undefined ? { maxChoiceOptions: entry.maxChoiceOptions } : {}),
  };
  try {
    switch (entry.adapter) {
      case "llm-emulation": {
        if (apiKey === null) return null;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { LlmEmulationDecisionProvider } =
          require("./llm-emulation.ts") as typeof import("./llm-emulation.ts");
        return new LlmEmulationDecisionProvider({ ...common, apiKey });
      }
      case "vercel-evaluate": {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { VercelEvaluateDecisionProvider } =
          require("./vercel-evaluate.ts") as typeof import("./vercel-evaluate.ts");
        return new VercelEvaluateDecisionProvider({
          ...common,
          apiKey,
          calibrated: entry.calibrated,
        });
      }
      case "systemone": {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SystemOneDecisionProvider } =
          require("./systemone.ts") as typeof import("./systemone.ts");
        return new SystemOneDecisionProvider({ ...common, apiKey, calibrated: entry.calibrated });
      }
      case "converse": {
        if (apiKey === null) return null;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ConverseDecisionProvider } =
          require("./converse.ts") as typeof import("./converse.ts");
        return new ConverseDecisionProvider({ ...common, apiKey, calibrated: entry.calibrated });
      }
    }
  } catch {
    // An endpoint the adapter refuses: treated as not configured. The
    // resolver already validated it, so this is a safety net only.
    return null;
  }
}

/**
 * The first chain entry's adapter, the shape every pre-chain caller used.
 * Kept as its own export because the diagnostics and single-provider use
 * sites read exactly one entry; the run builds the whole chain.
 */
export function makeDecisionProvider(
  cfg: ResolvedDecisionModelConfig | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  secretsVault?: string | null,
): DecisionProvider | null {
  if (cfg === null || cfg === undefined || cfg.status !== "active") return null;
  const entries = resolvedProviderEntries(cfg);
  const first = entries[0];
  if (first === undefined) return null;
  return makeEntryDecisionProvider(
    first,
    { allowInsecureHttp: cfg.allowInsecureHttp, timeoutMs: cfg.timeoutMs },
    env,
    secretsVault,
  );
}

/**
 * The resolved decision-model config shape, split out from `config.ts` so
 * modules that only name the type (the search config) do not import the
 * resolver and its endpoint validation.
 */

import type { DecisionCallOrigin, DecisionModelMode, DecisionModelUse } from "./contract.ts";

/**
 * Why the feature is (not) active. Only `active` ever builds a state or
 * sends a request.
 */
export type DecisionModelStatus =
  /** `decision_model_enabled` is not "true" (the default). */
  | "disabled"
  /** Enabled, but the named env var is unset or empty. */
  | "no_key"
  /** Enabled with a key, but this vault's `_brain.yaml` opted out. */
  | "disabled_by_vault"
  /** Enabled, but a value is invalid; `errors` names each key. */
  | "invalid"
  | "active";

export type DecisionModelUses = Readonly<Record<DecisionModelUse, DecisionModelMode>>;

export interface ResolvedDecisionModelConfig {
  readonly status: DecisionModelStatus;
  /** Config errors, each naming its key. Non-empty only when `invalid`. */
  readonly errors: ReadonlyArray<string>;
  /** Advisory notes for the diagnostics (never printed by hot paths). */
  readonly notes: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly adapter: "systemone";
  readonly baseUrl: string | null;
  readonly model: string | null;
  /** NAME of the env var holding the key; never the key. */
  readonly envKey: string | null;
  readonly keyPresent: boolean;
  readonly allowInsecureHttp: boolean;
  readonly timeoutMs: number;
  readonly hookBudgetMs: number;
  readonly maxStateTokens: number;
  readonly uses: DecisionModelUses;
  /**
   * The uses as configured, whatever the status. Diagnostics only: shows
   * what would run once the feature is active. Never consulted by a use.
   */
  readonly configuredUses: DecisionModelUses;
  readonly dailyCostGateUsd: number;
  /** USD per million input tokens for routes that report no cost; null when unknown. */
  readonly inputPriceUsdPerMtok: number | null;
  readonly allowUncalibrated: boolean;
  readonly calibrated: boolean;
  /** Who processes the data, for the diagnostics. */
  readonly processor: string | null;
  /** The vault whose `_brain.yaml` was consulted and where records go; null when none. */
  readonly vault: string | null;
  /**
   * Set by a caller that runs requests outside an ordinary use (the rerank
   * eval gate); stamped on each record. Never set by the resolver.
   */
  readonly recordOrigin?: DecisionCallOrigin;
}

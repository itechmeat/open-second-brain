/**
 * Decision-provider factory.
 *
 * Returns `null` unless the configuration is `active` (explicitly enabled
 * AND the named key variable set AND not opted out by the vault). Adapters
 * are required lazily, as in `search/rerank/provider.ts`, so a process that
 * never enables the feature never loads the HTTP adapter.
 *
 * The key is read here, from the environment, at call time. It is handed
 * to the adapter instance and never stored in any config object.
 */

import type { DecisionProvider } from "./contract.ts";
import type { ResolvedDecisionModelConfig } from "./config.ts";

export function makeDecisionProvider(
  cfg: ResolvedDecisionModelConfig | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DecisionProvider | null {
  if (cfg === null || cfg === undefined || cfg.status !== "active") return null;
  if (cfg.baseUrl === null || cfg.model === null || cfg.envKey === null) return null;
  const apiKey = env[cfg.envKey];
  if (typeof apiKey !== "string" || apiKey.trim() === "") return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SystemOneDecisionProvider } =
    require("./systemone.ts") as typeof import("./systemone.ts");
  return new SystemOneDecisionProvider({
    name: cfg.provider ?? "systemone",
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    envKey: cfg.envKey,
    apiKey: apiKey.trim(),
    allowInsecureHttp: cfg.allowInsecureHttp,
    calibrated: cfg.calibrated,
    timeoutMs: cfg.timeoutMs,
  });
}

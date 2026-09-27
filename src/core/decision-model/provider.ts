/**
 * Decision-provider factory.
 *
 * Returns `null` unless the configuration is `active` (explicitly enabled
 * AND the named key variable set, or a keyless loopback server, AND not
 * opted out by the vault). Adapters are required lazily, as in
 * `search/rerank/provider.ts`, so a process that never enables the
 * feature never loads an HTTP adapter.
 *
 * The adapter is the one the configured preset names; nothing here picks
 * another one, and `llm-emulation` in particular is never a fallback.
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
  if (cfg.baseUrl === null || cfg.model === null) return null;
  const raw = cfg.envKey !== null ? env[cfg.envKey] : undefined;
  const apiKey = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  // Only a loopback server whose preset allows it runs without a key.
  if (apiKey === null && cfg.keyRequired !== false) return null;
  const common = {
    name: cfg.provider ?? cfg.adapter,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    envKey: cfg.envKey,
    allowInsecureHttp: cfg.allowInsecureHttp,
    timeoutMs: cfg.timeoutMs,
    ...(cfg.maxChoiceOptions !== undefined ? { maxChoiceOptions: cfg.maxChoiceOptions } : {}),
  };
  try {
    switch (cfg.adapter) {
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
          calibrated: cfg.calibrated,
        });
      }
      case "systemone": {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SystemOneDecisionProvider } =
          require("./systemone.ts") as typeof import("./systemone.ts");
        return new SystemOneDecisionProvider({ ...common, apiKey, calibrated: cfg.calibrated });
      }
    }
  } catch {
    // An endpoint the adapter refuses: treated as not configured. The
    // resolver already validated it, so this is a safety net only.
    return null;
  }
}

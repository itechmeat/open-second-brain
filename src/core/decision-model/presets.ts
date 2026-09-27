/**
 * Decision-model provider presets.
 *
 * A preset names a route to a `POST <base>/v1/systemone` endpoint: its
 * base URL, the pinned model id (never a moving alias such as
 * `jev-latest`, whose answers would change under the operator on the
 * vendor's release day), the NAME of the environment variable that
 * conventionally holds its key, the largest state it accepts, and the
 * input price when one is published. Every field is overridable from the
 * operator's own config; nothing here is read from the vault.
 *
 * Prices are estimates for the daily cost gate only. A route that reports
 * `usage.cost` is charged at what it reports.
 */

/** Largest state (plus the longest question) the hosted routes accept, in tokens. */
export const DECISION_MODEL_HOSTED_MAX_STATE_TOKENS = 32_000;

export interface DecisionModelPreset {
  readonly name: string;
  /** Adapter that speaks this route's wire format. */
  readonly adapter: "systemone";
  /** Base URL without the `/v1/systemone` suffix; null when it must be configured. */
  readonly baseUrl: string | null;
  /** Pinned model id; null when it must be configured. */
  readonly model: string | null;
  /** Conventional env var NAME for the key; null when it must be configured. */
  readonly envKey: string | null;
  readonly maxStateTokens: number;
  /** Input price in USD per million tokens, when published. */
  readonly inputPriceUsdPerMtok: number | null;
  /** Whether the route's probabilities are calibrated. */
  readonly calibrated: boolean;
  /** Who processes the data, and what that processor states about retention. */
  readonly processor: string;
}

const HOSTED_PROCESSOR_TERMS =
  "not used for training; retention has no fixed period on standard accounts " +
  "(zero retention only by enterprise arrangement)";

export const DECISION_MODEL_PRESETS: Readonly<Record<string, DecisionModelPreset>> = Object.freeze({
  typesafe: {
    name: "typesafe",
    adapter: "systemone",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-1.13.0",
    envKey: "TYPESAFE_API_KEY",
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    processor: `TypeSafe (direct): ${HOSTED_PROCESSOR_TERMS}`,
  },
  openrouter: {
    name: "openrouter",
    adapter: "systemone",
    baseUrl: "https://openrouter.ai/api",
    model: "typesafe/jev-1.13",
    envKey: "OPENROUTER_API_KEY",
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    processor:
      `OpenRouter, forwarding to TypeSafe: the gateway's own logging policy applies ` +
      `in addition to TypeSafe's (${HOSTED_PROCESSOR_TERMS})`,
  },
  vercel: {
    name: "vercel",
    adapter: "systemone",
    baseUrl: "https://ai-gateway.vercel.sh/typesafe",
    model: "typesafe-ai/jev",
    envKey: "AI_GATEWAY_API_KEY",
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    processor:
      `Vercel AI Gateway, forwarding to TypeSafe: the gateway's own terms apply in ` +
      `addition to TypeSafe's (${HOSTED_PROCESSOR_TERMS})`,
  },
  "opencode-zen": {
    name: "opencode-zen",
    adapter: "systemone",
    baseUrl: "https://opencode.ai/zen",
    model: "jev-1.13",
    envKey: "OPENCODE_API_KEY",
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    processor:
      `OpenCode Zen, forwarding to TypeSafe: the gateway's own terms apply in ` +
      `addition to TypeSafe's (${HOSTED_PROCESSOR_TERMS})`,
  },
  compatible: {
    name: "compatible",
    adapter: "systemone",
    baseUrl: null,
    model: null,
    envKey: null,
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    inputPriceUsdPerMtok: null,
    calibrated: true,
    processor: "the compatible server at the configured base URL; its operator's terms apply",
  },
});

export const DECISION_MODEL_PRESET_NAMES: ReadonlyArray<string> = Object.freeze(
  Object.keys(DECISION_MODEL_PRESETS),
);

export function decisionModelPreset(name: string): DecisionModelPreset | null {
  return Object.hasOwn(DECISION_MODEL_PRESETS, name) ? DECISION_MODEL_PRESETS[name]! : null;
}

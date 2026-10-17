/**
 * Decision-model provider presets.
 *
 * A preset names a route to a decision endpoint and the adapter that
 * speaks it: its base URL, the pinned model id (never a moving alias such
 * as `jev-latest`, whose answers would change under the operator on the
 * vendor's release day), the NAME of the environment variable that
 * conventionally holds its key, the largest state and `choice` it
 * accepts, the input price when one is published, the threshold profile
 * its answers are held to, and the model licence for open weights. The
 * endpoint fields are overridable from the operator's own config; nothing
 * here is read from the vault.
 *
 * Self-hosted presets (`laya`, `openjev`) default to a loopback base URL,
 * where plain http is accepted and the key is optional: nothing leaves the
 * machine. Their limits follow each project's documentation at the time of
 * writing; set `decision_model_max_state_tokens` to the server's real
 * context.
 *
 * Prices are estimates for the daily cost gate only. A route that reports
 * `usage.cost` is charged at what it reports.
 */

/** Largest state (plus the longest question) the hosted routes accept, in tokens. */
export const DECISION_MODEL_HOSTED_MAX_STATE_TOKENS = 32_000;

/**
 * The adapters a preset can name. `systemone` speaks `POST <base>/v1/systemone`;
 * `vercel-evaluate` speaks the Vercel AI Gateway's renamed
 * `POST <base>/v1/evaluate` variant; `llm-emulation` asks an
 * OpenAI-compatible chat model for probabilities (uncalibrated, explicit
 * only); `converse` speaks a bearer-authenticated Converse-protocol
 * (Bedrock-style) gateway's `POST <base>/model/<model_id>/converse`, the
 * model named in the path.
 */
export type DecisionModelAdapter = "systemone" | "vercel-evaluate" | "llm-emulation" | "converse";

/** Most `choice` options the wire format accepts in one question. */
export const DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS = 255;

export interface DecisionModelPreset {
  readonly name: string;
  /** Adapter that speaks this route's wire format. */
  readonly adapter: DecisionModelAdapter;
  /** Base URL without the adapter's path suffix; null when it must be configured. */
  readonly baseUrl: string | null;
  /** Pinned model id; null when it must be configured. */
  readonly model: string | null;
  /** Conventional env var NAME for the key; null when it must be configured. */
  readonly envKey: string | null;
  /**
   * Largest state the route accepts, in tokens: the ceiling
   * `decision_model_max_state_tokens` is clamped to.
   */
  readonly maxStateTokens: number;
  /**
   * The state cap used when `decision_model_max_state_tokens` is not set;
   * defaults to {@link maxStateTokens}. Self-hosted servers default far
   * below their ceiling because their context depends on how they run.
   */
  readonly defaultStateTokens?: number;
  /** Most options one `choice` question may carry on this route. */
  readonly maxChoiceOptions: number;
  /**
   * Whether the key may be absent when the base URL is a loopback host (a
   * self-hosted server on this machine). A remote endpoint always needs one.
   */
  readonly keyOptionalOnLoopback: boolean;
  /** Input price in USD per million tokens, when published. */
  readonly inputPriceUsdPerMtok: number | null;
  /** Whether the route's probabilities are calibrated. */
  readonly calibrated: boolean;
  /**
   * The threshold profile (`questions.ts`) this route's answers are held
   * to; null when unknown, in which case no use enforces.
   */
  readonly thresholdProfile: string | null;
  /** The model licence, when the route serves open weights. */
  readonly licence: string | null;
  /** Printed by `check` when the model licence restricts commercial use. */
  readonly licenceNote: string | null;
  /** Who processes the data, and what that processor states about retention. */
  readonly processor: string;
}

/** The threshold profile of the hosted Jev 1.13 family. */
export const JEV_PROFILE = "jev-1.13";

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
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    keyOptionalOnLoopback: false,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    thresholdProfile: JEV_PROFILE,
    licence: null,
    licenceNote: null,
    processor: `TypeSafe (direct): ${HOSTED_PROCESSOR_TERMS}`,
  },
  openrouter: {
    name: "openrouter",
    adapter: "systemone",
    baseUrl: "https://openrouter.ai/api",
    model: "typesafe/jev-1.13",
    envKey: "OPENROUTER_API_KEY",
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    keyOptionalOnLoopback: false,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    thresholdProfile: JEV_PROFILE,
    licence: null,
    licenceNote: null,
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
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    keyOptionalOnLoopback: false,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    thresholdProfile: JEV_PROFILE,
    licence: null,
    licenceNote: null,
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
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    keyOptionalOnLoopback: false,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    thresholdProfile: JEV_PROFILE,
    licence: null,
    licenceNote: null,
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
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    // The base URL is the operator's to set and may point anywhere, so a
    // key variable stays required; the loopback presets below need none.
    keyOptionalOnLoopback: false,
    inputPriceUsdPerMtok: null,
    calibrated: true,
    // Unknown model: no use enforces unless decision_model_threshold_profile
    // names the family it serves.
    thresholdProfile: null,
    licence: null,
    licenceNote: null,
    processor: "the compatible server at the configured base URL; its operator's terms apply",
  },
  "vercel-evaluate": {
    name: "vercel-evaluate",
    adapter: "vercel-evaluate",
    baseUrl: "https://ai-gateway.vercel.sh",
    model: "typesafe-ai/jev",
    envKey: "AI_GATEWAY_API_KEY",
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    keyOptionalOnLoopback: false,
    inputPriceUsdPerMtok: 0.042,
    calibrated: true,
    thresholdProfile: JEV_PROFILE,
    licence: null,
    licenceNote: null,
    processor:
      `Vercel AI Gateway (/v1/evaluate), forwarding to TypeSafe: the gateway's own terms ` +
      `apply in addition to TypeSafe's (${HOSTED_PROCESSOR_TERMS})`,
  },
  laya: {
    name: "laya",
    adapter: "systemone",
    // laya-serve listens on port 8000 by default.
    baseUrl: "http://127.0.0.1:8000",
    // The English checkpoint; `multilingual` selects the multilingual one.
    model: "english",
    // laya-serve checks a bearer key only when started with LAYA_API_KEY.
    envKey: null,
    // The encoder accepts up to 8192 tokens when the server raises max_len;
    // its default window is far smaller and a longer state is truncated
    // silently, so the default stays small.
    maxStateTokens: 8192,
    defaultStateTokens: 2000,
    // laya-serve refuses more than 100 options per question (HTTP 413).
    maxChoiceOptions: 100,
    keyOptionalOnLoopback: true,
    inputPriceUsdPerMtok: 0,
    calibrated: true,
    thresholdProfile: "laya",
    licence: "Apache-2.0",
    licenceNote: null,
    processor:
      "a self-hosted Laya server at the configured base URL; on loopback nothing leaves the machine",
  },
  openjev: {
    name: "openjev",
    adapter: "systemone",
    // The OpenJev decision shim listens on port 3000 in its documentation.
    baseUrl: "http://127.0.0.1:3000",
    model: "openjev",
    envKey: null,
    // The documented serving setup allows 16384 tokens per prompt.
    maxStateTokens: 16_384,
    defaultStateTokens: 4000,
    // One pass scores at most 52 options.
    maxChoiceOptions: 52,
    keyOptionalOnLoopback: true,
    inputPriceUsdPerMtok: 0,
    calibrated: true,
    thresholdProfile: "openjev",
    licence: "CC-BY-NC-4.0",
    licenceNote:
      "the OpenJev weights are licensed CC-BY-NC-4.0: free for non-commercial use with " +
      "attribution; commercial use needs the licensor's permission",
    processor:
      "a self-hosted OpenJev server at the configured base URL; on loopback nothing leaves the machine",
  },
  "llm-emulation": {
    name: "llm-emulation",
    adapter: "llm-emulation",
    // An OpenAI-compatible base URL such as https://api.example.com/v1.
    baseUrl: null,
    model: null,
    envKey: null,
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    keyOptionalOnLoopback: false,
    inputPriceUsdPerMtok: null,
    // A generative model reports its own probabilities: not calibrated.
    calibrated: false,
    thresholdProfile: "llm-emulation",
    licence: null,
    licenceNote: null,
    processor:
      "the OpenAI-compatible chat endpoint at the configured base URL (a generative model); " +
      "its operator's terms apply",
  },
  // Calibration decision, recorded: a Converse gateway is chat-shaped -
  // the answers are generated text in which the model wrote its own
  // probabilities, exactly the grounds `llm-emulation` is declared
  // uncalibrated on - and nothing in the Converse protocol implies a
  // calibrated judgment model behind it, so the route is declared
  // uncalibrated too. The per-item answer rules are identical on every
  // route; `enforce` additionally needs
  // `decision_model_allow_uncalibrated`. The gateway is the operator's,
  // so the base URL, the pinned model id and the key variable are
  // configured, and the processor terms are the gateway operator's. The
  // answers are NOT the hosted Jev 1.13 family's, so the preset does not
  // borrow `jev-1.13`: it carries its own threshold profile, and nothing
  // enforces on it until it is tuned from this route's own shadow data -
  // an `enforce` setting runs as `shadow` until then.
  converse: {
    name: "converse",
    adapter: "converse",
    // The operator's bearer-authenticated gateway, such as
    // https://gateway.example.com; requests go to
    // <base>/model/<model_id>/converse, the model named in the path.
    baseUrl: null,
    model: null,
    envKey: null,
    maxStateTokens: DECISION_MODEL_HOSTED_MAX_STATE_TOKENS,
    maxChoiceOptions: DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
    // A Converse gateway is bearer-authenticated: the key variable is
    // required on every host, loopback included.
    keyOptionalOnLoopback: false,
    // The gateway's pricing is the operator's; a reported usage still feeds
    // the daily cost gate once a price is configured.
    inputPriceUsdPerMtok: null,
    calibrated: false,
    thresholdProfile: "converse",
    licence: null,
    licenceNote: null,
    processor:
      "the Converse-protocol gateway at the configured base URL; its operator's terms apply",
  },
});

export const DECISION_MODEL_PRESET_NAMES: ReadonlyArray<string> = Object.freeze(
  Object.keys(DECISION_MODEL_PRESETS),
);

/**
 * The adapters none of whose presets publish an input price - the
 * chat-shaped routes (`llm-emulation`, `converse`), where the gateway
 * fronts an operator-chosen model family, so the repo cannot name a
 * price and the daily cost gate records nothing for the route's calls
 * until the operator sets one. Derived from the preset table: an adapter
 * is here when every preset that speaks it carries
 * `inputPriceUsdPerMtok: null`, so a new route of the same shape joins
 * the unpriced-route warning of `check` without a name list to extend. A
 * family with any published price (`systemone`, `vercel-evaluate`) stays
 * out: its wire format may report a per-request cost, so an unpriced
 * preset of it keeps the generic unknown-price warning.
 */
export const DECISION_MODEL_UNPRICED_ADAPTERS: ReadonlyArray<DecisionModelAdapter> = Object.freeze(
  [...new Set(Object.values(DECISION_MODEL_PRESETS).map((preset) => preset.adapter))].filter(
    (adapter) =>
      Object.values(DECISION_MODEL_PRESETS)
        .filter((preset) => preset.adapter === adapter)
        .every((preset) => preset.inputPriceUsdPerMtok === null),
  ),
);

/**
 * The adapters whose routes are chat-shaped: the answer is generated text
 * in which the model wrote its own probabilities, so the request bills
 * output tokens the same way it bills input ones, and the cost is only
 * known once the operator sets both prices. Derived from the preset table
 * like {@link DECISION_MODEL_UNPRICED_ADAPTERS}: a route is chat-shaped
 * exactly when nothing about its wire protocol grounds a calibration
 * claim, the grounds the table records as `calibrated: false`, so an
 * adapter is here when every preset that speaks it is declared
 * uncalibrated. A calibrated route (`systemone`, `vercel-evaluate`)
 * serves a judgment model family whose published price covers the reply.
 */
export const DECISION_MODEL_CHAT_SHAPED_ADAPTERS: ReadonlyArray<DecisionModelAdapter> =
  Object.freeze(
    [...new Set(Object.values(DECISION_MODEL_PRESETS).map((preset) => preset.adapter))].filter(
      (adapter) =>
        Object.values(DECISION_MODEL_PRESETS)
          .filter((preset) => preset.adapter === adapter)
          .every((preset) => preset.calibrated === false),
    ),
  );

export function decisionModelPreset(name: string): DecisionModelPreset | null {
  return Object.hasOwn(DECISION_MODEL_PRESETS, name) ? DECISION_MODEL_PRESETS[name]! : null;
}

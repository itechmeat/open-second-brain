/**
 * The shared model-aware context-window resolver (t_a567cc12).
 *
 * Every context-pack, preset and compact budget in the repo used to be a
 * caller-declared guess; this module is the one place that turns a host
 * model id plus the operator's declarations into a window number, and it
 * states for each answer WHAT decided (`source`) so surfaces can disclose
 * it. Two inference tiers, with the embeddings-preset philosophy applied
 * verbatim: a window is a number that differs between checkpoints of one
 * family, so only PUBLISHED declarations may produce one.
 *
 *   - Declared: an exact-id table entry (provenance noted per row). No
 *     family substring ever resolves - "sonnet" matches nothing, and that
 *     is the defect this module exists to remove.
 *   - Structural: a trailing, delimited `1m` suffix (`-1m` / `_1m`). The
 *     suffix is itself a published declaration, so reading it is safe;
 *     generalizing it to "the family is big" is not, and never happens
 *     here. Delimited means `-` or `_` (or the whole id): a dot-led
 *     version fragment like the `4.1m` in `gpt-4.1m` is a version, not a
 *     window.
 *
 * Everything else resolves to {@link DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS},
 * the figure `token-footprint.ts` already treats as the de-facto standard
 * window - an unknown model is a default, never a guess from its name.
 *
 * Operator channels win over published facts (the operator knows the
 * deployment; the table knows the brochure), and a well-formed but
 * out-of-band operator value is clamped into
 * `[MIN_MODEL_CONTEXT_WINDOW_TOKENS, MAX_MODEL_CONTEXT_WINDOW_TOKENS]`
 * with `clamped: true` so the clamp can be disclosed, never silently
 * reverted. Table and suffix values are published facts and pass through
 * unclamped; a table row outside the band is a table bug the unit test
 * catches.
 *
 * PURE by contract: no fs, no environment reads, no network, no
 * `loadBrainConfig`. The caller parses its own channels (the
 * `context.window_tokens` block, {@link MODEL_CONTEXT_WINDOW_ENV_KEY} via
 * `resolveModelContextWindowEnvTokens()`, the per-call model string) and
 * hands the parsed values in, which keeps this module testable and lets
 * MCP, CLI and hook callers thread their own config channels.
 */

import { CONTEXT_WINDOW_TOKENS_DEFAULT } from "./policy/blocks/context.ts";

/** One published model window. Exact ids only; see the module header. */
export interface ModelContextWindowEntry {
  /** Exact host model id, matched case-insensitively after trimming. */
  readonly model: string;
  /** The window the vendor publishes for exactly this id, in tokens. */
  readonly windowTokens: number;
  /** One-line provenance ("model card: ...") for the published figure. */
  readonly note: string;
}

/**
 * Exact-id table. Deliberately small: the structural `1m` suffix rule
 * carries most of the value, and an entry is a published fact this repo
 * now asserts, so rows are added only for ids whose window the vendor
 * states as a plain number. Ids whose published window differs by
 * configuration or beta flag stay out.
 */
export const MODEL_CONTEXT_WINDOWS: ReadonlyArray<ModelContextWindowEntry> = Object.freeze([
  {
    model: "gpt-4o",
    windowTokens: 128_000,
    note: "OpenAI model card: 128,000 token context window",
  },
  {
    model: "gpt-4.1",
    windowTokens: 1_000_000,
    note: "OpenAI announcement: 1,000,000 token context window",
  },
  {
    model: "gpt-4.1-mini",
    windowTokens: 1_000_000,
    note: "OpenAI announcement: 1,000,000 token context window",
  },
  {
    model: "gpt-4.1-nano",
    windowTokens: 1_000_000,
    note: "OpenAI announcement: 1,000,000 token context window",
  },
  {
    model: "claude-sonnet-4-5",
    windowTokens: 200_000,
    note: "Anthropic models overview: 200K context window",
  },
  {
    model: "claude-opus-4-1",
    windowTokens: 200_000,
    note: "Anthropic models overview: 200K context window",
  },
  {
    model: "claude-opus-4",
    windowTokens: 200_000,
    note: "Anthropic models overview: 200K context window",
  },
]);

/** The window nothing better resolves to; see the module header. */
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = CONTEXT_WINDOW_TOKENS_DEFAULT;
/** Floor for the operator channels; below it a declaration clamps up. */
export const MIN_MODEL_CONTEXT_WINDOW_TOKENS = 100_000;
/** Ceiling for the operator channels; above it a declaration clamps down. */
export const MAX_MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** The `_brain.yaml` key the operator's `context:` block spells the window with. */
export const MODEL_CONTEXT_WINDOW_CONFIG_KEY = "window_tokens";
/** The environment variable that overrides the vault declaration. */
export const MODEL_CONTEXT_WINDOW_ENV_KEY = "OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW";

/** What decided the resolved window; surfaces disclose this verbatim. */
export type ModelWindowSource =
  | "operator-config"
  | "operator-env"
  | "declared"
  | "suffix"
  | "default";

export interface ResolvedModelWindow {
  readonly windowTokens: number;
  readonly source: ModelWindowSource;
  /** True when an operator/env value was clamped into the band. */
  readonly clamped: boolean;
}

export interface ResolveModelContextWindowInput {
  /** The host model id, as free-form as the caller received it. */
  readonly model?: string | null;
  /** Parsed `context.window_tokens`; `null`/`undefined` when absent. */
  readonly operatorWindowTokens?: number | null;
  /** Parsed {@link MODEL_CONTEXT_WINDOW_ENV_KEY} value; absent when unset. */
  readonly envWindowTokens?: number | null;
}

/**
 * The declared-window lookup: exact id, case-insensitive, trimmed. `null`
 * means UNKNOWN and is never treated as any default's synonym - the
 * resolver applies the default one tier later, where `source` can say so.
 */
export function declaredModelContextWindowTokens(model: string | null | undefined): number | null {
  const id = model?.trim().toLowerCase() ?? "";
  if (id === "") return null;
  const hit = MODEL_CONTEXT_WINDOWS.find((entry) => entry.model.toLowerCase() === id);
  return hit ? hit.windowTokens : null;
}

/**
 * The structural tier: one million tokens, and only when the id carries a
 * trailing, delimited `1m` window suffix. See the module header for the
 * delimiter set and the near-misses it exists to refuse.
 */
export function structuralModelContextWindowTokens(
  model: string | null | undefined,
): number | null {
  const id = model?.trim().toLowerCase() ?? "";
  if (/(^|[-_])1m$/.test(id)) return MAX_MODEL_CONTEXT_WINDOW_TOKENS;
  return null;
}

/** A channel value is usable only when it is a positive finite number. */
function usableChannelValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Clamp an operator/env value into the band. Returns the clamped number
 * and whether anything was moved; a value already inside passes through
 * untouched.
 */
function clampToBand(value: number): { windowTokens: number; clamped: boolean } {
  if (value < MIN_MODEL_CONTEXT_WINDOW_TOKENS) {
    return { windowTokens: MIN_MODEL_CONTEXT_WINDOW_TOKENS, clamped: true };
  }
  if (value > MAX_MODEL_CONTEXT_WINDOW_TOKENS) {
    return { windowTokens: MAX_MODEL_CONTEXT_WINDOW_TOKENS, clamped: true };
  }
  return { windowTokens: value, clamped: false };
}

/**
 * Resolve the model context window. Precedence: operator config >
 * operator env > declared table > `1m` suffix > default; see the module
 * header for the clamping and purity contracts.
 */
export function resolveModelContextWindowTokens(
  input: ResolveModelContextWindowInput,
): ResolvedModelWindow {
  if (usableChannelValue(input.operatorWindowTokens)) {
    const clamped = clampToBand(input.operatorWindowTokens);
    return { ...clamped, source: "operator-config" };
  }
  if (usableChannelValue(input.envWindowTokens)) {
    const clamped = clampToBand(input.envWindowTokens);
    return { ...clamped, source: "operator-env" };
  }
  const declared = declaredModelContextWindowTokens(input.model);
  if (declared !== null) return { windowTokens: declared, source: "declared", clamped: false };
  const structural = structuralModelContextWindowTokens(input.model);
  if (structural !== null) return { windowTokens: structural, source: "suffix", clamped: false };
  return { windowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, source: "default", clamped: false };
}

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
 *     is the defect this module exists to remove. Host-side decorations
 *     that still name exactly one row normalize away first (provider and
 *     region prefixes like `openai/` and `us.anthropic.`, trailing date
 *     snapshots, `-vN:N` revision suffixes), so `openai/gpt-4.1` and
 *     `gpt-4.1-2025-04-14` reach the row; nothing else is ever widened
 *     into a hit.
 *   - Structural: a trailing, delimited `1m` suffix (`-1m` / `_1m`, or
 *     the trailing `[1m]` bracket form hosts report). The suffix is
 *     itself a published declaration, so reading it is safe;
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
 * deployment; the table knows the brochure), and a first-hand declaration
 * - operator config, operator env, an exact table row - passes through
 * EXACTLY as given. The declaration exists to keep budgets inside the
 * true window; clamping it would re-inflate a declared 8k local model to
 * a 100k window and long-context budgets that overflow the very model it
 * describes. The `[MIN_MODEL_CONTEXT_WINDOW_TOKENS,
 * MAX_MODEL_CONTEXT_WINDOW_TOKENS]` band governs the GUESSED answers
 * only - the `-1m` suffix expansion and the unknown-model default, where
 * the true window is unknown and the band is the sanity bound. Both
 * published figures sit inside the band today, so `clamped` is false on
 * every derivable answer; a table row outside the band is a table bug
 * the unit test catches.
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
/** Band floor for the GUESSED answers (suffix expansion, default); see the module header. */
export const MIN_MODEL_CONTEXT_WINDOW_TOKENS = 100_000;
/**
 * Band ceiling for the GUESSED answers; the `1m` suffix resolves to
 * exactly this edge. First-hand declarations are never held to it.
 */
export const MAX_MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** The `_brain.yaml` key the operator's `context:` block spells the window with. */
export const MODEL_CONTEXT_WINDOW_CONFIG_KEY = "window_tokens";
/**
 * The environment channel for the operator's window. The vault
 * declaration WINS over it - the resolver's precedence is operator
 * config > operator env > declared table > `1m` suffix > default - so a
 * value here answers only where no `context.window_tokens` is set.
 */
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
  /** True when a GUESSED answer was clamped into the band; see the module header. */
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
 * The declared-window lookup: the id is normalized first - host-side
 * decorations that still name one published model (provider and region
 * prefixes, trailing date snapshots, `-vN:N` revision suffixes; see
 * {@link normalizeDeclaredModelId}) are stripped - then matched
 * case-insensitively against the exact rows. `null` means UNKNOWN and is
 * never treated as any default's synonym - the resolver applies the
 * default one tier later, where `source` can say so.
 */
export function declaredModelContextWindowTokens(model: string | null | undefined): number | null {
  const id = normalizeDeclaredModelId(model?.trim().toLowerCase() ?? "");
  if (id === "") return null;
  const hit = MODEL_CONTEXT_WINDOWS.find((entry) => entry.model.toLowerCase() === id);
  return hit ? hit.windowTokens : null;
}

/**
 * The structural tier: one million tokens, and only when the id carries a
 * trailing, delimited `1m` window suffix - `-1m` / `_1m` (or the whole
 * id), or the trailing `[1m]` bracket form hosts report
 * (`claude-sonnet-5-5[1m]`). See the module header for the delimiter set
 * and the near-misses it exists to refuse.
 */
export function structuralModelContextWindowTokens(
  model: string | null | undefined,
): number | null {
  const id = model?.trim().toLowerCase() ?? "";
  if (/(^|[-_])1m$/.test(id) || id.endsWith("[1m]")) return MAX_MODEL_CONTEXT_WINDOW_TOKENS;
  return null;
}

/** The remainder of a prefix strip still has to look like a model id. */
function looksLikeModelId(candidate: string): boolean {
  return /^[a-z]/.test(candidate) && candidate.replace(/[^a-z]/g, "").length >= 3;
}

/**
 * Strip the deployment plumbing an id can carry and still name exactly
 * one published model, so host-side spellings reach the exact-id table:
 * provider/router prefixes (`openai/gpt-4.1`), Bedrock-style region
 * prefixes (`us.anthropic.claude-...`), trailing date snapshots
 * (`gpt-4.1-2025-04-14`, the compact `-20250929`) and `-vN:N` revision
 * suffixes. A prefix is stripped only up to the first `.` or `/` AND
 * only while the remainder still looks like a model id, so the dot-led
 * minor version in `gpt-4.1` survives whole. Normalization feeds the
 * TABLE lookup only - it never invents a row, and unknown ids stay
 * unknown through it.
 */
function normalizeDeclaredModelId(rawId: string): string {
  let id = rawId;
  // Prefixes: repeatedly cut at the first `/` or `.`, whichever comes
  // first, while the remainder stays id-shaped -
  // `bedrock/us.anthropic.claude-...` sheds all three.
  for (;;) {
    const slash = id.indexOf("/");
    const dot = id.indexOf(".");
    const cut = slash === -1 ? dot : dot === -1 ? slash : Math.min(slash, dot);
    if (cut === -1) break;
    const rest = id.slice(cut + 1);
    if (!looksLikeModelId(rest)) break;
    id = rest;
  }
  // The decorated tail: `-vN:N` revision suffixes and date snapshots,
  // dotted and compact, each repeatedly so `...-20250929-v1:0` sheds
  // its whole tail.
  for (;;) {
    const stripped = id
      .replace(/-v\d+(:\d+)?$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")
      .replace(/-\d{8}$/, "");
    if (stripped === id) break;
    id = stripped;
  }
  return id;
}

/** A channel value is usable only when it is a positive finite number. */
function usableChannelValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Clamp a GUESSED window into the band. First-hand declarations never
 * pass through here - they are the operator's or the vendor's own
 * number, and the declaration exists precisely to state the true window.
 * Both derived figures (the `1m` suffix expansion, the unknown-model
 * default) sit inside the band today, so this is a no-op invariant that
 * keeps a future constant edit from answering out of band unnoticed.
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
 * header for the pass-through and clamping contracts.
 */
export function resolveModelContextWindowTokens(
  input: ResolveModelContextWindowInput,
): ResolvedModelWindow {
  // A first-hand declaration is the true window by definition: it passes
  // through exactly, so a declared 8k/32k model is budgeted inside its
  // real window instead of being re-inflated to the band floor.
  if (usableChannelValue(input.operatorWindowTokens)) {
    return { windowTokens: input.operatorWindowTokens, source: "operator-config", clamped: false };
  }
  if (usableChannelValue(input.envWindowTokens)) {
    return { windowTokens: input.envWindowTokens, source: "operator-env", clamped: false };
  }
  const declared = declaredModelContextWindowTokens(input.model);
  if (declared !== null) return { windowTokens: declared, source: "declared", clamped: false };
  // The guessed tiers: the band bounds both, where the true window is
  // unknown and the answer is an expansion or an assumption.
  const structural = structuralModelContextWindowTokens(input.model);
  if (structural !== null) return { ...clampToBand(structural), source: "suffix" };
  return { ...clampToBand(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS), source: "default" };
}

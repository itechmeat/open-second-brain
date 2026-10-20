import { resolveModelContextWindowTokens, type ResolvedModelWindow } from "./model-window.ts";

export type ContextPresetId = "tight-context" | "long-context";
export type ContextPresetConfidence = "high" | "medium" | "low";

export interface ContextBudgetPreset {
  readonly id: ContextPresetId;
  readonly label: string;
  readonly model_hints: ReadonlyArray<string>;
  readonly context_window_tokens: {
    readonly min: number;
    readonly max: number | null;
  };
  readonly context_pack: {
    readonly max_tokens: number;
    readonly max_chars_per_memory: number;
    readonly max_total_chars: number;
  };
  readonly pre_compress: {
    readonly top_k: number;
    readonly max_chars_per_memory: number;
    readonly max_total_chars: number;
  };
}

export interface ContextPresetSuggestionInput {
  readonly model?: string;
  readonly contextWindowTokens?: number;
}

export interface ContextPresetSuggestion {
  readonly preset_id: ContextPresetId;
  readonly confidence: ContextPresetConfidence;
  readonly reason: string;
  readonly preset: ContextBudgetPreset;
  /**
   * Present only when the window was RESOLVED from the model id through
   * the shared resolver AND that resolution decided the preset (a
   * declared table hit, a `1m` suffix, or the default when no hint
   * outranks it). An explicit window is the caller's own number, and a
   * hint-only model answers from its hint: neither claims a resolved
   * window.
   */
  readonly resolvedWindow?: ResolvedModelWindow;
}

export interface ContextPresetCurrentConfig {
  readonly context_pack?: Partial<ContextBudgetPreset["context_pack"]>;
  readonly pre_compress?: Partial<ContextBudgetPreset["pre_compress"]>;
  readonly overrides?: ReadonlyArray<string>;
}

export interface ContextPresetChange {
  readonly path: string;
  readonly current: number | null;
  readonly preset: number;
}

export interface ContextPresetDiff {
  readonly preset_id: ContextPresetId;
  readonly changes: ReadonlyArray<ContextPresetChange>;
  readonly preserved_overrides: ReadonlyArray<ContextPresetChange>;
  readonly unchanged: ReadonlyArray<string>;
  readonly invalid_overrides: ReadonlyArray<string>;
}

const PRESETS: ReadonlyArray<ContextBudgetPreset> = Object.freeze([
  Object.freeze({
    id: "tight-context",
    label: "Tight context",
    model_hints: Object.freeze(["mini", "small", "flash", "haiku"]),
    context_window_tokens: Object.freeze({ min: 0, max: 32_000 }),
    context_pack: Object.freeze({
      max_tokens: 4_000,
      max_chars_per_memory: 1_200,
      max_total_chars: 6_000,
    }),
    pre_compress: Object.freeze({
      top_k: 5,
      max_chars_per_memory: 800,
      max_total_chars: 4_000,
    }),
  }),
  Object.freeze({
    id: "long-context",
    label: "Long context",
    model_hints: Object.freeze(["sonnet", "opus", "pro", "large"]),
    context_window_tokens: Object.freeze({ min: 32_001, max: null }),
    context_pack: Object.freeze({
      max_tokens: 24_000,
      max_chars_per_memory: 4_000,
      max_total_chars: 30_000,
    }),
    pre_compress: Object.freeze({
      top_k: 20,
      max_chars_per_memory: 2_000,
      max_total_chars: 16_000,
    }),
  }),
]);

const PRESET_FIELDS = Object.freeze([
  "context_pack.max_tokens",
  "context_pack.max_chars_per_memory",
  "context_pack.max_total_chars",
  "pre_compress.top_k",
  "pre_compress.max_chars_per_memory",
  "pre_compress.max_total_chars",
]);

export function listContextPresets(): ReadonlyArray<ContextBudgetPreset> {
  return PRESETS;
}

export function getContextPreset(id: string): ContextBudgetPreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * The preset whose window bucket contains `window`. The one definition of
 * the bucket mapping - suggest sizes from it, and so does every surface
 * that derives a budget from a resolved window (t_a567cc12) - so a caller
 * can never size from a different mapping than a suggestion named. A
 * budget derived for a MODEL goes through {@link presetForResolvedWindow},
 * which layers the shared hint fallback on this mapping when the
 * resolver's answer is the default-sourced assumption.
 */
export function presetForWindowTokens(window: number): ContextBudgetPreset {
  const hit = PRESETS.find(
    (preset) =>
      window >= preset.context_window_tokens.min &&
      (preset.context_window_tokens.max === null || window <= preset.context_window_tokens.max),
  );
  // The buckets tile [0, ∞), so the fallback is unreachable; it keeps the
  // compiler honest without inventing a third preset.
  return hit ?? PRESETS[0]!;
}

/**
 * The `model_hints` fallback, defined once: the preset whose hint list
 * contains a whole token of the id - the lowercased id split on
 * `[-_.:/@\s]+`, and the hint must EQUAL one token, so "mini" never
 * matches inside "gemini" while a real `mini` token still does.
 * {@link suggestContextPreset} answers from it when the resolver has
 * nothing published to say, and {@link presetForResolvedWindow} budgets
 * from it on exactly the same condition - so a hint-only model suggests
 * and budgets one mapping.
 */
function hintPresetForModel(model: string | null | undefined): ContextBudgetPreset | null {
  const id = model?.toLowerCase() ?? "";
  if (id === "") return null;
  const tokens = new Set(id.split(/[-_.:/@\s]+/));
  return PRESETS.find((preset) => preset.model_hints.some((hint) => tokens.has(hint))) ?? null;
}

/**
 * The pack-budget refusal for a model id nothing published places: no
 * declared table row, no `1m`/`[1m]` suffix, no matching hint. The
 * derived budget used to answer such an id with the default window's
 * long-context `max_tokens` - about three times an 8k local model's
 * whole window - so the pack surfaces refuse instead, the conservative
 * posture they held before derivation existed. `null` means the id IS
 * placed and budgets from its resolved window (table, suffix) or its
 * hint. A blank or absent model is ABSENT - the same condition the
 * surfaces' nothing-resolvable refusal already answers - so the two
 * refusals agree, and {@link suggestContextPreset} answers its
 * conservative fallback on exactly this predicate.
 */
export function unrecognisedModelBudgetRefusal(
  model: string | null | undefined,
  resolved: ResolvedModelWindow,
): string | null {
  if (resolved.source !== "default") return null;
  const id = model?.trim() ?? "";
  if (id !== "" && hintPresetForModel(id) !== null) return null;
  return id === ""
    ? "model not recognised; pass max_tokens or set context.window_tokens"
    : `model '${id}' not recognised; pass max_tokens or set context.window_tokens`;
}

/**
 * The preset a DERIVED budget sizes from for one model id: the mapping
 * the resolved window names - except when that answer is the resolver's
 * `default`-sourced assumption about the host, where the same
 * `model_hints` fallback {@link suggestContextPreset} answers with
 * applies, so a hint-only id (the reviewed disagreement: `gemini-2.5-flash`
 * suggested tight-context from its hint while the pack budgeted
 * long-context from the default window) budgets and suggests one mapping.
 * An id the table knows resolves from the table on both surfaces and
 * never from its hint; a model-free call (an operator channel resolved
 * the window) has no hint to apply and sizes from the resolved window.
 * An id NOTHING places (default source, no hint) never reaches a pack
 * budget from here - the pack surfaces refuse it first through
 * {@link unrecognisedModelBudgetRefusal} - and the pre-compress caps
 * path, which must always answer, keeps this mapping for it.
 * The window's `source` stays what the surface discloses either way.
 */
export function presetForResolvedWindow(
  model: string | null | undefined,
  resolved: ResolvedModelWindow,
): ContextBudgetPreset {
  if (resolved.source === "default") {
    const byHint = hintPresetForModel(model);
    if (byHint !== null) return byHint;
  }
  return presetForWindowTokens(resolved.windowTokens);
}

/**
 * The conservative fallback, defined once: tight-context, low
 * confidence, the answer for every call nothing published places - a
 * model-free call, or a model id with no window source, no suffix and no
 * hint. Never claims a resolved window.
 */
function conservativeFallbackSuggestion(): ContextPresetSuggestion {
  const fallback = PRESETS[0]!;
  return {
    preset_id: fallback.id,
    confidence: "low",
    reason: "no model or context-window hint matched; using conservative default",
    preset: fallback,
  };
}

export function suggestContextPreset(input: ContextPresetSuggestionInput): ContextPresetSuggestion {
  const model = input.model?.toLowerCase() ?? "";

  // Order (deliberate, changed by this branch from the hint-first order
  // it replaced): an explicit window wins over a matching `model_hints`
  // token. The window is authoritative - it is the caller's own
  // number for the deployment at hand, the same figure a derived budget
  // sizes from, just as the operator-config channel is authoritative in
  // the resolver - while a hint is a heuristic read off the id, and a
  // hint answers only when the resolver has nothing published to say. A
  // caller passing both therefore gets the window's mapping, and nothing
  // is resolved: the number was given, not inferred.
  const window = input.contextWindowTokens;
  if (window !== undefined && Number.isFinite(window)) {
    const byWindow = presetForWindowTokens(window);
    return {
      preset_id: byWindow.id,
      confidence: "high",
      reason: `context window ${window} tokens matched ${byWindow.id}`,
      preset: byWindow,
    };
  }

  // The window resolves FIRST, through the same resolver every derived
  // budget sizes from, so a suggestion can never name a different mapping
  // than the pack uses for the same model: a table-declared id that also
  // matches a hint answers from the table here AND in the pack budget
  // (the reviewed disagreement), and a hint-only id falls to the SAME
  // `model_hints` fallback on both surfaces - the pack derivation applies
  // it through presetForResolvedWindow whenever the resolver's
  // answer is the default-sourced assumption. A hint never masquerades as
  // a resolved window: the hint answer claims no `resolvedWindow`.
  if (model !== "") {
    const resolved = resolveModelContextWindowTokens({ model: input.model });
    if (resolved.source !== "default") {
      const byWindow = presetForWindowTokens(resolved.windowTokens);
      const clampedNote = resolved.clamped ? " (clamped)" : "";
      return {
        preset_id: byWindow.id,
        confidence: "high",
        reason: `context window ${resolved.windowTokens} tokens resolved from ${resolved.source}${clampedNote} matched ${byWindow.id}`,
        preset: byWindow,
        resolvedWindow: resolved,
      };
    }
    const byModel = hintPresetForModel(input.model);
    if (byModel) {
      return {
        preset_id: byModel.id,
        confidence: "high",
        reason: `model hint matched ${byModel.id}`,
        preset: byModel,
      };
    }
    // Nothing published places the id: the resolver's answer is the
    // default-sourced assumption and no hint matched, so the conservative
    // fallback answers - the same tight-context/low answer a model-free
    // call gets, and the exact condition the pack budget surfaces refuse
    // on ({@link unrecognisedModelBudgetRefusal}). An ASSUMED window is
    // never a basis for a suggestion: no `resolvedWindow` is claimed.
    return conservativeFallbackSuggestion();
  }

  return conservativeFallbackSuggestion();
}

export function diffContextPreset(
  id: string,
  current: ContextPresetCurrentConfig,
): ContextPresetDiff {
  const preset = getContextPreset(id);
  if (preset === null) throw new Error(`unknown context preset: ${id}`);

  const overrides = new Set(current.overrides ?? []);
  const validFields = new Set(PRESET_FIELDS);
  const changes: ContextPresetChange[] = [];
  const preserved: ContextPresetChange[] = [];
  const unchanged: string[] = [];

  for (const path of PRESET_FIELDS) {
    const presetValue = valueAt(preset, path)!;
    const currentValue = valueAt(current, path);
    if (currentValue === presetValue) {
      unchanged.push(path);
      continue;
    }
    const change = { path, current: currentValue, preset: presetValue };
    if (overrides.has(path)) preserved.push(change);
    else changes.push(change);
  }

  return Object.freeze({
    preset_id: preset.id,
    changes: Object.freeze(changes),
    preserved_overrides: Object.freeze(preserved),
    unchanged: Object.freeze(unchanged),
    invalid_overrides: Object.freeze([...overrides].filter((path) => !validFields.has(path))),
  });
}

function valueAt(
  obj: ContextBudgetPreset | ContextPresetCurrentConfig,
  path: string,
): number | null {
  const [section, key] = path.split(".") as ["context_pack" | "pre_compress", string];
  const sectionValue = obj[section] as Record<string, number | undefined> | undefined;
  const value = sectionValue?.[key];
  return typeof value === "number" ? value : null;
}

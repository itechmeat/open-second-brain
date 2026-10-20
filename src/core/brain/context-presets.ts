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
 * can never size from a different mapping than a suggestion named.
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

export function suggestContextPreset(input: ContextPresetSuggestionInput): ContextPresetSuggestion {
  const model = input.model?.toLowerCase() ?? "";

  // An explicit window is the caller's own number and wins over anything
  // heuristic, exactly as the operator-config channel wins in the
  // resolver - it keeps today's exact answer, with nothing resolved.
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
  // than the pack uses for the same model (the reviewed disagreement: a
  // table-declared id that also matches a hint answered tight-context
  // here while the pack budgeted long-context). A `model_hints`
  // substring answers only when the resolver has nothing published to
  // say - a hint-only model keeps its byte-identical hint answer, and a
  // hint never masquerades as a resolved window.
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
    const byModel = PRESETS.find((preset) =>
      preset.model_hints.some((hint) => model.includes(hint)),
    );
    if (byModel) {
      return {
        preset_id: byModel.id,
        confidence: "high",
        reason: `model hint matched ${byModel.id}`,
        preset: byModel,
      };
    }
    // The default-sourced window is an assumption about the host, not a
    // published fact, so it answers with `medium` confidence; the
    // resolution source is disclosed in the reason and carried
    // structurally.
    const byWindow = presetForWindowTokens(resolved.windowTokens);
    return {
      preset_id: byWindow.id,
      confidence: "medium",
      reason: `context window ${resolved.windowTokens} tokens resolved from ${resolved.source} matched ${byWindow.id}`,
      preset: byWindow,
      resolvedWindow: resolved,
    };
  }

  const fallback = PRESETS[0]!;
  return {
    preset_id: fallback.id,
    confidence: "low",
    reason: "no model or context-window hint matched; using conservative default",
    preset: fallback,
  };
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

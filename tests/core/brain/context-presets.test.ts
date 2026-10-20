import { describe, expect, test } from "bun:test";

import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
  presetForWindowTokens,
  suggestContextPreset,
} from "../../../src/core/brain/context-presets.ts";

describe("context budget presets", () => {
  test("exposes named tight and long context presets", () => {
    const presets = listContextPresets();
    expect(presets.map((preset) => preset.id)).toEqual(["tight-context", "long-context"]);
    expect(getContextPreset("tight-context")).toMatchObject({
      id: "tight-context",
      context_pack: { max_tokens: 4000 },
      pre_compress: { top_k: 5 },
    });
  });

  test("suggests by model hint and context window", () => {
    expect(
      suggestContextPreset({
        model: "gpt-4.1-mini",
        contextWindowTokens: 8000,
      }),
    ).toMatchObject({
      preset_id: "tight-context",
      confidence: "high",
    });
    expect(
      suggestContextPreset({
        model: "claude-sonnet-4",
        contextWindowTokens: 200000,
      }),
    ).toMatchObject({
      preset_id: "long-context",
      confidence: "high",
    });
  });

  test("a model-only call resolves the window and the reason discloses the source", () => {
    // Declared table (no hint word in "gpt-4o").
    expect(suggestContextPreset({ model: "gpt-4o" })).toEqual({
      preset_id: "long-context",
      confidence: "high",
      reason: "context window 128000 tokens resolved from declared matched long-context",
      preset: getContextPreset("long-context")!,
      resolvedWindow: { windowTokens: 128_000, source: "declared", clamped: false },
    });
    // Structural 1m suffix, hint-free id.
    expect(suggestContextPreset({ model: "qwen3-235b-1m" }).reason).toBe(
      "context window 1000000 tokens resolved from suffix matched long-context",
    );
    // Unknown model: the default window, an assumption - medium confidence.
    expect(suggestContextPreset({ model: "kimi-k2" })).toEqual({
      preset_id: "long-context",
      confidence: "medium",
      reason: "context window 200000 tokens resolved from default matched long-context",
      preset: getContextPreset("long-context")!,
      resolvedWindow: { windowTokens: 200_000, source: "default", clamped: false },
    });
  });

  test("a resolved window beats a model hint; a hint-only model keeps the hint", () => {
    // "gemini-2.5-pro-1m" contains the hint "mini", but the id also
    // carries a published `-1m` suffix. The resolver decides, because the
    // derivation surfaces size every budget from this same resolved
    // window - the suggestion must name the mapping the pack uses.
    const suggestion = suggestContextPreset({ model: "gemini-2.5-pro-1m" });
    expect(suggestion).toEqual({
      preset_id: "long-context",
      confidence: "high",
      reason: "context window 1000000 tokens resolved from suffix matched long-context",
      preset: getContextPreset("long-context")!,
      resolvedWindow: { windowTokens: 1_000_000, source: "suffix", clamped: false },
    });
    // A hint-only model - the resolver has nothing published for it - keeps
    // today's byte-identical hint answer, and no window resolution is
    // claimed for the same call.
    const hintOnly = suggestContextPreset({ model: "gemini-2.5-flash" });
    expect(hintOnly).toMatchObject({
      preset_id: "tight-context",
      confidence: "high",
      reason: "model hint matched tight-context",
    });
    expect(hintOnly.resolvedWindow).toBeUndefined();
  });

  test("a table-declared window beats a hint, so suggest agrees with the pack budget", () => {
    // The disagreeing-model case the review names: `gpt-4.1-mini` matches
    // the "mini" hint AND the declared table. The pack derives from the
    // resolved 1M window and budgets long-context; the suggestion used to
    // answer tight-context from the hint - two mappings for one model.
    const suggestion = suggestContextPreset({ model: "gpt-4.1-mini" });
    expect(suggestion).toEqual({
      preset_id: "long-context",
      confidence: "high",
      reason: "context window 1000000 tokens resolved from declared matched long-context",
      preset: getContextPreset("long-context")!,
      resolvedWindow: { windowTokens: 1_000_000, source: "declared", clamped: false },
    });
    // The mapping the pack sizes from names the same preset.
    expect(presetForWindowTokens(suggestion.resolvedWindow!.windowTokens).id).toBe("long-context");
  });

  test("an explicit window keeps today's exact answer with nothing resolved", () => {
    const suggestion = suggestContextPreset({ model: "kimi-k2", contextWindowTokens: 8000 });
    expect(suggestion).toMatchObject({
      preset_id: "tight-context",
      confidence: "high",
      reason: "context window 8000 tokens matched tight-context",
    });
    expect(suggestion.resolvedWindow).toBeUndefined();
  });

  test("no model and no window keeps the conservative fallback", () => {
    expect(suggestContextPreset({})).toMatchObject({
      preset_id: "tight-context",
      confidence: "low",
      reason: "no model or context-window hint matched; using conservative default",
    });
  });

  test("diffs preset values while reporting explicit overrides", () => {
    const diff = diffContextPreset("tight-context", {
      context_pack: {
        max_tokens: 9000,
        max_chars_per_memory: 1200,
        max_total_chars: 6000,
      },
      pre_compress: {
        top_k: 5,
        max_chars_per_memory: 800,
        max_total_chars: 4000,
      },
      overrides: ["context_pack.max_tokens"],
    });

    expect(diff).toMatchObject({
      preset_id: "tight-context",
      changes: [],
      preserved_overrides: [
        {
          path: "context_pack.max_tokens",
          current: 9000,
          preset: 4000,
        },
      ],
      invalid_overrides: [],
    });
    expect(diff.unchanged).toContain("context_pack.max_total_chars");
    expect(diff.unchanged).toContain("pre_compress.top_k");
  });
});

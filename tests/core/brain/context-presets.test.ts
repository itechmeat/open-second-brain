import { describe, expect, test } from "bun:test";

import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
  presetForResolvedWindow,
  presetForWindowTokens,
  suggestContextPreset,
  unrecognisedModelBudgetRefusal,
} from "../../../src/core/brain/context-presets.ts";
import { resolveModelContextWindowTokens } from "../../../src/core/brain/model-window.ts";

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
    // Unknown model, no hint: nothing published places the id, so the
    // conservative fallback answers - the same tight-context/low answer a
    // model-free call gets - and no window resolution is claimed for the
    // id. The default window is an assumption, never a suggestion basis.
    expect(suggestContextPreset({ model: "kimi-k2" })).toEqual({
      preset_id: "tight-context",
      confidence: "low",
      reason: "no model or context-window hint matched; using conservative default",
      preset: getContextPreset("tight-context")!,
    });
  });

  test("a resolved window beats a model hint; a hint-only model keeps the hint", () => {
    // "gemini-2.5-pro-1m" carries a hint word ("pro" is a whole token of
    // the id), but the id also carries a published `-1m` suffix. The
    // resolver decides, because the derivation surfaces size every budget
    // from this same resolved window - the suggestion must name the
    // mapping the pack uses.
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

  test("a hint-only model budgets the same preset suggest answers", () => {
    // The remaining disagreement the review names: for an id the declared
    // table does not know, the resolver answers the default window, the
    // pack budgeted long-context (24k) from it, while suggest answered the
    // hint (tight-context, 4k) - two mappings for one model. The budget
    // derivation now applies the same `model_hints` fallback suggest uses
    // whenever the resolver's source is "default"; the disclosed source
    // stays the window's.
    for (const id of ["gemini-2.5-flash", "claude-3-haiku"]) {
      const suggestion = suggestContextPreset({ model: id });
      expect(suggestion).toMatchObject({
        preset_id: "tight-context",
        confidence: "high",
        reason: "model hint matched tight-context",
      });
      const resolved = resolveModelContextWindowTokens({ model: id });
      expect(resolved.source).toBe("default");
      const budgetPreset = presetForResolvedWindow(id, resolved);
      expect(budgetPreset.id).toBe(suggestion.preset_id);
      expect(budgetPreset.context_pack.max_tokens).toBe(suggestion.preset.context_pack.max_tokens);
    }
    // A table-known id keeps the table's mapping and never its hint, on
    // both surfaces: "gpt-4.1-mini" matches "mini" but resolves declared 1M.
    const declared = resolveModelContextWindowTokens({ model: "gpt-4.1-mini" });
    expect(declared.source).toBe("declared");
    expect(presetForResolvedWindow("gpt-4.1-mini", declared).id).toBe("long-context");
    expect(suggestContextPreset({ model: "gpt-4.1-mini" }).preset_id).toBe("long-context");
    // No model, no hint to fall back on: the resolved window decides.
    expect(
      presetForResolvedWindow(undefined, {
        windowTokens: 200_000,
        source: "default",
        clamped: false,
      }).id,
    ).toBe("long-context");
  });

  test("a hint matches a whole token of the id, never a fragment of one", () => {
    // "mini" is a substring of "gemini" and the declared table has no
    // gemini rows, so the raw-substring matcher fell every gemini-* id
    // through to the hint path and matched tight-context first:
    // gemini-2.5-pro - a 1M-class model whose id also carries "pro" -
    // was budgeted 4k. A hint now has to EQUAL one delimiter-split token
    // of the lowercased id: the spurious "mini" hit is gone, and the
    // genuine "pro" token decides - long-context, 24k.
    const suggestion = suggestContextPreset({ model: "gemini-2.5-pro" });
    expect(suggestion).toMatchObject({
      preset_id: "long-context",
      confidence: "high",
      reason: "model hint matched long-context",
    });
    expect(suggestion.resolvedWindow).toBeUndefined();
    const resolved = resolveModelContextWindowTokens({ model: "gemini-2.5-pro" });
    expect(resolved.source).toBe("default");
    const budget = presetForResolvedWindow("gemini-2.5-pro", resolved);
    expect(budget.id).toBe("long-context");
    expect(budget.context_pack.max_tokens).toBe(24_000);

    // The positive half of the contract: an exact token still matches.
    // gpt-4.1-mini is table-known, so its production budget answers from
    // the declared 1M window, but on the hint fallback itself (a
    // default-sourced answer) the whole token "mini" decides tight.
    expect(
      presetForResolvedWindow("gpt-4.1-mini", {
        windowTokens: 200_000,
        source: "default",
        clamped: false,
      }).id,
    ).toBe("tight-context");

    // A fragment inside a larger token is not a hit: "ministral" is one
    // token, so nothing places the id and the conservative fallback
    // answers - never the default window's long-context mapping, which
    // would budget a small local model three times its real window.
    expect(suggestContextPreset({ model: "ministral-8b" })).toMatchObject({
      preset_id: "tight-context",
      confidence: "low",
      reason: "no model or context-window hint matched; using conservative default",
    });
  });

  test("an unrecognised id refuses the derived budget; table and hint ids do not", () => {
    // M1: an id with no table row, no suffix and no hint used to budget
    // the default window's long-context 24k - about three times an 8k
    // local model's whole window. The pack surfaces refuse instead, and
    // this shared predicate is the exact condition they refuse on (and
    // the condition suggest's conservative fallback answers on).
    const unknown = resolveModelContextWindowTokens({ model: "llama3:8b" });
    expect(unknown.source).toBe("default");
    expect(unrecognisedModelBudgetRefusal("llama3:8b", unknown)).toBe(
      "model 'llama3:8b' not recognised; pass max_tokens or set context.window_tokens",
    );
    // A table-declared id budgets long-context from its row, never refuses.
    expect(
      unrecognisedModelBudgetRefusal(
        "gpt-4.1-mini",
        resolveModelContextWindowTokens({ model: "gpt-4.1-mini" }),
      ),
    ).toBeNull();
    // A hint-matching id budgets from its hint, never refuses.
    expect(
      unrecognisedModelBudgetRefusal(
        "gemini-2.5-flash",
        resolveModelContextWindowTokens({ model: "gemini-2.5-flash" }),
      ),
    ).toBeNull();
    // A blank model is ABSENT, not a name to match: with the default
    // window the only answer left, the refusal carries no id.
    expect(
      unrecognisedModelBudgetRefusal("   ", {
        windowTokens: 200_000,
        source: "default",
        clamped: false,
      }),
    ).toBe("model not recognised; pass max_tokens or set context.window_tokens");
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

  test("an explicit window beats a model hint when both are given", () => {
    // The shipped order, pinned in both directions of the disagreement:
    // the `model_hints` check used to run first, so `gpt-4o-mini` with an
    // explicit 128000 window answered tight-context from the "mini" hint
    // while the window named long-context. The window is authoritative -
    // it is the caller's own number for the deployment at hand, the same
    // figure a derived budget sizes from - and a hint answers only when
    // the resolver has nothing to say, so the window's mapping wins.
    const hintTight = suggestContextPreset({
      model: "gpt-4o-mini",
      contextWindowTokens: 128_000,
    });
    expect(hintTight).toEqual({
      preset_id: "long-context",
      confidence: "high",
      reason: "context window 128000 tokens matched long-context",
      preset: getContextPreset("long-context")!,
    });
    // The number was given, not resolved: nothing is claimed.
    expect(hintTight.resolvedWindow).toBeUndefined();
    expect(
      suggestContextPreset({ model: "claude-sonnet-4", contextWindowTokens: 8_000 }),
    ).toMatchObject({
      preset_id: "tight-context",
      confidence: "high",
      reason: "context window 8000 tokens matched tight-context",
    });
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

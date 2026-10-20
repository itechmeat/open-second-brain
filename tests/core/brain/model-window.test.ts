import { describe, expect, test } from "bun:test";

import { presetForWindowTokens } from "../../../src/core/brain/context-presets.ts";
import { CONTEXT_WINDOW_TOKENS_DEFAULT } from "../../../src/core/brain/policy.ts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  declaredModelContextWindowTokens,
  MAX_MODEL_CONTEXT_WINDOW_TOKENS,
  MIN_MODEL_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  resolveModelContextWindowTokens,
  structuralModelContextWindowTokens,
} from "../../../src/core/brain/model-window.ts";

describe("model context window table", () => {
  test("every table entry is a published in-band window with provenance", () => {
    for (const entry of MODEL_CONTEXT_WINDOWS) {
      expect(entry.windowTokens).toBeGreaterThanOrEqual(MIN_MODEL_CONTEXT_WINDOW_TOKENS);
      expect(entry.windowTokens).toBeLessThanOrEqual(MAX_MODEL_CONTEXT_WINDOW_TOKENS);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  test("declared lookup is exact-id only, case-insensitive", () => {
    expect(declaredModelContextWindowTokens("gpt-4o")).toBe(128_000);
    expect(declaredModelContextWindowTokens("GPT-4O")).toBe(128_000);
    expect(declaredModelContextWindowTokens(" gpt-4o ")).toBe(128_000);
  });

  test("no family substring ever resolves - neither direction", () => {
    // A prefix of a declared id is not the declared id.
    expect(declaredModelContextWindowTokens("gpt-4")).toBeNull();
    // A declared id's family name does not carry its window.
    expect(declaredModelContextWindowTokens("claude-sonnet-4")).toBeNull();
    // A longer id that merely contains a declared id resolves nothing.
    expect(declaredModelContextWindowTokens("my-gpt-4o-custom")).toBeNull();
  });

  test("host-side decorations normalize onto the exact row (M3)", () => {
    // Router prefix: the published model is what the table knows.
    expect(declaredModelContextWindowTokens("openai/gpt-4.1")).toBe(1_000_000);
    // A dated snapshot of a declared id is that declared id.
    expect(declaredModelContextWindowTokens("gpt-4.1-2025-04-14")).toBe(1_000_000);
    // Bedrock-style region prefix plus compact date plus `-vN:N` revision
    // suffix: all plumbing; the row is claude-sonnet-4-5's 200k (NOT 1M -
    // the row decides, the normalizer only reaches it).
    expect(declaredModelContextWindowTokens("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      200_000,
    );
    expect(declaredModelContextWindowTokens("bedrock/us.anthropic.claude-opus-4-1-v1:0")).toBe(
      200_000,
    );
    // Through the resolver: the normalized hit answers `declared`, not
    // the default.
    expect(resolveModelContextWindowTokens({ model: "openai/gpt-4.1" })).toEqual({
      windowTokens: 1_000_000,
      source: "declared",
      clamped: false,
    });
  });

  test("normalization never invents a row", () => {
    // A dot-led minor version is not a prefix: `gpt-4.1` survives whole.
    expect(declaredModelContextWindowTokens("gpt-4.1")).toBe(1_000_000);
    // Unknown models stay unknown whatever plumbing they carry.
    expect(declaredModelContextWindowTokens("openai/llama3:8b")).toBeNull();
    expect(declaredModelContextWindowTokens("llama3:8b")).toBeNull();
    // A non-date tail is not stripped.
    expect(declaredModelContextWindowTokens("gpt-4o-preview")).toBeNull();
  });

  test("unknown and null models declare nothing", () => {
    expect(declaredModelContextWindowTokens(null)).toBeNull();
    expect(declaredModelContextWindowTokens(undefined)).toBeNull();
    expect(declaredModelContextWindowTokens("")).toBeNull();
    expect(declaredModelContextWindowTokens("totally-unknown-model")).toBeNull();
  });
});

describe("structural 1m suffix rule", () => {
  test("a trailing delimited 1m suffix declares one million tokens", () => {
    expect(structuralModelContextWindowTokens("gemini-2.5-pro-1m")).toBe(1_000_000);
    expect(structuralModelContextWindowTokens("some-model_1m")).toBe(1_000_000);
    expect(structuralModelContextWindowTokens("GEMINI-2.5-PRO-1M")).toBe(1_000_000);
  });

  test("the bracket form hosts report is a structural 1m suffix too (M3)", () => {
    expect(structuralModelContextWindowTokens("claude-sonnet-5-5[1m]")).toBe(1_000_000);
    expect(structuralModelContextWindowTokens("opus[1m]")).toBe(1_000_000);
    expect(structuralModelContextWindowTokens("MODEL[1M]")).toBe(1_000_000);
    // Through the resolver: the bracket answers `suffix`.
    expect(resolveModelContextWindowTokens({ model: "claude-sonnet-5-5[1m]" })).toEqual({
      windowTokens: 1_000_000,
      source: "suffix",
      clamped: false,
    });
    // Only trailing: text after the bracket is not a window.
    expect(structuralModelContextWindowTokens("model[1m]-preview")).toBeNull();
    // A dot-led fragment is still a version, bracket or not.
    expect(structuralModelContextWindowTokens("gpt-4.1[m]")).toBeNull();
  });

  test("1m inside a larger token never matches", () => {
    // Not trailing.
    expect(structuralModelContextWindowTokens("gemini-2.5-pro-1m-preview")).toBeNull();
    // Trailing but larger token ("1million").
    expect(structuralModelContextWindowTokens("model-1million")).toBeNull();
    // Preceded by an alphanumeric, not a delimiter ("m11m").
    expect(structuralModelContextWindowTokens("minimax-m11m")).toBeNull();
    // Dot-delimited version fragment, not a window suffix ("4.1m").
    expect(structuralModelContextWindowTokens("gpt-4.1m")).toBeNull();
    // A different magnitude.
    expect(structuralModelContextWindowTokens("model-128k")).toBeNull();
    expect(structuralModelContextWindowTokens("model-1mx")).toBeNull();
  });

  test("suffix and declared lookups agree that unknown models carry nothing structural", () => {
    expect(structuralModelContextWindowTokens(null)).toBeNull();
    expect(structuralModelContextWindowTokens("")).toBeNull();
  });
});

describe("resolveModelContextWindowTokens", () => {
  test("the default is the repo's de-facto standard window", () => {
    expect(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS).toBe(200_000);
    expect(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS).toBe(CONTEXT_WINDOW_TOKENS_DEFAULT);
    expect(resolveModelContextWindowTokens({})).toEqual({
      windowTokens: 200_000,
      source: "default",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({ model: null })).toEqual({
      windowTokens: 200_000,
      source: "default",
      clamped: false,
    });
    // An unknown model id is a default, never a family guess.
    expect(resolveModelContextWindowTokens({ model: "mystery-model" })).toEqual({
      windowTokens: 200_000,
      source: "default",
      clamped: false,
    });
  });

  test("declared table beats suffix beats default", () => {
    expect(resolveModelContextWindowTokens({ model: "gpt-4o" })).toEqual({
      windowTokens: 128_000,
      source: "declared",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({ model: "gemini-2.5-pro-1m" })).toEqual({
      windowTokens: 1_000_000,
      source: "suffix",
      clamped: false,
    });
  });

  test("operator env beats table and suffix", () => {
    expect(
      resolveModelContextWindowTokens({
        model: "gpt-4o",
        envWindowTokens: 150_000,
      }),
    ).toEqual({ windowTokens: 150_000, source: "operator-env", clamped: false });
    expect(
      resolveModelContextWindowTokens({
        model: "gemini-2.5-pro-1m",
        envWindowTokens: 150_000,
      }),
    ).toEqual({ windowTokens: 150_000, source: "operator-env", clamped: false });
  });

  test("operator config beats env", () => {
    expect(
      resolveModelContextWindowTokens({
        model: "gpt-4o",
        operatorWindowTokens: 400_000,
        envWindowTokens: 150_000,
      }),
    ).toEqual({ windowTokens: 400_000, source: "operator-config", clamped: false });
  });

  test("a declared window passes through unclamped at any size", () => {
    // The declaration exists to keep budgets inside the true window: an
    // 8k local model declared exactly must not be re-inflated.
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: 8_000 })).toEqual({
      windowTokens: 8_000,
      source: "operator-config",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({ envWindowTokens: 8_000 })).toEqual({
      windowTokens: 8_000,
      source: "operator-env",
      clamped: false,
    });
    // Above the historical ceiling too - the operator knows the deployment.
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: 5_000_000 })).toEqual({
      windowTokens: 5_000_000,
      source: "operator-config",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({ envWindowTokens: 5_000_000 })).toEqual({
      windowTokens: 5_000_000,
      source: "operator-env",
      clamped: false,
    });
    // Band edges were never clamps and still are not.
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: 100_000 })).toEqual({
      windowTokens: 100_000,
      source: "operator-config",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: 1_000_000 })).toEqual({
      windowTokens: 1_000_000,
      source: "operator-config",
      clamped: false,
    });
  });

  test("a declared 32k window sizes tight-context, not the 100k clamp", () => {
    const resolved = resolveModelContextWindowTokens({ operatorWindowTokens: 32_000 });
    expect(resolved).toEqual({
      windowTokens: 32_000,
      source: "operator-config",
      clamped: false,
    });
    // The bucket mapping every derived budget is sized from agrees: the
    // tight-context pack budget, never long-context.
    expect(presetForWindowTokens(resolved.windowTokens).id).toBe("tight-context");
    expect(presetForWindowTokens(resolved.windowTokens).context_pack.max_tokens).toBe(4_000);
  });

  test("a declared 32k base beats a -1m suffix and is never clamped to the 100k floor", () => {
    // The reviewed bug: the old resolver clamped the declaration up to
    // the band minimum (100_000, clamped: true) and every derived budget
    // went long-context, overflowing the very model the declaration
    // describes. The declaration is first-hand; the suffix is a guess.
    expect(
      resolveModelContextWindowTokens({ operatorWindowTokens: 32_000, model: "qwen3-32b-1m" }),
    ).toEqual({ windowTokens: 32_000, source: "operator-config", clamped: false });
    // The suffix alone stays a derived answer inside the band: one
    // million, exactly the band's top edge, reported unclamped.
    expect(resolveModelContextWindowTokens({ model: "qwen3-32b-1m" })).toEqual({
      windowTokens: 1_000_000,
      source: "suffix",
      clamped: false,
    });
  });

  test("the band governs the guessed answers, which sit inside it today", () => {
    // The clamp's remaining charge: the `-1m` suffix expansion and the
    // unknown-model default, where the true window is unknown and the
    // band is the sanity bound. Both published figures sit inside the
    // band, so `clamped` is false on every derivable answer - and a
    // constant drifting out of band is a bug this pins.
    expect(resolveModelContextWindowTokens({ model: "gemini-2.5-pro-1m" })).toEqual({
      windowTokens: MAX_MODEL_CONTEXT_WINDOW_TOKENS,
      source: "suffix",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({})).toEqual({
      windowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
      source: "default",
      clamped: false,
    });
    expect(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS).toBeGreaterThanOrEqual(
      MIN_MODEL_CONTEXT_WINDOW_TOKENS,
    );
    expect(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS).toBeLessThanOrEqual(
      MAX_MODEL_CONTEXT_WINDOW_TOKENS,
    );
  });

  test("a declared value still wins over a lower declared table entry", () => {
    expect(
      resolveModelContextWindowTokens({
        model: "gpt-4o",
        operatorWindowTokens: 5_000_000,
      }),
    ).toEqual({ windowTokens: 5_000_000, source: "operator-config", clamped: false });
  });

  test("zero, negative and non-finite operator values resolve nothing", () => {
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: 0 })).toEqual({
      windowTokens: 200_000,
      source: "default",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({ envWindowTokens: -5 })).toEqual({
      windowTokens: 200_000,
      source: "default",
      clamped: false,
    });
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: Number.NaN })).toEqual({
      windowTokens: 200_000,
      source: "default",
      clamped: false,
    });
  });

  test("the resolver is pure: it never reads the environment itself", () => {
    const key = "OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW";
    const previous = process.env[key];
    process.env[key] = "999_999";
    try {
      expect(resolveModelContextWindowTokens({})).toEqual({
        windowTokens: 200_000,
        source: "default",
        clamped: false,
      });
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

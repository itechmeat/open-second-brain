import { describe, expect, test } from "bun:test";

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
    expect(declaredModelContextWindowTokens("gpt-4o-2026-01-01")).toBeNull();
    expect(declaredModelContextWindowTokens("my-gpt-4o-custom")).toBeNull();
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

  test("operator values clamp into the band, both directions, and say so", () => {
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: 50 })).toEqual({
      windowTokens: 100_000,
      source: "operator-config",
      clamped: true,
    });
    expect(resolveModelContextWindowTokens({ operatorWindowTokens: 5_000_000 })).toEqual({
      windowTokens: 1_000_000,
      source: "operator-config",
      clamped: true,
    });
    expect(resolveModelContextWindowTokens({ envWindowTokens: 50 })).toEqual({
      windowTokens: 100_000,
      source: "operator-env",
      clamped: true,
    });
    expect(resolveModelContextWindowTokens({ envWindowTokens: 5_000_000 })).toEqual({
      windowTokens: 1_000_000,
      source: "operator-env",
      clamped: true,
    });
    // Band edges are not clamps.
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

  test("a clamped operator value still wins over a lower declared table entry", () => {
    expect(
      resolveModelContextWindowTokens({
        model: "gpt-4o",
        operatorWindowTokens: 5_000_000,
      }),
    ).toEqual({ windowTokens: 1_000_000, source: "operator-config", clamped: true });
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

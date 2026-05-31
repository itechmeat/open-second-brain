import { describe, expect, test } from "bun:test";

import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
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

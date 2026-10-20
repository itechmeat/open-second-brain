import { expect, test } from "bun:test";

import { runCli } from "../helpers/run-cli.ts";

test("brain context-presets show/suggest/diff returns dry-run diagnostics", async () => {
  const show = await runCli(["brain", "context-presets", "show", "tight-context", "--json"]);
  expect(show.returncode).toBe(0);
  expect(JSON.parse(show.stdout)).toMatchObject({
    id: "tight-context",
    context_pack: { max_tokens: 4000 },
  });

  const suggest = await runCli([
    "brain",
    "context-presets",
    "suggest",
    "--model",
    "claude-sonnet-4",
    "--context-window",
    "200000",
    "--json",
  ]);
  expect(suggest.returncode).toBe(0);
  expect(JSON.parse(suggest.stdout)).toMatchObject({
    preset_id: "long-context",
    confidence: "high",
  });

  // `--model` alone resolves a window and the reason discloses what decided.
  const modelOnly = await runCli([
    "brain",
    "context-presets",
    "suggest",
    "--model",
    "gpt-4o",
    "--json",
  ]);
  expect(modelOnly.returncode).toBe(0);
  expect(JSON.parse(modelOnly.stdout)).toMatchObject({
    preset_id: "long-context",
    confidence: "high",
    reason: "context window 128000 tokens resolved from declared matched long-context",
  });

  // The disagreeing-model case: a declared table id that also matches a
  // hint must suggest the mapping the pack budget derives from.
  const hintAndTable = await runCli([
    "brain",
    "context-presets",
    "suggest",
    "--model",
    "gpt-4.1-mini",
    "--json",
  ]);
  expect(hintAndTable.returncode).toBe(0);
  expect(JSON.parse(hintAndTable.stdout)).toMatchObject({
    preset_id: "long-context",
    confidence: "high",
    reason: "context window 1000000 tokens resolved from declared matched long-context",
  });

  // A hint-only model - nothing published resolves for the id - answers
  // from its hint; the pack budget derivation applies the same fallback,
  // so both surfaces name one mapping for the model.
  const hintOnly = await runCli([
    "brain",
    "context-presets",
    "suggest",
    "--model",
    "gemini-2.5-flash",
    "--json",
  ]);
  expect(hintOnly.returncode).toBe(0);
  expect(JSON.parse(hintOnly.stdout)).toMatchObject({
    preset_id: "tight-context",
    confidence: "high",
    reason: "model hint matched tight-context",
  });

  const diff = await runCli([
    "brain",
    "context-presets",
    "diff",
    "tight-context",
    "--context-pack-max-tokens",
    "9000",
    "--override",
    "context_pack.max_tokens",
    "--json",
  ]);
  expect(diff.returncode).toBe(0);
  expect(JSON.parse(diff.stdout)).toMatchObject({
    preset_id: "tight-context",
    preserved_overrides: [{ path: "context_pack.max_tokens", current: 9000, preset: 4000 }],
  });
});

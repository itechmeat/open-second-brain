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

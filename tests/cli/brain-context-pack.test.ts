import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { listContextReceipts } from "../../src/core/brain/context-receipts.ts";
import { listRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-context-pack-cli-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, principle: string, extra = ""): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    ["---", `id: pref-${slug}`, "topic: t", `principle: ${principle}`, extra, "---", ""].join("\n"),
  );
}

test("brain context-pack --lanes --json returns polarity lanes", async () => {
  writePref("directive", "Prefer concise answers", "tier: core");
  // The constraints lane is opt-in via the explicit context_lane field,
  // not inferred from prose words like "Never" (language-agnostic).
  writePref("constraint", "Never expose tokens", "tier: core\ncontext_lane: constraints");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--max-tokens", "10000", "--lanes", "--json"],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.lanes.directives.map((item: { id: string }) => item.id)).toContain("pref-directive");
  expect(json.lanes.constraints.map((item: { id: string }) => item.id)).toContain(
    "pref-constraint",
  );
});

test("brain context-pack can opt in to receipts and recall telemetry", async () => {
  writePref("telemetry", "Prefer auditable context", "tier: core");

  const out = await runCli(
    [
      "brain",
      "context-pack",
      "--vault",
      vault,
      "--max-tokens",
      "10000",
      "--receipt",
      "--receipt-host",
      "cli-test",
      "--telemetry",
      "--telemetry-host",
      "cli-test",
      "--json",
    ],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.receipt_id).toStartWith("ctn_");
  expect(json.telemetry_id).toStartWith("ctn_");
  const receipts = listContextReceipts(vault, {
    trigger: "context_pack",
    host: "cli-test",
  });
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.payload).toMatchObject({
    trigger: "context_pack",
    item_count: 1,
  });
  const records = listRecallTelemetry(vault, {
    mode: "context_pack",
    host: "cli-test",
  });
  expect(records).toHaveLength(1);
  expect(records[0]!.payload).toMatchObject({ status: "ok", result_count: 1 });
});

test("brain context-pack exposes opt-in transform annotations", async () => {
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-zulu.md"),
    [
      "---",
      "id: pref-zulu",
      "topic: t",
      "principle: shared body",
      "tier: core",
      "created_at: 2026-05-02T00:00:00Z",
      "---",
      "",
      "shared body",
    ].join("\n"),
  );
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-alpha.md"),
    [
      "---",
      "id: pref-alpha",
      "topic: t",
      "principle: shared body",
      "tier: core",
      "created_at: 2026-05-01T00:00:00Z",
      "---",
      "",
      "shared body",
    ].join("\n"),
  );

  const out = await runCli(
    [
      "brain",
      "context-pack",
      "--vault",
      vault,
      "--max-tokens",
      "10000",
      "--cache-stable",
      "--dedup-repeated",
      "--json",
    ],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.items.map((item: { id: string }) => item.id)).toEqual(["pref-alpha", "pref-zulu"]);
  expect(json.items[0]).toMatchObject({ original_rank: 2, stable_rank: 1 });
  expect(json.items[1]).toMatchObject({
    deduped_from: "pref-alpha",
    reference_hint: "see pref-alpha",
  });
});

/**
 * Derived budget (t_a567cc12): `--max-tokens` is optional. When it is
 * omitted, the budget derives from the resolved model context window
 * (vault `context:` block, env, or `--model`) through the matching
 * preset; with nothing resolvable the verb refuses exactly as before.
 */
test("brain context-pack derives the budget from --model when --max-tokens is omitted", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--model", "gpt-4o", "--json"],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.max_tokens).toBe(24_000);
  expect(json.max_tokens_source).toBe("declared");
});

test("brain context-pack derives from a 1m-suffix model", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--model", "qwen3-235b-1m", "--json"],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.max_tokens).toBe(24_000);
  expect(json.max_tokens_source).toBe("suffix");
});

test("brain context-pack budgets a hint-only model from its hint, like suggest", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--model", "gemini-2.5-flash", "--json"],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  // Unknown to the declared table, the resolver answers the default
  // window; the budget defers to the model's hint (tight-context), the
  // same mapping `brain context-presets suggest` answers for the id.
  expect(json.max_tokens).toBe(4_000);
  expect(json.max_tokens_source).toBe("default");
});

test("brain context-pack keeps the declared mapping for a table-known hinted model", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--model", "gpt-4.1-mini", "--json"],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  // "gpt-4.1-mini" matches the "mini" hint AND the declared table; the
  // declared 1M window decides on both surfaces, never the hint.
  expect(json.max_tokens).toBe(24_000);
  expect(json.max_tokens_source).toBe("declared");
});

test("brain context-pack refuses an unrecognised model by name", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--model", "llama3:8b", "--json"],
    {},
  );

  // No table row, no `-1m` suffix, no hint: the verb refuses instead of
  // budgeting the default window's long-context 24k - the model's whole
  // 8k window is a third of that. The refusal names the id and remedies.
  expect(out.returncode).toBe(1);
  expect(out.stderr).toContain("llama3:8b");
  expect(out.stderr).toContain("not recognised");
  expect(out.stderr).toContain("context.window_tokens");
});

test("brain context-pack treats a blank --model as absent", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--model", "   ", "--json"],
    {},
  );

  // A blank name is no name: the same nothing-resolvable refusal a call
  // without --model gets, never a derived default budget.
  expect(out.returncode).toBe(1);
  expect(out.stderr).toContain("--max-tokens <n> is required");
});

test("brain context-pack derives from the vault context block without --model", async () => {
  writePref("core", "core principle", "tier: core");
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\ncontext:\n  window_tokens: 150000\n",
  );

  const out = await runCli(["brain", "context-pack", "--vault", vault, "--json"], {});

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.max_tokens).toBe(24_000);
  expect(json.max_tokens_source).toBe("operator-config");
});

test("brain context-pack passes an out-of-band declared window through unclamped", async () => {
  writePref("core", "core principle", "tier: core");
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\ncontext:\n  window_tokens: 5000000\n",
  );

  const out = await runCli(["brain", "context-pack", "--vault", vault, "--json"], {});

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  // A first-hand declaration passes through exactly as given (never
  // clamped into the band); 5M simply lands in the long-context bucket,
  // whose 24k budget is what the answer discloses.
  expect(json.max_tokens).toBe(24_000);
  expect(json.max_tokens_source).toBe("operator-config");
});

test("brain context-pack still refuses when nothing resolves", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(["brain", "context-pack", "--vault", vault, "--json"], {});

  expect(out.returncode).toBe(1);
  expect(out.stderr).toContain("--max-tokens <n> is required");
});

test("brain context-pack explicit --max-tokens wins over --model", async () => {
  writePref("core", "core principle", "tier: core");

  const out = await runCli(
    [
      "brain",
      "context-pack",
      "--vault",
      vault,
      "--model",
      "gpt-4o",
      "--max-tokens",
      "1000",
      "--json",
    ],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.max_tokens).toBe(1_000);
  expect(json.max_tokens_source).toBeUndefined();
});

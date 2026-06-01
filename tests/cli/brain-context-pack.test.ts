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
  writePref("constraint", "Never expose tokens", "tier: core");

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

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-context-receipts-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain context-receipts lists and shows prompt receipt records", async () => {
  const receipt = emitContextReceipt(vault, {
    options: {
      host: "cli-test",
      trigger: "context_pack",
      createdAt: "2026-05-20T12:00:00.000Z",
      sessionId: "session-cli",
    },
    finalText: "Packed visible context",
    items: [
      {
        id: "pref-alpha",
        path: join(vault, "Brain", "preferences", "pref-alpha.md"),
        text: "Prefer crisp answers",
        tokens: 4,
        tier: "core",
      },
    ],
    budget: { max_tokens: 100 },
  });

  const list = await runCli(["brain", "context-receipts", "list", "--vault", vault, "--json"]);
  expect(list.returncode).toBe(0);
  const listJson = JSON.parse(list.stdout);
  expect(listJson.total).toBe(1);
  expect(listJson.receipts[0]).toMatchObject({
    id: receipt.id,
    created_at: "2026-05-20T12:00:00.000Z",
    trigger: "context_pack",
    host: "cli-test",
    item_count: 1,
  });

  const show = await runCli([
    "brain",
    "context-receipts",
    "show",
    receipt.id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(show.returncode).toBe(0);
  const showJson = JSON.parse(show.stdout);
  expect(showJson.id).toBe(receipt.id);
  expect(showJson.payload.items[0]).toMatchObject({
    id: "pref-alpha",
    tier: "core",
    tokens: 4,
  });
});

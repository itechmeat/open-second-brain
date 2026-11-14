/**
 * `o2b brain context-receipts verify <receipt-id>` (t_4300e5fd).
 *
 * The operator face over the same K2 kernel the MCP verify operation
 * serves: per-item verdict lines and a summary, exit 0 while nothing
 * reports changed, exit 1 with the offending item ids when something
 * does, the exact K2 shape under `--json`, and the same refusals the
 * MCP face applies (unknown id named, private or redacted refused).
 *
 * The manifest / help / completion registrations for the new
 * subcommand are the shared registration pass; this suite pins only
 * what the verb module's own router answers.
 */

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const PAGE_BODY = "Prefer terse answers over long preambles.\n";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-context-receipts-verify-cli-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePage(name: string, body: string): string {
  const abs = join(vault, "Brain", "preferences", name);
  writeFileSync(abs, `---\nid: ${name.replace(/\.md$/, "")}\n---\n\n${body}`, "utf8");
  return abs;
}

function emitPageReceipt(abs: string, body: string) {
  return emitContextReceipt(vault, {
    options: {
      host: "cli-verify-test",
      trigger: "context_pack",
      createdAt: "2026-06-01T10:00:00.000Z",
    },
    items: [{ id: "pref-verify", path: abs, text: body.trim() }],
    finalText: body.trim(),
  });
}

/** Set a withholding flag on the stored record in place, as redaction would leave it. */
function flagStoredReceipt(id: string, flag: "private" | "redacted"): void {
  const storePath = join(vault, "Brain", "log", "continuity");
  for (const shard of readdirSync(storePath)) {
    const shardPath = join(storePath, shard);
    const lines = readFileSync(shardPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const rewritten = lines.map((line) => {
      const record = JSON.parse(line) as { id: string } & Record<string, unknown>;
      if (record.id === id) return JSON.stringify({ ...record, [flag]: true });
      return line;
    });
    writeFileSync(shardPath, `${rewritten.join("\n")}\n`, "utf8");
  }
}

test("verify prints per-item verdict lines and a summary, exit 0 when nothing changed", async () => {
  const abs = writePage("pref-verify.md", PAGE_BODY);
  const receipt = emitPageReceipt(abs, PAGE_BODY);

  const run = await runCli(["brain", "context-receipts", "verify", receipt.id, "--vault", vault]);

  expect(run.returncode).toBe(0);
  expect(run.stdout).toContain(`id: ${receipt.id}`);
  expect(run.stdout).toMatch(/match\s+pref-verify/);
  expect(run.stdout).toMatch(/verified 1 item\(s\): 1 match, 0 changed, 0 unavailable/);
});

test("verify exits 1 and names the offending item ids when content changed", async () => {
  const abs = writePage("pref-verify.md", PAGE_BODY);
  const receipt = emitPageReceipt(abs, PAGE_BODY);
  writePage("pref-verify.md", "Rewritten after the session saw it.\n");

  const run = await runCli(["brain", "context-receipts", "verify", receipt.id, "--vault", vault]);

  expect(run.returncode).toBe(1);
  expect(run.stdout).toMatch(/changed\s+pref-verify/);
  expect(run.stdout).toContain("changed item(s): pref-verify");
});

test("--json emits the exact K2 ReceiptVerification shape", async () => {
  const abs = writePage("pref-verify.md", PAGE_BODY);
  const receipt = emitPageReceipt(abs, PAGE_BODY);

  const run = await runCli([
    "brain",
    "context-receipts",
    "verify",
    receipt.id,
    "--vault",
    vault,
    "--json",
  ]);

  expect(run.returncode).toBe(0);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  // The K2 ReceiptVerification shape, field for field, including the
  // additive trigger header: `triggerRaw` carries the receipt's own
  // trigger when the closed vocabulary cannot name it, and is null on a
  // readable one (fix wave 1, F13).
  expect(Object.keys(parsed).toSorted()).toEqual([
    "counts",
    "createdAt",
    "items",
    "receiptId",
    "sessionInjected",
    "trigger",
    "triggerRaw",
  ]);
  expect(parsed["receiptId"]).toBe(receipt.id);
  expect(parsed["trigger"]).toBe("context_pack");
  expect(parsed["triggerRaw"]).toBeNull();
  expect(parsed["sessionInjected"]).toBe(false);
  const items = parsed["items"] as ReadonlyArray<Record<string, unknown>>;
  expect(Object.keys(items[0]!).toSorted()).toEqual([
    "expectedHash",
    "id",
    "note",
    "observedHash",
    "path",
    "unavailableReason",
    "verdict",
  ]);
  expect(parsed["counts"]).toEqual({ match: 1, changed: 0, unavailable: 0 });
});

test("an unknown receipt id exits non-zero naming the id", async () => {
  const run = await runCli(["brain", "context-receipts", "verify", "ctn_absent", "--vault", vault]);

  expect(run.returncode).not.toBe(0);
  expect(run.stderr).toContain("ctn_absent");
});

test("a private receipt is refused with exit 1 and the refusal is named", async () => {
  const abs = writePage("pref-verify.md", PAGE_BODY);
  const receipt = emitPageReceipt(abs, PAGE_BODY);
  flagStoredReceipt(receipt.id, "private");

  const run = await runCli(["brain", "context-receipts", "verify", receipt.id, "--vault", vault]);

  expect(run.returncode).toBe(1);
  expect(run.stderr).toContain("private");
});

test("a missing receipt id argument is a usage error", async () => {
  const run = await runCli(["brain", "context-receipts", "verify", "--vault", vault]);

  expect(run.returncode).not.toBe(0);
  expect(run.stderr).toContain("receipt id is required");
});

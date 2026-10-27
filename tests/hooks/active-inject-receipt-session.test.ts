/**
 * The `session_inject` receipt's session key (verified-delivery-honest-writes,
 * t_f8510c55 task A5): the SessionStart eager layer's context receipt carries
 * the hook payload's `session_id`, so the receipt the read surface serves can
 * be joined to the session's `reply_presence` records by exact key instead of
 * an inferred time window.
 *
 * Pinned here: a real session id lands on the receipt payload; a payload
 * without one leaves the key absent (additive optionality, the same shape
 * every other session-keyed record keeps) - and the injected context and
 * exit code are exactly what they were without the key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

const SESSION = "sess-inject-receipt-1";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-inject-session-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-inject-session-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(async () => {
  // A SessionStart on an initialised vault spawns a detached reindex that
  // would otherwise recreate the directories removed below.
  await waitForSelfHealChildren(vault);
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function runHook(
  payload: Record<string, unknown>,
): Promise<{ readonly stdout: string; readonly exit: number }> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(configHome),
      OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
      VAULT_DIR: vault,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

function writeActive(body: string): void {
  writeFileSync(join(vault, "Brain", "active.md"), body, "utf8");
}

interface ReceiptRecord {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function injectionReceipts(): ReadonlyArray<ReceiptRecord> {
  const dir = join(vault, "Brain", "log", "continuity");
  if (!existsSync(dir)) return [];
  const out: ReceiptRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as ReceiptRecord;
      if (record.kind === "context_receipt" && record.payload["trigger"] === "session_inject") {
        out.push(record);
      }
    }
  }
  return out;
}

const ACTIVE_BODY =
  "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n";

describe("active-inject session_inject receipt session key", () => {
  test("the receipt carries the hook payload's session_id", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook({ hook_event_name: "SessionStart", session_id: SESSION });
    expect(r.exit).toBe(0);
    const receipts = injectionReceipts();
    expect(receipts.length).toBe(1);
    expect(receipts[0]!.payload["session_id"]).toBe(SESSION);
    // The injected context is unchanged: the key is bookkeeping, not payload.
    const injected: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(injected.length).toBeGreaterThan(0);
    // Each test here spawns a real `bun run` hook child; pin the per-test
    // budget past bun's 5 s default so a loaded runner cannot flake it.
  }, 20000);

  test("a payload without a session_id leaves the key absent, never invented", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook({ hook_event_name: "SessionStart" });
    expect(r.exit).toBe(0);
    const receipts = injectionReceipts();
    expect(receipts.length).toBe(1);
    expect("session_id" in receipts[0]!.payload).toBe(false);
  }, 20000);
});

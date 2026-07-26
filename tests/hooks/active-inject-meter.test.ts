/**
 * Unit H - injection-size meter for the SessionStart eager layer.
 *
 * The hook is fail-soft by absolute contract, so every assertion here is
 * paired with the invariant that matters more than the measurement: the
 * emitted context and the exit code are what they were without the meter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-inject-meter-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-inject-meter-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: configHome,
    OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
    VAULT_DIR: vault,
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, exit };
}

function writeActive(body: string): void {
  writeFileSync(join(vault, "Brain", "active.md"), body, "utf8");
}

function writeLessons(body: string): void {
  writeFileSync(join(vault, "Brain", "lessons.md"), body, "utf8");
}

interface ReceiptRecord {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function readReceipts(): ReceiptRecord[] {
  const dir = join(vault, "Brain", "log", "continuity");
  if (!existsSync(dir)) return [];
  const out: ReceiptRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as ReceiptRecord);
    }
  }
  return out;
}

function injectionReceipts(): ReceiptRecord[] {
  return readReceipts().filter(
    (r) => r.kind === "context_receipt" && r.payload["trigger"] === "session_inject",
  );
}

const ACTIVE_BODY =
  "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n";
const LESSONS_BODY =
  "---\nkind: brain-lessons\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Lessons\n\n## Avoid (1)\n\n- `de-2026-05-18-x` (score: -0.95) — the flaky retry loop\n";

describe("active-inject injection meter", () => {
  test("records one session_inject receipt per injection with per-source bytes and tokens", async () => {
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);

    const r = await runHook({ hook_event_name: "SessionStart" });
    expect(r.exit).toBe(0);
    const injected: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

    const receipts = injectionReceipts();
    expect(receipts.length).toBe(1);
    const payload = receipts[0]!.payload;
    const injection = payload["injection"] as Record<string, unknown>;
    expect(injection["hook_event"]).toBe("SessionStart");
    expect(injection["loader_source"]).toBe("fresh");
    expect(injection["sources_measured"]).toBe(true);
    expect(injection["total_bytes"]).toBe(Buffer.byteLength(injected, "utf8"));
    expect(injection["total_tokens"]).toBe(Math.ceil(Buffer.byteLength(injected, "utf8") / 4));

    const items = payload["items"] as ReadonlyArray<Record<string, unknown>>;
    const byId = new Map(items.map((i) => [i["id"], i]));
    expect([...byId.keys()].toSorted()).toEqual(["active-body", "lessons-body"]);
    for (const item of items) {
      const bytes = item["bytes"] as number;
      expect(bytes).toBeGreaterThan(0);
      expect(item["tokens"]).toBe(Math.ceil(bytes / 4));
    }
  });

  test("scopes the meter to this hook and names the runtime-notice source", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook(
      { hook_event_name: "SessionStart" },
      { OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "true" },
    );
    expect(r.exit).toBe(0);
    const items = injectionReceipts()[0]!.payload["items"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(items.map((i) => i["id"]).toSorted()).toEqual(["active-body", "runtime-notices"]);
  });

  test("records the hook event name so a non-SessionStart injection is distinguishable", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook({ hook_event_name: "UserPromptSubmit" });
    expect(r.exit).toBe(0);
    const injection = injectionReceipts()[0]!.payload["injection"] as Record<string, unknown>;
    expect(injection["hook_event"]).toBe("UserPromptSubmit");
  });

  test("records the budget the sources were measured against", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 500\n",
      "utf8",
    );
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);
    const r = await runHook({ hook_event_name: "SessionStart" });
    expect(r.exit).toBe(0);
    const budget = injectionReceipts()[0]!.payload["budget"] as Record<string, unknown>;
    // Both budgeted sub-bodies are charged against the SAME configured
    // ceiling, so the effective ceiling is a multiple of it. The record
    // states both numbers rather than implying one.
    expect(budget["inject_budget_chars"]).toBe(500);
    expect(budget["budgeted_source_count"]).toBe(2);
  });

  test("a degraded-to-cache injection is distinguishable from a genuinely small one", async () => {
    writeActive(ACTIVE_BODY);
    const first = await runHook({ hook_event_name: "SessionStart" });
    expect(first.exit).toBe(0);
    const fresh: string = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;

    // A directory where active.md was makes the assembly throw, so the
    // fail-open loader degrades to the last-good cache.
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));

    const second = await runHook({ hook_event_name: "SessionStart" });
    expect(second.exit).toBe(0);
    const cached: string = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    expect(cached).toBe(fresh);

    const receipts = injectionReceipts();
    expect(receipts.length).toBe(2);
    const injection = receipts[1]!.payload["injection"] as Record<string, unknown>;
    expect(injection["loader_source"]).toBe("cached");
    // Nothing was assembled, so there is no per-source attribution to
    // report - and reporting zeros would be a finding that never happened.
    expect(injection["sources_measured"]).toBe(false);
    expect(receipts[1]!.payload["items"]).toEqual([]);
    expect(injection["total_bytes"]).toBe(Buffer.byteLength(cached, "utf8"));
  });

  test("a throwing receipt sink changes neither the emitted context nor the exit code", async () => {
    writeActive(ACTIVE_BODY);
    writeLessons(LESSONS_BODY);

    const healthy = await runHook({ hook_event_name: "SessionStart" });
    expect(healthy.exit).toBe(0);
    expect(injectionReceipts().length).toBe(1);

    // A regular file where the continuity store expects its directory
    // makes every append throw (mkdirSync recursive raises EEXIST).
    rmSync(join(vault, "Brain", "log", "continuity"), { recursive: true, force: true });
    writeFileSync(join(vault, "Brain", "log", "continuity"), "not a directory", "utf8");

    const broken = await runHook({ hook_event_name: "SessionStart" });
    expect(broken.exit).toBe(0);
    expect(broken.stdout).toBe(healthy.stdout);
  });
});

/**
 * Spawn tests for hooks/pretool-host-backup.ts - the opt-in PreToolUse
 * host-settings backup hook (t_f4555087). Four behavioral cases; the
 * path/collision combinatorics live in the pure-layer suite
 * (tests/core/brain/pretool-host-backup.test.ts).
 *
 * Spawn pattern shared with tests/hooks/pretool-orient.test.ts: each
 * case spawns the hook with a JSON payload on stdin and a per-case temp
 * HOME, then asserts stdout shape and on-disk effects.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homeEnv, IS_WINDOWS } from "../helpers/platform.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "pretool-host-backup.ts",
);

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let configHome: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-hook-hb-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "osb-hook-hb-cfg-"));
  home = mkdtempSync(join(tmpdir(), "osb-hook-hb-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), '{"theme":"dark"}\n');
});

afterEach(() => {
  for (const dir of [vault, configHome, home]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(configHome),
    OPEN_SECOND_BRAIN_VAULT: vault,
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

function writePayload(filePath: string): unknown {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: home,
    tool_use_id: "tu1",
    tool_name: "Write",
    tool_input: { file_path: filePath },
  };
}

function auditRecords(): Array<Record<string, unknown>> {
  const dir = join(vault, ".open-second-brain", "hook-audit");
  if (!existsSync(dir)) return [];
  const records: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.trim().length > 0) records.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return records;
}

describe("pretool-host-backup hook", () => {
  test("flag off: a settings-targeting Write is a byte-identical no-op (exit 0, no output, no ceiling work)", async () => {
    const r = await runHook(writePayload(join(home, ".claude", "settings.json")));
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    // Nothing backed up, nothing receipted.
    expect(existsSync(join(home, ".claude", ".o2b-backups"))).toBe(false);
    expect(auditRecords()).toEqual([]);
    // The settings file itself is untouched (the hook never writes it).
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe('{"theme":"dark"}\n');
  });

  test("flag on: a Write to the settings file produces a backup, one receipt, and no deny", async () => {
    const r = await runHook(writePayload(join(home, ".claude", "settings.json")), {
      OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true",
    });
    expect(r.exit).toBe(0);
    // No deny on the only channel that survives the fail-soft dispatcher.
    expect(r.stdout).not.toContain('"deny"');
    const backupRoot = join(home, ".claude", ".o2b-backups", "settings.json");
    expect(existsSync(backupRoot)).toBe(true);
    const backups = readdirSync(backupRoot);
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupRoot, backups[0]!), "utf8")).toBe('{"theme":"dark"}\n');
    // Exactly one receipt line carrying the trust receipt head.
    const records = auditRecords();
    expect(records.length).toBe(1);
    const record = records[0] as {
      actor: string;
      ok: boolean;
      target: string;
      details: Record<string, unknown>;
    };
    expect(record.actor).toContain("hook:");
    expect(record.ok).toBe(true);
    expect(record.target).toBe(join(home, ".claude", "settings.json"));
    expect(record.details["before_hash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The receipt records the spawned hook process, not this test.
    expect(typeof record.details["pid"]).toBe("number");
    expect(String(record.details["summary"])).toContain("settings.json");
    expect(record.details["backup"]).toBe(join(backupRoot, backups[0]!));
  });

  test.skipIf(IS_WINDOWS)(
    "flag on: the wrapper twin's backup is private 0600, same as the canonical core",
    async () => {
      const r = await runHook(writePayload(join(home, ".claude", "settings.json")), {
        OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true",
      });
      expect(r.exit).toBe(0);
      const backupRoot = join(home, ".claude", ".o2b-backups", "settings.json");
      const backups = readdirSync(backupRoot);
      expect(backups.length).toBe(1);
      expect(statSync(join(backupRoot, backups[0]!)).mode & 0o777).toBe(0o600);
    },
  );

  test("flag on with a backup made to fail emits a stdout deny naming the path", async () => {
    // A FILE where the backup folder must be makes the backup impossible.
    writeFileSync(join(home, ".claude", ".o2b-backups"), "not a dir\n");
    const target = join(home, ".claude", "settings.json");
    const r = await runHook(writePayload(target), {
      OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true",
    });
    expect(r.exit).toBe(0); // the dispatcher contract: the deny rides stdout
    expect(r.stdout).toContain('"permissionDecision":"deny"');
    expect(r.stdout).toContain(target);
    // The settings file was not touched by the hook.
    expect(readFileSync(target, "utf8")).toBe('{"theme":"dark"}\n');
  });

  test("flag on without a vault skips the receipt but still backs up", async () => {
    const r = await runHook(writePayload(join(home, ".claude", "settings.json")), {
      OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true",
      OPEN_SECOND_BRAIN_VAULT: "", // no vault resolved
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toContain('"deny"');
    const backupRoot = join(home, ".claude", ".o2b-backups", "settings.json");
    expect(existsSync(backupRoot)).toBe(true);
    // A missing vault degrades the receipt, never the backup or the call.
    expect(auditRecords()).toEqual([]);
  });
});

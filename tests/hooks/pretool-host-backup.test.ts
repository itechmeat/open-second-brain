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
  symlinkSync,
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

function writePayload(filePath: string): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: home,
    tool_use_id: "tu1",
    tool_name: "Write",
    tool_input: { file_path: filePath },
  };
}

function applyPatchPayload(patchBody: string): unknown {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: home,
    tool_use_id: "tu1",
    tool_name: "apply_patch",
    tool_input: { input: patchBody },
  };
}

function auditRecords(from: string = vault): Array<Record<string, unknown>> {
  const dir = join(from, ".open-second-brain", "hook-audit");
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

  test("flag on: a Write that CREATES a missing settings file is a silent allow (twin's allow-no-source)", async () => {
    // The canonical twin allows a missing source ("nothing to protect",
    // tests/core/brain/pretool-host-backup.test.ts): a fresh
    // settings.local.json must be creatable with the flag on, not denied
    // for having no prior bytes to back up.
    const target = join(home, ".claude", "settings.local.json");
    expect(existsSync(target)).toBe(false);
    const r = await runHook(writePayload(target), {
      OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true",
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toContain('"deny"');
    // Nothing existed to back up: no backup folder, no receipt.
    expect(existsSync(join(home, ".claude", ".o2b-backups"))).toBe(false);
    expect(auditRecords()).toEqual([]);
  });

  test("flag on: a '#' inside a quoted config value does not truncate the receipt vault", async () => {
    const configVault = mkdtempSync(join(tmpdir(), "osb-hook-hb-cfgvault-"));
    writeFileSync(
      join(configHome, "config.yaml"),
      `host_settings_backup: true\nvault: "${join(configVault, "brain#main")}"\n`,
    );
    try {
      const r = await runHook(writePayload(join(home, ".claude", "settings.json")), {
        OPEN_SECOND_BRAIN_VAULT: "", // vault comes from the config, not the env
        OPEN_SECOND_BRAIN_CONFIG: join(configHome, "config.yaml"),
      });
      expect(r.exit).toBe(0);
      expect(r.stdout).not.toContain('"deny"');
      expect(existsSync(join(home, ".claude", ".o2b-backups"))).toBe(true);
      // The receipt lands under the FULL quoted path, hash included - not
      // under a value truncated at the `#` as if it began a YAML comment.
      const records = auditRecords(join(configVault, "brain#main"));
      expect(records.length).toBe(1);
      expect(records[0]!["action"]).toBe("host-settings-backup");
    } finally {
      rmSync(configVault, { recursive: true, force: true });
    }
  });

  test("flag on with a backup made to fail emits a stdout deny naming the path", async () => {
    // A FILE where the backup folder must be makes the backup impossible.
    writeFileSync(join(home, ".claude", ".o2b-backups"), "not a dir\n");
    const target = join(home, ".claude", "settings.json");
    const r = await runHook(writePayload(target), {
      OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true",
    });
    expect(r.exit).toBe(0); // the dispatcher contract: the deny rides stdout
    expect(r.stdout).toContain('"permissionDecision":"deny"');
    // The deny names the target. Stdout is JSON, and on Windows the
    // path's separators arrive JSON-escaped (`\\`), so match the PARSED
    // reason, not the raw bytes.
    const decision = JSON.parse(r.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(target);
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

  test("flag on: an apply_patch Update File on a protected path backs up (Codex lane)", async () => {
    const target = join(home, ".claude", "settings.json");
    const r = await runHook(
      applyPatchPayload("*** Begin Patch\n*** Update File: " + target + "\n@@\n- old\n+ new\n"),
      { OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toContain('"deny"');
    const backupRoot = join(home, ".claude", ".o2b-backups", "settings.json");
    const backups = readdirSync(backupRoot);
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupRoot, backups[0]!), "utf8")).toBe('{"theme":"dark"}\n');
    const records = auditRecords();
    expect(records.length).toBe(1);
    expect((records[0] as { target: string }).target).toBe(target);
  });

  test("flag on: an apply_patch patch with several targets backs up each protected one", async () => {
    const local = join(home, ".claude", "settings.local.json");
    writeFileSync(local, '{"allow":["Bash"]}\n');
    const notes = join(home, "notes.md");
    writeFileSync(notes, "x\n");
    const r = await runHook(
      applyPatchPayload(
        "*** Begin Patch\n" +
          "*** Add File: " +
          notes +
          "\n+hello\n" +
          "*** Update File: " +
          join(home, ".claude", "settings.json") +
          "\n@@\n" +
          "*** Delete File: " +
          local +
          "\n",
      ),
      { OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toContain('"deny"');
    const backupRoot = join(home, ".claude", ".o2b-backups");
    // One folder per protected file name; notes.md has none. The
    // `*`-ignore marker (git hygiene) sits beside the folders.
    expect(readdirSync(backupRoot).toSorted()).toEqual([
      ".gitignore",
      "settings.json",
      "settings.local.json",
    ]);
    // Exactly one receipt per protected target, none for notes.md.
    expect(auditRecords().length).toBe(2);
  });

  test.skipIf(IS_WINDOWS)(
    "flag on: a settings file that is itself a symlink is backed up through the link",
    async () => {
      const dotfiles = join(home, "dotfiles");
      mkdirSync(dotfiles, { recursive: true });
      const real = join(dotfiles, "claude-settings.json");
      writeFileSync(real, '{"theme":"stow"}\n');
      const target = join(home, ".claude", "settings.json");
      rmSync(target);
      symlinkSync(real, target);

      const r = await runHook(writePayload(target), {
        OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true",
      });
      expect(r.exit).toBe(0);
      expect(r.stdout).not.toContain('"deny"');
      // The backup lands beside the path the agent writes through, and
      // holds the real bytes (read through the link).
      const backupRoot = join(home, ".claude", ".o2b-backups", "settings.json");
      const backups = readdirSync(backupRoot);
      expect(backups.length).toBe(1);
      expect(readFileSync(join(backupRoot, backups[0]!), "utf8")).toBe('{"theme":"stow"}\n');
    },
  );

  test("flag on: the first project backup drops a *-ignore into the backups root", async () => {
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".claude"), { recursive: true });
    const local = join(proj, ".claude", "settings.local.json");
    writeFileSync(local, '{"allow":["Bash"]}\n');
    const payload = { ...writePayload(local), cwd: proj };
    const r = await runHook(payload, { OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP: "true" });
    expect(r.exit).toBe(0);
    expect(r.stdout).not.toContain('"deny"');
    const ignorePath = join(proj, ".claude", ".o2b-backups", ".gitignore");
    expect(existsSync(ignorePath)).toBe(true);
    const text = readFileSync(ignorePath, "utf8");
    expect(text).toContain("*");
    expect(text).toContain("!.gitignore");
  });
});

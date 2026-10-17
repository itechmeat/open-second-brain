/**
 * Tests for src/core/brain/pretool-host-backup.ts - the pure decision
 * core and fail-closed backup executor behind the opt-in PreToolUse
 * host-settings backup hook (t_f4555087).
 *
 * The matcher resolves tilde, cwd-relative and symlinked forms of a
 * Claude settings path to one canonical target; anything else allows.
 * The executor backs the file up under the trust conventions' stamped
 * folder (tests/core/trust-conventions.test.ts), never overwrites a
 * same-second backup, and appends exactly one receipt carrying actor,
 * pid, before-hash and summary.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { join, sep } from "node:path";

import {
  decideHostBackup,
  executeHostBackup,
  HostBackupError,
  HOST_BACKUP_ALLOC_MAX_ATTEMPTS,
  PROTECTED_SETTINGS_NAMES,
  WRITE_TOOL_NAMES,
} from "../../../src/core/brain/pretool-host-backup.ts";
import { hookAuditDir } from "../../../src/core/brain/paths.ts";
import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";

/** Minimal audit reader: every record in the (single-shard) audit root. */
function readAuditRecords(auditDir: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(auditDir)) {
    for (const line of readFileSync(join(auditDir, file), "utf8").split("\n")) {
      if (line.trim().length > 0) records.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return records;
}

let tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function decide(home: string, cwd: string, filePath: string, toolName = "Write") {
  return decideHostBackup({
    runtime: "claudecode",
    toolName,
    toolInput: { file_path: filePath },
    home,
    cwd,
  });
}

describe("decideHostBackup", () => {
  test("tilde, cwd-relative and symlinked settings paths resolve to one canonical target", () => {
    const home = tmpDir("osb-hb-home-");
    mkdirSync(join(home, "f", ".claude"), { recursive: true });
    writeFileSync(join(home, "f", ".claude", "settings.json"), "{}\n");

    const tilde = decide(home, home, "~/f/.claude/settings.json");
    const relative = decide(home, join(home, "f"), ".claude/settings.json");
    // A symlinked settings dir resolving at the same file. A directory
    // junction needs no symlink privilege on Windows and is a plain
    // symlink on POSIX - the one portable way to build this fixture.
    symlinkSync(join(home, "f", ".claude"), join(home, "linked-claude"), "junction");
    const symlinked = decide(home, home, join(home, "linked-claude", "settings.json"));

    for (const d of [tilde, relative, symlinked]) {
      expect(d.kind).toBe("backup");
    }
    const target = tilde.kind === "backup" ? tilde.targets[0]! : "";
    expect(relative.kind === "backup" && relative.targets[0]).toBe(target);
    expect(symlinked.kind === "backup" && symlinked.targets[0]).toBe(target);
    // The canonical target names the real .claude settings file; the
    // comparison is separator-agnostic so the win32 spelling matches.
    expect(target.split(sep).join("/").endsWith(".claude/settings.json")).toBe(true);
  });

  test("settings.local.json and the user-level settings file are protected", () => {
    const home = tmpDir("osb-hb-home2-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.local.json"), "{}\n");
    const local = decide(home, home, "~/.claude/settings.local.json");
    expect(local.kind).toBe("backup");
    const user = decide(home, home, "~/.claude/settings.json");
    expect(user.kind).toBe("backup");
    // The names the predicate matches, named once.
    expect([...PROTECTED_SETTINGS_NAMES]).toEqual(["settings.json", "settings.local.json"]);
    expect([...WRITE_TOOL_NAMES]).toEqual(["Write", "Edit", "MultiEdit", "apply_patch"]);
  });

  test("unrelated paths return allow", () => {
    const home = tmpDir("osb-hb-home3-");
    mkdirSync(join(home, "proj"), { recursive: true });
    writeFileSync(join(home, "proj", "note.md"), "hi\n");
    for (const p of [
      "~/f/Brain/note.md",
      ".claude/other.json",
      "settings.json",
      "~/f/.claude/settings.json.bak.123",
      "/etc/passwd",
    ]) {
      const d = decide(home, join(home, "proj"), p);
      expect(d.kind).toBe("allow");
    }
  });

  test("codex config.toml is excluded: protect's own fence manages it", () => {
    const home = tmpDir("osb-hb-home4-");
    const d = decide(home, home, "~/.codex/config.toml");
    expect(d.kind).toBe("allow");
  });

  test("a non-write tool or a missing path argument allows", () => {
    const home = tmpDir("osb-hb-home5-");
    const read = decideHostBackup({
      runtime: "claudecode",
      toolName: "Read",
      toolInput: { file_path: "~/.claude/settings.json" },
      home,
      cwd: home,
    });
    expect(read.kind).toBe("allow");
    const noPath = decideHostBackup({
      runtime: "claudecode",
      toolName: "Write",
      toolInput: {},
      home,
      cwd: home,
    });
    expect(noPath.kind).toBe("allow");
  });
});

describe("decideHostBackup — Codex apply_patch payloads", () => {
  test("an Update File header naming a protected path backs up", () => {
    const home = tmpDir("osb-hb-ap-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    const d = decideHostBackup({
      runtime: "codex",
      toolName: "apply_patch",
      toolInput: {
        input:
          "*** Begin Patch\n*** Update File: " +
          join(home, ".claude", "settings.json") +
          "\n@@\n- old\n+ new\n*** End Patch",
      },
      home,
      cwd: home,
    });
    expect(d.kind).toBe("backup");
    if (d.kind !== "backup") return;
    expect(d.targets).toEqual([join(home, ".claude", "settings.json")]);
  });

  test("every header path is collected; only the protected ones back up", () => {
    const home = tmpDir("osb-hb-ap2-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude", "settings.local.json"), "{}\n");
    writeFileSync(join(home, "notes.md"), "x\n");
    const d = decideHostBackup({
      runtime: "codex",
      toolName: "apply_patch",
      toolInput: {
        input:
          "*** Begin Patch\n" +
          "*** Add File: " +
          join(home, "notes.md") +
          "\n+hello\n" +
          "*** Update File: " +
          join(home, ".claude", "settings.json") +
          "\n@@\n" +
          "*** Delete File: " +
          join(home, ".claude", "settings.local.json") +
          "\n*** End Patch",
      },
      home,
      cwd: home,
    });
    expect(d.kind).toBe("backup");
    if (d.kind !== "backup") return;
    expect(d.targets).toEqual([
      join(home, ".claude", "settings.json"),
      join(home, ".claude", "settings.local.json"),
    ]);
  });

  test("a relative header path resolves against the hook cwd", () => {
    const home = tmpDir("osb-hb-ap3-");
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.local.json"), "{}\n");
    const d = decideHostBackup({
      runtime: "codex",
      toolName: "apply_patch",
      toolInput: { input: "*** Begin Patch\n*** Add File: .claude/settings.local.json\n+{}\n" },
      home,
      cwd: proj,
    });
    expect(d.kind).toBe("backup");
    if (d.kind !== "backup") return;
    expect(d.targets).toEqual([join(proj, ".claude", "settings.local.json")]);
  });
});

describe("decideHostBackup — symlinked settings files", () => {
  test("a settings file that is itself a symlink is protected via its lexical path", () => {
    const home = tmpDir("osb-hb-symlink-");
    mkdirSync(join(home, "dotfiles"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const real = join(home, "dotfiles", "settings.json");
    writeFileSync(real, '{"theme":"dark"}\n');
    symlinkSync(real, join(home, ".claude", "settings.json"));

    // The realpath resolves the final component into the dotfiles dir,
    // whose parent is not `.claude`; the lexical path the agent names
    // IS a `.claude` settings file, and either match protects.
    const d = decide(home, home, "~/.claude/settings.json");
    expect(d.kind).toBe("backup");
    if (d.kind !== "backup") return;
    expect(d.targets).toEqual([join(home, ".claude", "settings.json")]);
  });

  test("the symlinked file's backup carries the real bytes through the link", () => {
    const home = tmpDir("osb-hb-symlink2-");
    mkdirSync(join(home, "dotfiles"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const real = join(home, "dotfiles", "settings.json");
    const contents = '{"token":"s3cret"}\n';
    writeFileSync(real, contents);
    const lexical = join(home, ".claude", "settings.json");
    symlinkSync(real, lexical);

    const out = executeHostBackup({
      target: lexical,
      vault: null,
      now: new Date("2026-10-16T12:34:56Z"),
      actor: "hook:claudecode",
    });
    expect(out.kind).toBe("backed-up");
    if (out.kind !== "backed-up") return;
    expect(readFileSync(out.backupPath, "utf8")).toBe(contents);
  });
});

describe("executeHostBackup — backups root git hygiene", () => {
  test("the first project backup drops a *-ignore into the backups root", () => {
    const home = tmpDir("osb-hb-ignore-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, ".claude", "settings.local.json");
    writeFileSync(target, '{"allow":["Bash"]}\n');
    const out = executeHostBackup({
      target,
      vault: null,
      now: new Date("2026-10-16T12:34:56Z"),
      actor: "hook:claudecode",
    });
    expect(out.kind).toBe("backed-up");
    if (out.kind !== "backed-up") return;
    // settings.local.json copies can hold tokens; without this marker
    // the next `git add -A` commits them from a project repo.
    const ignorePath = join(home, ".claude", ".o2b-backups", ".gitignore");
    expect(existsSync(ignorePath)).toBe(true);
    const text = readFileSync(ignorePath, "utf8");
    expect(text).toContain("*");
    expect(text).toContain("!.gitignore");
  });

  test("a second backup never rewrites the ignore file", () => {
    const home = tmpDir("osb-hb-ignore2-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, ".claude", "settings.json");
    writeFileSync(target, "x\n");
    const opts = {
      target,
      vault: null,
      now: new Date("2026-10-16T12:34:56Z"),
      actor: "hook:claudecode",
    };
    executeHostBackup(opts);
    const ignorePath = join(home, ".claude", ".o2b-backups", ".gitignore");
    const before = readFileSync(ignorePath, "utf8");
    executeHostBackup({ ...opts, now: new Date("2026-10-16T12:34:57Z") });
    expect(readFileSync(ignorePath, "utf8")).toBe(before);
  });
});

describe("executeHostBackup", () => {
  test("two backups inside one second produce two distinct files", () => {
    const home = tmpDir("osb-hb-exec-");
    const vault = tmpDir("osb-hb-vault-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, ".claude", "settings.json");
    writeFileSync(target, '{"theme":"dark"}\n');
    const now = new Date("2026-10-16T12:34:56Z");

    const first = executeHostBackup({ target, vault, now, actor: "hook:claudecode" });
    const second = executeHostBackup({ target, vault, now, actor: "hook:claudecode" });
    expect(first.kind).toBe("backed-up");
    expect(second.kind).toBe("backed-up");
    if (first.kind !== "backed-up" || second.kind !== "backed-up") return;
    expect(first.backupPath).not.toBe(second.backupPath);
    // Both hold the exact source bytes.
    expect(readFileSync(first.backupPath, "utf8")).toBe('{"theme":"dark"}\n');
    expect(readFileSync(second.backupPath, "utf8")).toBe('{"theme":"dark"}\n');
    // Folder layout: <dir>/.o2b-backups/settings.json/<stamp>[-N].
    // Separator-agnostic: the win32 backup path is backslash-joined.
    expect(first.backupPath.split(sep).join("/")).toContain(
      ".o2b-backups/settings.json/2026-10-16-123456",
    );
  });

  test.skipIf(IS_WINDOWS)(
    "the backup file is private 0600 - settings backups carry secrets",
    () => {
      const home = tmpDir("osb-hb-mode-");
      const vault = tmpDir("osb-hb-vault-mode-");
      mkdirSync(join(home, ".claude"), { recursive: true });
      const target = join(home, ".claude", "settings.json");
      writeFileSync(target, '{"token":"s3cret"}\n');
      const out = executeHostBackup({
        target,
        vault,
        now: new Date("2026-10-16T12:34:56Z"),
        actor: "hook:claudecode",
      });
      expect(out.kind).toBe("backed-up");
      if (out.kind !== "backed-up") return;
      // Both twins agree with the wrapper's openSync(..., "wx", 0o600):
      // the canonical core creates exclusively at the same private mode.
      expect(statSync(out.backupPath).mode & 0o777).toBe(0o600);
    },
  );

  test("exhausted collision attempts raise a typed error, never overwriting", () => {
    const home = tmpDir("osb-hb-exh-");
    const vault = tmpDir("osb-hb-vault2-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, ".claude", "settings.json");
    writeFileSync(target, "x\n");
    // Pre-create every candidate name the allocator may try.
    const backupRoot = join(home, ".claude", ".o2b-backups", "settings.json");
    mkdirSync(backupRoot, { recursive: true });
    const now = new Date("2026-10-16T12:34:56Z");
    for (let attempt = 1; attempt <= HOST_BACKUP_ALLOC_MAX_ATTEMPTS; attempt++) {
      const name = attempt === 1 ? "2026-10-16-123456" : `2026-10-16-123456-${attempt}`;
      writeFileSync(join(backupRoot, name), "occupied\n");
    }
    let raised: unknown = null;
    try {
      executeHostBackup({ target, vault, now, actor: "hook:claudecode" });
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(HostBackupError);
    expect((raised as Error).message).toContain(target);
    // Nothing was overwritten.
    expect(readFileSync(join(backupRoot, "2026-10-16-123456"), "utf8")).toBe("occupied\n");
  });

  test("a missing source file allows with no receipt", () => {
    const home = tmpDir("osb-hb-miss-");
    const vault = tmpDir("osb-hb-vault3-");
    const target = join(home, ".claude", "settings.json");
    const out = executeHostBackup({ target, vault, now: new Date(), actor: "hook:claudecode" });
    expect(out.kind).toBe("allow-no-source");
    expect(existsSync(hookAuditDir(vault))).toBe(false);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable source returns a typed failure naming the path",
    () => {
      const home = tmpDir("osb-hb-unread-");
      const vault = tmpDir("osb-hb-vault4-");
      mkdirSync(join(home, ".claude"), { recursive: true });
      const target = join(home, ".claude", "settings.json");
      writeFileSync(target, "secret\n");
      chmodSync(target, 0o000);
      try {
        let raised: unknown = null;
        try {
          executeHostBackup({ target, vault, now: new Date(), actor: "hook:claudecode" });
        } catch (e) {
          raised = e;
        }
        expect(raised).toBeInstanceOf(HostBackupError);
        expect((raised as Error).message).toContain(target);
      } finally {
        chmodSync(target, 0o644);
      }
    },
  );

  test("a failed copy raises a typed failure naming the path", () => {
    const home = tmpDir("osb-hb-failcopy-");
    const vault = tmpDir("osb-hb-vault5-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, ".claude", "settings.json");
    writeFileSync(target, "x\n");
    // A FILE where the backup folder must be makes every create fail.
    writeFileSync(join(home, ".claude", ".o2b-backups"), "not a dir\n");
    let raised: unknown = null;
    try {
      executeHostBackup({ target, vault, now: new Date(), actor: "hook:claudecode" });
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(HostBackupError);
    expect((raised as Error).message).toContain(target);
  });

  test("success appends exactly one receipt with actor, pid, before-hash, summary", () => {
    const home = tmpDir("osb-hb-rcpt-");
    const vault = tmpDir("osb-hb-vault6-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, ".claude", "settings.json");
    const contents = '{"theme":"dark"}\n';
    writeFileSync(target, contents);
    const out = executeHostBackup({
      target,
      vault,
      now: new Date("2026-10-16T12:34:56Z"),
      actor: "hook:claudecode",
    });
    expect(out.kind).toBe("backed-up");
    if (out.kind !== "backed-up") return;
    // Exactly one audit record across the whole week shard.
    const auditDir = hookAuditDir(vault);
    const files = readdirSync(auditDir);
    expect(files.length).toBe(1);
    const records = readAuditRecords(auditDir);
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.actor).toBe("hook:claudecode");
    expect(r.ok).toBe(true);
    expect(r.target).toBe(target);
    // The trust receipt head (tests/core/trust-conventions.test.ts).
    expect(r.details).toBeDefined();
    const details = r.details as Record<string, unknown>;
    expect(details["pid"]).toBe(process.pid);
    expect(details["before_hash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(details["summary"])).toContain("settings.json");
    expect(details["backup"]).toBe(out.backupPath);
    // The hash is the source content's sha-256.
    const digest = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
    expect(details["before_hash"]).toBe(`sha256:${digest}`);
  });

  test("a missing vault skips the receipt without failing the backup", () => {
    const home = tmpDir("osb-hb-novault-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const target = join(home, ".claude", "settings.json");
    writeFileSync(target, "x\n");
    const out = executeHostBackup({
      target,
      vault: null,
      now: new Date(),
      actor: "hook:claudecode",
    });
    expect(out.kind).toBe("backed-up");
    if (out.kind !== "backed-up") return;
    expect(out.receiptPath).toBeNull();
    expect(existsSync(out.backupPath)).toBe(true);
  });
});

/**
 * `scripts/sync-plugin-mirrors.ts` - the Codex plugin ships real files, not
 * symlinks, and they stay byte-identical to their sources.
 *
 * Codex copies only `plugins/codex/` into its plugin cache and drops
 * symlinks on the way, so a symlinked `hooks` or `skills` dir there reached
 * users as nothing at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_SESSION_END_TIMEOUT_CAP_SEC,
  codexHooksJson,
  codexWindowsHookCommand,
  findDrift,
  writeMirrors,
} from "../../scripts/sync-plugin-mirrors.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

type HookGroups = Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;

describe("the repository", () => {
  test("the Codex plugin mirrors are in sync with their sources", () => {
    expect(findDrift(REPO_ROOT)).toEqual([]);
  });

  test("no plugin directory tracks a symlink", () => {
    // Mode 120000 is a symlink in the git index. Checked in the index rather
    // than on disk because a Windows checkout without `core.symlinks`
    // materialises one as a plain file, which the disk check cannot tell apart.
    const r = spawnSync("git", ["ls-files", "-s", "--", "plugins", ".agents"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (r.status !== 0) return; // not a git checkout (a packed tarball)
    const links = r.stdout.split("\n").filter((line) => line.startsWith("120000 "));
    expect(links).toEqual([]);
  });

  test("the Codex hooks mirror carries hooks.json only, never the hook scripts", () => {
    // Codex exports CLAUDE_PLUGIN_ROOT as its cache dir; a `.ts` hook there
    // would win `o2b-hook`'s resolution and then fail on `../src` imports.
    const hooksJson = join(REPO_ROOT, "plugins/codex/hooks/hooks.json");
    expect(existsSync(hooksJson)).toBe(true);
    expect(existsSync(join(REPO_ROOT, "plugins/codex/hooks/active-inject.ts"))).toBe(false);
  });
});

describe("the Codex hooks.json", () => {
  test("caps SessionEnd timeouts at the Codex limit and leaves everything else alone", () => {
    const source = readFileSync(join(REPO_ROOT, "hooks/hooks.json"), "utf8");
    const src = JSON.parse(source);
    const out = JSON.parse(codexHooksJson(source));

    const sessionEnd = out.hooks.SessionEnd.flatMap((g: { hooks: unknown[] }) => g.hooks);
    expect(sessionEnd.length).toBeGreaterThan(0);
    for (const hook of sessionEnd) {
      expect(hook.timeout).toBeLessThanOrEqual(CODEX_SESSION_END_TIMEOUT_CAP_SEC);
    }

    // Apart from those timeouts and the added Windows commands, the Codex
    // copy is the shared file.
    for (const group of src.hooks.SessionEnd) {
      for (const hook of group.hooks)
        hook.timeout = Math.min(hook.timeout, CODEX_SESSION_END_TIMEOUT_CAP_SEC);
    }
    for (const groups of Object.values(out.hooks) as HookGroups[]) {
      for (const group of groups) {
        for (const hook of group.hooks) delete hook.commandWindows;
      }
    }
    expect(out).toEqual(src);
  });

  test("gives every hook a cmd.exe form that runs the same o2b-hook", () => {
    // On Windows Codex runs `%COMSPEC% /C "<command>"`, which cannot parse
    // the POSIX command, unless the hook carries `commandWindows`.
    const source = readFileSync(join(REPO_ROOT, "hooks/hooks.json"), "utf8");
    const out = JSON.parse(codexHooksJson(source));
    let count = 0;
    for (const groups of Object.values(out.hooks) as HookGroups[]) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          const name = /exec o2b-hook ([a-z0-9-]+); exit 0$/.exec(hook.command)?.[1];
          expect(name).toBeDefined();
          expect(hook.commandWindows).toBe(codexWindowsHookCommand(name!));
          const keys = Object.keys(hook);
          expect(keys.indexOf("commandWindows")).toBe(keys.indexOf("command") + 1);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  test("the cmd.exe form never looks in the current directory and never blocks", () => {
    const cmd = codexWindowsHookCommand("session-capture");
    // Set before the first bare command name, so neither `where` nor
    // `o2b-hook` resolves from the project Codex opened.
    expect(cmd.startsWith("set NoDefaultCurrentDirectoryInExePath=1&")).toBe(true);
    // A bare `where` searches the current directory; `$PATH:` does not.
    expect(cmd).toContain("where /q $PATH:o2b-hook && o2b-hook session-capture");
    expect(cmd.endsWith("& exit /b 0")).toBe(true);
    // Codex wraps the line in one pair of quotes, which cmd.exe strips
    // cleanly only while the line holds no other quote; a `%` would expand.
    expect(cmd).not.toMatch(/["%]/);
  });

  test("refuses a hook command whose Windows form it cannot derive", () => {
    const source = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }] },
    });
    expect(() => codexHooksJson(source)).toThrow(/cannot derive its Windows form/);
  });

  test("keeps the source's formatting, so the mirror passes fmt:check", () => {
    // With the timeouts already within the cap, everything but the added
    // commandWindows lines is the source, byte for byte.
    const source = readFileSync(join(REPO_ROOT, "hooks/hooks.json"), "utf8").replace(
      /"timeout": 10/g,
      '"timeout": 2',
    );
    const out = codexHooksJson(source)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith('"commandWindows": '))
      .join("\n");
    expect(out).toBe(source);
  });
});

describe("drift detection", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osb-plugin-mirrors-"));
    mkdirSync(join(root, "skills/alpha"), { recursive: true });
    writeFileSync(join(root, "skills/alpha/SKILL.md"), "alpha\n");
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks/hooks.json"), '{"hooks":{}}\n');
    writeFileSync(join(root, "hooks/active-inject.ts"), "// not mirrored\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a fresh write is clean, and copies only what the specs name", () => {
    expect(writeMirrors(root)).toBe(2);
    expect(findDrift(root)).toEqual([]);
    expect(readFileSync(join(root, "plugins/codex/skills/alpha/SKILL.md"), "utf8")).toBe("alpha\n");
    expect(existsSync(join(root, "plugins/codex/hooks/active-inject.ts"))).toBe(false);
  });

  test("a missing, a changed and an extra file are each reported", () => {
    writeMirrors(root);
    writeFileSync(join(root, "skills/alpha/SKILL.md"), "alpha, edited\n");
    mkdirSync(join(root, "skills/beta"));
    writeFileSync(join(root, "skills/beta/SKILL.md"), "beta\n");
    writeFileSync(join(root, "plugins/codex/skills/stale.md"), "gone upstream\n");

    expect(findDrift(root)).toEqual([
      { path: "plugins/codex/skills/stale.md", reason: "extra" },
      { path: "plugins/codex/skills/alpha/SKILL.md", reason: "differs" },
      { path: "plugins/codex/skills/beta/SKILL.md", reason: "missing" },
    ]);

    writeMirrors(root);
    expect(findDrift(root)).toEqual([]);
    expect(existsSync(join(root, "plugins/codex/skills/stale.md"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a symlinked mirror dir is drift, and a write replaces it with real files",
    () => {
      mkdirSync(join(root, "plugins/codex"), { recursive: true });
      symlinkSync("../../skills", join(root, "plugins/codex/skills"));
      symlinkSync("../../hooks", join(root, "plugins/codex/hooks"));

      expect(findDrift(root)).toEqual([
        { path: "plugins/codex/skills", reason: "symlink" },
        { path: "plugins/codex/hooks", reason: "symlink" },
      ]);

      writeMirrors(root);
      expect(findDrift(root)).toEqual([]);
      expect(existsSync(join(root, "hooks/active-inject.ts"))).toBe(true);
    },
  );
});

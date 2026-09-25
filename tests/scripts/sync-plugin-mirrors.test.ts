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
  findDrift,
  writeMirrors,
} from "../../scripts/sync-plugin-mirrors.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

    // Apart from those timeouts, the Codex copy is the shared file.
    for (const group of src.hooks.SessionEnd) {
      for (const hook of group.hooks)
        hook.timeout = Math.min(hook.timeout, CODEX_SESSION_END_TIMEOUT_CAP_SEC);
    }
    expect(out).toEqual(src);
  });

  test("keeps the source's formatting, so the mirror passes fmt:check", () => {
    const source = readFileSync(join(REPO_ROOT, "hooks/hooks.json"), "utf8");
    expect(codexHooksJson(source.replace(/"timeout": 10/g, '"timeout": 2'))).toBe(
      source.replace(/"timeout": 10/g, '"timeout": 2'),
    );
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

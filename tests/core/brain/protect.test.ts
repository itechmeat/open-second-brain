import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  applyProtect,
  BrainProtectError,
  buildProtectRules,
  claudeCodeRulePath,
  computeProtect,
  computeUnprotect,
  printSnippet,
  PROTECT_SCHEMA_VERSION,
  readManifest,
  renderClaudeCode,
  renderCodex,
  unprotect,
  writeManifest,
} from "../../../src/core/brain/protect.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";

const tmpRoots: string[] = [];

/**
 * The rules carry the vault's ABSOLUTE path with forward slashes on every
 * host (both permission matchers want POSIX-shaped paths), so a POSIX
 * literal like `/vault` resolves to `C:/vault` on Windows. Expected values
 * are derived the same way instead of being hardcoded.
 */
function abs(p: string): string {
  return resolve(p).replaceAll("\\", "/");
}
const V = abs("/vault");
const VS = abs("/v");

/**
 * The same absolute path as a Claude Code permission rule spells it:
 * `//` anchors at the filesystem root (a single `/` would anchor at the
 * project), and on Windows the drive becomes a lower-case POSIX segment
 * (`C:/vault` -> `//c/vault`). Spelled out independently of the helper
 * under test.
 */
function cc(absPosix: string): string {
  const drive = /^([A-Za-z]):\/(.*)$/.exec(absPosix);
  return drive ? `//${drive[1]!.toLowerCase()}/${drive[2]}` : `/${absPosix}`;
}

function mkVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
  mkdirSync(join(dir, "Brain"), { recursive: true });
  tmpRoots.push(dir);
  return dir;
}

function mkHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-codex-home-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpRoots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // tmp cleanup is best-effort
    }
  }
});

describe("buildProtectRules", () => {
  test("returns 11 rules in stable order for a given vault", () => {
    const rules = buildProtectRules("/vault");
    // 5 deny paths × 2 actions (Write+Edit) + 1 allow.
    expect(rules).toHaveLength(11);
    expect(rules[0]).toEqual({
      kind: "deny",
      action: "Write",
      path: `${V}/Brain/preferences/**`,
    });
    const last = rules[rules.length - 1];
    expect(last).toEqual({
      kind: "allow",
      action: "Write",
      path: `${V}/Brain/inbox/**`,
    });
  });

  test("denies cover the five protected sub-paths", () => {
    const rules = buildProtectRules("/v");
    const denyPaths = Array.from(
      new Set(rules.filter((r) => r.kind === "deny").map((r) => r.path)),
    ).toSorted();
    expect(denyPaths).toEqual([
      `${VS}/Brain/.snapshots/**`,
      `${VS}/Brain/_brain.yaml`,
      `${VS}/Brain/log/**`,
      `${VS}/Brain/preferences/**`,
      `${VS}/Brain/retired/**`,
    ]);
  });
});

describe("renderClaudeCode", () => {
  test("emits a snippet with deny + allow arrays and a manifest", () => {
    const rules = buildProtectRules("/vault");
    const out = renderClaudeCode(rules, "/vault");
    expect(out.snippet.permissions.deny).toContain(`Write(${cc(V)}/Brain/preferences/**)`);
    expect(out.snippet.permissions.deny).toContain(`Edit(${cc(V)}/Brain/preferences/**)`);
    expect(out.snippet.permissions.allow).toEqual([`Write(${cc(V)}/Brain/inbox/**)`]);
    expect(out.manifest.schema_version).toBe(PROTECT_SCHEMA_VERSION);
    expect(out.manifest.target).toBe("claudecode");
    expect(out.manifest.vault).toBe("/vault");
    expect(out.manifest.owned_deny).toHaveLength(10);
    expect(out.manifest.owned_allow).toEqual([`Write(${cc(V)}/Brain/inbox/**)`]);
  });
});

describe("claudeCodeRulePath", () => {
  // Claude Code permissions docs (code.claude.com/docs/en/permissions):
  // "`//path` | Absolute path from filesystem root" and "On Windows, paths
  // are normalized to POSIX form before matching. `C:\Users\alice`
  // becomes `/c/Users/alice`, so use `//c/**/.env` ...".
  test("win32: a drive path becomes //<lower-case drive>/...", () => {
    expect(claudeCodeRulePath("C:/vault/Brain/log/**", "win32")).toBe("//c/vault/Brain/log/**");
    expect(claudeCodeRulePath("d:/Users/me/Brain/_brain.yaml", "win32")).toBe(
      "//d/Users/me/Brain/_brain.yaml",
    );
  });

  test("POSIX: an absolute path gains the second root slash", () => {
    // `/home/me/vault/...` alone would anchor at the project directory.
    expect(claudeCodeRulePath("/home/me/vault/Brain/log/**", "linux")).toBe(
      "//home/me/vault/Brain/log/**",
    );
    expect(claudeCodeRulePath("/Users/me/vault/Brain/log/**", "darwin")).toBe(
      "//Users/me/vault/Brain/log/**",
    );
  });

  test("an already filesystem-absolute path is left alone", () => {
    expect(claudeCodeRulePath("//server/share/Brain/**", "win32")).toBe("//server/share/Brain/**");
    expect(claudeCodeRulePath("//srv/Brain/**", "linux")).toBe("//srv/Brain/**");
  });

  test("renderClaudeCode emits the win32 form for a Windows vault", () => {
    const rules = buildProtectRules("C:\\vault").map((r) => ({
      ...r,
      path: r.path.replace(/^.*?\/Brain\//, "C:/vault/Brain/"),
    }));
    const out = renderClaudeCode(rules, "C:\\vault", "win32");
    expect(out.snippet.permissions.deny).toContain("Write(//c/vault/Brain/preferences/**)");
    expect(out.snippet.permissions.deny).toContain("Edit(//c/vault/Brain/_brain.yaml)");
    expect(out.snippet.permissions.allow).toEqual(["Write(//c/vault/Brain/inbox/**)"]);
  });
});

describe("renderCodex", () => {
  test("emits TOML wrapped in osb fence with right keys", () => {
    const rules = buildProtectRules("/vault");
    const out = renderCodex(rules);
    expect(out.body).toContain("# >>> open-second-brain managed >>>");
    expect(out.body).toContain("# <<< open-second-brain managed <<<");
    expect(out.body).toContain("[permissions.osb_protected.filesystem]");
    expect(out.body).toContain(`"${V}/Brain/preferences/**" = "none"`);
    expect(out.body).toContain(`"${V}/Brain/inbox/**" = "write"`);
    expect(out.body).toContain('default_permissions = "osb_protected"');
    expect(out.body).toContain(`schema_version = ${PROTECT_SCHEMA_VERSION}`);
  });

  test("emits each filesystem path only once", () => {
    const out = renderCodex(buildProtectRules("/vault"));
    const keys = out.body
      .split(/\r?\n/)
      .map((line) => /^"([^"]+)"\s*=/.exec(line)?.[1])
      .filter((path): path is string => path !== undefined);
    expect(keys.length).toBe(new Set(keys).size);
    expect(keys).toHaveLength(6);
  });
});

describe("manifest read/write", () => {
  test("round-trip claudecode manifest", () => {
    const vault = mkVault();
    const m = {
      schema_version: PROTECT_SCHEMA_VERSION,
      target: "claudecode" as const,
      vault,
      owned_deny: ["Write(/v/Brain/preferences/**)"],
      owned_allow: ["Write(/v/Brain/inbox/**)"],
    };
    writeManifest(vault, m);
    expect(readManifest(vault, "claudecode")).toEqual(m);
  });

  test("reading absent manifest returns null", () => {
    const vault = mkVault();
    expect(readManifest(vault, "claudecode")).toBeNull();
  });

  test("higher schema_version on disk throws", () => {
    const vault = mkVault();
    writeManifest(vault, {
      schema_version: 999,
      target: "claudecode",
      vault,
      owned_deny: [],
      owned_allow: [],
    });
    expect(() => readManifest(vault, "claudecode")).toThrow(BrainProtectError);
  });
});

describe("applyProtect claudecode", () => {
  test("creates settings.json + manifest on a fresh vault", () => {
    const vault = mkVault();
    const r = applyProtect({ target: "claudecode", vault });
    expect(r.changed).toBe(true);
    const settings = JSON.parse(readFileSync(join(vault, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain(`Write(${cc(abs(vault))}/Brain/preferences/**)`);
  });

  test("computeProtect returns before/after without writing (t_b6bcd984)", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    const original = '{\n  "theme": "dark"\n}\n';
    writeFileSync(join(vault, ".claude", "settings.json"), original);
    const c = computeProtect({ target: "claudecode", vault });
    expect(c.changed).toBe(true);
    expect(c.before).toBe(original);
    // The after-side merges the OSB rules beside the operator's own key.
    expect(c.after).toContain('"theme": "dark"');
    expect(c.after).toContain(`Write(${cc(abs(vault))}/Brain/preferences/**)`);
    // The compute step is a preview: the file on disk is untouched.
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toBe(original);
  });

  test("computeProtect reports no change when settings already match", () => {
    const vault = mkVault();
    applyProtect({ target: "claudecode", vault });
    const onDisk = readFileSync(join(vault, ".claude", "settings.json"), "utf8");
    const c = computeProtect({ target: "claudecode", vault });
    expect(c.changed).toBe(false);
    expect(c.after).toBe(onDisk);
  });

  test("idempotent: second apply produces byte-identical settings", () => {
    const vault = mkVault();
    applyProtect({ target: "claudecode", vault });
    const first = readFileSync(join(vault, ".claude", "settings.json"), "utf8");
    applyProtect({ target: "claudecode", vault });
    const second = readFileSync(join(vault, ".claude", "settings.json"), "utf8");
    expect(second).toBe(first);
  });

  test("preserves user-authored permissions on apply", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(
      join(vault, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"], allow: [] } }, null, 2) + "\n",
    );
    applyProtect({ target: "claudecode", vault });
    const settings = JSON.parse(readFileSync(join(vault, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Bash(rm -rf /)");
    expect(settings.permissions.deny).toContain(`Write(${cc(abs(vault))}/Brain/preferences/**)`);
  });

  test("apply against unbootstrapped vault throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-noinit-"));
    tmpRoots.push(dir);
    expect(() => applyProtect({ target: "claudecode", vault: dir })).toThrow(BrainProtectError);
  });

  test.skipIf(IS_WINDOWS)(
    "apply's own .bak backup is exclusive and private 0600 (settings carry secrets)",
    () => {
      const vault = mkVault();
      mkdirSync(join(vault, ".claude"), { recursive: true });
      writeFileSync(join(vault, ".claude", "settings.json"), '{\n  "theme": "dark"\n}\n');
      const r = applyProtect({ target: "claudecode", vault });
      expect(r.changed).toBe(true);
      expect(r.backupPath).not.toBe("");
      expect(statSync(r.backupPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(r.backupPath, "utf8")).toBe('{\n  "theme": "dark"\n}\n');
    },
  );
});

describe("unprotect claudecode", () => {
  test("round-trip restores settings.json to pre-protect content", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    const userSettings =
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"], allow: [] } }, null, 2) + "\n";
    writeFileSync(join(vault, ".claude", "settings.json"), userSettings);

    applyProtect({ target: "claudecode", vault });
    unprotect({ target: "claudecode", vault });

    const after = readFileSync(join(vault, ".claude", "settings.json"), "utf8");
    expect(after).toBe(userSettings);
  });

  test("unprotect on absent manifest exits without throwing", () => {
    const vault = mkVault();
    expect(() => unprotect({ target: "claudecode", vault })).not.toThrow();
  });

  test("backups the settings file before rewriting, exclusive name", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(join(vault, ".claude", "settings.json"), "{}\n");
    applyProtect({ target: "claudecode", vault });
    const before = readFileSync(join(vault, ".claude", "settings.json"), "utf8");

    const r = unprotect({ target: "claudecode", vault });
    expect(r.changed).toBe(true);
    expect(r.backupPath).not.toBe("");
    // The backup is the pre-unprotect bytes (rules still in them), taken
    // before the rewrite under the exclusive stamp name.
    expect(readFileSync(r.backupPath, "utf8")).toBe(before);
  });

  test.skipIf(IS_WINDOWS)(
    "unprotect's backup is private 0600 - settings backups carry secrets",
    () => {
      const vault = mkVault();
      mkdirSync(join(vault, ".claude"), { recursive: true });
      writeFileSync(join(vault, ".claude", "settings.json"), "{}\n");
      applyProtect({ target: "claudecode", vault });
      const r = unprotect({ target: "claudecode", vault });
      expect(r.changed).toBe(true);
      // Private 0600: settings backups carry secrets (guarded-host-writes
      // convention, t_b6bcd984). Windows stat.mode does not carry the
      // POSIX bits, so the mode is a POSIX-only assertion - the apply
      // twin above gates the same way.
      expect(statSync(r.backupPath).mode & 0o777).toBe(0o600);
    },
  );

  test("a no-op unprotect takes no backup and reports changed:false", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(join(vault, ".claude", "settings.json"), '{"user": true}\n');
    const before = readFileSync(join(vault, ".claude", "settings.json"), "utf8");
    const r = unprotect({ target: "claudecode", vault });
    expect(r.changed).toBe(false);
    expect(r.backupPath).toBe("");
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toBe(before);
  });
});

describe("computeUnprotect", () => {
  test("returns before/after without writing (t_b6bcd984 twin, claudecode)", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(join(vault, ".claude", "settings.json"), '{"user": true}\n');
    applyProtect({ target: "claudecode", vault });
    const onDisk = readFileSync(join(vault, ".claude", "settings.json"), "utf8");

    const c = computeUnprotect({ target: "claudecode", vault });
    expect(c.changed).toBe(true);
    expect(c.before).toBe(onDisk);
    expect(c.after).toContain('"user": true');
    expect(c.after).not.toContain("Brain/preferences");
    // The compute step is a preview: the file on disk is untouched.
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toBe(onDisk);
    // The preview IS the write: running the unprotect lands `after`.
    unprotect({ target: "claudecode", vault });
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toBe(c.after);
  });

  test("reports no change with no manifest and no settings file (claudecode)", () => {
    const vault = mkVault();
    const c = computeUnprotect({ target: "claudecode", vault });
    expect(c.changed).toBe(false);
    expect(c.after).toBe(c.before);
    expect(c.before).toBe("");
    // And the write half agrees: nothing appears on disk.
    unprotect({ target: "claudecode", vault });
    expect(existsSync(join(vault, ".claude", "settings.json"))).toBe(false);
  });

  test("codex: preview matches the write, fence removed on the last vault", () => {
    const home = mkHome();
    const vault = mkVault();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const userToml = '# user content\nmodel = "gpt-5.5"\n';
    writeFileSync(join(home, ".codex", "config.toml"), userToml);
    applyProtect({ target: "codex", vault, __homeOverride: home });
    const withFence = readFileSync(join(home, ".codex", "config.toml"), "utf8");

    const c = computeUnprotect({ target: "codex", vault, __homeOverride: home });
    expect(c.changed).toBe(true);
    expect(c.before).toBe(withFence);
    expect(c.after).toBe(userToml);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(withFence);
  });
});

describe("approved preview pin (t_b6bcd984)", () => {
  /** The in-vault manifest the lanes read; moved by hand after a preview here. */
  function manifestEntry(vault: string, target: string): Record<string, unknown> {
    const path = join(vault, ".open-second-brain", "protect.lock.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = parsed.entries.find((e) => e["target"] === target) as Record<string, unknown>;
    return entry;
  }

  function rewriteManifest(
    vault: string,
    target: string,
    mutate: (e: Record<string, unknown>) => void,
  ): void {
    const path = join(vault, ".open-second-brain", "protect.lock.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = parsed.entries.find((e) => e["target"] === target) as Record<string, unknown>;
    mutate(entry);
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
  }

  function backupCount(dir: string): number {
    return readdirSync(dir).filter((name) => name.includes(".bak.")).length;
  }

  test("applyProtect lands exactly the approved preview bytes", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(join(vault, ".claude", "settings.json"), '{\n  "theme": "dark"\n}\n');
    const c = computeProtect({ target: "claudecode", vault });
    applyProtect({ target: "claudecode", vault, approved: c });
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toBe(c.after);
  });

  test("applyProtect refuses when the target moved after the preview (claudecode)", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    writeFileSync(join(vault, ".claude", "settings.json"), '{\n  "theme": "dark"\n}\n');
    const c = computeProtect({ target: "claudecode", vault });
    // The file moves after the preview was taken; the approved pair no
    // longer describes reality, so nothing is written and no backup lands.
    writeFileSync(join(vault, ".claude", "settings.json"), '{\n  "theme": "light"\n}\n');
    expect(() => applyProtect({ target: "claudecode", vault, approved: c })).toThrow(
      /moved since the consent preview/,
    );
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toBe(
      '{\n  "theme": "light"\n}\n',
    );
    expect(backupCount(join(vault, ".claude"))).toBe(0);
  });

  test("unprotect refuses when the manifest moved after the preview (claudecode)", () => {
    const vault = mkVault();
    mkdirSync(join(vault, ".claude"), { recursive: true });
    const userDeny = "Bash(rm -rf /)";
    writeFileSync(
      join(vault, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: [userDeny], allow: [] } }, null, 2) + "\n",
    );
    applyProtect({ target: "claudecode", vault });
    const c = computeUnprotect({ target: "claudecode", vault });
    // The manifest the removal set is read from changes after the preview:
    // it now claims the operator's own rule too, so the derived write no
    // longer matches the approved diff. The pin refuses; nothing moves.
    rewriteManifest(vault, "claudecode", (e) => {
      (e["owned_deny"] as string[]).push(userDeny);
    });
    // The pre-protect apply already took its own backup; the refused
    // unprotect must not take another.
    const backupsBefore = backupCount(join(vault, ".claude"));
    expect(() => unprotect({ target: "claudecode", vault, approved: c })).toThrow(
      /moved since the consent preview/,
    );
    // The host file keeps the exact bytes the preview showed.
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toBe(c.before);
    expect(backupCount(join(vault, ".claude"))).toBe(backupsBefore);
    expect(manifestEntry(vault, "claudecode")).not.toBeNull();
  });

  test("a no-op approval refuses a target that moved (claudecode)", () => {
    const vault = mkVault();
    applyProtect({ target: "claudecode", vault });
    const c = computeProtect({ target: "claudecode", vault });
    expect(c.changed).toBe(false);
    // An edit arrives after the "no changes" preview: applying the old
    // no-op approval must not silently grow into a real write.
    writeFileSync(
      join(vault, ".claude", "settings.json"),
      JSON.stringify({ theme: "light" }, null, 2) + "\n",
    );
    expect(() => applyProtect({ target: "claudecode", vault, approved: c })).toThrow(
      /moved since the consent preview/,
    );
    expect(readFileSync(join(vault, ".claude", "settings.json"), "utf8")).toContain('"theme"');
  });

  test("codex unprotect refuses when the manifest moved after the preview", () => {
    const home = mkHome();
    const vault = mkVault();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const userToml = '# user content\nmodel = "gpt-5.5"\n';
    writeFileSync(join(home, ".codex", "config.toml"), userToml);
    applyProtect({ target: "codex", vault, __homeOverride: home });
    const c = computeUnprotect({ target: "codex", vault, __homeOverride: home });
    rewriteManifest(vault, "codex", (e) => {
      // Drop one owned path, so the derived fence keeps an entry the
      // approved preview would have removed.
      (e["owned_paths"] as string[]).pop();
    });
    expect(() => unprotect({ target: "codex", vault, __homeOverride: home, approved: c })).toThrow(
      /moved since the consent preview/,
    );
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(c.before);
  });
});

describe("applyProtect codex", () => {
  test("creates config.toml with the managed fence on a fresh user home", () => {
    const home = mkHome();
    const vault = mkVault();
    const r = applyProtect({ target: "codex", vault, __homeOverride: home });
    expect(r.changed).toBe(true);
    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(config).toContain("# >>> open-second-brain managed >>>");
    expect(config).toContain("[permissions.osb_protected.filesystem]");
    expect(config).toContain(`"${abs(vault)}/Brain/preferences/**" = "none"`);
  });

  test("idempotent on Codex too", () => {
    const home = mkHome();
    const vault = mkVault();
    applyProtect({ target: "codex", vault, __homeOverride: home });
    const first = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    applyProtect({ target: "codex", vault, __homeOverride: home });
    const second = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(second).toBe(first);
  });

  test("computeProtect codex returns before/after without writing (t_b6bcd984)", () => {
    const home = mkHome();
    const vault = mkVault();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const userToml = '# user content\nmodel = "gpt-5.5"\n';
    writeFileSync(join(home, ".codex", "config.toml"), userToml);
    const c = computeProtect({ target: "codex", vault, __homeOverride: home });
    expect(c.changed).toBe(true);
    expect(c.before).toBe(userToml);
    expect(c.after).toContain("# >>> open-second-brain managed >>>");
    expect(c.after.startsWith(userToml)).toBe(true);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(userToml);
  });

  test("preserves user content outside the fence", () => {
    const home = mkHome();
    const vault = mkVault();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const userToml = '# user content\nmodel = "gpt-5.5"\n';
    writeFileSync(join(home, ".codex", "config.toml"), userToml);
    applyProtect({ target: "codex", vault, __homeOverride: home });
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(after.startsWith(userToml)).toBe(true);
    expect(after).toContain("# >>> open-second-brain managed >>>");
  });

  test("inserts root-level default_permissions before the first TOML table", () => {
    const home = mkHome();
    const vault = mkVault();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        'model = "gpt-5.5"',
        "",
        '[plugins."open-second-brain@open-second-brain"]',
        "enabled = true",
        "",
      ].join("\n"),
    );

    applyProtect({ target: "codex", vault, __homeOverride: home });
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(after.indexOf('default_permissions = "osb_protected"')).toBeLessThan(
      after.indexOf('[plugins."open-second-brain@open-second-brain"]'),
    );
    expect(after.indexOf("[permissions.osb_protected.filesystem]")).toBeLessThan(
      after.indexOf('[plugins."open-second-brain@open-second-brain"]'),
    );
  });

  test("applying a second vault preserves the first vault's entries", () => {
    const home = mkHome();
    const vaultA = mkVault();
    const vaultB = mkVault();
    applyProtect({ target: "codex", vault: vaultA, __homeOverride: home });
    applyProtect({ target: "codex", vault: vaultB, __homeOverride: home });

    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(config).toContain(`"${abs(vaultA)}/Brain/preferences/**" = "none"`);
    expect(config).toContain(`"${abs(vaultB)}/Brain/preferences/**" = "none"`);
  });

  test.skipIf(IS_WINDOWS)(
    "codex apply's own .bak backup is private 0600 too (one backup helper for the lane)",
    () => {
      const home = mkHome();
      const vault = mkVault();
      mkdirSync(join(home, ".codex"), { recursive: true });
      const userToml = '# user content\nmodel = "gpt-5.5"\n';
      writeFileSync(join(home, ".codex", "config.toml"), userToml);
      const r = applyProtect({ target: "codex", vault, __homeOverride: home });
      expect(r.changed).toBe(true);
      expect(r.backupPath).not.toBe("");
      expect(statSync(r.backupPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(r.backupPath, "utf8")).toBe(userToml);
    },
  );
});

describe("unprotect codex", () => {
  test("round-trip on Codex restores pre-protect content", () => {
    const home = mkHome();
    const vault = mkVault();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const userToml = '# user content\nmodel = "gpt-5.5"\n';
    writeFileSync(join(home, ".codex", "config.toml"), userToml);
    applyProtect({ target: "codex", vault, __homeOverride: home });
    unprotect({ target: "codex", vault, __homeOverride: home });
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(after).toBe(userToml);
  });

  test("removes only the selected vault from a shared managed fence", () => {
    const home = mkHome();
    const vaultA = mkVault();
    const vaultB = mkVault();
    applyProtect({ target: "codex", vault: vaultA, __homeOverride: home });
    applyProtect({ target: "codex", vault: vaultB, __homeOverride: home });

    unprotect({ target: "codex", vault: vaultA, __homeOverride: home });
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(after).not.toContain(`${abs(vaultA)}/Brain/preferences/**`);
    expect(after).toContain(`${abs(vaultB)}/Brain/preferences/**`);
    expect(after).toContain("# >>> open-second-brain managed >>>");
  });
});

describe("printSnippet", () => {
  test("claudecode prints the JSON shape (no manifest)", () => {
    const out = printSnippet({ target: "claudecode", vault: "/v" });
    expect(out.body).toContain(`"Write(${cc(VS)}/Brain/preferences/**)"`);
    expect(out.body).toContain("permissions");
    // Manifest fields stay internal — `--print` shows only the
    // file-shaped snippet a user would paste.
    expect(out.body).not.toContain("schema_version");
    expect(out.body).not.toContain("owned_deny");
  });

  test("codex prints the fenced TOML block", () => {
    const out = printSnippet({ target: "codex", vault: "/v" });
    expect(out.body).toContain("# >>> open-second-brain managed >>>");
    expect(out.body).toContain("[permissions.osb_protected.filesystem]");
  });
});

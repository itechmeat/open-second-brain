import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyProtect,
  BrainProtectError,
  buildProtectRules,
  printSnippet,
  PROTECT_SCHEMA_VERSION,
  readManifest,
  renderClaudeCode,
  renderCodex,
  unprotect,
  writeManifest,
} from "../../../src/core/brain/protect.ts";

const tmpRoots: string[] = [];

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
      path: "/vault/Brain/preferences/**",
    });
    const last = rules[rules.length - 1];
    expect(last).toEqual({
      kind: "allow",
      action: "Write",
      path: "/vault/Brain/inbox/**",
    });
  });

  test("denies cover the five protected sub-paths", () => {
    const rules = buildProtectRules("/v");
    const denyPaths = Array.from(
      new Set(rules.filter((r) => r.kind === "deny").map((r) => r.path)),
    ).toSorted();
    expect(denyPaths).toEqual([
      "/v/Brain/.snapshots/**",
      "/v/Brain/_brain.yaml",
      "/v/Brain/log/**",
      "/v/Brain/preferences/**",
      "/v/Brain/retired/**",
    ]);
  });
});

describe("renderClaudeCode", () => {
  test("emits a snippet with deny + allow arrays and a manifest", () => {
    const rules = buildProtectRules("/vault");
    const out = renderClaudeCode(rules, "/vault");
    expect(out.snippet.permissions.deny).toContain("Write(/vault/Brain/preferences/**)");
    expect(out.snippet.permissions.deny).toContain("Edit(/vault/Brain/preferences/**)");
    expect(out.snippet.permissions.allow).toEqual(["Write(/vault/Brain/inbox/**)"]);
    expect(out.manifest.schema_version).toBe(PROTECT_SCHEMA_VERSION);
    expect(out.manifest.target).toBe("claudecode");
    expect(out.manifest.vault).toBe("/vault");
    expect(out.manifest.owned_deny).toHaveLength(10);
    expect(out.manifest.owned_allow).toEqual(["Write(/vault/Brain/inbox/**)"]);
  });
});

describe("renderCodex", () => {
  test("emits TOML wrapped in osb fence with right keys", () => {
    const rules = buildProtectRules("/vault");
    const out = renderCodex(rules);
    expect(out.body).toContain("# >>> open-second-brain managed >>>");
    expect(out.body).toContain("# <<< open-second-brain managed <<<");
    expect(out.body).toContain("[permissions.osb_protected.filesystem]");
    expect(out.body).toContain('"/vault/Brain/preferences/**" = "none"');
    expect(out.body).toContain('"/vault/Brain/inbox/**" = "write"');
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
    expect(settings.permissions.deny).toContain(`Write(${vault}/Brain/preferences/**)`);
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
    expect(settings.permissions.deny).toContain(`Write(${vault}/Brain/preferences/**)`);
  });

  test("apply against unbootstrapped vault throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-noinit-"));
    tmpRoots.push(dir);
    expect(() => applyProtect({ target: "claudecode", vault: dir })).toThrow(BrainProtectError);
  });
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
    expect(config).toContain(`"${vault}/Brain/preferences/**" = "none"`);
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
    expect(config).toContain(`"${vaultA}/Brain/preferences/**" = "none"`);
    expect(config).toContain(`"${vaultB}/Brain/preferences/**" = "none"`);
  });
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
    expect(after).not.toContain(`${vaultA}/Brain/preferences/**`);
    expect(after).toContain(`${vaultB}/Brain/preferences/**`);
    expect(after).toContain("# >>> open-second-brain managed >>>");
  });
});

describe("printSnippet", () => {
  test("claudecode prints the JSON shape (no manifest)", () => {
    const out = printSnippet({ target: "claudecode", vault: "/v" });
    expect(out.body).toContain('"Write(/v/Brain/preferences/**)"');
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

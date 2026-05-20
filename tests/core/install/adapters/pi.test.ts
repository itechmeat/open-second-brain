import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { piAdapter } from "../../../../src/core/install/adapters/pi.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";
import { InstallError } from "../../../../src/core/install/types.ts";

let vault: string;
let home: string;
let pluginRoot: string;
let skillSource: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pi-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-pi-h-"));
  pluginRoot = mkdtempSync(join(tmpdir(), "osb-pi-r-"));
  skillSource = join(pluginRoot, "skills", "brain-memory");
  mkdirSync(skillSource, { recursive: true });
  writeFileSync(join(skillSource, "SKILL.md"), "# brain-memory skill\n");
});

afterEach(() => {
  for (const p of [vault, home, pluginRoot]) {
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

function env() {
  return { vault, home, cwd: home, env: {}, now: new Date("2026-05-20T12:00:00.000Z") };
}

function applyOpts(overrides: Record<string, unknown> = {}) {
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  return {
    dryRun: false, force: false,
    stdout: sink as unknown as NodeJS.WriteStream,
    stderr: sink as unknown as NodeJS.WriteStream,
    piSkillSource: skillSource,
    ...overrides,
  };
}

const payload = buildPayload({ vault: "/v", agent_name: "a", timezone: "UTC" });

describe("pi adapter", () => {
  const linkPath = () => join(home, ".pi", "skills", "brain-memory");

  test("detect on clean home returns not-installed at the default path", () => {
    const r = piAdapter.detect(env());
    expect(r.status).toBe("not-installed");
    expect(r.configPath).toBe(linkPath());
  });

  test("apply creates symlink ~/.pi/skills/brain-memory pointing at source", () => {
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath())).toBe(skillSource);
    expect(readManifest(vault).installs.pi).toBeDefined();
  });

  test("re-apply on valid symlink is a no-op (idempotent)", () => {
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    const before = readlinkSync(linkPath());
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    const after = readlinkSync(linkPath());
    expect(after).toBe(before);
  });

  test("re-apply replaces broken symlink (target removed)", () => {
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    // Remove the source — symlink is now dangling
    rmSync(skillSource, { recursive: true, force: true });
    mkdirSync(skillSource, { recursive: true });
    writeFileSync(join(skillSource, "SKILL.md"), "# new\n");
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    expect(existsSync(linkPath())).toBe(true);
    expect(readlinkSync(linkPath())).toBe(skillSource);
  });

  test("refuses to clobber a non-symlink directory at the target without --force", () => {
    mkdirSync(linkPath(), { recursive: true });
    writeFileSync(join(linkPath(), "user-file.md"), "stay clear\n");
    try {
      piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InstallError);
    }
    expect(lstatSync(linkPath()).isDirectory()).toBe(true);
    expect(existsSync(join(linkPath(), "user-file.md"))).toBe(true);
  });

  test("--force overrides the non-symlink-at-target refusal", () => {
    mkdirSync(linkPath(), { recursive: true });
    writeFileSync(join(linkPath(), "user-file.md"), "will go\n");
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts({ force: true }));
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
  });

  test("piSkillDir override changes target location", () => {
    const altDir = mkdtempSync(join(tmpdir(), "osb-pi-alt-"));
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts({ piSkillDir: altDir }));
    expect(lstatSync(join(altDir, "brain-memory")).isSymbolicLink()).toBe(true);
    try { rmSync(altDir, { recursive: true, force: true }); } catch {}
  });

  test("uninstall removes the symlink only, leaves source alone", () => {
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    piAdapter.uninstall(env(), applyOpts());
    expect(existsSync(linkPath())).toBe(false);
    // Source must still be there
    expect(existsSync(join(skillSource, "SKILL.md"))).toBe(true);
    expect(readManifest(vault).installs.pi).toBeUndefined();
  });

  test("verify returns ok when symlink is valid", () => {
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    expect(piAdapter.verify(env()).status).toBe("ok");
  });

  test("verify reports drift when symlink is broken (target gone)", () => {
    piAdapter.apply(piAdapter.plan(payload, env()), payload, env(), applyOpts());
    rmSync(skillSource, { recursive: true, force: true });
    expect(piAdapter.verify(env()).status).toBe("drift");
  });
});

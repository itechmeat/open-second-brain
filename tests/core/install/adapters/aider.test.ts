import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { aiderAdapter } from "../../../../src/core/install/adapters/aider.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";
import { InstallError } from "../../../../src/core/install/types.ts";
import {
  hasManagedBlock,
  extractManagedBlock,
} from "../../../../src/core/install/managed-block.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-aider-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-aider-h-"));
});
afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function env(now = new Date("2026-05-20T12:00:00.000Z"), envVars: Record<string, string> = {}) {
  return { vault, home, cwd: home, env: envVars, now };
}

function applyOpts(overrides: Record<string, unknown> = {}) {
  const sink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  return {
    dryRun: false,
    force: false,
    stdout: sink as unknown as NodeJS.WriteStream,
    stderr: sink as unknown as NodeJS.WriteStream,
    ...overrides,
  };
}

function aiderConfPath() {
  return join(home, ".aider.conf.yml");
}

const payload = buildPayload({ vault: "/v", agent_name: "claude-vps", timezone: "UTC" });

describe("aider adapter", () => {
  test("detect on clean home returns not-installed at default path", () => {
    const r = aiderAdapter.detect(env());
    expect(r.status).toBe("not-installed");
    expect(r.configPath).toBe(aiderConfPath());
  });

  test("apply creates ~/.aider.conf.yml with managed block + sidecar context file", () => {
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    expect(existsSync(aiderConfPath())).toBe(true);
    const conf = readFileSync(aiderConfPath(), "utf8");
    expect(hasManagedBlock(conf)).toBe(true);
    const body = extractManagedBlock(conf);
    expect(body).toContain("read:");
    const sidecarPath = join(vault, ".open-second-brain", "aider-context.md");
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = readFileSync(sidecarPath, "utf8");
    expect(sidecar).toContain("@claude-vps");
    expect(sidecar).toContain(vault);
    expect(readManifest(vault).installs.aider).toBeDefined();
  });

  test("re-apply is idempotent (managed-block + sidecar bytes unchanged)", () => {
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    const conf1 = readFileSync(aiderConfPath(), "utf8");
    const sidecarPath = join(vault, ".open-second-brain", "aider-context.md");
    const side1 = readFileSync(sidecarPath, "utf8");
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    expect(readFileSync(aiderConfPath(), "utf8")).toBe(conf1);
    expect(readFileSync(sidecarPath, "utf8")).toBe(side1);
  });

  test("preserves user-authored config above and below the managed block", () => {
    const userConf = "# user config\nmodel: gpt-4o-mini\nedit-format: diff\n";
    writeFileSync(aiderConfPath(), userConf);
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    const conf = readFileSync(aiderConfPath(), "utf8");
    expect(conf.startsWith("# user config\nmodel: gpt-4o-mini\nedit-format: diff\n")).toBe(true);
    expect(hasManagedBlock(conf)).toBe(true);
  });

  test("uninstall removes managed block + sidecar file, drops manifest entry", () => {
    const userConf = "model: gpt-4o-mini\n";
    writeFileSync(aiderConfPath(), userConf);
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    aiderAdapter.uninstall(env(), applyOpts());

    const conf = readFileSync(aiderConfPath(), "utf8");
    expect(hasManagedBlock(conf)).toBe(false);
    expect(conf).toContain("model: gpt-4o-mini");
    expect(existsSync(join(vault, ".open-second-brain", "aider-context.md"))).toBe(false);
    expect(readManifest(vault).installs.aider).toBeUndefined();
  });

  test("uninstall without manifest entry throws manifest-missing", () => {
    writeFileSync(aiderConfPath(), "# top\n");
    try {
      aiderAdapter.uninstall(env(), applyOpts());
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InstallError);
      expect((err as InstallError).kind).toBe("manifest-missing");
    }
  });

  test("verify reports ok after install", () => {
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    expect(aiderAdapter.verify(env()).status).toBe("ok");
  });

  test("verify reports drift when sidecar context file removed", () => {
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    rmSync(join(vault, ".open-second-brain", "aider-context.md"), { force: true });
    expect(aiderAdapter.verify(env()).status).toBe("drift");
  });

  test("hand-edited block + mtime newer → apply refuses without --force", () => {
    aiderAdapter.apply(aiderAdapter.plan(payload, env()), payload, env(), applyOpts());
    // Tamper with managed block
    const conf = readFileSync(aiderConfPath(), "utf8");
    const tampered = conf.replace(/aider-context\.md/g, "TAMPERED");
    writeFileSync(aiderConfPath(), tampered);
    const future = new Date("2026-05-20T13:00:00.000Z");
    utimesSync(aiderConfPath(), future, future);

    try {
      aiderAdapter.apply(
        aiderAdapter.plan(payload, env(new Date("2026-05-20T13:05:00.000Z"))),
        payload,
        env(new Date("2026-05-20T13:05:00.000Z")),
        applyOpts(),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InstallError);
      expect((err as InstallError).kind).toBe("user-modified-block");
    }
  });

  test("AIDER_CONFIG env var overrides config path", () => {
    const custom = mkdtempSync(join(tmpdir(), "osb-aider-custom-"));
    const customConf = join(custom, "my-aider.yml");
    const e = env(new Date(), { AIDER_CONFIG: customConf });
    aiderAdapter.apply(aiderAdapter.plan(payload, e), payload, e, applyOpts());
    expect(existsSync(customConf)).toBe(true);
    try {
      rmSync(custom, { recursive: true, force: true });
    } catch {}
  });
});

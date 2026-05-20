import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpdate } from "../../../src/core/install/update.ts";
import { createRegistry } from "../../../src/core/install/registry.ts";
import { readManifest } from "../../../src/core/install/manifest.ts";
import type {
  InstallAdapter,
  InstallEnv,
  DetectResult,
  InstallPlan,
  ApplyResult,
  VerifyResult,
} from "../../../src/core/install/types.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-update-"));
  home = mkdtempSync(join(tmpdir(), "osb-update-home-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
});

afterEach(() => {
  try { rmSync(vault, { recursive: true, force: true }); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function makeEnv(): InstallEnv {
  return { vault, home, cwd: process.cwd(), env: {}, now: new Date() };
}

function fakeAdapter(
  target: string,
  status: "installed" | "not-installed" = "installed",
): InstallAdapter {
  return {
    target,
    label: target,
    detect(): DetectResult {
      return { target, status, configPath: `/tmp/${target}-config`, notes: [] };
    },
    plan(): InstallPlan {
      return {
        target,
        steps: [{ kind: "json-merge", path: "/tmp/c.json", preview: "merge" }],
        postNotes: ["restart " + target],
      };
    },
    apply(): ApplyResult {
      return {
        target,
        steps_executed: 1,
        manifest: {
          target,
          applied_at: new Date().toISOString(),
          operation: "json-merge",
          config_path: "/tmp/c.json",
        },
      };
    },
    uninstall() {
      return { target, removed_keys: [], removed_paths: [], skipped: [] };
    },
    verify(): VerifyResult {
      return { target, status: "ok", details: [], fix_hint: null };
    },
  };
}

describe("runUpdate", () => {
  test("skips not-installed targets", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("cursor", "not-installed"));
    const result = runUpdate(reg, makeEnv(), { dryRun: false, force: false, target: null });
    expect(result.targets.length).toBe(1);
    expect(result.targets[0]!.status).toBe("skipped");
  });

  test("applies when no previous manifest exists", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("claudecode"));
    const result = runUpdate(reg, makeEnv(), { dryRun: false, force: false, target: null });
    expect(result.targets[0]!.status).toBe("applied");
  });

  test("dry-run reports would-apply without applying", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("claudecode"));
    const result = runUpdate(reg, makeEnv(), { dryRun: true, force: false, target: null });
    expect(result.targets[0]!.status).toBe("would-apply");
  });

  test("skips when payload hash is unchanged", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("claudecode"));
    const env = makeEnv();

    const first = runUpdate(reg, env, { dryRun: false, force: false, target: null });
    expect(first.targets[0]!.status).toBe("applied");

    const second = runUpdate(reg, env, { dryRun: false, force: false, target: null });
    expect(second.targets[0]!.status).toBe("up-to-date");
    expect(second.targets[0]!.reason).toBe("payload unchanged");
  });

  test("--force bypasses hash-skip", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("claudecode"));
    const env = makeEnv();

    const first = runUpdate(reg, env, { dryRun: false, force: false, target: null });
    expect(first.targets[0]!.status).toBe("applied");

    const forced = runUpdate(reg, env, { dryRun: false, force: true, target: null });
    expect(forced.targets[0]!.status).toBe("applied");
  });

  test("payload_hash stored in install.lock.json after apply", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("claudecode"));
    const env = makeEnv();

    runUpdate(reg, env, { dryRun: false, force: false, target: null });

    const manifest = readManifest(env.vault);
    const entry = manifest.installs["claudecode"];
    expect(entry).toBeDefined();
    expect(entry!.payload_hash).toBeDefined();
    expect(entry!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

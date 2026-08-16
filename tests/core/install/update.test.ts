import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
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
import type { InstallTargetId } from "../../../src/core/runtime/host-facts.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-update-"));
  home = mkdtempSync(join(tmpdir(), "osb-update-home-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function makeEnv(): InstallEnv {
  return { vault, home, cwd: process.cwd(), env: {}, now: new Date() };
}

function fakeAdapter(
  target: InstallTargetId,
  status: "installed" | "not-installed" = "installed",
): InstallAdapter {
  return {
    target,
    label: target,
    // The seam is required on every adapter; a double that answers
    // `null` is a runtime with no session store, which is what a double is.
    sessionPaths(): null {
      return null;
    },
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
    reg.register(fakeAdapter("cursor"));
    const result = runUpdate(reg, makeEnv(), { dryRun: false, force: false, target: null });
    expect(result.targets[0]!.status).toBe("applied");
  });

  test("dry-run reports would-apply without applying", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("cursor"));
    const result = runUpdate(reg, makeEnv(), { dryRun: true, force: false, target: null });
    expect(result.targets[0]!.status).toBe("would-apply");
  });

  test("skips when payload hash is unchanged", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("cursor"));
    const env = makeEnv();

    const first = runUpdate(reg, env, { dryRun: false, force: false, target: null });
    expect(first.targets[0]!.status).toBe("applied");

    const second = runUpdate(reg, env, { dryRun: false, force: false, target: null });
    expect(second.targets[0]!.status).toBe("up-to-date");
    expect(second.targets[0]!.reason).toBe("payload unchanged");
  });

  test("--force bypasses hash-skip", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("cursor"));
    const env = makeEnv();

    const first = runUpdate(reg, env, { dryRun: false, force: false, target: null });
    expect(first.targets[0]!.status).toBe("applied");

    const forced = runUpdate(reg, env, { dryRun: false, force: true, target: null });
    expect(forced.targets[0]!.status).toBe("applied");
  });

  test("a changed tool profile is not 'payload unchanged'", () => {
    // The hash used to be taken over the CANONICAL payload - vault, agent
    // name, timezone - and the host dimensions (`--tool-profile`,
    // `--host-target`) are added afterwards, by `payloadForHost`, which
    // `runUpdate` never called. So an operator who changed
    // `install.tool_profile` in the committed `_brain.yaml` got
    // "up-to-date, payload unchanged" from `o2b update` while
    // `o2b install --check` reported drift on the same target, and a
    // 110-tool registration stayed under Cursor's 40-tool ceiling.
    const reg = createRegistry();
    reg.register(fakeAdapter("cursor"));
    const env = makeEnv();

    expect(
      runUpdate(reg, env, { dryRun: false, force: false, target: null }).targets[0]!.status,
    ).toBe("applied");
    expect(
      runUpdate(reg, env, { dryRun: false, force: false, target: null }).targets[0]!.status,
    ).toBe("up-to-date");

    atomicWriteFileSync(
      brainConfigPath(vault),
      'schema_version: 1\ninstall:\n  tool_profile: "minimal"\n',
    );
    const after = runUpdate(reg, env, { dryRun: false, force: false, target: null });
    expect(`${after.targets[0]!.status}: ${after.targets[0]!.reason ?? ""}`).toBe("applied: ");
  });

  test("an unreadable _brain.yaml is an error on that target, not a crash", () => {
    // The settings ladder REFUSES an unparsable vault config rather than
    // regenerating a default. `runUpdate` reports it per target, so the
    // other targets in the same run still get their status.
    const reg = createRegistry();
    reg.register(fakeAdapter("cursor"));
    atomicWriteFileSync(
      brainConfigPath(vault),
      "schema_version: 1\ninstall:\n  tool_profile: [x\n",
    );
    const result = runUpdate(reg, makeEnv(), { dryRun: false, force: false, target: null });
    expect(result.targets[0]!.status).toBe("error");
    expect(result.targets[0]!.error ?? "").toContain(brainConfigPath(vault));
  });

  test("payload_hash stored in install.lock.json after apply", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("cursor"));
    const env = makeEnv();

    runUpdate(reg, env, { dryRun: false, force: false, target: null });

    const manifest = readManifest(env.vault);
    const entry = manifest.installs["cursor"];
    expect(entry).toBeDefined();
    expect(entry!.payload_hash).toBeDefined();
    expect(entry!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

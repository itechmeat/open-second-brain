import { describe, expect, test } from "bun:test";
import { createRegistry } from "../../../src/core/install/registry.ts";
import type {
  InstallAdapter,
  InstallEnv,
  DetectResult,
  InstallPlan,
  ApplyResult,
  UninstallResult,
  VerifyResult,
} from "../../../src/core/install/types.ts";

function makeFakeAdapter(target: string): InstallAdapter {
  return {
    target,
    label: target,
    detect(env: InstallEnv): DetectResult {
      void env;
      return { target, status: "not-installed", configPath: null, notes: [] };
    },
    plan(): InstallPlan {
      return { target, steps: [], postNotes: [] };
    },
    apply(): ApplyResult {
      return {
        target,
        steps_executed: 0,
        manifest: {
          target,
          applied_at: "2026-05-20T00:00:00.000Z",
          operation: "print",
          config_path: null,
        },
      };
    },
    uninstall(): UninstallResult {
      return { target, removed_keys: [], removed_paths: [], skipped: [] };
    },
    verify(): VerifyResult {
      return { target, status: "not-installed", details: [], fix_hint: null };
    },
  };
}

function makeEnv(): InstallEnv {
  return {
    vault: "/tmp/v",
    home: "/tmp/h",
    cwd: "/tmp/c",
    env: {},
    now: new Date("2026-05-20T00:00:00.000Z"),
  };
}

describe("install registry", () => {
  test("starts empty", () => {
    const reg = createRegistry();
    expect(reg.list()).toEqual([]);
    expect(reg.get("cursor")).toBeUndefined();
  });

  test("register + get round-trip", () => {
    const reg = createRegistry();
    const a = makeFakeAdapter("test");
    reg.register(a);
    expect(reg.get("test")).toBe(a);
    expect(reg.list().map((x) => x.target)).toEqual(["test"]);
  });

  test("register rejects duplicate target", () => {
    const reg = createRegistry();
    reg.register(makeFakeAdapter("cursor"));
    expect(() => reg.register(makeFakeAdapter("cursor"))).toThrow(/duplicate/i);
  });

  test("detectAll returns one entry per registered adapter", () => {
    const reg = createRegistry();
    reg.register(makeFakeAdapter("a"));
    reg.register(makeFakeAdapter("b"));
    const out = reg.detectAll(makeEnv());
    expect(out.map((d) => d.target).toSorted()).toEqual(["a", "b"]);
  });

  test("list returns adapters in registration order", () => {
    const reg = createRegistry();
    reg.register(makeFakeAdapter("b"));
    reg.register(makeFakeAdapter("a"));
    reg.register(makeFakeAdapter("c"));
    expect(reg.list().map((x) => x.target)).toEqual(["b", "a", "c"]);
  });

  test("targets() returns target names only", () => {
    const reg = createRegistry();
    reg.register(makeFakeAdapter("a"));
    reg.register(makeFakeAdapter("b"));
    expect(reg.targets()).toEqual(["a", "b"]);
  });
});

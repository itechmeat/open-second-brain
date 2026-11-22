import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertNotRunnerCache,
  classifyOrigin,
  installOrigin,
  type InstallOrigin,
} from "../../../src/core/install/origin.ts";
import { buildInstallEnv } from "../../../src/core/install/env.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const fixtureRoot = tempDirs()("origin-test-");

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("classifyOrigin", () => {
  test("recognizes Bun global node_modules", () => {
    expect(
      classifyOrigin(join(fixtureRoot, ".bun/install/global/node_modules/open-second-brain")),
    ).toBe("registry");
  });

  test("recognizes npm global node_modules on POSIX", () => {
    expect(classifyOrigin(join(fixtureRoot, "npm/lib/node_modules/open-second-brain"))).toBe(
      "registry",
    );
  });

  test("recognizes npm global node_modules in the Windows shape", () => {
    expect(classifyOrigin("C:\\npm\\node_modules\\open-second-brain")).toBe("registry");
  });

  test("recognizes an npm runner cache before its node_modules parent", () => {
    expect(classifyOrigin(join(fixtureRoot, ".npm/_npx/hash/node_modules/open-second-brain"))).toBe(
      "runner-cache",
    );
  });

  test("recognizes Bun's runner cache", () => {
    expect(
      classifyOrigin(join(fixtureRoot, ".bun/install/cache/pkg/node_modules/open-second-brain")),
    ).toBe("runner-cache");
  });

  test("recognizes a plugin cache", () => {
    expect(classifyOrigin(join(fixtureRoot, "plugins/cache/vendor/open-second-brain"))).toBe(
      "plugin-cache",
    );
  });

  test("treats a checkout as a checkout", () => {
    expect(classifyOrigin(fixtureRoot)).toBe("checkout");
  });

  test("classifies a symbolic link by the package root it points to", () => {
    const packageRoot = join(fixtureRoot, "registry/node_modules/open-second-brain");
    const link = join(fixtureRoot, "linked-package");
    mkdirSync(packageRoot, { recursive: true });
    symlinkSync(packageRoot, link, "dir");
    expect(classifyOrigin(realpathSync(link))).toBe("registry");
  });

  test("installOrigin reports the current package root and version", () => {
    const origin = installOrigin();
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../../package.json"), "utf8"),
    ) as { version: string };
    expect(origin).toEqual({
      kind: "checkout",
      root: realpathSync(resolve(import.meta.dir, "../../..")),
      version: packageJson.version,
    });
  });

  test("buildInstallEnv carries the current package origin", () => {
    const env = buildInstallEnv({
      vault: "",
      configPath: join(fixtureRoot, "config.yaml"),
      home: fixtureRoot,
      cwd: fixtureRoot,
      env: {},
    });
    expect(env.origin).toEqual(installOrigin());
  });

  test("runner-cache registrations name the permanent install command", () => {
    const origin: InstallOrigin = {
      kind: "runner-cache",
      root: join(fixtureRoot, "bun/install/cache/open-second-brain"),
      version: "2.0.0",
    };
    expect(() => assertNotRunnerCache(origin)).toThrow("bun add -g open-second-brain");
    expect(() => assertNotRunnerCache({ ...origin, kind: "registry" })).not.toThrow();
  });
});

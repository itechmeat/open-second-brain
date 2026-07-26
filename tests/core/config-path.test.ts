/**
 * Platform boundary for the plugin config path.
 *
 * `defaultConfigPath()` ends in `$HOME/.config/open-second-brain/…`.
 * That layout is a POSIX convention; Windows does not use it, and this
 * project has no Windows support - no adapter, no install document, no
 * path handling beyond three incidental `win32` branches. Returning a
 * `C:\Users\…\.config\…` path there is a plausible-looking answer to a
 * question this build cannot answer, so the resolver refuses by name
 * instead.
 *
 * The refusal is reachable ONLY on an unsupported platform AND only
 * after both explicit overrides have been checked, so every supported
 * platform is byte-identical.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  defaultConfigPath,
  resolveDefaultConfigPath,
  UnsupportedPlatformError,
  type ConfigPathEnv,
} from "../../src/core/config.ts";

const HOME = "/home/tester";

function envFor(platform: string, vars: Record<string, string> = {}): ConfigPathEnv {
  return { platform, home: HOME, env: vars };
}

describe("resolveDefaultConfigPath — supported platforms", () => {
  for (const platform of ["linux", "darwin", "freebsd", "openbsd", "sunos", "aix"]) {
    test(`${platform} resolves to $HOME/.config/open-second-brain/config.yaml`, () => {
      expect(resolveDefaultConfigPath(envFor(platform))).toBe(
        join(HOME, ".config", "open-second-brain", "config.yaml"),
      );
    });
  }

  test("the explicit override wins over the home fallback", () => {
    expect(
      resolveDefaultConfigPath(envFor("linux", { OPEN_SECOND_BRAIN_CONFIG: "/etc/osb.yaml" })),
    ).toBe("/etc/osb.yaml");
  });

  test("XDG_CONFIG_HOME wins over the home fallback", () => {
    expect(resolveDefaultConfigPath(envFor("linux", { XDG_CONFIG_HOME: "/xdg" }))).toBe(
      join("/xdg", "open-second-brain", "config.yaml"),
    );
  });

  test("the zero-argument form reads the real process and still resolves here", () => {
    // This test process runs on a supported platform; the refusal must be
    // unreachable for it, and the answer unchanged from before the branch.
    delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
    delete process.env["XDG_CONFIG_HOME"];
    expect(defaultConfigPath()).toBe(
      join(homedir(), ".config", "open-second-brain", "config.yaml"),
    );
  });
});

describe("resolveDefaultConfigPath — unsupported platform", () => {
  test("win32 raises a named error that names the platform", () => {
    let thrown: unknown;
    try {
      resolveDefaultConfigPath(envFor("win32"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedPlatformError);
    const error = thrown as UnsupportedPlatformError;
    expect(error.name).toBe("UnsupportedPlatformError");
    expect(error.platform).toBe("win32");
    expect(error.message).toContain("win32");
  });

  test("the refusal names both escape hatches", () => {
    expect(() => resolveDefaultConfigPath(envFor("win32"))).toThrow(/OPEN_SECOND_BRAIN_CONFIG/);
    expect(() => resolveDefaultConfigPath(envFor("win32"))).toThrow(/XDG_CONFIG_HOME/);
  });

  test("an explicit override is still honoured on win32", () => {
    expect(
      resolveDefaultConfigPath(
        envFor("win32", { OPEN_SECOND_BRAIN_CONFIG: "C:\\osb\\config.yaml" }),
      ),
    ).toBe("C:\\osb\\config.yaml");
  });

  test("XDG_CONFIG_HOME is still honoured on win32", () => {
    expect(resolveDefaultConfigPath(envFor("win32", { XDG_CONFIG_HOME: "C:\\cfg" }))).toBe(
      join("C:\\cfg", "open-second-brain", "config.yaml"),
    );
  });
});

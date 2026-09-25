/**
 * Platform boundary for the plugin config path.
 *
 * POSIX platforms resolve to `$HOME/.config/open-second-brain/config.yaml`;
 * native Windows resolves to `%LOCALAPPDATA%\open-second-brain\config.yaml`
 * (see `src/core/platform-dirs.ts`). Both explicit overrides win on every
 * platform, so an operator can always say where the file lives.
 */

import { describe, expect, test } from "bun:test";
import { join, win32 } from "node:path";

import {
  defaultConfigPath,
  resolveDefaultConfigPath,
  UnsupportedPlatformError,
  type ConfigPathEnv,
} from "../../src/core/config.ts";
import { configBaseDir, processDirsEnv } from "../../src/core/platform-dirs.ts";

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
    //
    // The two overrides are removed and PUT BACK. bun runs every test file in
    // one process, so dropping `OPEN_SECOND_BRAIN_CONFIG` for good takes the
    // hermetic default `tests/setup.ts` installs away from every file ordered
    // after this one - which is invisible on a machine that has a real
    // `~/.config/open-second-brain/config.yaml` to fall back on, and is 40-odd
    // failures on a bare runner that does not.
    const saved = {
      config: process.env["OPEN_SECOND_BRAIN_CONFIG"],
      xdg: process.env["XDG_CONFIG_HOME"],
    };
    delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
    delete process.env["XDG_CONFIG_HOME"];
    try {
      expect(defaultConfigPath()).toBe(
        join(configBaseDir(processDirsEnv()), "open-second-brain", "config.yaml"),
      );
    } finally {
      if (saved.config === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = saved.config;
      if (saved.xdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = saved.xdg;
    }
  });
});

describe("resolveDefaultConfigPath — native Windows", () => {
  test("win32 resolves under %LOCALAPPDATA%", () => {
    expect(
      resolveDefaultConfigPath(envFor("win32", { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" })),
    ).toBe(join("C:\\Users\\t\\AppData\\Local", "open-second-brain", "config.yaml"));
  });

  test("win32 without LOCALAPPDATA falls back to the profile's AppData\\Local", () => {
    expect(resolveDefaultConfigPath(envFor("win32"))).toBe(
      join(win32.join(HOME, "AppData", "Local"), "open-second-brain", "config.yaml"),
    );
  });

  test("win32 no longer raises UnsupportedPlatformError", () => {
    expect(() => resolveDefaultConfigPath(envFor("win32"))).not.toThrow(UnsupportedPlatformError);
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

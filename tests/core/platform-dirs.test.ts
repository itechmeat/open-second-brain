/**
 * Per-platform base directories (`src/core/platform-dirs.ts`).
 *
 * Every resolver is exercised through an injected environment, so the
 * Windows layout is pinned from a POSIX runner and vice versa.
 */

import { describe, expect, test } from "bun:test";
import { join, win32 } from "node:path";

import {
  cacheBaseDir,
  configBaseDir,
  dataBaseDir,
  describeBaseDir,
  isWindows,
  stateBaseDir,
  userBinDir,
  windowsLocalAppData,
  windowsRoamingAppData,
  type PlatformDirsEnv,
} from "../../src/core/platform-dirs.ts";

const POSIX_HOME = "/home/tester";
const WIN_HOME = "C:\\Users\\tester";
const LOCAL = "C:\\Users\\tester\\AppData\\Local";

function posix(vars: Record<string, string> = {}): PlatformDirsEnv {
  return { platform: "linux", home: POSIX_HOME, env: vars };
}

function windows(vars: Record<string, string> = { LOCALAPPDATA: LOCAL }): PlatformDirsEnv {
  return { platform: "win32", home: WIN_HOME, env: vars };
}

describe("POSIX defaults follow the XDG base directory layout", () => {
  test("config, data, state and cache", () => {
    expect(configBaseDir(posix())).toBe(join(POSIX_HOME, ".config"));
    expect(dataBaseDir(posix())).toBe(join(POSIX_HOME, ".local", "share"));
    expect(stateBaseDir(posix())).toBe(join(POSIX_HOME, ".local", "state"));
    expect(cacheBaseDir(posix())).toBe(join(POSIX_HOME, ".cache"));
  });

  test("macOS keeps the XDG layout, not ~/Library", () => {
    const mac: PlatformDirsEnv = { platform: "darwin", home: "/Users/t", env: {} };
    expect(configBaseDir(mac)).toBe(join("/Users/t", ".config"));
  });

  test("each XDG variable wins over its default", () => {
    const env = posix({
      XDG_CONFIG_HOME: "/x/c",
      XDG_DATA_HOME: "/x/d",
      XDG_STATE_HOME: "/x/s",
      XDG_CACHE_HOME: "/x/k",
    });
    expect(configBaseDir(env)).toBe("/x/c");
    expect(dataBaseDir(env)).toBe("/x/d");
    expect(stateBaseDir(env)).toBe("/x/s");
    expect(cacheBaseDir(env)).toBe("/x/k");
  });

  test("an empty XDG variable counts as unset", () => {
    expect(configBaseDir(posix({ XDG_CONFIG_HOME: "" }))).toBe(join(POSIX_HOME, ".config"));
  });
});

describe("native Windows uses %LOCALAPPDATA%", () => {
  test("every base directory is LOCALAPPDATA", () => {
    expect(configBaseDir(windows())).toBe(LOCAL);
    expect(dataBaseDir(windows())).toBe(LOCAL);
    expect(stateBaseDir(windows())).toBe(LOCAL);
    expect(cacheBaseDir(windows())).toBe(LOCAL);
  });

  test("a stripped environment falls back to the profile's AppData\\Local", () => {
    expect(windowsLocalAppData(windows({}))).toBe(win32.join(WIN_HOME, "AppData", "Local"));
    expect(windowsRoamingAppData(windows({}))).toBe(win32.join(WIN_HOME, "AppData", "Roaming"));
  });

  test("XDG variables still win on Windows", () => {
    expect(configBaseDir(windows({ LOCALAPPDATA: LOCAL, XDG_CONFIG_HOME: "D:\\cfg" }))).toBe(
      "D:\\cfg",
    );
  });

  test("launchers go to ~/.local/bin on every platform", () => {
    expect(userBinDir(windows())).toBe(join(WIN_HOME, ".local", "bin"));
    expect(userBinDir(posix())).toBe(join(POSIX_HOME, ".local", "bin"));
  });

  test("isWindows is true only for win32", () => {
    expect(isWindows({ platform: "win32" })).toBe(true);
    expect(isWindows({ platform: "linux" })).toBe(false);
  });
});

describe("describeBaseDir prints the rule for the reading platform", () => {
  test("POSIX shell expansion form", () => {
    expect(describeBaseDir("data", "linux")).toBe("${XDG_DATA_HOME:-~/.local/share}");
  });

  test("Windows environment-variable form", () => {
    expect(describeBaseDir("config", "win32")).toBe(
      "%XDG_CONFIG_HOME% if set, else %LOCALAPPDATA%",
    );
  });
});

/**
 * A `runCli` caller that sandboxes HOME gets that home for the per-user
 * config base in-process too, as a child process with that HOME would.
 *
 * Bun fixes `os.homedir()` when the process starts: neither an assignment
 * to `process.env.HOME` nor the in-process run's swapped environment moves
 * it. So a run that names a temp HOME and leaves `XDG_CONFIG_HOME` unset or
 * empty resolved the default config to the developer's REAL
 * `~/.config/open-second-brain/config.yaml` in-process, while the same run
 * as a subprocess used the temp home. A base passed empty with no HOME at
 * all falls back to the real home in both modes, so the harness refuses it.
 *
 * Windows keeps every base under `%LOCALAPPDATA%` (which the preload pins)
 * unless an XDG variable is set, so there the home fallback is an emptied
 * `%LOCALAPPDATA%` or `%APPDATA%`: each platform's expectations run on that
 * platform, and the pure rules of both run everywhere.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "./cli-timeout.ts";
import { perUserSandbox, runCli } from "./run-cli.ts";
import { tempDirs } from "./temp-dir.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const mkTemp = tempDirs();

function configLine(stdout: string): string | undefined {
  return stdout.split("\n").find((line) => line.includes("config writable:"));
}

const POSIX = process.platform !== "win32";

describe("perUserSandbox (either platform's rules, from any host)", () => {
  test("POSIX: an emptied base and the unpassed config base go under HOME", () => {
    expect(perUserSandbox({ HOME: "/t/h", XDG_STATE_HOME: "" }, "linux")).toEqual({
      XDG_CONFIG_HOME: "/t/h/.config",
      XDG_STATE_HOME: "/t/h/.local/state",
    });
    expect(perUserSandbox({ HOME: "/t/h", XDG_CONFIG_HOME: "/t/c" }, "darwin")).toEqual({});
  });

  test("POSIX: an emptied base without HOME is refused, the cache base included", () => {
    expect(() => perUserSandbox({ XDG_CACHE_HOME: "" }, "linux")).toThrow("pass HOME");
    expect(perUserSandbox({}, "linux")).toEqual({});
  });

  test("Windows: an emptied app-data base or profile goes under HOME, an emptied XDG base is left to the pinned app data", () => {
    expect(
      perUserSandbox(
        { HOME: "C:\\t\\h", LOCALAPPDATA: "", APPDATA: "", XDG_CONFIG_HOME: "" },
        "win32",
      ),
    ).toEqual({
      LOCALAPPDATA: "C:\\t\\h\\AppData\\Local",
      APPDATA: "C:\\t\\h\\AppData\\Roaming",
    });
    expect(perUserSandbox({ HOME: "C:\\t\\h", USERPROFILE: "" }, "win32")).toEqual({
      USERPROFILE: "C:\\t\\h",
    });
    expect(perUserSandbox({ USERPROFILE: "C:\\t\\p", LOCALAPPDATA: "" }, "win32")).toEqual({
      LOCALAPPDATA: "C:\\t\\p\\AppData\\Local",
    });
  });

  test("Windows: an emptied app-data base or profile without a home is refused", () => {
    for (const name of ["LOCALAPPDATA", "APPDATA", "USERPROFILE"]) {
      expect(() => perUserSandbox({ [name]: "" }, "win32")).toThrow("pass HOME");
    }
    expect(perUserSandbox({ XDG_CONFIG_HOME: "" }, "win32")).toEqual({});
  });
});

describe.skipIf(!POSIX)("runCli with a sandboxed HOME (POSIX)", () => {
  for (const subprocess of [false, true]) {
    test(`the default config lives under that HOME (${subprocess ? "subprocess" : "in-process"})`, async () => {
      const home = mkTemp("osb-run-cli-home-");
      const vault = join(home, "vault");
      mkdirSync(vault);
      const r = await runCli(["doctor", "--vault", vault], {
        env: { HOME: home, XDG_CONFIG_HOME: "", OPEN_SECOND_BRAIN_CONFIG: "" },
        subprocess,
      });
      expect(configLine(r.stdout)).toContain(
        join(home, ".config", "open-second-brain", "config.yaml"),
      );
    });
  }

  test("an XDG base passed empty without a HOME is refused, in either mode", async () => {
    for (const subprocess of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- one mode after the other
      await expect(
        runCli(["--version"], { env: { XDG_CONFIG_HOME: "" }, subprocess }),
      ).rejects.toThrow("pass HOME");
    }
  });
});

describe.skipIf(POSIX)("runCli with a sandboxed HOME (Windows)", () => {
  for (const subprocess of [false, true]) {
    test(`an emptied %LOCALAPPDATA% puts the default config under that HOME (${subprocess ? "subprocess" : "in-process"})`, async () => {
      const home = mkTemp("osb-run-cli-home-");
      const vault = join(home, "vault");
      mkdirSync(vault);
      const r = await runCli(["doctor", "--vault", vault], {
        env: { HOME: home, XDG_CONFIG_HOME: "", LOCALAPPDATA: "", OPEN_SECOND_BRAIN_CONFIG: "" },
        subprocess,
      });
      expect(configLine(r.stdout)).toContain(
        join(home, "AppData", "Local", "open-second-brain", "config.yaml"),
      );
    });
  }

  test("an app-data base passed empty without a HOME is refused, in either mode", async () => {
    for (const subprocess of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- one mode after the other
      await expect(
        runCli(["--version"], { env: { LOCALAPPDATA: "" }, subprocess }),
      ).rejects.toThrow("pass HOME");
    }
  });
});

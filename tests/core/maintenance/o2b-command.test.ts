/**
 * How Open Second Brain starts itself again (`o2b-command.ts`): under the
 * runtime of this process by its absolute path, never a PATH lookup, with
 * the launcher only as the fallback of a process that does not run under
 * Bun; the macOS SQLite setup the launcher made travels in the
 * environment; every background child is detached.
 */
import { describe, expect, test } from "bun:test";

import {
  CLI_ENTRY,
  detachedSpawnOptions,
  MACOS_SQLITE_PREFIXES,
  o2bCommand,
  selfCommandFor,
  selfSpawnEnv,
} from "../../../src/core/maintenance/o2b-command.ts";

const ENTRY = "/checkout/src/cli/main.ts";
const LAUNCHER = "/checkout/scripts/o2b";
const BOOTSTRAP = "/checkout/src/cli/deps-bootstrap.ts";

describe("selfCommandFor", () => {
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly bun: boolean;
    readonly execPath: string;
    readonly platform: NodeJS.Platform;
    readonly launcher: string | null;
    readonly depsMissing?: boolean;
    readonly argv: string[];
  }> = [
    {
      name: "Bun on POSIX: the runtime's own path, not the launcher",
      bun: true,
      execPath: "/opt/bun/bin/bun",
      platform: "darwin",
      launcher: LAUNCHER,
      argv: ["/opt/bun/bin/bun", "run", ENTRY],
    },
    {
      name: "Bun on Windows",
      bun: true,
      execPath: "C:\\bun\\bun.exe",
      platform: "win32",
      launcher: LAUNCHER,
      argv: ["C:\\bun\\bun.exe", "run", ENTRY],
    },
    {
      name: "Bun with a relative executable path: the fallback",
      bun: true,
      execPath: "bun",
      platform: "linux",
      launcher: LAUNCHER,
      argv: [LAUNCHER],
    },
    {
      name: "Node on POSIX, the CLI: the launcher",
      bun: false,
      execPath: "/usr/bin/node",
      platform: "linux",
      launcher: LAUNCHER,
      argv: [LAUNCHER],
    },
    {
      name: "Node on Windows: Bun from PATH",
      bun: false,
      execPath: "C:\\node\\node.exe",
      platform: "win32",
      launcher: LAUNCHER,
      argv: ["bun", "run", ENTRY],
    },
    {
      name: "Bun, the checkout's dependency tree missing: the bootstrap entry",
      bun: true,
      execPath: "/opt/bun/bin/bun",
      platform: "linux",
      launcher: LAUNCHER,
      depsMissing: true,
      argv: ["/opt/bun/bin/bun", "run", BOOTSTRAP],
    },
    {
      name: "Bun on Windows, the dependency tree missing: the bootstrap entry",
      bun: true,
      execPath: "C:\\bun\\bun.exe",
      platform: "win32",
      launcher: LAUNCHER,
      depsMissing: true,
      argv: ["C:\\bun\\bun.exe", "run", BOOTSTRAP],
    },
    {
      name: "Node, another entry script: Bun from PATH",
      bun: false,
      execPath: "/usr/bin/node",
      platform: "linux",
      launcher: null,
      argv: ["bun", "run", ENTRY],
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      expect(
        selfCommandFor(
          ENTRY,
          { bun: row.bun, execPath: row.execPath },
          row.platform,
          row.launcher,
          row.depsMissing === true ? BOOTSTRAP : null,
        ),
      ).toEqual(row.argv);
    });
  }

  test("this process (Bun) runs the CLI under its own runtime", () => {
    expect(o2bCommand()).toEqual([process.execPath, "run", CLI_ENTRY]);
  });
});

describe("selfSpawnEnv", () => {
  const brew = MACOS_SQLITE_PREFIXES[0]!;

  test("macOS with Homebrew SQLite and no DYLD_LIBRARY_PATH: the launcher's setup", () => {
    const env = selfSpawnEnv({ A: "1" }, "darwin", (p) => p === brew);
    expect(env).toEqual({ A: "1", DYLD_LIBRARY_PATH: brew });
  });

  test("a DYLD_LIBRARY_PATH the caller set, even empty, is kept as it is", () => {
    expect(selfSpawnEnv({ DYLD_LIBRARY_PATH: "" }, "darwin", () => true)).toEqual({
      DYLD_LIBRARY_PATH: "",
    });
  });

  test("macOS without Homebrew SQLite, and every other platform: a plain copy", () => {
    const base = { A: "1" };
    expect(selfSpawnEnv(base, "darwin", () => false)).toEqual(base);
    const linux = selfSpawnEnv(base, "linux", () => true);
    expect(linux).toEqual(base);
    expect(linux).not.toBe(base);
  });
});

describe("detachedSpawnOptions", () => {
  test("detached on every platform, hidden, streams ignored unless a log is named", () => {
    expect(detachedSpawnOptions({})).toMatchObject({
      detached: true,
      windowsHide: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(detachedSpawnOptions({}, 7).stderr).toBe(7);
  });
});

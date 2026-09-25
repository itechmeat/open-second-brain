/**
 * The MCP launch command on native Windows (`buildPayload(..., "win32")`).
 */

import { describe, expect, test } from "bun:test";

import {
  buildPayload,
  launcherCommand,
  PayloadError,
  WINDOWS_LAUNCHER_ENV,
} from "../../../src/core/install/payload.ts";

const CFG = { vault: "C:\\Users\\t\\Vault", agent_name: "claude-box-agent", timezone: "UTC" };

describe("buildPayload on win32", () => {
  test("starts the o2b.cmd launcher through cmd /d /c", () => {
    const { full, writer } = buildPayload(CFG, "win32");
    expect(full.command).toBe("cmd");
    expect(full.args).toEqual(["/d", "/c", "o2b", "mcp", "--vault", CFG.vault]);
    expect(writer.args).toEqual(["/d", "/c", "o2b", "mcp", "--writer-only", "--vault", CFG.vault]);
    expect(full.env).toEqual({
      NoDefaultCurrentDirectoryInExePath: "1",
      VAULT_AGENT_NAME: "claude-box-agent",
      VAULT_TIMEZONE: "UTC",
    });
  });

  test("every Windows entry turns off cmd's current-directory lookup, even without identity", () => {
    // An MCP host starts the server in the project it opened, and cmd.exe
    // looks for `o2b` there before PATH: a repository shipping an o2b.cmd
    // would run. The variable is what stops that, so no entry may lack it.
    const { full, writer } = buildPayload({ ...CFG, agent_name: null, timezone: null }, "win32");
    expect(full.env).toEqual({ ...WINDOWS_LAUNCHER_ENV });
    expect(writer.env).toEqual({ ...WINDOWS_LAUNCHER_ENV });
    expect(WINDOWS_LAUNCHER_ENV).toEqual({ NoDefaultCurrentDirectoryInExePath: "1" });
    // POSIX has no such lookup and carries no such variable.
    expect(buildPayload({ ...CFG, agent_name: null, timezone: null }, "linux").full.env).toBe(
      undefined,
    );
  });

  test("POSIX is unchanged: bare o2b off PATH", () => {
    const { full } = buildPayload(CFG, "linux");
    expect(full.command).toBe("o2b");
    expect(full.args).toEqual(["mcp", "--vault", CFG.vault]);
    expect(launcherCommand("darwin")).toEqual({ command: "o2b", prefix: [] });
  });

  test("a vault path with a cmd metacharacter is refused by name", () => {
    for (const bad of [
      "C:\\R&D\\vault",
      "C:\\a|b",
      "C:\\100%\\v",
      "C:\\a^b",
      "C:\\a<b",
      "C:\\a>b",
      'C:\\a"b',
      // Expanded wherever delayed expansion is on in the registry.
      "C:\\Hey!\\vault",
    ]) {
      expect(() => buildPayload({ ...CFG, vault: bad }, "win32")).toThrow(PayloadError);
    }
    // Spaces are fine: every host quotes an argument that has them.
    expect(() => buildPayload({ ...CFG, vault: "C:\\My Vault" }, "win32")).not.toThrow();
    // The guard is Windows-only; POSIX spawns o2b directly.
    expect(() => buildPayload({ ...CFG, vault: "/srv/r&d" }, "linux")).not.toThrow();
  });
});

/**
 * The MCP launch command on native Windows (`buildPayload(..., "win32")`).
 */

import { describe, expect, test } from "bun:test";

import { buildPayload, launcherCommand, PayloadError } from "../../../src/core/install/payload.ts";

const CFG = { vault: "C:\\Users\\t\\Vault", agent_name: "claude-box-agent", timezone: "UTC" };

describe("buildPayload on win32", () => {
  test("starts the o2b.cmd launcher through cmd /d /c", () => {
    const { full, writer } = buildPayload(CFG, "win32");
    expect(full.command).toBe("cmd");
    expect(full.args).toEqual(["/d", "/c", "o2b", "mcp", "--vault", CFG.vault]);
    expect(writer.args).toEqual(["/d", "/c", "o2b", "mcp", "--writer-only", "--vault", CFG.vault]);
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "claude-box-agent", VAULT_TIMEZONE: "UTC" });
  });

  test("POSIX is unchanged: bare o2b off PATH", () => {
    const { full } = buildPayload(CFG, "linux");
    expect(full.command).toBe("o2b");
    expect(full.args).toEqual(["mcp", "--vault", CFG.vault]);
    expect(launcherCommand("darwin")).toEqual({ command: "o2b", prefix: [] });
  });

  test("a vault path with a cmd metacharacter is refused by name", () => {
    for (const bad of ["C:\\R&D\\vault", "C:\\a|b", "C:\\100%\\v", "C:\\a^b"]) {
      expect(() => buildPayload({ ...CFG, vault: bad }, "win32")).toThrow(PayloadError);
    }
    // Spaces are fine: every host quotes an argument that has them.
    expect(() => buildPayload({ ...CFG, vault: "C:\\My Vault" }, "win32")).not.toThrow();
    // The guard is Windows-only; POSIX spawns o2b directly.
    expect(() => buildPayload({ ...CFG, vault: "/srv/r&d" }, "linux")).not.toThrow();
  });
});

/**
 * The note `o2b install-cli` prints when the launcher directory is not on
 * the Windows PATH. Platform and PATH are injected, so it runs anywhere.
 */

import { describe, expect, test } from "bun:test";

import { windowsPathHint } from "../../src/cli/windows-path-hint.ts";

const BIN = "C:\\Users\\o'brien\\.local\\bin";

describe("windowsPathHint", () => {
  test("silent off Windows", () => {
    expect(windowsPathHint(BIN, "linux", "")).toBeNull();
    expect(windowsPathHint(BIN, "darwin", "")).toBeNull();
  });

  test("silent when the directory is on PATH, in any case and with a trailing slash", () => {
    expect(windowsPathHint(BIN, "win32", `C:\\Windows;${BIN}`)).toBeNull();
    expect(windowsPathHint(BIN, "win32", `C:\\Windows;${BIN.toUpperCase()}\\`)).toBeNull();
    expect(windowsPathHint(BIN, "win32", `C:\\Windows; ${BIN}/`)).toBeNull();
  });

  test("names the route to the Path editor, and no command that rewrites the value", () => {
    const hint = windowsPathHint(BIN, "win32", "C:\\Windows;C:\\Tools");
    expect(hint).not.toBeNull();
    expect(hint).toContain(`${BIN} is not on PATH`);
    expect(hint).toContain("Environment Variables");
    expect(hint).toContain("rundll32.exe sysdm.cpl,EditEnvironmentVariables");
    // The old PowerShell one-liner broke on the `'` in this user name and
    // rewrote a REG_EXPAND_SZ Path as a frozen REG_SZ copy.
    expect(hint).not.toContain("SetEnvironmentVariable");
  });
});

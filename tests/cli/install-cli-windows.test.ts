/**
 * `.cmd` launchers written by `o2b install-cli` on native Windows.
 *
 * The functions take the scripts directory and the bin directory as
 * arguments, so the ownership policy is pinned on any host. The launchers
 * they write are run end to end through a real `cmd.exe` on Windows by
 * `tests/scripts/windows-launchers.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  healCliWindows,
  installCliWindows,
  launcherBody,
  launcherTarget,
  uninstallCliWindows,
} from "../../src/cli/install-cli-windows.ts";

const NAMES = ["o2b", "vault-log", "o2b-hook"] as const;

let root: string;
let scripts: string;
let bin: string;

function makeCheckout(dir: string): string {
  const s = join(dir, "scripts");
  mkdirSync(s, { recursive: true });
  for (const n of NAMES) writeFileSync(join(s, `${n}.cmd`), "@echo off\r\n");
  return s;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-cli-win-"));
  scripts = makeCheckout(join(root, "checkout"));
  bin = join(root, "bin");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("launcher format", () => {
  test("the body hands over to the target with CRLF line endings", () => {
    const body = launcherBody("C:\\osb\\scripts\\o2b.cmd");
    expect(body).toBe(
      '@echo off\r\nrem open-second-brain launcher -> C:\\osb\\scripts\\o2b.cmd\r\n"C:\\osb\\scripts\\o2b.cmd" %*\r\n',
    );
  });

  test("a % in the target is doubled on the command line, kept as-is in the marker", () => {
    const body = launcherBody("C:\\100%\\scripts\\o2b.cmd");
    expect(body.split("\r\n")[1]).toBe(
      "rem open-second-brain launcher -> C:\\100%\\scripts\\o2b.cmd",
    );
    expect(body.split("\r\n")[2]).toBe('"C:\\100%%\\scripts\\o2b.cmd" %*');
  });

  test("the marker is read back; a foreign file has none", () => {
    const file = join(root, "x.cmd");
    writeFileSync(file, launcherBody("C:\\a\\scripts\\o2b.cmd"));
    expect(launcherTarget(file)).toBe("C:\\a\\scripts\\o2b.cmd");
    writeFileSync(file, "@echo off\r\necho hi\r\n");
    expect(launcherTarget(file)).toBeNull();
    expect(launcherTarget(join(root, "absent.cmd"))).toBeNull();
  });
});

describe("install", () => {
  test("creates one launcher per CLI name, then reports them as existing", () => {
    const first = installCliWindows(NAMES, scripts, bin);
    expect(first.errors).toEqual([]);
    for (const n of NAMES) {
      expect(launcherTarget(join(bin, `${n}.cmd`))).toBe(join(scripts, `${n}.cmd`));
    }
    const second = installCliWindows(NAMES, scripts, bin);
    expect(second.outcomes.every(([, m]) => m.startsWith("exists:"))).toBe(true);
  });

  test("rewrites our launcher when its command line is not the current body", () => {
    installCliWindows(NAMES, scripts, bin);
    const file = join(bin, "o2b.cmd");
    const target = join(scripts, "o2b.cmd");
    // Ours by the marker, but an older or hand-edited command line.
    writeFileSync(
      file,
      `@echo off\r\nrem open-second-brain launcher -> ${target}\r\necho stale\r\n`,
    );
    const res = installCliWindows(NAMES, scripts, bin);
    expect(res.outcomes.find(([n]) => n === "o2b")?.[1]).toStartWith("updated:");
    expect(readFileSync(file, "utf8")).toBe(launcherBody(target));
  });

  test("repoints our own launcher from another checkout", () => {
    const other = makeCheckout(join(root, "old"));
    installCliWindows(NAMES, other, bin);
    const res = installCliWindows(NAMES, scripts, bin);
    expect(res.outcomes.every(([, m]) => m.startsWith("repointed:"))).toBe(true);
    expect(launcherTarget(join(bin, "o2b.cmd"))).toBe(join(scripts, "o2b.cmd"));
  });

  test("refuses a file that is not ours", () => {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "o2b.cmd"), "@echo off\r\necho someone else\r\n");
    const res = installCliWindows(NAMES, scripts, bin);
    expect(res.errors.length).toBe(1);
    expect(readFileSync(join(bin, "o2b.cmd"), "utf8")).toContain("someone else");
  });

  test("reports a missing launcher source as an error", () => {
    rmSync(join(scripts, "vault-log.cmd"));
    const res = installCliWindows(NAMES, scripts, bin);
    expect(res.errors.some((e) => e.includes("vault-log.cmd"))).toBe(true);
  });
});

describe("heal", () => {
  test("repairs a launcher whose target rotated out of a plugin cache", () => {
    const cached = makeCheckout(join(root, "plugins", "cache", "osb", "1.0.0"));
    installCliWindows(NAMES, cached, bin);
    rmSync(join(root, "plugins"), { recursive: true, force: true });
    const res = healCliWindows(NAMES, scripts, bin);
    expect(res.outcomes.length).toBe(NAMES.length);
    expect(launcherTarget(join(bin, "o2b.cmd"))).toBe(join(scripts, "o2b.cmd"));
  });

  test("leaves a stable-directory install alone", () => {
    const stable = makeCheckout(join(root, "srv", "osb"));
    installCliWindows(NAMES, stable, bin);
    const res = healCliWindows(NAMES, scripts, bin);
    expect(res.outcomes).toEqual([]);
    expect(launcherTarget(join(bin, "o2b.cmd"))).toBe(join(stable, "o2b.cmd"));
  });
});

describe("uninstall", () => {
  test("removes only launchers that point into this checkout", () => {
    installCliWindows(NAMES, scripts, bin);
    writeFileSync(join(bin, "vault-log.cmd"), "@echo off\r\n");
    const res = uninstallCliWindows(NAMES, scripts, bin);
    expect(existsSync(join(bin, "o2b.cmd"))).toBe(false);
    expect(existsSync(join(bin, "vault-log.cmd"))).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

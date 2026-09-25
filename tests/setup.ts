/**
 * Global bun:test preload (registered in bunfig.toml).
 *
 * Makes the whole suite hermetic: unless a test or the environment already
 * points `OPEN_SECOND_BRAIN_CONFIG` somewhere explicit, every test resolves an
 * isolated throwaway vault + config instead of the developer's real
 * `~/.config/open-second-brain/config.yaml`.
 *
 * Two problems this fixes:
 *   1. On a bare CI runner there is no `o2b init` config, so any test that
 *      resolved the config threw "plugin config not found" - ~136 failures
 *      that only passed on a machine with a pre-initialised config.
 *   2. On a configured machine those same tests read (and could write) the
 *      operator's REAL vault. A throwaway default keeps tests off it.
 *
 * Tests that need their own vault still set `OPEN_SECOND_BRAIN_CONFIG` /
 * `XDG_CONFIG_HOME` themselves; this only provides a safe default.
 */
import { beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearOriginChannel } from "../src/core/origin-channel.ts";

// The origin channel (`src/core/origin-channel.ts`) is process-scoped by
// design: an entry point claims it once and every record written under
// that process carries it. Bun runs many test files in ONE process, so a
// file that invokes `main()` leaves `cli` claimed for every file that
// runs after it - and a byte-identity golden over a log line, a signal or
// a continuity record would then pass or fail on file ORDER.
//
// Unclaiming before each test makes the default deterministic (`unset`,
// the explicit literal for "no entry point claimed this process") without
// pinning a real channel that would hide the difference. A test that
// wants a channel claims it, exactly as the entry point does. Registered
// here rather than in each suite for the same reason `O2B_DEVICE_ID` is
// pinned above: a hermeticity rule every file needs is not a rule every
// file should have to remember.
beforeEach(() => {
  clearOriginChannel();
});

// Per-device log sharding (Memory Integrity Suite): pin the device id
// to the empty string so the suite writes the legacy un-sharded log
// pair deterministically. Shard-specific tests clear / override
// O2B_DEVICE_ID themselves.
if (process.env["O2B_DEVICE_ID"] === undefined) {
  process.env["O2B_DEVICE_ID"] = "";
}

if (!process.env["OPEN_SECOND_BRAIN_CONFIG"]) {
  const root = mkdtempSync(join(tmpdir(), "osb-test-default-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
}

// Windows keeps the per-user config/state/cache roots under
// `%LOCALAPPDATA%` (and a few host-agent roots, e.g. Cursor's sessions,
// under `%APPDATA%`) - see `src/core/platform-dirs.ts`. Suites isolate
// themselves the POSIX way, by pointing HOME or XDG_* at a temp dir; on
// Windows a HOME-only redirect leaves `%LOCALAPPDATA%` naming the
// operator's REAL profile, and a test that mints a device id or an
// installation secret writes it into the real
// `%LOCALAPPDATA%\open-second-brain\config.yaml`. Redirecting both roots to
// a throwaway directory for the whole process gives Windows the same
// safe default the XDG layout gets from a temp HOME. A test that needs a
// specific root still sets the variable itself.
//
// Like every override in this file, it reaches only this process and
// children spawned with an explicit `env: { ...process.env }`: Bun hands a
// child without one the environment the process started with.
if (process.platform === "win32") {
  const appRoot = mkdtempSync(join(tmpdir(), "osb-test-appdata-"));
  for (const name of ["LOCALAPPDATA", "APPDATA"] as const) {
    const dir = join(appRoot, name);
    mkdirSync(dir, { recursive: true });
    process.env[name] = dir;
  }
}

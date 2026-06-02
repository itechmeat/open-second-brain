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
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

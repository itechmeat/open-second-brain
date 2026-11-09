/**
 * What the migration puts into this machine's device config (design D14
 * items 3 and 15), and what a rollback takes back out:
 *
 *  - The MCP token map: the per-vault `mcp-tokens.json` is copied to the
 *    device-config copy beside the machine config
 *    (`brain/secrets/device-token-path.ts`), which the MCP transport reads
 *    first, so a server with no vault still authenticates the tokens
 *    minted before the switch. The copy is written owner-only from its
 *    first byte and exclusively, so a device copy already there (or one a
 *    concurrent mint writes meanwhile) is never overwritten. The copy is
 *    noted in the migration folder; a rollback makes the per-vault file the
 *    token map again: an unchanged copy is removed, and a copy that changed
 *    since (tokens minted, rotated or revoked after the switch) is written
 *    back over the per-vault file when that file did not change since the
 *    copy, so no revoked token authenticates again and no newer one stops.
 *    When both changed, the device copy is set aside and reported.
 *  - The device keys of `_brain.yaml`: each changed device key the import
 *    reports is appended to the machine config as `<key>: <JSON value>`,
 *    the form the settings reader parses, unless the config already sets
 *    that key (the user's value stays). `setConfigValue` is not used: it
 *    rewrites every line as a quoted string, which would turn the user's
 *    typed device values into strings.
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deviceTokenStorePath } from "../brain/secrets/device-token-path.ts";
import { restrictToOwner } from "../brain/secrets/owner-acl.ts";
import { tokenStorePath } from "../brain/secrets/store.ts";
import { discoverConfig } from "../config.ts";
import { atomicWriteFileSync, renameWithRetry } from "../fs-atomic.ts";

const TOKEN_COPY_NOTE = "device-tokens.json";

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** What became of the vault's MCP token map. */
export type DeviceTokenPlacement =
  | { readonly status: "none" }
  | { readonly status: "copied" | "same" | "kept"; readonly path: string };

/**
 * Copy `vault`'s MCP token map to the device-config copy (see the module
 * header). `kept`: a different device copy was already there and stays.
 */
export function placeDeviceTokens(
  vault: string,
  configPath: string | undefined,
  migrationDir: string,
): DeviceTokenPlacement {
  const source = tokenStorePath(vault);
  if (!existsSync(source)) return { status: "none" };
  const target = deviceTokenStorePath(configPath);
  try {
    // Owner-only from its first byte, and exclusive: a device copy already
    // there, or one a concurrent mint writes meanwhile, is never replaced.
    writeFileSync(target, readFileSync(source), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { status: sha256(target) === sha256(source) ? "same" : "kept", path: target };
  }
  if (process.platform === "win32") restrictToOwner(target, "file");
  atomicWriteFileSync(
    join(migrationDir, TOKEN_COPY_NOTE),
    `${JSON.stringify({ path: target, sha256: sha256(target) })}\n`,
  );
  return { status: "copied", path: target };
}

/** Replace `target` with the bytes of `source`, owner-only, through a temp name. */
function writeOwnerOnlyOver(source: string, target: string): void {
  const temp = `${target}.rollback-${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, readFileSync(source), { mode: 0o600, flag: "wx" });
  try {
    renameWithRetry(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  if (process.platform === "win32") restrictToOwner(target, "file");
}

/**
 * Undo {@link placeDeviceTokens} for a rollback (see the module header):
 * the copy the migration made is removed when unchanged; when it changed
 * since, it is written back over the vault's token map if that map did
 * not change since the copy, else set aside as `<file>.rolled-back`
 * (nothing is deleted that the migration did not write). Returns the path
 * set aside, or null.
 */
export function removeDeviceTokens(migrationDir: string, vault: string): string | null {
  const note = join(migrationDir, TOKEN_COPY_NOTE);
  let copy: { path?: unknown; sha256?: unknown };
  try {
    copy = JSON.parse(readFileSync(note, "utf8")) as typeof copy;
  } catch {
    return null;
  }
  let aside: string | null = null;
  if (typeof copy.path === "string" && existsSync(copy.path)) {
    const perVault = tokenStorePath(vault);
    if (sha256(copy.path) === copy.sha256) rmSync(copy.path, { force: true });
    else if (existsSync(perVault) && sha256(perVault) === copy.sha256) {
      // The device copy is the up-to-date map: it becomes the vault's again.
      writeOwnerOnlyOver(copy.path, perVault);
      rmSync(copy.path, { force: true });
    } else {
      aside = `${copy.path}.rolled-back`;
      renameSync(copy.path, aside);
    }
  }
  rmSync(note, { force: true });
  return aside;
}

/** What the migration did with the device keys of `_brain.yaml`. */
export interface DeviceConfigWrite {
  /** The machine config the keys went to. */
  readonly path: string;
  /** Config lines appended. */
  readonly written: ReadonlyArray<string>;
  /** Config keys the machine config already set, left as they were. */
  readonly kept: ReadonlyArray<string>;
}

/** The keys a machine config file sets (`key:` at the start of a line). */
function configKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at > 0) keys.add(line.slice(0, at).trim());
  }
  return keys;
}

/** Append each `<key>: <value>` line whose key the machine config does not set yet. */
export function writeDeviceSettings(
  lines: ReadonlyArray<{ readonly line: string }>,
  configPath: string | undefined,
): DeviceConfigWrite {
  const path = discoverConfig(configPath).path;
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = configKeys(before);
  const written: string[] = [];
  const kept: string[] = [];
  for (const { line } of lines) {
    const key = line.slice(0, line.indexOf(":")).trim();
    if (present.has(key)) kept.push(key);
    else {
      written.push(line);
      present.add(key);
    }
  }
  if (written.length > 0) {
    const sep = before === "" || before.endsWith("\n") ? "" : "\n";
    atomicWriteFileSync(path, `${before}${sep}${written.join("\n")}\n`);
  }
  return { path, written, kept };
}

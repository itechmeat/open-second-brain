/**
 * Server-resolved scope identity for the scoped operator rules
 * (`scoped-rules.ts`).
 *
 * Every axis is derived from a fact the caller cannot name:
 *
 *   - project: the directory holding the nearest `.o2b-vault.json`
 *     pointer that names the serving vault, written by the operator with
 *     `o2b brain project link`;
 *   - harness: the launch-time `o2b mcp --harness` option written by the
 *     packager or installer, else the install target (`--host-target`);
 *   - host: the device id, never the host name (not stable, not unique,
 *     and host names must not reach public text).
 *
 * Never `clientInfo`, never a tool argument, never page frontmatter.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { ConfigReadError, resolveDeviceId } from "../config.ts";
import type { InstallTargetId } from "../runtime/host-facts.ts";
import { findVaultPointer } from "./portability/pointer.ts";
import { type HarnessId, scopedRuleKey } from "./scoped-rules.ts";

/**
 * Project key of a workspace directory: the basename of the directory
 * that holds the nearest pointer naming the serving vault, keyed by
 * `scopedRuleKey`. A pointer that names another vault, or is malformed,
 * does not stop the walk: a repository cloned inside a linked project
 * cannot choose or suppress that project's scope with a committed
 * pointer. `null` for a null directory or when no pointer up the tree
 * names the serving vault (fail closed).
 */
export function resolveProjectScope(
  workspaceDir: string | null,
  servingVault: string,
): string | null {
  if (workspaceDir === null) return null;
  const serving = canonical(servingVault);
  let probe = findVaultPointer(workspaceDir);
  while (probe !== null) {
    if (probe.pointer !== null && canonical(resolve(probe.dir, probe.pointer.vault)) === serving) {
      return scopedRuleKey(basename(probe.dir));
    }
    const parent = dirname(probe.dir);
    if (parent === probe.dir) return null;
    probe = findVaultPointer(parent);
  }
  return null;
}

/** The real path, or the resolved path when it cannot be resolved. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export interface HostScope {
  /** The device id as a scoped-rule key, or `null` when there is none. */
  readonly host: string | null;
  /** True when the device id could not be read (the config is unreadable). */
  readonly unreadable: boolean;
}

/**
 * Host key from the device id. The empty id is the operator's explicit
 * opt-out and is silent; an unreadable config is reported through
 * `unreadable` so the reader can say host-scoped rules were not applied.
 * Any other failure propagates.
 */
export function resolveHostScope(configPath: string | undefined): HostScope {
  let id: string;
  try {
    id = resolveDeviceId(configPath);
  } catch (err) {
    if (err instanceof ConfigReadError) return Object.freeze({ host: null, unreadable: true });
    throw err;
  }
  if (id === "") return Object.freeze({ host: null, unreadable: false });
  return Object.freeze({ host: scopedRuleKey(id), unreadable: false });
}

/** The `--harness` value, else the install target, else `null`. */
export function resolveHarnessScope(
  harness: HarnessId | undefined,
  hostTarget: InstallTargetId | undefined,
): HarnessId | null {
  return harness ?? hostTarget ?? null;
}

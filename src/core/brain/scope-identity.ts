/**
 * Server-resolved scope identity for the scoped operator rules
 * (`scoped-rules.ts`).
 *
 * Every axis is derived from a fact the caller cannot name:
 *
 *   - project: the directory holding the nearest `.o2b-vault.json`
 *     pointer, written by the operator with `o2b brain project link`;
 *   - harness: the launch-time `o2b mcp --harness` option written by the
 *     packager or installer, else the install target (`--host-target`);
 *   - host: the device id, never the host name (not stable, not unique,
 *     and host names must not reach public text).
 *
 * Never `clientInfo`, never a tool argument, never page frontmatter.
 */

import { basename } from "node:path";

import { ConfigReadError, resolveDeviceId } from "../config.ts";
import type { InstallTargetId } from "../runtime/host-facts.ts";
import { findVaultPointer } from "./portability/pointer.ts";
import { type HarnessId, scopedRuleKey } from "./scoped-rules.ts";

/**
 * Project key of a workspace directory: the basename of the directory
 * that holds the nearest pointer, keyed by `scopedRuleKey`. `null` for a
 * null directory, no pointer, or a malformed pointer (fail closed). The
 * pointer is not required to name the serving vault: it proves the
 * directory is a linked project.
 */
export function resolveProjectScope(workspaceDir: string | null): string | null {
  if (workspaceDir === null) return null;
  const probe = findVaultPointer(workspaceDir);
  if (probe === null || probe.error !== null) return null;
  return scopedRuleKey(basename(probe.dir));
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

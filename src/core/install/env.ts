/**
 * The `InstallEnv` every adapter on a run is handed, built once.
 *
 * `InstallEnv` is documented as the complete description of a run, and
 * building it was private to the `o2b install` verb. The MCP `hosts`
 * view answers the same question over the same adapters, and a second
 * env builder would be a second answer to "which machine is being
 * verified" - the split this constructor's own docblock in the CLI was
 * written to close, one surface over.
 *
 * Core rather than CLI because both callers need it and core is the
 * layer they share; nothing here writes to stdout or exits.
 */

import { homedir } from "node:os";

import { discoverConfig } from "../config.ts";
import type { InstallEnv } from "./types.ts";

/**
 * Why a run with no vault refuses instead of verifying.
 *
 * `verify()` reads the per-vault sidecar manifest, so with an unset
 * vault every adapter reports `not-installed` off a bogus path and the
 * operator is told ten runtimes are absent when the real condition is
 * that nothing was configured. Named here rather than in each surface
 * so the CLI's usage error and the MCP refusal say the same sentence.
 */
export const VAULT_NOT_CONFIGURED_REASON =
  "vault not configured. Pass --vault <path>, set VAULT_DIR, or run `o2b init`.";

/** What an install run needs to know before it can build its env. */
export interface InstallEnvInput {
  /** The resolved vault; the empty string when nothing resolved one. */
  readonly vault: string;
  /** The config file that parameterises the whole run. */
  readonly configPath: string;
}

/**
 * The environment adapters see.
 *
 * `OPEN_SECOND_BRAIN_CONFIG` is stamped from the resolved config path so
 * that ONE file parameterises the run: the agent name, timezone and
 * vault came from `--config` while `install_hook_timeout_seconds` and
 * `mcp_tool_profile` were read out of the machine default, and on a box
 * with both files populated `--apply` generated from one and `--check`
 * verified against the other.
 */
export function buildInstallEnv(input: InstallEnvInput): InstallEnv {
  const cfg = discoverConfig(input.configPath).data;
  const env = { ...process.env } as Record<string, string>;
  env["OPEN_SECOND_BRAIN_CONFIG"] = input.configPath;
  if (cfg["agent_name"]) env["VAULT_AGENT_NAME"] = cfg["agent_name"];
  if (cfg["timezone"]) env["VAULT_TIMEZONE"] = cfg["timezone"];
  return {
    vault: input.vault,
    home: homedir(),
    cwd: process.cwd(),
    env,
    now: new Date(),
  };
}

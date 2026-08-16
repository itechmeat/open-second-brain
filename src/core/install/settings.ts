/**
 * Resolution of the settings that parameterise GENERATED install and
 * hook output, with the layer that produced each one.
 *
 * One reason to change: where a generated artifact's inputs may come
 * from. Four tiers, highest first:
 *
 *   1. the environment variable;
 *   2. the `install:` block of `<vault>/Brain/_brain.yaml` - the
 *      COMMITTED vault tier;
 *   3. the machine-local `config.yaml` key;
 *   4. the compiled default - which for a per-host setting is the
 *      host's own `RUNTIME_FACTS` row, not one number for every
 *      runtime (see {@link resolveInstallToolProfile}).
 *
 * Tier 2 above tier 3 is the whole point and is the reverse of the
 * ordering a reader would guess. Generated content is verified by
 * RE-CONSTRUCTION rather than a stored hash, so two machines cloning one
 * vault must reconstruct the same bytes; letting a stale key in one
 * operator's `~/.config/open-second-brain/config.yaml` outrank the file
 * their teammate committed would make each machine report the other's
 * correct install as drift. The environment still wins over both,
 * because that is a deliberate act at the moment of the run.
 *
 * An UNREADABLE `_brain.yaml` refuses. {@link loadInstallBlockSafe}
 * raises a {@link BrainConfigError} naming the parse failure and the
 * file, and nothing here catches it: an absent config is a vault with no
 * settings to contradict, but a malformed one is settings that exist and
 * are not in force, and a writer cannot infer intent from bytes it could
 * not parse.
 */

import { discoverConfig, resolveDefaultConfigPath } from "../config.ts";
import { loadInstallBlockSafe } from "../brain/policy/load.ts";
import {
  BRAIN_INSTALL_DEFAULTS,
  INSTALL_HOOK_TIMEOUT_SECONDS_MAX,
  INSTALL_HOOK_TIMEOUT_SECONDS_MIN,
  INSTALL_TOOL_PROFILE_NAMES,
} from "../brain/policy/blocks/install.ts";
import { RUNTIME_FACTS, type InstallTargetId } from "../runtime/host-facts.ts";
import { CONFIG_ORIGIN, parseInteger, resolveWithOrigin, type ConfigOrigin } from "../validate.ts";
import type { BrainInstallConfig } from "../brain/types.ts";
import type { InstallEnv } from "./types.ts";

/** Environment variable for the generated hook entry timeout. */
export const INSTALL_HOOK_TIMEOUT_ENV_KEY = "OPEN_SECOND_BRAIN_INSTALL_HOOK_TIMEOUT_SECONDS";
/** Machine-local `config.yaml` key for the same setting. */
export const INSTALL_HOOK_TIMEOUT_CONFIG_KEY = "install_hook_timeout_seconds";

/**
 * Environment variable for the tool-surface profile. The SAME pair the
 * running MCP server already reads (`resolveMcpToolProfile`), not a
 * second one: an operator who pinned a profile for their sessions meant
 * it for the generated registration too, and two keys would let the
 * advertised surface and the installed one disagree.
 */
export const INSTALL_TOOL_PROFILE_ENV_KEY = "OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE";
/** Machine-local `config.yaml` key for the same setting. */
export const INSTALL_TOOL_PROFILE_CONFIG_KEY = "mcp_tool_profile";

/**
 * Everything the four tiers are read from. Every field is derivable from
 * an {@link InstallEnv} (see {@link installSettingsSource}), which is
 * what keeps `verify()`'s reconstruction honest: it recomputes the
 * expected output from `InstallEnv` alone, so a setting it cannot reach
 * from there would make apply and verify disagree.
 */
export interface InstallSettingsSource {
  /** Vault whose committed `Brain/_brain.yaml` supplies the vault tier. */
  readonly vault: string;
  /** Environment the highest tier is read from. */
  readonly env: NodeJS.ProcessEnv;
  /** The machine-local `config.yaml`. */
  readonly configPath: string;
}

/** A resolved install setting and the layer that produced it. */
export interface ResolvedInstallSetting<T> {
  readonly value: T;
  readonly origin: ConfigOrigin;
}

/**
 * The source an install adapter resolves from. `configPath` is derived
 * from the adapter's own `InstallEnv` rather than from `process.env`
 * directly, so a test that hands the adapter a temporary home does not
 * silently read the developer's own configuration.
 */
export function installSettingsSource(env: InstallEnv): InstallSettingsSource {
  return {
    vault: env.vault,
    env: env.env,
    configPath: resolveDefaultConfigPath({
      platform: process.platform,
      home: env.home,
      env: env.env,
    }),
  };
}

/**
 * The shared four-tier walk. `fromVault` reads the one key out of the
 * raw block, `parse` turns a string tier into the typed value (naming
 * the key it came from when it refuses), and `fallback` is the compiled
 * default.
 */
function resolveLayered<T>(
  source: InstallSettingsSource,
  envKey: string,
  configKey: string,
  fromVault: (block: BrainInstallConfig) => T | undefined,
  parse: (raw: string, field: string) => T,
  fallback: T,
): ResolvedInstallSetting<T> {
  const base = resolveWithOrigin(
    source.env,
    discoverConfig(source.configPath).data,
    envKey,
    configKey,
  );
  if (base.origin === CONFIG_ORIGIN.env) {
    return { value: parse(base.value!, envKey), origin: CONFIG_ORIGIN.env };
  }

  // Raises on an unreadable `_brain.yaml`; absent yields `undefined`.
  const block = loadInstallBlockSafe(source.vault);
  const declared = block === undefined ? undefined : fromVault(block);
  if (declared !== undefined) {
    return { value: declared, origin: CONFIG_ORIGIN.vaultConfig };
  }

  if (base.origin === CONFIG_ORIGIN.userConfig) {
    return { value: parse(base.value!, configKey), origin: CONFIG_ORIGIN.userConfig };
  }
  return { value: fallback, origin: CONFIG_ORIGIN.default };
}

/** Seconds a generated lifecycle hook entry may run, and where that came from. */
export function resolveInstallHookTimeoutSeconds(
  source: InstallSettingsSource,
): ResolvedInstallSetting<number> {
  return resolveLayered(
    source,
    INSTALL_HOOK_TIMEOUT_ENV_KEY,
    INSTALL_HOOK_TIMEOUT_CONFIG_KEY,
    (block) => block.hook_timeout_seconds,
    (raw, field) =>
      parseInteger(raw, BRAIN_INSTALL_DEFAULTS.hook_timeout_seconds, field, {
        min: INSTALL_HOOK_TIMEOUT_SECONDS_MIN,
        max: INSTALL_HOOK_TIMEOUT_SECONDS_MAX,
      }),
    BRAIN_INSTALL_DEFAULTS.hook_timeout_seconds,
  );
}

/**
 * The MCP tool-surface profile generated content selects for one host,
 * and where it came from.
 *
 * The bottom tier is the host's own {@link RUNTIME_FACTS} row rather
 * than a single compiled name, because the question the bottom tier
 * answers is per host: Cursor caps a workspace at forty tools across
 * every enabled MCP server, so the profile that fits there is not the
 * profile that fits a host with no published limit. A row that declares
 * nothing resolves to `null` - NO profile, which is the flag-free
 * registration every host got before this existed - and `null` is not
 * the same answer as `full`: one leaves the surface unnamed, the other
 * would write a name into the payload of eight hosts that never asked
 * for one.
 */
export function resolveInstallToolProfile(
  source: InstallSettingsSource,
  target: InstallTargetId,
): ResolvedInstallSetting<string | null> {
  return resolveLayered<string | null>(
    source,
    INSTALL_TOOL_PROFILE_ENV_KEY,
    INSTALL_TOOL_PROFILE_CONFIG_KEY,
    (block) => block.tool_profile,
    requireToolProfileName,
    RUNTIME_FACTS[target].toolProfile,
  );
}

/**
 * An unknown profile name from a string tier is a hard refusal, unlike
 * the RUNNING server's `resolveToolSurface`, which fails open to the
 * full surface rather than locking an agent out mid-session. The
 * asymmetry is the reader/writer split: nothing is locked out here, an
 * artifact is being generated, and generating a registration for a
 * profile that does not exist would install a surface the operator never
 * named and only discover it on the next session start.
 */
function requireToolProfileName(raw: string, field: string): string {
  if (!INSTALL_TOOL_PROFILE_NAMES.includes(raw)) {
    throw new Error(
      `${field} must name a tool-surface profile ` +
        `(${INSTALL_TOOL_PROFILE_NAMES.join(", ")}), got '${raw}'`,
    );
  }
  return raw;
}

/**
 * Resolution of the settings that parameterise GENERATED install and
 * hook output, with the layer that produced each one.
 *
 * One reason to change: where a generated artifact's inputs may come
 * from. Three tiers, highest first:
 *
 *   1. the `install:` block of `<vault>/Brain/_brain.yaml` - the
 *      COMMITTED vault tier;
 *   2. the machine-local `config.yaml` key;
 *   3. the compiled default - which for a per-host setting is the
 *      host's own `RUNTIME_FACTS` row, not one number for every
 *      runtime (see {@link resolveInstallToolProfile}).
 *
 * Tier 1 above tier 2 is the whole point and is the reverse of the
 * ordering a reader would guess. Generated content is verified by
 * RE-CONSTRUCTION rather than a stored hash, so two machines cloning one
 * vault must reconstruct the same bytes; letting a stale key in one
 * operator's `~/.config/open-second-brain/config.yaml` outrank the file
 * their teammate committed would make each machine report the other's
 * correct install as drift.
 *
 * ## Why there is no environment tier
 *
 * There was one, above all three, on the argument that an environment
 * variable is "a deliberate act at the moment of the run". That argument
 * is sound for a value a running process consumes and wrong for a value a
 * writer bakes into a file, and this ladder only ever feeds the second
 * kind. Verification here is re-construction: `verify()` rebuilds the
 * expected artifact from the `InstallEnv` and compares. An input that is
 * present on the apply invocation and absent on the next one therefore
 * makes a CORRECT install report drift - measured, with
 * `OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE=minimal o2b install --apply`
 * followed by a plain `o2b install --check`, which reported drift and
 * offered a fix that would have silently downgraded the profile the
 * operator asked for.
 *
 * Every remaining tier survives the next invocation: a committed file, a
 * machine-local file, a compiled constant. That property, not the tier
 * count, is the rule - a setting that cannot be read back identically
 * tomorrow cannot parameterise an artifact verified by re-construction.
 * An operator who wants a non-default profile or hook timeout writes it
 * into one of the two files, where the next `--check` can still see it.
 * `OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE` still selects the surface of the
 * RUNNING server (`src/core/config.ts`), which is exactly the per-process
 * act it is good for.
 *
 * An UNREADABLE `_brain.yaml` refuses. {@link loadInstallBlockSafe}
 * raises a {@link BrainConfigError} naming the parse failure and the
 * file, and nothing here catches it: an absent config is a vault with no
 * settings to contradict, but a malformed one is settings that exist and
 * are not in force, and a writer cannot infer intent from bytes it could
 * not parse. With the environment tier gone the refusal is also
 * UNCONDITIONAL - the vault tier is now read on every resolution, where
 * before an environment variable short-circuited the ladder above it and
 * a broken vault config went unnoticed for exactly those runs.
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
import { CONFIG_ORIGIN, parseInteger, type ConfigOrigin } from "../validate.ts";
import type { BrainInstallConfig } from "../brain/types.ts";
import type { InstallEnv } from "./types.ts";

/** Machine-local `config.yaml` key for the generated hook entry timeout. */
export const INSTALL_HOOK_TIMEOUT_CONFIG_KEY = "install_hook_timeout_seconds";

/**
 * Machine-local `config.yaml` key for the tool-surface profile. The SAME
 * key the running MCP server already reads, not a second one: an operator
 * who pinned a profile for their sessions meant it for the generated
 * registration too, and two keys would let the advertised surface and the
 * installed one disagree.
 */
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
  /** The machine-local `config.yaml`. */
  readonly configPath: string;
}

/** A resolved install setting and the layer that produced it. */
export interface ResolvedInstallSetting<T> {
  readonly value: T;
  readonly origin: ConfigOrigin;
}

/**
 * The source an install adapter resolves from.
 *
 * `configPath` is derived from the adapter's own `InstallEnv` rather than
 * from `process.env` directly, for two reasons. A test that hands the
 * adapter a temporary home must not silently read the developer's own
 * configuration - and, more importantly, `o2b install --config <p>` is the
 * operator naming the file this run is parameterised by. That override
 * used to be dropped here: `--config` supplied the agent name, the
 * timezone and the vault while `install_hook_timeout_seconds` and
 * `mcp_tool_profile` came from `~/.config/open-second-brain/config.yaml`,
 * so one generated artifact was fed by two different files and `--check`
 * split the same way. The CLI now publishes its resolved choice as
 * `OPEN_SECOND_BRAIN_CONFIG` in `InstallEnv.env` (see `buildInstallEnv`),
 * which is the variable {@link resolveDefaultConfigPath} already consults
 * first - so there is one override, honoured in one place, and the
 * `InstallEnv` remains the complete description of the run it claims to be.
 *
 * @throws {@link UnsupportedPlatformError} when the operator has named
 *   neither `OPEN_SECOND_BRAIN_CONFIG` nor `XDG_CONFIG_HOME` and the
 *   platform has no `$HOME/.config` convention. Callers that owe a status
 *   rather than a throw - `grokAdapter.detect` - catch it by name.
 */
export function installSettingsSource(env: InstallEnv): InstallSettingsSource {
  return {
    vault: env.vault,
    configPath: resolveDefaultConfigPath({
      platform: process.platform,
      home: env.home,
      env: env.env,
    }),
  };
}

/**
 * The shared three-tier walk. `fromVault` reads the one key out of the
 * raw block, `parse` turns the string tier into the typed value (naming
 * the key it came from when it refuses), and `fallback` is the compiled
 * default.
 *
 * The vault tier is consulted FIRST and unconditionally, so the refusal an
 * unreadable `_brain.yaml` owes is not something another tier can skip
 * past.
 */
function resolveLayered<T>(
  source: InstallSettingsSource,
  configKey: string,
  fromVault: (block: BrainInstallConfig) => T | undefined,
  parse: (raw: string, field: string) => T,
  fallback: T,
): ResolvedInstallSetting<T> {
  // Raises on an unreadable `_brain.yaml`; absent yields `undefined`.
  const block = loadInstallBlockSafe(source.vault);
  const declared = block === undefined ? undefined : fromVault(block);
  if (declared !== undefined) {
    return { value: declared, origin: CONFIG_ORIGIN.vaultConfig };
  }

  const configured = discoverConfig(source.configPath).data[configKey];
  if (configured !== undefined && configured !== "") {
    return { value: parse(configured, configKey), origin: CONFIG_ORIGIN.userConfig };
  }
  return { value: fallback, origin: CONFIG_ORIGIN.default };
}

/** Seconds a generated lifecycle hook entry may run, and where that came from. */
export function resolveInstallHookTimeoutSeconds(
  source: InstallSettingsSource,
): ResolvedInstallSetting<number> {
  return resolveLayered(
    source,
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
    INSTALL_TOOL_PROFILE_CONFIG_KEY,
    (block) => block.tool_profile,
    requireToolProfileName,
    RUNTIME_FACTS[target].toolProfile,
  );
}

/**
 * An unknown profile name from the string tier is a hard refusal, unlike
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

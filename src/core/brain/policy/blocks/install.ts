/**
 * The `install:` block - the two settings that parameterise GENERATED
 * install and hook output.
 *
 * One reason to change: what a generated artifact needs to know that the
 * machine running the generator cannot answer. Both keys are here rather
 * than in the machine-local `config.yaml` for the same reason: install
 * verification works by RE-CONSTRUCTION, never a stored hash, so two
 * machines that clone one vault must reconstruct the same bytes. A knob
 * that lived only on one machine would make the other report drift it
 * cannot explain and re-apply a file that was already correct.
 *
 * Out-of-range values are hard errors, following `../field-checks.ts`: a
 * clamped timeout would be indistinguishable from the operator never
 * having set one, and the operator would believe a bound is in force
 * that is not.
 */

import type { BrainInstallConfig, ResolvedBrainInstallConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, readBoundedInt } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "install";

/**
 * Seconds a generated lifecycle hook entry may run before the host kills
 * it. Ten, because that is the value the shipped hook set
 * (`hooks/hooks.json`) and the grok generator both carried before this
 * block existed - so a vault that declares nothing regenerates exactly
 * the bytes it already has on disk.
 */
export const INSTALL_HOOK_TIMEOUT_SECONDS_DEFAULT = 10;

/**
 * One second is the floor. Zero is not "no timeout" in any host that
 * reads these entries - it is a hook that is killed before it can run -
 * and a negative number is not a duration at all.
 */
export const INSTALL_HOOK_TIMEOUT_SECONDS_MIN = 1;

/**
 * Ten minutes is the ceiling. Every hook in this tree runs inside a
 * session turn the operator is waiting on, so a larger number is a unit
 * error (milliseconds written where seconds belong) rather than an
 * intent, and accepting it would hang the host instead of the hook.
 */
export const INSTALL_HOOK_TIMEOUT_SECONDS_MAX = 600;

/**
 * The MCP tool-surface profile generated install content selects. `full`
 * is every tool advertised, which is what generated content selected
 * before this key existed.
 */
export const INSTALL_TOOL_PROFILE_DEFAULT = "full";

/**
 * The profile names `tool_profile` accepts.
 *
 * A second declaration of the `TOOL_SURFACE_PROFILES` key set, and
 * deliberately so: that table lives in `src/mcp/profiles.ts` and carries
 * the scope and window of each profile, which is an MCP concern, and
 * nothing under `src/core/` imports `src/mcp/`. What travels down here is
 * only the NAME vocabulary, and
 * `tests/core/brain/policy/install-block.test.ts` requires the two lists
 * to be equal so the copy cannot drift.
 */
export const INSTALL_TOOL_PROFILE_NAMES: ReadonlyArray<string> = Object.freeze([
  "full",
  "writer",
  "catalog",
  "recall",
  "minimal",
]);

const KNOWN_KEYS = ["hook_timeout_seconds", "tool_profile"] as const;

/**
 * Defaults for an absent block: the output every vault generated before
 * the block existed.
 */
export const BRAIN_INSTALL_DEFAULTS: ResolvedBrainInstallConfig = Object.freeze({
  hook_timeout_seconds: INSTALL_HOOK_TIMEOUT_SECONDS_DEFAULT,
  tool_profile: INSTALL_TOOL_PROFILE_DEFAULT,
}) as ResolvedBrainInstallConfig;

export function parseInstallBlock(ctx: BlockParseContext): BrainInstallConfig | undefined {
  const map = openBlock(ctx, BLOCK);
  if (map === undefined) return undefined;

  const hookTimeoutSeconds = readBoundedInt(
    map,
    "hook_timeout_seconds",
    INSTALL_HOOK_TIMEOUT_SECONDS_MIN,
    INSTALL_HOOK_TIMEOUT_SECONDS_MAX,
    `${BLOCK}.hook_timeout_seconds`,
    ctx.source,
  );

  let toolProfile: string | undefined;
  if ("tool_profile" in map) {
    const raw = map["tool_profile"];
    if (typeof raw !== "string" || !INSTALL_TOOL_PROFILE_NAMES.includes(raw)) {
      throw new BrainConfigError(
        `must name a tool-surface profile (${INSTALL_TOOL_PROFILE_NAMES.join(", ")}); ` +
          `got ${describe(raw)}`,
        `${BLOCK}.tool_profile`,
        ctx.source,
      );
    }
    toolProfile = raw;
  }

  warnUnknownKeys(ctx, map, KNOWN_KEYS, BLOCK);
  return Object.freeze({
    ...(hookTimeoutSeconds !== undefined ? { hook_timeout_seconds: hookTimeoutSeconds } : {}),
    ...(toolProfile !== undefined ? { tool_profile: toolProfile } : {}),
  });
}

/**
 * This block ships no `resolveInstall(cfg)` sibling, unlike every other
 * block here, and the omission is deliberate. Its only consumer -
 * `src/core/install/settings.ts` - sits in the MIDDLE of a four-tier
 * ladder and has to tell "the vault block set this key" from "the vault
 * block did not", because the answer decides whether the user-level tier
 * gets to speak. A resolved value cannot express that distinction: it
 * has already folded the two into one number. The consumer therefore
 * reads the raw block and falls back to {@link BRAIN_INSTALL_DEFAULTS}
 * itself, at the bottom of the ladder where the default belongs.
 */

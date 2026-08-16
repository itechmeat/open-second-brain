/**
 * The host-dependent dimensions of the generated MCP payload.
 *
 * {@link buildPayload} is pure and stays that way: same config in, same
 * two entries out. What it cannot know is WHICH runtime the entries are
 * about, and two things in the registration depend on exactly that:
 *
 *   - the tool-surface profile a capped host needs. Cursor sends at
 *     most the first forty tools of every enabled MCP server to the
 *     model; the full surface advertises a hundred and ten, so without
 *     a profile the host drops seventy of them and says nothing.
 *   - the runtime's own id, so the server the payload launches can name
 *     its host in `second_brain_capabilities` instead of reporting a
 *     ceiling it has no way to look up.
 *
 * Both are applied HERE rather than inside `buildPayload` because they
 * are impure - the profile walks the environment, the committed
 * `<vault>/Brain/_brain.yaml` and the machine-local config before
 * falling back to the host row - and because the adapters are the only
 * callers that know a target at all. `install --target generic` prints
 * a payload for a host it was never told the name of and therefore
 * never comes through here.
 *
 * The rule that constrains the shape: `verify()` reconstructs the
 * expected payload from {@link InstallEnv} ALONE, never from a stored
 * hash. Every argument added here is therefore a pure function of the
 * `InstallEnv` plus the target id the adapter carries in its spec, so
 * apply and verify compute byte-identical args and a fresh install
 * reports no drift.
 */

import { installSettingsSource, resolveInstallToolProfile } from "./settings.ts";
import type { InstallEnv, McpPayload, McpServerEntry } from "./types.ts";
import type { InstallTargetId } from "../runtime/host-facts.ts";

/** Names the runtime the generated entry was written for. */
export const HOST_TARGET_FLAG = "--host-target";
/** Names the tool-surface profile the generated entry selects. */
export const TOOL_PROFILE_FLAG = "--tool-profile";

/**
 * The canonical payload with this host's dimensions baked in.
 *
 * The profile lands on the FULL entry only. The writer entry advertises
 * five tools on every host in the table, so no ceiling can bind it and
 * naming a profile there would only be a second place for the two to
 * disagree. `--host-target` lands on both, because the ceiling question
 * is about the host and both servers run on it.
 */
export function payloadForHost(
  target: InstallTargetId,
  payload: McpPayload,
  env: InstallEnv,
): McpPayload {
  const profile = resolveInstallToolProfile(installSettingsSource(env), target).value;
  return {
    full: withArgs(payload.full, [
      ...(profile === null ? [] : [TOOL_PROFILE_FLAG, profile]),
      HOST_TARGET_FLAG,
      target,
    ]),
    writer: withArgs(payload.writer, [HOST_TARGET_FLAG, target]),
  };
}

/** One entry with `extra` appended; argument order is the byte identity. */
function withArgs(entry: McpServerEntry, extra: ReadonlyArray<string>): McpServerEntry {
  return { ...entry, args: [...entry.args, ...extra] };
}

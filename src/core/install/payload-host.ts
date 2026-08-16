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
import { INSTALL_TARGET_ID, type InstallTargetId } from "../runtime/host-facts.ts";
import type { ResolvedInstallSetting } from "./settings.ts";

/** Names the runtime the generated entry was written for. */
export const HOST_TARGET_FLAG = "--host-target";
/** Names the tool-surface profile the generated entry selects. */
export const TOOL_PROFILE_FLAG = "--tool-profile";

/**
 * The targets whose generated registration passes through
 * {@link payloadForHost}, and therefore carries the host dimensions.
 *
 * Three of the ten do not, and it is not an oversight: `generic` prints a
 * payload for a host it was never told the name of, `aider` is wired
 * through a managed YAML block and a sidecar context file rather than an
 * MCP server, and `pi` is a skill symlink. None of the three writes an MCP
 * command line at all, so there is nothing for `--tool-profile` or
 * `--host-target` to land on.
 *
 * Declared here because this is the module the dimensions live in, and
 * read by everything that must not claim a dimension a target never
 * carries: `o2b update`'s payload hash, and `--friction`'s profile cell -
 * which printed `generic tool-profile minimal` for a registration that
 * carries no profile flag at all.
 * `tests/core/install/payload-host.test.ts` holds the declaration against
 * the artifacts the ten adapters actually write.
 */
export const HOST_PAYLOAD_TARGETS: ReadonlySet<InstallTargetId> = Object.freeze(
  new Set<InstallTargetId>([
    INSTALL_TARGET_ID.codex,
    INSTALL_TARGET_ID.copilotCli,
    INSTALL_TARGET_ID.cursor,
    INSTALL_TARGET_ID.geminiCli,
    INSTALL_TARGET_ID.grok,
    INSTALL_TARGET_ID.kiro,
    INSTALL_TARGET_ID.opencode,
  ]),
);

/** Whether `target`'s generated registration carries the host dimensions. */
export function carriesHostDimensions(target: InstallTargetId): boolean {
  return HOST_PAYLOAD_TARGETS.has(target);
}

/**
 * The profile `target`'s registration will actually carry, or `null` when
 * the registration carries no profile at all.
 *
 * The two `null`s are different answers and both are honest: a member of
 * {@link HOST_PAYLOAD_TARGETS} whose ladder resolves to `null` writes a
 * flag-free MCP command line, while a non-member writes no MCP command
 * line for a flag to be absent from. Callers that print the answer say
 * which one they mean.
 */
export function writtenToolProfile(
  target: InstallTargetId,
  env: InstallEnv,
): ResolvedInstallSetting<string | null> | null {
  if (!carriesHostDimensions(target)) return null;
  return resolveInstallToolProfile(installSettingsSource(env), target);
}

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
  const resolved = writtenToolProfile(target, env);
  if (resolved === null) {
    // A caller outside {@link HOST_PAYLOAD_TARGETS} is a programming
    // error, not an operator one: the declaration and the routing would
    // have silently disagreed, and every surface that reads the
    // declaration to describe the registration would have described the
    // wrong one.
    throw new Error(
      `payloadForHost: ${target} is not declared in HOST_PAYLOAD_TARGETS; ` +
        "add it there, or stop routing this target's payload through here",
    );
  }
  const profile = resolved.value;
  return {
    full: withArgs(payload.full, [
      ...(profile === null ? [] : [TOOL_PROFILE_FLAG, profile]),
      HOST_TARGET_FLAG,
      target,
    ]),
    writer: withArgs(payload.writer, [HOST_TARGET_FLAG, target]),
  };
}

/**
 * The payload `target` will actually be registered with, whether or not
 * that target carries host dimensions.
 *
 * The total function {@link payloadForHost} deliberately is not. It exists
 * for `o2b update`, which decides whether an installed target needs
 * re-applying by hashing the payload and comparing it against the stored
 * `payload_hash`: a hash taken over the CANONICAL payload cannot see the
 * host dimensions, so an operator whose vault, agent name and timezone
 * were unchanged got "up-to-date, payload unchanged" while `--check`
 * reported drift on the same target, and a 110-tool registration stayed
 * under Cursor's 40-tool ceiling. Hashing what is written closes that,
 * and hashing the canonical payload for the three targets that write no
 * MCP command line keeps the hash from claiming dimensions they do not
 * carry.
 */
export function payloadAsWritten(
  target: InstallTargetId,
  payload: McpPayload,
  env: InstallEnv,
): McpPayload {
  return carriesHostDimensions(target) ? payloadForHost(target, payload, env) : payload;
}

/** One entry with `extra` appended; argument order is the byte identity. */
function withArgs(entry: McpServerEntry, extra: ReadonlyArray<string>): McpServerEntry {
  return { ...entry, args: [...entry.args, ...extra] };
}

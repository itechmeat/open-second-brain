/**
 * Cross-agent shared memory namespace (Agent Write Contract Suite,
 * t_936a1a61).
 *
 * Opt-in: the `shared_namespace` device-config key names a second
 * vault root. When set, explicit remember-writes (feedback signals and
 * narrative notes) MIRROR there after the primary write succeeds, so
 * facts learned by one agent become visible to every agent sharing the
 * namespace. Attribution is carried twice: the existing `agent` field
 * plus `origin_vault` (basename of the primary vault).
 *
 * Mirror semantics are FAIL-SOFT by contract: any mirror failure is
 * swallowed and reported as `"failed"` - it must never break, delay,
 * or alter the primary write. Default (key absent) is `"off"` with
 * zero behavior change. One-way by design: the shared vault's own
 * dream pass treats mirrored records as ordinary first-class signals.
 */

import { basename } from "node:path";

import { discoverConfig } from "../config.ts";
import { appendLogEvent } from "./log.ts";
import { writeSignal, type WriteSignalInput } from "./signal.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

export type MirrorOutcome = "ok" | "failed" | "off";

/** Shared-namespace root from the device config, or null when off. */
export function resolveSharedNamespace(configPath?: string | null): string | null {
  const discovery = discoverConfig(configPath ?? undefined);
  const value = discovery.data["shared_namespace"]?.trim();
  return value ? value : null;
}

/**
 * Mirror a feedback signal into the shared vault. The record is the
 * same signal with `origin_vault` attribution; slug collisions resolve
 * through the normal allocator.
 */
export function mirrorSignal(
  sharedVault: string,
  originVault: string,
  input: WriteSignalInput,
): MirrorOutcome {
  try {
    writeSignal(sharedVault, { ...input, origin_vault: basename(originVault) });
    return "ok";
  } catch {
    return "failed";
  }
}

export interface MirrorNoteInput {
  readonly text: string;
  readonly agent: string;
  readonly now?: Date;
}

/** Mirror a narrative note event into the shared vault's log. */
export function mirrorNote(
  sharedVault: string,
  originVault: string,
  input: MirrorNoteInput,
): MirrorOutcome {
  try {
    appendLogEvent(sharedVault, {
      timestamp: isoSecond(input.now ?? new Date()),
      eventType: BRAIN_LOG_EVENT_KIND.note,
      body: {
        text: input.text,
        agent: input.agent,
        origin_vault: basename(originVault),
      },
    });
    return "ok";
  } catch {
    return "failed";
  }
}

/**
 * Shared body for appending a `note` event to today's Brain log.
 * Both the MCP `brain_note` tool and the `o2b brain note` CLI verb
 * delegate here so the on-disk shape cannot drift between them.
 * Wrappers translate the thrown `Error` into their protocol's
 * idiom (MCP `INVALID_PARAMS` envelope, CLI exit code).
 */

import { resolve } from "node:path";

import { normalizeAgentArgument } from "../agent-identity.ts";
import { resolveAgentName } from "../config.ts";
import { vaultRelative } from "../path-safety.ts";
import { sanitiseTextField } from "../redactor.ts";

import { appendLogEvent } from "./log.ts";
import { mirrorNote, resolveSharedNamespace, type MirrorOutcome } from "./shared-namespace.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

const NOTE_TEXT_MAX_LEN = 4096;

export interface AppendBrainNoteInput {
  readonly vault: string;
  readonly text: string;
  /** Identity override. Resolver default is used when omitted or blank. */
  readonly agent?: string;
  /** Wall clock for the event timestamp. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Config path for `resolveAgentName`. Optional. */
  readonly configPath?: string;
}

export interface AppendBrainNoteResult {
  /** Canonical ISO-8601 UTC second of the appended event. */
  readonly logged_at: string;
  /** Vault-relative POSIX path (`Brain/log/<date>.md`). */
  readonly log_path: string;
  /** Absolute filesystem path of the markdown log file. */
  readonly absolute_log_path: string;
  /** Identity actually written into the log entry. */
  readonly agent: string;
  /**
   * Shared-namespace mirror outcome (t_936a1a61). Present only when
   * the `shared_namespace` config key is set - unconfigured setups
   * keep the previous result shape.
   */
  readonly mirror?: MirrorOutcome;
}

/**
 * Append one `note` event to `Brain/log/<today>.md` (and the JSONL
 * sidecar via `appendLogEvent`). Throws plain `Error` on empty text
 * — wrappers translate the error to their protocol's idiom.
 */
export function appendBrainNote(input: AppendBrainNoteInput): AppendBrainNoteResult {
  const sanitised = sanitiseTextField(input.text, {
    maxLen: NOTE_TEXT_MAX_LEN,
    singleLine: true,
  }).trim();
  if (!sanitised) {
    throw new Error("brain_note: text is required");
  }
  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);
  const timestamp = isoSecond(input.now ?? new Date());
  const entry = {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.note,
    body: { text: sanitised, agent },
  } as const;
  const res = appendLogEvent(input.vault, entry);
  // t_936a1a61: mirror AFTER the primary append succeeded; the mirror
  // is fail-soft and must never alter the primary result.
  const shared = resolveSharedNamespace(input.configPath ?? null);
  const mirror =
    shared === null
      ? undefined
      : mirrorNote(shared, input.vault, {
          text: sanitised,
          agent,
          ...(input.now ? { now: input.now } : {}),
        });
  return {
    logged_at: timestamp,
    log_path: vaultRelative(res.logPath, input.vault),
    absolute_log_path: resolve(res.logPath),
    agent,
    ...(mirror !== undefined ? { mirror } : {}),
  };
}

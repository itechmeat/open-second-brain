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

import {
  callerInput,
  opaqueFields,
  operationPrivacy,
  type OperationPrivacy,
  type PrivacyVerdict,
} from "../store/operation-privacy.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { appendLogEvent, logEventPrivacyContent, type AppendLogEventResult } from "./log.ts";
import {
  mirrorNote,
  mirrorReportFields,
  resolveSharedNamespace,
  type MirrorOutcome,
} from "./shared-namespace.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

const NOTE_TEXT_MAX_LEN = 4096;

export interface AppendBrainNoteInput {
  /** The vault; `null` on a store-only machine with none (design D14). */
  readonly vault: string | null;
  readonly text: string;
  /** Identity override. Resolver default is used when omitted or blank. */
  readonly agent?: string;
  /** Wall clock for the event timestamp. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Config path for `resolveAgentName`. Optional. */
  readonly configPath?: string;
  /**
   * The privacy verdict of an enclosing operation (a write batch), which
   * the event's store record inherits. See `AppendLogEventOptions.storePrivate`.
   */
  readonly storePrivate?: PrivacyVerdict;
}

export interface AppendBrainNoteResult {
  /** Canonical ISO-8601 UTC second of the appended event. */
  readonly logged_at: string;
  /**
   * Where the event went: the vault-relative POSIX path of the log day
   * page (`Brain/log/<date>.md`) on an unswitched machine, the store shard
   * (`shared/log/<device>/<YYYY-MM>.jsonl`) on a store-only one.
   */
  readonly log_path: string;
  /** Absolute filesystem path of that file. */
  readonly absolute_log_path: string;
  /** The store record id of the event on a store-only machine; absent otherwise. */
  readonly record_id?: string;
  /** Identity actually written into the log entry. */
  readonly agent: string;
  /**
   * Shared-namespace mirror outcome (t_936a1a61). Present only when
   * the `shared_namespace` config key is set - unconfigured setups
   * keep the previous result shape.
   */
  readonly mirror?: MirrorOutcome;
  /**
   * Why the mirror did not succeed. Present exactly when `mirror` is
   * present and is not `ok`: a fail-soft outcome that carries no diagnosis
   * is a bit the operator cannot act on.
   */
  readonly mirror_reason?: string;
}

function sanitiseNoteText(text: string): string {
  return sanitiseTextField(text, { maxLen: NOTE_TEXT_MAX_LEN, singleLine: true }).trim();
}

/**
 * Fields of a note call's input that are local settings, not text: the
 * vault, the clock, the config path and an enclosing verdict.
 */
const NOTE_INPUT_OPAQUE: ReadonlySet<string> = opaqueFields(
  "vault",
  "now",
  "configPath",
  "storePrivate",
);

/**
 * The privacy verdict of the note event {@link appendBrainNote} would
 * append for `input`: its whole input (the text, raw and as the event
 * carries it, and the agent), judged as the log appender judges the
 * event, plus `inherit` (an enclosing operation). A write batch judges
 * its log lines with it before it commits.
 */
export function brainNotePrivacy(
  vault: string | null,
  input: Omit<AppendBrainNoteInput, "vault">,
  inherit?: PrivacyVerdict,
): OperationPrivacy {
  return operationPrivacy(vault, {
    content: [
      logEventPrivacyContent({ text: sanitiseNoteText(input.text) }),
      callerInput(input, NOTE_INPUT_OPAQUE),
    ],
    inherit: [inherit],
  });
}

/**
 * Append one `note` event to the Brain log through `appendLogEvent`: the
 * log day files on an unswitched machine, the store only on a store-only
 * one. Throws plain `Error` on empty text
 * — wrappers translate the error to their protocol's idiom.
 */
export function appendBrainNote(input: AppendBrainNoteInput): AppendBrainNoteResult {
  const sanitised = sanitiseNoteText(input.text);
  if (!sanitised) {
    throw new Error("brain_note: text is required");
  }
  // Every store record written from here on (the note event, a mirror
  // copy, anything a writer below appends) carries this call's verdict
  // (`store/operation-scope.ts`).
  const privacy = brainNotePrivacy(input.vault, input, input.storePrivate);
  return withOperationPrivacy(privacy, () => appendJudgedNote(input, sanitised, privacy));
}

/** The note's log as the result reports it: the store shard, or the day file vault-relative. */
function reportedLogPath(res: AppendLogEventResult, vault: string | null): string {
  if (res.storeShard !== null) return res.storeShard;
  if (vault === null || res.logPath === "") return res.logPath;
  return vaultRelative(res.logPath, vault);
}

function appendJudgedNote(
  input: AppendBrainNoteInput,
  sanitised: string,
  privacy: OperationPrivacy,
): AppendBrainNoteResult {
  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);
  const timestamp = isoSecond(input.now ?? new Date());
  const entry = {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.note,
    body: { text: sanitised, agent },
  } as const;
  // The routing (store-only or not) and the store root follow the same
  // machine config the agent name came from.
  const res = appendLogEvent(input.vault, entry, {
    storePrivate: privacy,
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
  });
  // t_936a1a61: mirror AFTER the primary append succeeded; the mirror
  // is fail-soft and must never alter the primary result. The mirror
  // copies the note into another vault's legacy log: with no vault there
  // is nothing to mirror from, and once the note went to the store a
  // "mirror" would only be a second record in this same store.
  const vault = input.vault;
  const shared =
    vault === null || res.stored === "store"
      ? null
      : resolveSharedNamespace(input.configPath ?? null);
  const mirror =
    shared === null || vault === null
      ? undefined
      : mirrorNote(shared, vault, {
          text: sanitised,
          agent,
          ...(input.now ? { now: input.now } : {}),
        });
  return {
    logged_at: timestamp,
    log_path: reportedLogPath(res, vault),
    // A fail-open write that did not land names no file (never the cwd).
    absolute_log_path: res.logPath === "" ? "" : resolve(res.logPath),
    ...(res.recordId !== null ? { record_id: res.recordId } : {}),
    agent,
    ...mirrorReportFields(mirror),
  };
}

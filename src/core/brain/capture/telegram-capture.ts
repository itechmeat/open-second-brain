/**
 * Inbound Telegram capture core (Knowledge intake suite, t_f8f5ef6a).
 *
 * A long-poll `getUpdates` bot that turns pocket messages into staged
 * captures through the seam-1 capture-note contract. The transport is an
 * injected interface so the update-handling core is unit-testable with no
 * network; the real transport ({@link createFetchTelegramTransport}) is a
 * thin `fetch` wrapper built only by the CLI runner verb, never by a hook.
 *
 * Design invariants:
 *   - every accepted text update becomes exactly one capture note;
 *   - every rejected or malformed update is one explicit logged decision -
 *     never a silent drop;
 *   - `/catchup` replies with captures since the last acknowledged one,
 *     using the existing MarkdownV2 escaping;
 *   - a missing bot token is a typed error at startup, surfaced by
 *     {@link requireTelegramToken};
 *   - nothing runs implicitly - the loop only turns when a caller invokes
 *     {@link runTelegramCapture}.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { escapeMarkdownV2 } from "../../discipline/telegram.ts";
import { isoSecond } from "../time.ts";
import { captureDecisionLogPath } from "../paths.ts";
import {
  capturesSince,
  readCatchupWatermark,
  writeCaptureNote,
  writeCatchupWatermark,
  type CaptureNote,
} from "./capture-note.ts";

/** Telegram command that triggers a catchup reply. */
export const CATCHUP_COMMAND = "/catchup";

/** Default capture channel label stamped into provenance. */
export const TELEGRAM_CAPTURE_SOURCE = "telegram";

/** Telegram Bot API host. Kept as a named constant, never logged with a token. */
const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Long-poll timeout (seconds) passed to getUpdates. */
const LONG_POLL_TIMEOUT_SECONDS = 30;

/**
 * Margin (seconds) added to the long-poll window before the client-side fetch
 * aborts, so a wedged connection surfaces as a caught, retried transport error
 * rather than a hang that stalls the runner forever.
 */
const FETCH_TIMEOUT_MARGIN_SECONDS = 10;

/** Client-side abort timeout (seconds) for the short sendMessage request. */
const SEND_MESSAGE_TIMEOUT_SECONDS = 15;

/** Minimal shape of the Telegram update objects this bot reads. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id?: number;
    readonly text?: string;
    readonly chat?: { readonly id: number | string };
  };
}

/** Transport seam: the two Telegram Bot API calls the bot needs. */
export interface TelegramTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string | number, text: string): Promise<void>;
}

export type CaptureDecisionResult =
  | "captured"
  | "catchup"
  | "rejected-chat"
  | "malformed"
  | "transport-error";

export interface CaptureDecision {
  readonly updateId: number;
  readonly result: CaptureDecisionResult;
  readonly reason: string;
  readonly chatId: string | null;
  /** Vault-relative path of the capture written, when `result` is captured. */
  readonly capturePath: string | null;
  readonly at: string;
}

export interface HandleUpdateResult {
  readonly decision: CaptureDecision;
  /** A reply to send back, or null when the update warrants no reply. */
  readonly reply: {
    readonly chatId: string;
    readonly text: string;
    /**
     * Deferred side effect to run only once delivery has succeeded (the bot
     * path advances the catchup watermark here). Absent when the reply carries
     * no post-delivery commit.
     */
    readonly commit?: () => void;
  } | null;
}

/** A rendered catchup reply plus the deferred watermark advance. */
export interface CatchupReply {
  /** The MarkdownV2-escaped reply text. */
  readonly text: string;
  /**
   * Advance the watermark to the newest capture included in `text`. Split from
   * rendering so a caller whose delivery can fail (the bot's sendMessage) only
   * commits after a successful send; a caller whose rendering IS delivery (the
   * CLI writing to stdout) commits immediately.
   */
  readonly commit: () => void;
}

export interface HandleUpdateOptions {
  /** Allowlisted chat ids (as strings). An empty set accepts nothing. */
  readonly allowlist: ReadonlySet<string>;
  readonly agent: string;
  /** Injected clock so captures are deterministic in tests. */
  readonly now: () => Date;
  /** Capture channel label; defaults to {@link TELEGRAM_CAPTURE_SOURCE}. */
  readonly source?: string;
}

/** Typed startup error raised when no bot token is configured. */
export class MissingTelegramTokenError extends Error {
  constructor() {
    super(
      "no Telegram bot token configured; set TELEGRAM_BOT_TOKEN or telegram_bot_token in the config",
    );
    this.name = "MissingTelegramTokenError";
  }
}

/** Return the token or raise {@link MissingTelegramTokenError} - never a silent no-op. */
export function requireTelegramToken(token: string | null): string {
  if (token === null || token.trim().length === 0) {
    throw new MissingTelegramTokenError();
  }
  return token;
}

function appendDecision(vault: string, decision: CaptureDecision): void {
  const path = captureDecisionLogPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(decision)}\n`, { encoding: "utf8" });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record one `transport-error` decision (getUpdates / sendMessage failure) so a
 * transient network fault is a logged, greppable decision rather than a crash
 * that terminates the runner. Returns the decision for the in-memory list too.
 */
function logTransportError(
  vault: string,
  updateId: number,
  chatId: string | null,
  reason: string,
  now: () => Date,
): CaptureDecision {
  const decision: CaptureDecision = {
    updateId,
    result: "transport-error",
    reason,
    chatId,
    capturePath: null,
    at: isoSecond(now()),
  };
  appendDecision(vault, decision);
  return decision;
}

/**
 * Render the catchup reply for the captures since the last acknowledged one.
 * Rendering NEVER advances the watermark; the returned {@link CatchupReply.commit}
 * does that, so a failed delivery cannot silently drop the catchup forever.
 */
export function renderCatchup(vault: string): CatchupReply {
  const watermark = readCatchupWatermark(vault);
  const pending = capturesSince(vault, watermark);
  if (pending.length === 0) {
    return { text: escapeMarkdownV2("No new captures since the last catchup."), commit: () => {} };
  }
  const header = escapeMarkdownV2(`${pending.length} capture(s) since the last catchup:`);
  const lines = pending.map((c) => `- ${escapeMarkdownV2(catchupLine(c))}`);
  const newest = pending[pending.length - 1]!;
  return {
    text: [header, ...lines].join("\n"),
    commit: () => writeCatchupWatermark(vault, newest.id),
  };
}

function catchupLine(capture: CaptureNote): string {
  return `${capture.provenance.capturedAt}: ${capture.body}`;
}

/**
 * Handle one inbound update: capture it, reject it, or answer `/catchup`.
 * Always writes exactly one decision to the ledger and never throws on a
 * malformed or disallowed update - those are decisions, not crashes.
 */
export function handleCaptureUpdate(
  vault: string,
  update: TelegramUpdate,
  opts: HandleUpdateOptions,
): HandleUpdateResult {
  const now = opts.now();
  const at = isoSecond(now);
  const updateId = typeof update.update_id === "number" ? update.update_id : -1;
  const source = opts.source ?? TELEGRAM_CAPTURE_SOURCE;

  const chatRaw = update.message?.chat?.id;
  const text = update.message?.text;

  const finish = (
    result: CaptureDecisionResult,
    reason: string,
    chatId: string | null,
    capturePath: string | null,
    reply: { chatId: string; text: string; commit?: () => void } | null,
  ): HandleUpdateResult => {
    const decision: CaptureDecision = { updateId, result, reason, chatId, capturePath, at };
    appendDecision(vault, decision);
    return { decision, reply };
  };

  if (chatRaw === undefined || chatRaw === null) {
    return finish("malformed", "update has no chat id", null, null, null);
  }
  const chatId = String(chatRaw);

  if (!opts.allowlist.has(chatId)) {
    return finish("rejected-chat", "chat id not in allowlist", chatId, null, null);
  }

  if (typeof text !== "string" || text.trim().length === 0) {
    return finish("malformed", "update has no text body", chatId, null, null);
  }

  const trimmed = text.trim();
  if (trimmed === CATCHUP_COMMAND) {
    const catchup = renderCatchup(vault);
    // The watermark advances via catchup.commit, invoked by the run loop only
    // after sendMessage succeeds - a failed send must not lose the catchup.
    return finish("catchup", "catchup requested", chatId, null, {
      chatId,
      text: catchup.text,
      commit: catchup.commit,
    });
  }

  const note = writeCaptureNote(vault, {
    body: trimmed,
    provenance: { source, sender: chatId, capturedAt: at },
  });
  return finish("captured", "text captured", chatId, note.path, null);
}

export interface RunTelegramCaptureOptions {
  readonly transport: TelegramTransport;
  readonly allowlist: ReadonlySet<string>;
  readonly agent: string;
  readonly now: () => Date;
  readonly source?: string;
  /**
   * Hard cap on poll cycles. Bounds the loop for tests and cron-style
   * single-shot runs; when unset the loop runs until {@link shouldStop}.
   */
  readonly maxCycles?: number;
  /** Cooperative shutdown signal, checked at the top of each cycle. */
  readonly shouldStop?: () => boolean;
}

export interface RunTelegramCaptureResult {
  readonly cycles: number;
  readonly decisions: readonly CaptureDecision[];
  readonly lastOffset: number;
}

/**
 * Long-poll loop over the injected transport. Each cycle fetches updates
 * from the running offset, handles each through {@link handleCaptureUpdate},
 * sends any reply, and advances the offset past the highest update_id seen.
 */
export async function runTelegramCapture(
  vault: string,
  opts: RunTelegramCaptureOptions,
): Promise<RunTelegramCaptureResult> {
  const decisions: CaptureDecision[] = [];
  let offset = 0;
  let cycles = 0;
  const handleOpts: HandleUpdateOptions = {
    allowlist: opts.allowlist,
    agent: opts.agent,
    now: opts.now,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
  };

  while (opts.maxCycles === undefined || cycles < opts.maxCycles) {
    if (opts.shouldStop?.() === true) break;
    cycles += 1;
    // A long-poll loop is inherently sequential: each getUpdates uses the
    // offset produced by the previous cycle, so the awaits cannot be
    // parallelized.
    let updates: TelegramUpdate[];
    try {
      // oxlint-disable-next-line no-await-in-loop
      updates = await opts.transport.getUpdates(offset);
    } catch (err) {
      // A transient transport failure is one logged decision, not a crash: the
      // loop retries on the next cycle. Typed startup errors (missing token)
      // are raised before the loop and stay fatal.
      decisions.push(
        logTransportError(vault, -1, null, `getUpdates failed: ${messageOf(err)}`, opts.now),
      );
      continue;
    }
    for (const update of updates) {
      const { decision, reply } = handleCaptureUpdate(vault, update, handleOpts);
      decisions.push(decision);
      if (reply !== null) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await opts.transport.sendMessage(reply.chatId, reply.text);
          // Commit deferred side effects (the catchup watermark) ONLY after a
          // successful send, so a failed delivery never loses the catchup.
          reply.commit?.();
        } catch (err) {
          decisions.push(
            logTransportError(
              vault,
              decision.updateId,
              reply.chatId,
              `sendMessage failed: ${messageOf(err)}`,
              opts.now,
            ),
          );
        }
      }
      if (typeof update.update_id === "number") {
        offset = Math.max(offset, update.update_id + 1);
      }
    }
  }

  return { cycles, decisions, lastOffset: offset };
}

/**
 * Build the real fetch-based transport. Used only by the CLI runner verb;
 * never constructed in tests, so no test path ever reaches the network. The
 * token travels only in the request URL path (never logged) per the Bot API.
 */
export function createFetchTelegramTransport(token: string): TelegramTransport {
  const base = `${TELEGRAM_API_BASE}/bot${token}`;
  return {
    async getUpdates(offset: number): Promise<TelegramUpdate[]> {
      const url = `${base}/getUpdates?offset=${offset}&timeout=${LONG_POLL_TIMEOUT_SECONDS}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(
          (LONG_POLL_TIMEOUT_SECONDS + FETCH_TIMEOUT_MARGIN_SECONDS) * 1000,
        ),
      });
      if (!res.ok) {
        throw new Error(`Telegram getUpdates failed with HTTP ${res.status}`);
      }
      const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
      if (body.ok !== true || !Array.isArray(body.result)) {
        throw new Error("Telegram getUpdates returned a non-ok payload");
      }
      return body.result;
    },
    async sendMessage(chatId: string | number, text: string): Promise<void> {
      const res = await fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
        signal: AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_SECONDS * 1000),
      });
      if (!res.ok) {
        throw new Error(`Telegram sendMessage failed with HTTP ${res.status}`);
      }
    },
  };
}

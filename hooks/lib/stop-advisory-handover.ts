/**
 * Hand-over of the end-of-turn advisories from the synchronous Stop hooks to
 * the background `stop-advisory-deliver` hook (Claude Code only).
 *
 * Why the split. Claude Code shows nothing for a synchronous Stop hook that
 * exits 0 with no output and adds no turn, but prints a synchronous Stop
 * `additionalContext` as "Stop hook says: ..." and continues the turn. An
 * `async` hook's `additionalContext` reaches the model with the next user
 * message, unprinted - but a one-shot `claude -p` run kills an async hook
 * still running at teardown. So the work is split:
 *
 *   1. The producers (`stop-log-guardrail`, `answer-quote-check`,
 *      `hygiene-digest`) stay synchronous. They do all the reading and every
 *      durable write (the quote check's `reply_presence` record and its
 *      `enforce` Brain-log event, the hygiene digest's hash ledger), print
 *      nothing, and leave their advisory text - or an explicit "nothing" - in
 *      one small file here.
 *   2. The async `stop-advisory-deliver` hook waits for those files, removes
 *      them, and prints the combined advisory once. If it is killed, only the
 *      advisory text is lost.
 *
 * Hooks of one event start in parallel, so the deliver hook may start before
 * a producer has written: it polls, bounded by {@link DELIVER_WAIT_MS}.
 *
 * Storage. `<state root>/stop-advisories/` (`stateRootDir()`, the
 * device-local state directory outside every vault): never synced. Files are
 * keyed by one Stop event (session id, prompt id and the final answer, which
 * every hook of the event receives alike), removed when read, and every write
 * prunes entries older than {@link HANDOVER_MAX_AGE_MS} and keeps at most
 * {@link HANDOVER_MAX_ENTRIES}, so a run whose deliver hook was killed leaves
 * nothing that grows.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { resolveStopAdvisoryDelivery } from "../../src/core/config.ts";
import { atomicWriteText, sleepSync } from "../../src/core/fs-atomic.ts";
import { stateRootDir } from "../../src/core/platform-dirs.ts";
import { detectHookRuntime } from "./detect.ts";
import type { HookPayloadBase } from "./stdin.ts";

/** The producers, in the order their advisories are joined. */
export const STOP_ADVISORY_PRODUCERS = [
  "stop-log-guardrail",
  "answer-quote-check",
  "hygiene-digest",
] as const;

export type StopAdvisoryProducer = (typeof STOP_ADVISORY_PRODUCERS)[number];

/** Longest wait of the deliver hook for the producers of its event. */
export const DELIVER_WAIT_MS = 12_000;

/** Poll interval of the deliver hook. */
const DELIVER_POLL_MS = 25;

/** Hand-over files older than this are leftovers of a killed deliver hook. */
export const HANDOVER_MAX_AGE_MS = 10 * 60_000;

/** Upper bound on the files kept in the hand-over directory. */
export const HANDOVER_MAX_ENTRIES = 256;

const DELIVERED_SUFFIX = "delivered";

/** The hand-over directory: device-local, outside every vault. */
export function stopAdvisoryHandoverDir(): string {
  return join(stateRootDir(), "stop-advisories");
}

/**
 * The key of one Stop event, or null when the payload names no session (no
 * hand-over then: the producer prints its synchronous form). Every hook of
 * the event receives the same payload, so producers and the deliver hook
 * derive the same key.
 */
export function stopEventKey(payload: HookPayloadBase): string | null {
  const session = payload.session_id;
  if (typeof session !== "string" || session.length === 0) return null;
  const prompt = typeof payload.prompt_id === "string" ? payload.prompt_id : "";
  const answer =
    typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
  return createHash("sha256")
    .update(`${session}\u0000${prompt}\u0000${answer}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Whether a producer hands its advisory over (Claude Code with the default
 * `async` delivery and a session id) or prints its own synchronous form.
 */
export function stopAdvisoryHandsOver(payload: HookPayloadBase): boolean {
  return (
    detectHookRuntime(payload) === "claudecode" &&
    resolveStopAdvisoryDelivery() === "async" &&
    stopEventKey(payload) !== null
  );
}

function handoverPath(key: string, producer: StopAdvisoryProducer): string {
  return join(stopAdvisoryHandoverDir(), `${key}-${producer}.json`);
}

function deliveredPath(key: string): string {
  return join(stopAdvisoryHandoverDir(), `${key}-${DELIVERED_SUFFIX}`);
}

/** Drop leftovers: entries past the age limit, then the oldest past the count limit. */
function pruneHandovers(dir: string, nowMs: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const kept: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (nowMs - mtime > HANDOVER_MAX_AGE_MS) unlinkSync(path);
      else kept.push({ path, mtime });
    } catch {
      // Gone or unreadable: nothing to keep.
    }
  }
  if (kept.length <= HANDOVER_MAX_ENTRIES) return;
  kept.sort((a, b) => a.mtime - b.mtime);
  for (const entry of kept.slice(0, kept.length - HANDOVER_MAX_ENTRIES)) {
    try {
      unlinkSync(entry.path);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Leave a producer's result for the deliver hook: the advisory text, or null
 * for "nothing to say this turn" (the deliver hook stops waiting for this
 * producer either way). Returns false when the write failed; never throws.
 */
export function writeStopAdvisoryHandover(
  payload: HookPayloadBase,
  producer: StopAdvisoryProducer,
  advisory: string | null,
): boolean {
  const key = stopEventKey(payload);
  if (key === null) return false;
  try {
    const dir = stopAdvisoryHandoverDir();
    mkdirSync(dir, { recursive: true });
    pruneHandovers(dir, Date.now());
    atomicWriteText(handoverPath(key, producer), `${JSON.stringify({ advisory })}\n`);
    return true;
  } catch {
    return false;
  }
}

function readAdvisory(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { advisory?: unknown };
    return typeof parsed.advisory === "string" && parsed.advisory.length > 0
      ? parsed.advisory
      : null;
  } catch {
    return null;
  }
}

/**
 * Collect and remove the hand-overs of one Stop event. Waits until every
 * expected producer has written (or `waitMs` passed), removes what it read,
 * and marks the event delivered so a second run returns at once with
 * nothing. Returns the advisories in producer order.
 */
export function takeStopAdvisories(
  payload: HookPayloadBase,
  expected: ReadonlyArray<StopAdvisoryProducer>,
  waitMs: number = DELIVER_WAIT_MS,
): string[] {
  const key = stopEventKey(payload);
  if (key === null || expected.length === 0) return [];
  if (existsSync(deliveredPath(key))) return [];
  const deadline = Date.now() + waitMs;
  const paths = expected.map((producer) => handoverPath(key, producer));
  while (!paths.every((path) => existsSync(path)) && Date.now() < deadline) {
    sleepSync(DELIVER_POLL_MS);
  }
  const advisories: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const advisory = readAdvisory(path);
    try {
      unlinkSync(path);
    } catch {
      // Already gone: read once all the same.
    }
    if (advisory !== null) advisories.push(advisory);
  }
  try {
    writeFileSync(deliveredPath(key), "");
  } catch {
    // Without the marker a second run waits and finds nothing: still silent.
  }
  return advisories;
}

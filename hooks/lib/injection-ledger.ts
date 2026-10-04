/**
 * Per-session injection ledger: what the context-injecting hooks already put
 * in front of the agent this session, and the queue of active-digest parts
 * still to re-deliver after a split.
 *
 * Three namespaced keys live in the per-scope hook-state file
 * (`session-state.ts`); this module is the only one that spells them:
 *
 * - {@link LEDGER_KEY_RECALL}: recall note keys already injected, so a later
 *   prompt does not repeat them.
 * - {@link LEDGER_KEY_ACTIVE}: vault paths the SessionStart digest emitted.
 * - {@link LEDGER_KEY_REGROUND}: digest parts 2..n plus a delivery cursor.
 *
 * Every entry carries a {@link LEDGER_TTL_MS} expiry refreshed on each write.
 * Readers degrade to "empty" on any failure and never throw; writers return
 * `false` rather than throwing, so the hooks stay fail-open.
 */

import { readHookStamp, updateHookState } from "./session-state.ts";

export const LEDGER_KEY_RECALL = "osb.recall_inject.injected";
export const LEDGER_KEY_ACTIVE = "osb.active_inject.emitted";
export const LEDGER_KEY_REGROUND = "osb.reground.queue";

/** Lifetime of every ledger entry (24 h), refreshed on every write. */
export const LEDGER_TTL_MS = 86_400_000;

/**
 * True only for a non-empty string session id. A sessionless host gets no
 * ledger at all, so one host's recall can never suppress another's through
 * the shared default scope.
 */
export function isRealSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.trim().length > 0;
}

/** Stable dedupe key of one recalled note span: origin, path and line span. */
export function recallNoteKey(note: {
  readonly path: string;
  readonly origin?: string;
  readonly startLine: number;
  readonly endLine: number;
}): string {
  return `${note.origin ?? ""}:${note.path}#L${note.startLine}-L${note.endLine}`;
}

/** The string members of `value` when it is an array, else an empty list. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Read one ledger key's string-array field as a set; empty when absent or expired. */
function readStringSet(
  vault: string,
  sessionId: string,
  key: string,
  field: string,
  nowMs: number,
): ReadonlySet<string> {
  const stamp = readHookStamp(vault, sessionId, key, nowMs);
  return new Set(stringList(stamp?.data?.[field]));
}

/** Recall note keys already injected this session. */
export function readRecallInjected(
  vault: string,
  sessionId: string,
  nowMs: number = Date.now(),
): ReadonlySet<string> {
  return readStringSet(vault, sessionId, LEDGER_KEY_RECALL, "keys", nowMs);
}

/**
 * Merge `keys` into the session's injected set and refresh its expiry. An
 * expired set is dropped rather than merged. Returns `false` on any failure.
 */
export function recordRecallInjected(
  vault: string,
  sessionId: string,
  keys: ReadonlyArray<string>,
  nowMs: number = Date.now(),
): boolean {
  const outcome = updateHookState(
    vault,
    sessionId,
    (state, now) => {
      const prior = liveData(state[LEDGER_KEY_RECALL], now);
      const merged = new Set([...stringList(prior?.["keys"]), ...keys]);
      state[LEDGER_KEY_RECALL] = { expiresAt: now + LEDGER_TTL_MS, data: { keys: [...merged] } };
      return { state, result: true };
    },
    { nowMs },
  );
  return outcome.status === "ok";
}

/** Vault paths the active digest emitted in the current epoch. */
export function readActiveEmittedPaths(
  vault: string,
  sessionId: string,
  nowMs: number = Date.now(),
): ReadonlySet<string> {
  return readStringSet(vault, sessionId, LEDGER_KEY_ACTIVE, "paths", nowMs);
}

/** Backticked preference id in a digest line, e.g. `` `pref-no-emoji` ``. */
const PREF_TOKEN_RE = /`pref-([A-Za-z0-9][A-Za-z0-9_-]*)`/g;

/**
 * Vault paths a digest emission covers: `Brain/active.md` and
 * `Brain/lessons.md` when their bodies were emitted, then one
 * `Brain/preferences/pref-<slug>.md` per backticked preference token, in
 * first-seen order with repeats dropped.
 */
export function digestNotePaths(input: {
  readonly emittedText: string;
  readonly activeBodyEmitted: boolean;
  readonly lessonsBodyEmitted: boolean;
}): ReadonlyArray<string> {
  const paths = new Set<string>();
  if (input.activeBodyEmitted) paths.add("Brain/active.md");
  if (input.lessonsBodyEmitted) paths.add("Brain/lessons.md");
  for (const match of input.emittedText.matchAll(PREF_TOKEN_RE)) {
    paths.add(`Brain/preferences/pref-${match[1]}.md`);
  }
  return [...paths];
}

/**
 * Start a new injection epoch in one locked write: record the digest's
 * emitted paths, clear the recall set (the new digest supersedes what recall
 * already showed), and replace the re-delivery queue with `regroundParts`
 * (parts 2..n), or delete it when there are none. Returns `false` on any
 * failure.
 */
export function beginInjectionEpoch(
  vault: string,
  sessionId: string,
  input: {
    readonly epoch: string;
    readonly emittedPaths: ReadonlyArray<string>;
    readonly regroundParts: ReadonlyArray<string>;
    readonly partCeilingChars: number;
  },
  nowMs: number = Date.now(),
): boolean {
  const outcome = updateHookState(
    vault,
    sessionId,
    (state, now) => {
      const expiresAt = now + LEDGER_TTL_MS;
      state[LEDGER_KEY_ACTIVE] = {
        expiresAt,
        data: { epoch: input.epoch, paths: [...new Set(input.emittedPaths)] },
      };
      delete state[LEDGER_KEY_RECALL];
      if (input.regroundParts.length === 0) {
        delete state[LEDGER_KEY_REGROUND];
      } else {
        state[LEDGER_KEY_REGROUND] = {
          expiresAt,
          data: {
            epoch: input.epoch,
            parts: [...input.regroundParts],
            next: 0,
            partCeilingChars: input.partCeilingChars,
          },
        };
      }
      return { state, result: true };
    },
    { nowMs },
  );
  return outcome.status === "ok";
}

/** Result of {@link takeRegroundPart}. */
export type RegroundTake =
  | {
      readonly status: "part";
      readonly part: string;
      /** 1-based position in the full split (the first queued part is 2). */
      readonly index: number;
      readonly total: number;
      readonly epoch: string;
      readonly partCeilingChars: number;
    }
  | { readonly status: "empty" }
  | { readonly status: "busy" }
  | { readonly status: "failed" };

/** The `data` record of a live (unexpired) stamp in raw state, else `null`. */
function liveData(raw: unknown, nowMs: number): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const expiresAt = record["expiresAt"];
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return null;
  }
  const data = record["data"];
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

/** A validated re-delivery queue. */
interface RegroundQueue {
  readonly epoch: string;
  readonly parts: string[];
  readonly next: number;
  readonly partCeilingChars: number;
}

/** Parse a queue payload; `null` when any field is missing or malformed. */
function parseQueue(data: Record<string, unknown> | null): RegroundQueue | null {
  if (data === null) return null;
  const { epoch, parts, next, partCeilingChars } = data;
  if (typeof epoch !== "string") return null;
  if (!Array.isArray(parts) || !parts.every((p) => typeof p === "string")) return null;
  if (typeof next !== "number" || !Number.isInteger(next) || next < 0) return null;
  if (typeof partCeilingChars !== "number" || !Number.isFinite(partCeilingChars)) return null;
  return { epoch, parts: parts as string[], next, partCeilingChars };
}

/**
 * Hand out the next queued digest part exactly once. One lock attempt, no
 * retry: on contention it returns `busy` and the caller emits nothing, so the
 * part stays queued for the next event. The cursor advance is persisted
 * before the part is returned, so a crash after the write loses that part and
 * never duplicates it. The queue key is deleted once its last part is taken.
 * A queue whose epoch is not the active epoch is a leftover of an earlier
 * SessionStart whose replacement write failed: it reads as empty and is
 * deleted. A missing queue is answered from a lock-free read without
 * touching disk.
 */
export function takeRegroundPart(
  vault: string,
  sessionId: string,
  nowMs: number = Date.now(),
): RegroundTake {
  if (readHookStamp(vault, sessionId, LEDGER_KEY_REGROUND, nowMs) === null) {
    return { status: "empty" };
  }
  const outcome = updateHookState<RegroundTake>(
    vault,
    sessionId,
    (state, now) => {
      const queue = parseQueue(liveData(state[LEDGER_KEY_REGROUND], now));
      const activeEpoch = liveData(state[LEDGER_KEY_ACTIVE], now)?.["epoch"];
      if (queue === null || queue.epoch !== activeEpoch || queue.next >= queue.parts.length) {
        delete state[LEDGER_KEY_REGROUND];
        return { state, result: { status: "empty" } };
      }
      const position = queue.next;
      if (position + 1 >= queue.parts.length) {
        delete state[LEDGER_KEY_REGROUND];
      } else {
        state[LEDGER_KEY_REGROUND] = {
          expiresAt: now + LEDGER_TTL_MS,
          data: { ...queue, next: position + 1 },
        };
      }
      return {
        state,
        result: {
          status: "part",
          part: queue.parts[position]!,
          index: position + 2,
          total: queue.parts.length + 1,
          epoch: queue.epoch,
          partCeilingChars: queue.partCeilingChars,
        },
      };
    },
    { tryOnce: true, nowMs },
  );
  return outcome.status === "ok" ? outcome.result : outcome;
}

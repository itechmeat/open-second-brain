/**
 * Batch session checkpoint (C4 / t_1a3a9eba).
 *
 * A whole session's extracted memories (taste signals), decisions,
 * learnings, an optional request/next-steps summary, and an optional
 * diary note, persisted in ONE call. OSB already exposes per-signal
 * writes and a session-summary digest, but closing a session cleanly
 * means several independent writes; a partial failure mid-way leaves the
 * vault in a half-captured state and a naive retry double-appends.
 *
 * This module makes an end-of-session save atomic FROM THE CALLER'S
 * PERSPECTIVE by giving the whole checkpoint a single idempotency key
 * (session id) over the C1 idempotency ledger:
 *
 *   - A first checkpoint for a session writes every item and records the
 *     session key -> whole-checkpoint content hash.
 *   - A retry with the SAME session id + SAME content short-circuits to a
 *     deduped no-op (`deduped: true`) BEFORE touching disk — the
 *     multi-runtime retry / double-delivery case.
 *   - A retry with the SAME session id + DIFFERENT content is an explicit
 *     {@link IdempotencyPayloadMismatchError} (never a silent overwrite).
 *
 * Within a single checkpoint, each item is written independently and a
 * per-item failure (a malformed signal, an empty summary) is COLLECTED
 * into `partial` rather than aborting the batch — the result is
 * `status: "mixed"` and nothing is silently dropped. A mixed checkpoint
 * does NOT record the session key, so a corrected retry re-attempts the
 * items that need review while the already-written items dedupe through
 * their own per-item keys.
 *
 * The kernel stays deterministic: no LLM, no wall-clock beyond the
 * caller-supplied (or defaulted) `createdAt`.
 */

import { relative } from "node:path";

import { appendBrainNote } from "./note.ts";
import {
  computePayloadHash,
  IdempotencyPayloadMismatchError,
  lookupKey,
  rememberKey,
} from "./idempotency-ledger.ts";
import { appendSessionSummary, type SessionSummaryDigest } from "./session-summary.ts";
import { writeSignal, type WriteSignalOptions } from "./signal.ts";
import { isoDate, isoSecond } from "./time.ts";
import { slugify } from "../vault.ts";
import type { BrainSignalSign } from "./types.ts";

export const SESSION_CHECKPOINT_STATUS = Object.freeze({
  ok: "ok",
  mixed: "mixed",
} as const);

export type SessionCheckpointStatus =
  (typeof SESSION_CHECKPOINT_STATUS)[keyof typeof SESSION_CHECKPOINT_STATUS];

/** One extracted memory (taste signal) in a checkpoint batch. */
export interface CheckpointSignalInput {
  readonly topic: string;
  readonly signal: BrainSignalSign;
  readonly principle: string;
  readonly scope?: string;
  readonly raw?: string;
  readonly source?: ReadonlyArray<string>;
}

export interface SessionCheckpointInput {
  readonly sessionId: string;
  /** Identity stamped on every written signal / diary note. */
  readonly agent: string;
  /** Extracted memories to persist as `sig-*` signals. */
  readonly signals?: ReadonlyArray<CheckpointSignalInput>;
  /** Session summary digest fields (folded into one digest record). */
  readonly request?: string;
  readonly decisions?: ReadonlyArray<string>;
  readonly learnings?: ReadonlyArray<string>;
  readonly nextSteps?: ReadonlyArray<string>;
  readonly sourceTurnIds?: ReadonlyArray<string>;
  readonly host?: string;
  /** Optional narrative diary line appended to today's Brain log. */
  readonly diary?: string;
  /**
   * Canonical UTC ISO-8601 write time. Defaults to `isoSecond(new Date())`;
   * supplied by tests for deterministic fixtures.
   */
  readonly createdAt?: string;
}

/** One item that needs review — never silently dropped. */
export interface CheckpointPartialItem {
  readonly kind: "signal" | "summary" | "diary";
  readonly index?: number;
  readonly topic?: string;
  readonly reason: string;
}

export interface CheckpointSignalResult {
  readonly id: string;
  /** Vault-relative POSIX path of the written (or deduped) signal. */
  readonly path: string;
  /** True when this signal deduped against a prior write of the same key. */
  readonly deduped: boolean;
}

export interface SessionCheckpointResult {
  readonly status: SessionCheckpointStatus;
  readonly sessionId: string;
  /** True when the whole checkpoint deduped at the session key (a retry). */
  readonly deduped: boolean;
  readonly signals: ReadonlyArray<CheckpointSignalResult>;
  readonly summary: { readonly id: string } | null;
  readonly diaryWritten: boolean;
  readonly partial: ReadonlyArray<CheckpointPartialItem>;
}

export class SessionCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCheckpointError";
  }
}

/**
 * The whole-checkpoint idempotency key. Scoped to the session id so a
 * retry of the same session collides here, and DISTINCT from the C1
 * feedback keys (which are `<session>:<slug>` shaped) by the `checkpoint:`
 * prefix.
 */
function checkpointKey(sessionId: string): string {
  return `checkpoint:${sessionId}`;
}

/** Per-signal key so a mixed-then-corrected retry dedupes items already
 * written by the earlier attempt. Index-scoped: a stable slot within the
 * batch, disambiguated by the ledger's content hash. */
function signalKey(sessionId: string, index: number): string {
  return `${checkpointKey(sessionId)}:sig:${index}`;
}

/** The semantic identity of a whole checkpoint for idempotency hashing:
 * every item's content, never timestamps or allocated slugs. */
function checkpointPayloadFields(input: SessionCheckpointInput): Record<string, unknown> {
  return {
    session_id: input.sessionId.trim(),
    signals: (input.signals ?? []).map((s) => ({
      topic: s.topic,
      signal: s.signal,
      principle: s.principle,
      scope: s.scope,
      raw: s.raw,
      source: s.source ? [...s.source] : undefined,
    })),
    request: input.request,
    decisions: input.decisions ? [...input.decisions] : undefined,
    learnings: input.learnings ? [...input.learnings] : undefined,
    next_steps: input.nextSteps ? [...input.nextSteps] : undefined,
    diary: input.diary,
    // `host` and `sourceTurnIds` are written to disk (appendSessionSummary), so
    // a retry with the same session id but different provenance must raise the
    // mismatch error rather than silently deduping.
    host: input.host,
    source_turn_ids: input.sourceTurnIds ? [...input.sourceTurnIds] : undefined,
  };
}

function hasSummaryContent(input: SessionCheckpointInput): boolean {
  return (
    (input.request?.trim().length ?? 0) > 0 ||
    (input.decisions?.length ?? 0) > 0 ||
    (input.learnings?.length ?? 0) > 0 ||
    (input.nextSteps?.length ?? 0) > 0
  );
}

/**
 * Save a whole session's memories + summary (+ optional diary) in one
 * idempotent batch. See the module header for the idempotency contract.
 *
 * @throws SessionCheckpointError when the session id is empty or the
 *   checkpoint carries no items at all.
 * @throws IdempotencyPayloadMismatchError when the session id was already
 *   checkpointed with different content.
 */
export function saveSessionCheckpoint(
  vault: string,
  input: SessionCheckpointInput,
  writeOptions: WriteSignalOptions = {},
): SessionCheckpointResult {
  const sessionId = input.sessionId.trim();
  if (sessionId.length === 0) {
    throw new SessionCheckpointError("session checkpoint requires a non-empty session id");
  }
  const signals = input.signals ?? [];
  const summaryWanted = hasSummaryContent(input);
  if (signals.length === 0 && !summaryWanted && !input.diary?.trim()) {
    throw new SessionCheckpointError(
      "session checkpoint requires at least one signal, summary field, or diary line",
    );
  }

  const createdAt = input.createdAt ?? isoSecond(new Date());
  const key = checkpointKey(sessionId);
  const contentHash = computePayloadHash(checkpointPayloadFields(input));

  // Whole-checkpoint idempotency consult BEFORE any write: a matching
  // retry short-circuits to a deduped no-op; a differing payload for the
  // same session throws rather than silently overwriting the checkpoint.
  const existing = lookupKey(vault, key);
  if (existing) {
    if (existing.contentHash === contentHash) {
      const ref = (existing.ref ?? {}) as {
        signals?: ReadonlyArray<CheckpointSignalResult>;
        summary?: { id: string } | null;
        diaryWritten?: boolean;
      };
      return Object.freeze({
        status: SESSION_CHECKPOINT_STATUS.ok,
        sessionId,
        deduped: true,
        signals: Object.freeze([...(ref.signals ?? [])]),
        summary: ref.summary ?? null,
        diaryWritten: ref.diaryWritten ?? false,
        partial: Object.freeze([]),
      });
    }
    throw new IdempotencyPayloadMismatchError(key, existing.contentHash, contentHash);
  }

  const signalDate = isoDate(new Date(createdAt));
  const signalResults: CheckpointSignalResult[] = [];
  const partial: CheckpointPartialItem[] = [];

  signals.forEach((sig, index) => {
    try {
      const res = writeSignal(
        vault,
        {
          topic: sig.topic,
          signal: sig.signal,
          agent: input.agent,
          principle: sig.principle,
          created_at: createdAt,
          date: signalDate,
          slug: slugify(sig.topic),
          ...(sig.scope ? { scope: sig.scope } : {}),
          ...(sig.raw ? { raw: sig.raw } : {}),
          ...(sig.source && sig.source.length > 0 ? { source: [...sig.source] } : {}),
          idempotency_key: signalKey(sessionId, index),
        },
        writeOptions,
      );
      signalResults.push(
        Object.freeze({
          id: res.id,
          path: res.path ? relative(vault, res.path) : "",
          deduped: res.deduped === true,
        }),
      );
    } catch (err) {
      // A malformed signal or a per-item payload mismatch needs review —
      // collect it, never abort the whole batch.
      partial.push(
        Object.freeze({
          kind: "signal",
          index,
          topic: sig.topic,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  let summary: { id: string } | null = null;
  if (summaryWanted) {
    try {
      const digest: SessionSummaryDigest = appendSessionSummary(vault, {
        sessionId,
        ...(input.request !== undefined ? { request: input.request } : {}),
        ...(input.decisions !== undefined ? { decisions: input.decisions } : {}),
        ...(input.learnings !== undefined ? { learnings: input.learnings } : {}),
        ...(input.nextSteps !== undefined ? { nextSteps: input.nextSteps } : {}),
        ...(input.sourceTurnIds !== undefined ? { sourceTurnIds: input.sourceTurnIds } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
        createdAt,
      });
      summary = Object.freeze({ id: digest.id });
    } catch (err) {
      partial.push(
        Object.freeze({
          kind: "summary",
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  let diaryWritten = false;
  if (input.diary?.trim()) {
    try {
      appendBrainNote({ vault, text: input.diary, agent: input.agent });
      diaryWritten = true;
    } catch (err) {
      partial.push(
        Object.freeze({
          kind: "diary",
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const status =
    partial.length === 0 ? SESSION_CHECKPOINT_STATUS.ok : SESSION_CHECKPOINT_STATUS.mixed;

  // Record the session key ONLY on a clean checkpoint. A mixed result
  // leaves the key unset so a corrected retry re-attempts the items that
  // needed review; the items that already landed dedupe via their own
  // per-item keys.
  if (status === SESSION_CHECKPOINT_STATUS.ok) {
    rememberKey(vault, {
      key,
      contentHash,
      createdAt,
      ref: { signals: signalResults, summary, diaryWritten },
    });
  }

  return Object.freeze({
    status,
    sessionId,
    deduped: false,
    signals: Object.freeze(signalResults),
    summary,
    diaryWritten,
    partial: Object.freeze(partial),
  });
}

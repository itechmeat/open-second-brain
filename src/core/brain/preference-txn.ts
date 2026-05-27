/**
 * `writePreferenceTxn` - single chokepoint for every preference write.
 *
 * Direct writes via {@link writePreference} and indirect writes via the
 * dream pass (promotion / retirement) both flow through this function.
 * That gives the brain integrity suite one place to bolt on every
 * collision check and gate (drift, stale-update, unsafe-shrink,
 * destructive replacement, ...) without sprinkling parallel checks
 * across `preference.ts` and `dream.ts`.
 *
 * Shape:
 *
 *   1. Compute target path from `input.slug`.
 *   2. Acquire the sync lockfile (`<path>.lock`). EEXIST -> `SourceLock`
 *      collision error (typed).
 *   3. Re-read the existing preference inside the lock, if the file
 *      already exists. The expectations chain sees this snapshot
 *      verbatim - any check that depends on "current vs. proposed"
 *      reads it from `ctx.existing`.
 *   4. Run the expectations chain in order. The first one that throws
 *      `BrainCollisionError` aborts the txn; subsequent expectations
 *      do not run.
 *   5. Delegate the write to {@link writePreference} (which handles
 *      validation, frontmatter rendering, content-equality shortcut,
 *      and the atomic write itself).
 *   6. Release the lock in a `finally` block so the lock is freed
 *      regardless of whether the write or an expectation threw.
 */

import { existsSync } from "node:fs";

import { computeContentHash } from "./content-hash.ts";
import { appendEditHistory, type EditHistoryEntry } from "./health/edit-history.ts";
import { preferencePath, validateSlug } from "./paths.ts";
import {
  parsePreference,
  writePreference,
  wouldRewritePreference,
  type WritePreferenceInput,
  type WritePreferenceOptions,
  type WritePreferenceResult,
} from "./preference.ts";
import { acquireLockSync } from "./sync-lockfile.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainPreference } from "./types.ts";

/**
 * Machine-friendly discriminants for the four collision modes covered
 * by the brain integrity suite. No human-language strings: the names
 * surface as `.kind` on {@link BrainCollisionError} and as event codes
 * in `Brain/log/`. Languages-of-output stay out of the rule itself.
 */
export const BRAIN_COLLISION_KIND = Object.freeze({
  staleUpdate: "StaleUpdate",
  unsafeShrink: "UnsafeShrink",
  sourceLock: "SourceLock",
  duplicateWrite: "DuplicateWrite",
} as const);

export type BrainCollisionKind = (typeof BRAIN_COLLISION_KIND)[keyof typeof BRAIN_COLLISION_KIND];

/**
 * Typed error surfaced by every txn collision mode. `kind` is the
 * machine-readable discriminant; the message carries human prose only
 * for log/console rendering.
 */
export class BrainCollisionError extends Error {
  readonly kind: BrainCollisionKind;

  constructor(kind: BrainCollisionKind, message: string) {
    super(message);
    this.name = "BrainCollisionError";
    this.kind = kind;
  }
}

/**
 * Opt-in edit-history recording for the txn (v0.14.0, F4). When
 * supplied AND the write actually changes bytes, the txn appends one
 * {@link EditHistoryEntry} per changed tracked field (`principle`,
 * `scope`, `status`) to the preference's `.history.jsonl` sidecar,
 * keyed by the resulting revision. Callers that omit this leave the
 * pre-v0.14.0 behaviour untouched - no sidecar is created.
 */
export interface EditHistoryOptions {
  /** Agent identity recorded on each entry. */
  readonly agent: string;
  /** Clock for the entry timestamp; defaults to `new Date()`. */
  readonly now?: () => Date;
}

/**
 * Frontmatter fields whose before/after the edit-history trail records.
 * Kept to the content-bearing fields plus lifecycle status; derived
 * counters and timestamps are intentionally excluded so the trail
 * stays a record of meaning, not bookkeeping churn.
 */
const HISTORY_TRACKED_FIELDS = ["principle", "scope", "status"] as const;

function editHistoryEntries(
  existing: BrainPreference | null,
  proposed: WritePreferenceInput,
  revision: number,
  opts: EditHistoryOptions,
): EditHistoryEntry[] {
  const ts = (opts.now?.() ?? new Date()).toISOString();
  const reader: Record<
    (typeof HISTORY_TRACKED_FIELDS)[number],
    {
      before: string | null;
      after: string | null;
    }
  > = {
    principle: {
      before: existing?.principle ?? null,
      after: proposed.principle ?? null,
    },
    scope: {
      before: existing?.scope ?? null,
      after: proposed.scope ?? null,
    },
    status: {
      before: existing?.status ?? null,
      after: proposed.status ?? null,
    },
  };
  const out: EditHistoryEntry[] = [];
  for (const field of HISTORY_TRACKED_FIELDS) {
    const { before, after } = reader[field];
    if (before === after) continue;
    out.push({ ts, agent: opts.agent, revision, field, before, after });
  }
  return out;
}

/**
 * Context passed to every expectation. Carries the resolved path, the
 * existing preference (if any), and the proposed input. Expectations
 * must be pure relative to the txn's own state - they can throw
 * {@link BrainCollisionError} but must not mutate `ctx`.
 */
export interface WritePreferenceContext {
  readonly vault: string;
  readonly path: string;
  readonly existing: BrainPreference | null;
  readonly input: WritePreferenceInput;
}

/**
 * One expectation in the chain. Synchronous, runs inside the lock
 * after the existing preference (if any) has been re-read. Throws
 * {@link BrainCollisionError} to abort the write; returning normally
 * signals "ok, keep going".
 */
export type WritePreferenceExpectation = (ctx: WritePreferenceContext) => void;

/**
 * Write a preference under an exclusive sync lock, running the
 * expectations chain before the mutation. {@link writePreference}'s
 * own validation + rendering + atomic-write still runs - the txn just
 * gates it.
 *
 * Callers without collision checks pass an empty expectations array;
 * the txn then behaves identically to `writePreference(vault, input,
 * options)` aside from the lock acquire/release pair (which is cheap
 * when uncontended).
 */
export function writePreferenceTxn(
  vault: string,
  input: WritePreferenceInput,
  expectations: ReadonlyArray<WritePreferenceExpectation>,
  options: WritePreferenceOptions = {},
  history?: EditHistoryOptions,
): WritePreferenceResult {
  const slug = validateSlug(input.slug);
  const path = preferencePath(vault, slug);

  let handle: ReturnType<typeof acquireLockSync>;
  try {
    handle = acquireLockSync(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ELOCKED") {
      throw new BrainCollisionError(
        BRAIN_COLLISION_KIND.sourceLock,
        `preference write blocked by active lock: ${path}`,
      );
    }
    throw err;
  }

  try {
    const existing = existsSync(path) ? parsePreference(path) : null;
    const ctx: WritePreferenceContext = Object.freeze({
      vault,
      path,
      existing,
      input,
    });
    for (const expectation of expectations) {
      expectation(ctx);
    }
    // Brain Integrity Suite smart defaults (v0.12.0). The txn owns
    // two pieces of bookkeeping for callers that opt in:
    //
    //   - `_content_hash` lands automatically on promotion to
    //     `confirmed` so the doctor's drift check has something to
    //     compare against. Skipped when the caller supplies a hash
    //     of their own.
    //   - `_revision` is a monotonic write counter that increments
    //     ONLY when the proposed content would actually change the
    //     on-disk bytes. A dream-pass no-op rerun must stay
    //     byte-identical, so the txn pre-renders the would-be write
    //     with the existing revision and bumps only when
    //     `wouldRewritePreference` says the file would change.
    //
    // Callers that bypass the txn keep pre-v0.12.0 semantics.
    const autoHash =
      input.content_hash === undefined && input.status === BRAIN_PREFERENCE_STATUS.confirmed
        ? { content_hash: computeContentHash(input.principle, input.scope) }
        : {};
    const candidate: WritePreferenceInput = {
      ...input,
      ...autoHash,
      revision: input.revision ?? existing?.revision ?? 0,
    };
    const willChange =
      input.revision !== undefined || existing === null || wouldRewritePreference(vault, candidate);
    const inputWithDefaults: WritePreferenceInput = willChange
      ? {
          ...candidate,
          revision: input.revision ?? (existing?.revision ?? 0) + 1,
        }
      : candidate;
    const result = writePreference(vault, inputWithDefaults, options);
    // Edit-history (opt-in): record field-level before/after only when
    // the write actually changed bytes, keyed by the resulting
    // revision. Idempotent appends keep Syncthing peers convergent.
    if (history && willChange) {
      const entries = editHistoryEntries(
        existing,
        inputWithDefaults,
        inputWithDefaults.revision ?? 1,
        history,
      );
      appendEditHistory(vault, slug, entries);
    }
    return result;
  } finally {
    handle.release();
  }
}

// ----- Expectation factories -----------------------------------------------
//
// Each factory returns a {@link WritePreferenceExpectation} ready to be
// dropped into the txn's expectations array. Callers compose them
// declaratively at the call site; the txn runs them in order under the
// lock, before delegating to {@link writePreference}.

/**
 * StaleUpdate gate. The writer must declare which revision it read;
 * the txn rejects the write if the on-disk revision has moved.
 *
 * Treats a missing on-disk `_revision` field as 0 - the absent-as-zero
 * convention from {@link BrainPreference.revision}'s reader.
 */
export function expectRevision(expected: number): WritePreferenceExpectation {
  return (ctx) => {
    const current = ctx.existing?.revision ?? 0;
    if (current !== expected) {
      throw new BrainCollisionError(
        BRAIN_COLLISION_KIND.staleUpdate,
        `stale update: expected revision ${expected}, found ${current} (path=${ctx.path})`,
      );
    }
  };
}

/**
 * UnsafeShrink gate. The new principle's length must stay at or above
 * `minRatio * existingPrinciple.length`. A first-time write (no
 * existing preference) is always allowed.
 *
 * `minRatio` should be a value in `(0, 1]`. The dream pass passes
 * `cfg.confidence.unsafe_shrink_min_ratio` here when promoting or
 * refreshing a confirmed preference.
 */
export function noUnsafeShrink(minRatio: number): WritePreferenceExpectation {
  if (!Number.isFinite(minRatio) || minRatio <= 0 || minRatio > 1) {
    throw new RangeError(
      `noUnsafeShrink(minRatio) expects a finite value in (0, 1]; got ${String(minRatio)}`,
    );
  }
  return (ctx) => {
    if (!ctx.existing) return;
    const existingLen = ctx.existing.principle.length;
    if (existingLen <= 0) return;
    const newLen = ctx.input.principle.length;
    const ratio = newLen / existingLen;
    if (ratio < minRatio) {
      throw new BrainCollisionError(
        BRAIN_COLLISION_KIND.unsafeShrink,
        `unsafe shrink: new principle ${newLen} chars is below ${minRatio} * ${existingLen} (ratio=${ratio.toFixed(3)})`,
      );
    }
  };
}

/**
 * DuplicateWrite gate. Triggers when the proposed content's
 * {@link computeContentHash} matches the existing `content_hash`
 * AND the existing `last_evidence_at` is within `windowMs` of `now()`.
 *
 * Use case: an agent re-fires a `dream` refresh for the same pref
 * while a previous write is still settling. The gate stays silent on
 * legacy preferences (no `content_hash`) so backfills are never
 * mis-classified as duplicates.
 *
 * `now` is injectable so tests do not depend on wall-clock.
 */
export function noDuplicateWriteWithin(
  windowMs: number,
  now: () => Date = () => new Date(),
): WritePreferenceExpectation {
  return (ctx) => {
    const existing = ctx.existing;
    if (!existing) return;
    const existingHash = existing.content_hash;
    if (!existingHash) return;
    const proposedHash = computeContentHash(ctx.input.principle, ctx.input.scope);
    if (existingHash !== proposedHash) return;
    const lastEv = existing.last_evidence_at;
    if (!lastEv) return;
    const ageMs = now().getTime() - new Date(lastEv).getTime();
    if (ageMs >= 0 && ageMs < windowMs) {
      throw new BrainCollisionError(
        BRAIN_COLLISION_KIND.duplicateWrite,
        `duplicate write: identical content hash within ${windowMs}ms window (age=${ageMs}ms)`,
      );
    }
  };
}

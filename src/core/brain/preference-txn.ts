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

import {
  preferencePath,
  validateSlug,
} from "./paths.ts";
import {
  parsePreference,
  writePreference,
  type WritePreferenceInput,
  type WritePreferenceOptions,
  type WritePreferenceResult,
} from "./preference.ts";
import { acquireLockSync } from "./sync-lockfile.ts";
import type { BrainPreference } from "./types.ts";

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

export type BrainCollisionKind =
  (typeof BRAIN_COLLISION_KIND)[keyof typeof BRAIN_COLLISION_KIND];

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
export type WritePreferenceExpectation = (
  ctx: WritePreferenceContext,
) => void;

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
    return writePreference(vault, input, options);
  } finally {
    handle.release();
  }
}

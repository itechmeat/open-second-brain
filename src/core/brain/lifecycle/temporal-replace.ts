/**
 * Atomic temporal fact-replacement (Belief lifecycle suite, A2,
 * t_3ba9c404).
 *
 * One operation closes a predecessor fact (`valid_until = T`) and opens
 * a successor fact (`valid_from = T`) at one shared instant, reusing
 * `superseded_by` as the successor link. Intervals are half-open
 * `[valid_from, valid_until)`: at exactly T the predecessor is no longer
 * valid and the successor is, so point-in-time evaluation of the pair
 * has no gap and no overlap. Date-only facts (`YYYY-MM-DD`) keep
 * whole-day semantics - the boundary is a whole day, evaluated as its
 * `T00:00:00Z` start.
 *
 * The pair is written atomically (both or neither): both files are
 * validated and their new content computed before any write, and a
 * failed second write rolls the first back to its captured bytes.
 *
 * This layer does NOT touch the existing conflict-resolution supersede
 * in `hygiene/resolve-conflicts.ts`; it is a distinct, explicit
 * operator/agent operation over bi-temporal validity fields.
 *
 * Import direction (design invariant): imports from `types.ts` and the
 * shared vault/log helpers plus the sibling `tombstone.ts` link
 * conventions, never the reverse. The pure validity rule lives in
 * `validity.ts` (re-exported here), so a reader never imports this writer.
 */

import { readFileSync } from "node:fs";

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import type { FrontmatterMap } from "../../types.ts";
import { writeFrontmatterAtomic } from "../../vault.ts";
import { withOperationPrivacy } from "../../store/operation-scope.ts";
import { StoreWriteError } from "../../store/store-write.ts";
import { appendLogEvent } from "../log.ts";
import {
  assertLifecycleWrite,
  MemoryTargetError,
  resolveMemoryTarget,
  verifyMemoryPatches,
  writeMemoryPatches,
  type MemoryPatch,
  type MemoryTarget,
} from "./memory-target.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { SUPERSEDED_BY_KEY } from "./tombstone-read.ts";

import {
  normalizeInstant,
  TemporalReplaceError,
  VALID_FROM_KEY,
  VALID_UNTIL_KEY,
} from "./validity.ts";

export * from "./validity.ts";

export interface TemporalReplaceInput {
  readonly vault: string;
  /** The predecessor fact being closed: its vault-relative path, bare id or `store:<id>`. */
  readonly predecessor: string;
  /** The successor fact being opened: its vault-relative path, bare id or `store:<id>`. */
  readonly successor: string;
  /** Shared instant T: ISO-8601 UTC instant or `YYYY-MM-DD` date. */
  readonly at: string | Date;
  readonly agent?: string;
  readonly configPath?: string;
  /**
   * The vault-relative paths the caller may read. A fact it may not read
   * is refused as a missing one, before anything is written. Absent,
   * every fact may be written.
   */
  readonly readable?: (rel: string) => boolean;
}

export interface TemporalReplaceResult {
  /** The shared instant as stored on disk. */
  readonly at: string;
  /** Vault-relative predecessor path. */
  readonly predecessor: string;
  /** Vault-relative successor path. */
  readonly successor: string;
  readonly agent: string;
  readonly loggedAt: string;
}

/**
 * Close the predecessor and open the successor at one shared instant.
 * Writes both facts atomically (both or neither) and logs one
 * `temporal-replace` event. Once switched to the brain store each fact
 * is its store record (`memory-target.ts`): the pair is one store
 * operation, and no legacy page is read or written; a fact may be named
 * by its path, its bare id or `store:<id>` on both sides.
 */
export function temporalReplace(input: TemporalReplaceInput): TemporalReplaceResult {
  // Write guard: the vault identity guard on an unswitched machine, the
  // store's content gates once switched (context-integrity-gates, Unit J).
  assertLifecycleWrite(input.vault, input.configPath);
  let pred: MemoryTarget;
  let succ: MemoryTarget;
  try {
    const opts = {
      ...(input.readable !== undefined ? { readable: input.readable } : {}),
      ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
    };
    pred = resolveMemoryTarget(input.vault, input.predecessor, opts);
    succ = resolveMemoryTarget(input.vault, input.successor, opts);
  } catch (err) {
    throw new TemporalReplaceError(
      `temporalReplace: a fact does not resolve inside the vault: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (pred.rel === succ.rel) {
    throw new TemporalReplaceError("temporalReplace: predecessor and successor must differ");
  }
  // Both or neither: a store record and a page file cannot be written in
  // one atomic step (a failed file write cannot take back the store
  // append), so a pair that spans the two is refused before either is
  // written. Two store records, or two files, stay supported.
  if (pred.inStore !== succ.inStore) {
    throw new TemporalReplaceError(
      `temporalReplace: ${pred.rel} and ${succ.rel} live in different places (one in the brain ` +
        "store, one a file in the vault); the pair cannot be written as one step, so nothing was " +
        "written",
    );
  }

  const relPred = pred.rel;
  const relSucc = succ.rel;
  const { stored } = normalizeInstant(input.at);
  const successorLink = `[[${succ.id}]]`;
  const patches: MemoryPatch[] = [
    { target: pred, patch: { [VALID_UNTIL_KEY]: stored, [SUPERSEDED_BY_KEY]: successorLink } },
    { target: succ, patch: { [VALID_FROM_KEY]: stored } },
  ];

  let isPrivate: boolean;
  try {
    ({ private: isPrivate } = writeMemoryPatches(
      input.vault,
      patches,
      (onDisk) => writePagePair(onDisk, relPred, relSucc),
      input.configPath !== undefined ? { configPath: input.configPath } : {},
    ));
    verifyMemoryPatches(input.vault, patches, input.configPath);
  } catch (err) {
    if (err instanceof TemporalReplaceError) throw err;
    const message =
      err instanceof StoreWriteError || err instanceof MemoryTargetError
        ? (err as Error).message
        : `failed to write the fact pair (${relPred} -> ${relSucc}): ${(err as Error).message}`;
    throw new TemporalReplaceError(`temporalReplace: ${message}`, { cause: err });
  }

  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);
  const loggedAt = isoSecond(new Date());
  withOperationPrivacy(isPrivate, () =>
    appendLogEvent(
      input.vault,
      {
        timestamp: loggedAt,
        eventType: BRAIN_LOG_EVENT_KIND.temporalReplace,
        body: {
          predecessor: relPred,
          successor: relSucc,
          at: stored,
          agent,
        },
      },
      input.configPath !== undefined ? { configPath: input.configPath } : {},
    ),
  );

  return { at: stored, predecessor: relPred, successor: relSucc, agent, loggedAt };
}

/**
 * Write the facts that are page files, in order, with the patch of each
 * applied. A failed later write rolls the earlier ones back to their
 * captured bytes, so the pair is both or neither.
 */
function writePagePair(onDisk: ReadonlyArray<MemoryPatch>, relPred: string, relSucc: string): void {
  const written: Array<{ abs: string; rel: string; bytes: string }> = [];
  try {
    for (const { target, patch } of onDisk) {
      const bytes = readFileSync(target.abs, "utf8");
      const next: FrontmatterMap = { ...(target.meta as FrontmatterMap) };
      for (const [name, value] of Object.entries(patch)) next[name] = value as never;
      writeFrontmatterAtomic(target.abs, next, target.body, { overwrite: true });
      written.push({ abs: target.abs, rel: target.rel, bytes });
    }
  } catch (err) {
    for (const page of written) {
      try {
        atomicWriteFileSync(page.abs, page.bytes);
      } catch (restoreErr) {
        throw new TemporalReplaceError(
          `temporalReplace: successor write failed AND predecessor rollback failed for ${page.rel}: ${(restoreErr as Error).message}`,
          { cause: restoreErr },
        );
      }
    }
    throw new TemporalReplaceError(
      `temporalReplace: failed to write the fact pair (${relPred} -> ${relSucc}): ${(err as Error).message}`,
      { cause: err },
    );
  }
}

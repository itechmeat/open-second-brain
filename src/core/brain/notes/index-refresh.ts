/**
 * The index-freshness evidence a note write reports, and the post-write
 * refresh claim it starts.
 *
 * This is `notes/lifecycle.ts`'s refresh half, lifted into a module of
 * its own so a SECOND write surface can claim the same detached refresh:
 * note creation and content edits go through writers that cannot import
 * the lifecycle module without a cycle (the lifecycle already imports
 * their path envelope), and the claim - the vocabulary, the evidence
 * read, the deferred search imports, the refusal reason - is one thing
 * that must not come to mean two.
 *
 * The search imports are deferred for the reason
 * `notes/lifecycle.ts` documents: the search barrel reaches back into
 * the Brain tree, and a static edge from a Brain note writer into it is
 * the shape the acyclic-import ratchet exists to keep out.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { requireNextStep } from "../next-step.ts";
import { SEARCH_INDEX_MISSING_CODE } from "../diagnostics.ts";

// ----- How stale the derived index is ---------------------------------------

/**
 * The state of the search index at the moment a write call finished.
 *
 * There is no `current` member and that is a result, not an omission:
 * the refresh an applied write claims is detached, so at the instant
 * this evidence is read no run has landed yet - an index that exists is
 * stale with respect to a write that just happened, every time.
 * Declaring a member nothing can produce would be inviting a reader to
 * believe a write might have refreshed the index; the claim that a run
 * is IN FLIGHT travels on the report beside this evidence, never inside
 * it.
 *
 * `unchanged` is the plan-only counterpart, and it exists because that
 * argument has a premise: an index goes stale with respect to a write
 * THAT HAPPENED. A plan moved no byte and rewrote no spelling, so the
 * index describes the vault exactly as well after the call as before it,
 * and reporting `stale` there was a false statement about the one field
 * this vocabulary's honesty rests on. It is deliberately not named
 * `current`: the claim is only that THIS call did not age the index,
 * never that some earlier write did not.
 */
export const INDEX_EVIDENCE = Object.freeze({
  /** An index exists; its last pass predates this call and names the old path. */
  stale: "stale",
  /** An index exists and this call wrote nothing, so it is no staler. */
  unchanged: "unchanged",
  /** No index at the configured path, so it held no evidence either way. */
  absent: "absent",
  /** An index exists and could not be opened, or records no run instant. */
  unreadable: "unreadable",
} as const);

/** Closed union over {@link INDEX_EVIDENCE}. */
export type IndexEvidenceState = (typeof INDEX_EVIDENCE)[keyof typeof INDEX_EVIDENCE];

/** Membership list, in declaration order. */
export const INDEX_EVIDENCE_STATES: ReadonlyArray<IndexEvidenceState> = Object.freeze(
  Object.values(INDEX_EVIDENCE),
);

/** The parameter is `unknown`: the value arrives as an untyped payload. */
export function isIndexEvidenceState(value: unknown): value is IndexEvidenceState {
  return (
    typeof value === "string" && (INDEX_EVIDENCE_STATES as ReadonlyArray<string>).includes(value)
  );
}

// ----- What a write did about a detached refresh -----------------------------

/**
 * What a write did about a detached refresh of the derived index.
 *
 * Two tokens, and the difference between them is the honesty claim. A
 * write that CLAIMED a refresh has started the same claim-guarded
 * detached run the freshen-on-read path starts, and that run - not this
 * call - will bring the index around. `not_claimed` covers every case
 * where nothing was started; WHY nothing was started travels beside it
 * as {@link PostWriteRefreshClaim.refreshReason}, so a deliberate
 * config-off is never indistinguishable from a broken spawn. In every
 * refusal case the index evidence's next command remains the way the
 * index actually gets reconciled, which is exactly why the claim must
 * never read as a guarantee.
 */
export const INDEX_REFRESH = Object.freeze({
  /** A detached refresh run was started for this write and holds the freshen claim. */
  claimed: "claimed",
  /** No refresh was started; the reason is on `refresh_reason` beside this token. */
  notClaimed: "not_claimed",
} as const);

/** Closed union over {@link INDEX_REFRESH}. */
export type IndexRefresh = (typeof INDEX_REFRESH)[keyof typeof INDEX_REFRESH];

/** Membership list, in declaration order. */
export const INDEX_REFRESHES: ReadonlyArray<IndexRefresh> = Object.freeze(
  Object.values(INDEX_REFRESH),
);

/** The parameter is `unknown`: the value arrives as an untyped payload. */
export function isIndexRefresh(value: unknown): value is IndexRefresh {
  return typeof value === "string" && (INDEX_REFRESHES as ReadonlyArray<string>).includes(value);
}

/** What the derived index knows, and how old that knowledge is. */
export interface IndexEvidence {
  readonly state: IndexEvidenceState;
  /**
   * ISO instant of the index's last pass; `null` unless the index
   * reported one, which is the `stale` and `unchanged` states.
   */
  readonly lastIndexedAt: string | null;
  /** The registered command that makes the index agree with the vault again. */
  readonly nextCommand: string;
}

/**
 * The command that reconciles the derived index with the vault. Resolved
 * from the diagnostics registry rather than written here, so the string
 * an operator is handed is the same one every other index advisory names,
 * and a registry rename fails at import instead of inside the advisory it
 * was meant to explain.
 */
const REINDEX_COMMAND = requireNextStep(SEARCH_INDEX_MISSING_CODE).nextCommand;

/**
 * Read the derived index's freshness. Never throws: this is evidence
 * ABOUT the operation, and an unreadable index must not fail a write
 * that already succeeded - it must be reported as unreadable, which is a
 * different answer from "no stale references exist".
 *
 * `wrote` is what separates {@link INDEX_EVIDENCE.stale} from
 * {@link INDEX_EVIDENCE.unchanged}: the staleness claim is about what
 * THIS call did to the vault, so a plan-only run - which moved nothing
 * and rewrote nothing - cannot have aged an index and must not say it
 * did. The other two states are facts about the index file itself and
 * read the same either way.
 */
export async function readIndexEvidence(
  vault: string,
  wrote: boolean,
  configPath?: string,
): Promise<IndexEvidence> {
  try {
    const { resolveSearchConfig } = await import("../../search/index.ts");
    const { LAST_INDEXED_AT_STATE_KEY, Store } = await import("../../search/store.ts");
    const config = resolveSearchConfig({
      vault,
      ...(configPath !== undefined ? { configPath } : {}),
    });
    if (!existsSync(config.dbPath)) {
      return Object.freeze({
        state: INDEX_EVIDENCE.absent,
        lastIndexedAt: null,
        nextCommand: REINDEX_COMMAND,
      });
    }
    const store = await Store.open(config, { mode: "read" });
    try {
      const last = store.getState(LAST_INDEXED_AT_STATE_KEY);
      if (last === null) {
        return Object.freeze({
          state: INDEX_EVIDENCE.unreadable,
          lastIndexedAt: null,
          nextCommand: REINDEX_COMMAND,
        });
      }
      return Object.freeze({
        state: wrote ? INDEX_EVIDENCE.stale : INDEX_EVIDENCE.unchanged,
        lastIndexedAt: last,
        nextCommand: REINDEX_COMMAND,
      });
    } finally {
      await store.close();
    }
  } catch {
    return Object.freeze({
      state: INDEX_EVIDENCE.unreadable,
      lastIndexedAt: null,
      nextCommand: REINDEX_COMMAND,
    });
  }
}

/** What a write's refresh claim did, and - refused - why. */
export interface PostWriteRefreshClaim {
  /** `claimed` says a run is IN FLIGHT, never that it has landed. */
  readonly refresh: IndexRefresh;
  /**
   * Why nothing was started: the freshen machinery's own skip token
   * (`off`, `backoff`, `writer_lock`, `claimed`, `no_index`,
   * `spawn_failed`), or the message of an error it raised. `null` when a
   * run was started, and when no claim was attempted at all (a plan-only
   * run refused nothing). Read from THIS call's own decision object -
   * never from state another call or another vault could have written.
   */
  readonly refreshReason: string | null;
}

/** The claim-shaped answer for an index this call did not age or cannot refresh. */
const NO_INDEX_CLAIM: PostWriteRefreshClaim = Object.freeze({
  refresh: INDEX_REFRESH.notClaimed,
  // The machinery's own token for an index with nothing to refresh: an
  // absent index and an unreadable one both hold no stamp to force past,
  // and both are already on the report with the command that rebuilds
  // or reconciles them.
  refreshReason: "no_index",
});

/**
 * Try to claim one detached refresh of the derived index on behalf of a
 * write that just happened - the freshen-on-read machinery, forced past
 * the freshness gate because the stamp is now older than the vault it
 * describes. The claim protocol is the reader path's, verbatim: the
 * same claim file, so a lifecycle refresh and a reader-triggered
 * freshen exclude each other, and a second write that arrives while the
 * first run still holds the claim starts nothing.
 *
 * Everything that can refuse is allowed to, and every refusal and every
 * failure lands on {@link INDEX_REFRESH.notClaimed} with ITS REASON on
 * {@link PostWriteRefreshClaim.refreshReason}: the write already
 * happened, the refresh is best-effort by design, and the report's next
 * command reconciles the index whatever became of the spawn. `spawn` is
 * the injected test seam; absent, the child is the real detached run.
 * `now` is the caller's injected clock: passed through as the decision's
 * `nowMs`, so the freshness and backoff judgements are made on the same
 * instant the rest of the run is reproducible against. `configPath` is
 * the config file the CALLER resolved its own world through - the CLI's
 * `--config`, the MCP server's config path - so the claim reads the same
 * index and spawns the child with the same freshen settings the rest of
 * the invocation used; absent, the config resolves from the environment
 * alone, exactly as a caller that passed no config path resolves
 * everything else. There is no
 * freshness floor against the write's own instant: the index stamp marks
 * when a run FINISHED, and a run that finished after the write began may
 * have scanned before the write landed, so a stamp cannot prove the
 * index has seen the write - a floor built on it would silently drop the
 * one refresh the write needs. Back-to-back applied writes spawn one run
 * each; the claim machinery itself - exclusivity, backoff, the
 * writer-lock probe - caps them.
 */
export async function claimPostWriteRefresh(
  vault: string,
  index: IndexEvidence,
  spawn?: (argv: string[]) => void,
  now?: Date,
  configPath?: string,
): Promise<PostWriteRefreshClaim> {
  // Stale is the only state that describes an index this call aged. An
  // absent index holds nothing to refresh, an unreadable one has no
  // stamp to force past, and both are already on the report with the
  // command that rebuilds or reconciles them.
  if (index.state !== INDEX_EVIDENCE.stale) return NO_INDEX_CLAIM;
  try {
    const { resolveSearchConfig } = await import("../../search/index.ts");
    const { FRESHEN_SKIP, markFreshenPending, maybeFreshenIndex } =
      await import("../../search/freshen.ts");
    const config = resolveSearchConfig({
      vault,
      ...(configPath !== undefined ? { configPath } : {}),
    });
    const decision = maybeFreshenIndex(config, {
      lastIndexedAt: index.lastIndexedAt,
      force: true,
      ...(spawn !== undefined ? { spawn } : {}),
      ...(now !== undefined ? { nowMs: now.getTime() } : {}),
    });
    if (decision !== "spawned") {
      // A refusal is a stated reason, not a thrown one: the freshen
      // machinery answers with a skip token - `spawn_failed` among them
      // - so the throwing arm below never ran for a spawn that failed
      // inside it. Every refusal now names itself on the result that
      // carries it, so `not_claimed` is never the whole answer.
      //
      // `claimed` and `writer_lock` are the two refusals that are a
      // QUEUE, not a dead end: a run is in flight either way.
      // `claimed` is the freshen claim held while the child runs - its
      // fresh stamp would otherwise suppress freshen-on-read for a whole
      // interval. `writer_lock` is the SAME run while it holds the index
      // writer lock - the bulk of its pass - where the lock probe
      // answers before the claim is ever consulted; a write that took
      // the lock's answer home unmarked would be exactly the mid-refresh
      // drop the marker exists to prevent. (A lock held by a NON-freshen
      // writer - a manual index - leaves the marker for the next freshen
      // child, whose scan start is later than the marker's instant, so
      // its settle drops it as covered.) The marker beside the freshen
      // state says a write is pending since this instant; the child
      // compares it with its scan start before releasing the claim and
      // runs one bounded extra pass when it is newer. Every other
      // refusal has no run to inform, and an off config has a run to NOT
      // inform - neither marks.
      if (decision === FRESHEN_SKIP.claimed || decision === FRESHEN_SKIP.writerLock) {
        markFreshenPending(dirname(config.dbPath), now?.getTime() ?? Date.now());
      }
      return Object.freeze({
        refresh: INDEX_REFRESH.notClaimed,
        refreshReason: decision,
      });
    }
    return Object.freeze({ refresh: INDEX_REFRESH.claimed, refreshReason: null });
  } catch (err) {
    // The token stays `not_claimed` - the report's vocabulary does not
    // grow a third member for a branch nothing can act on - but the
    // failure is no longer swallowed whole: the message lands on the
    // result, so a broken freshen path can be named by the report that
    // hit it.
    return Object.freeze({
      refresh: INDEX_REFRESH.notClaimed,
      refreshReason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The whole claim for a write path that does not already hold index
 * evidence: read it, then claim. Note creation and content edits land
 * here - the claim needs the same stale-gate and stamp input the
 * lifecycle's own writes assemble, and one read is the difference
 * between every write surface reporting the same refusal reason and each
 * guessing its own.
 */
export async function claimNoteWriteRefresh(
  vault: string,
  spawn?: (argv: string[]) => void,
  now?: Date,
  configPath?: string,
): Promise<PostWriteRefreshClaim> {
  const index = await readIndexEvidence(vault, true, configPath);
  return claimPostWriteRefresh(vault, index, spawn, now, configPath);
}

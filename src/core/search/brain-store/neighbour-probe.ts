/**
 * The neighbour probe (task 4.3, design D20 item 6): the change probe the
 * neighbour-updates lane asks before a turn, answered from the index.
 *
 * Unlike {@link brainChanges} it never pages over every record: it asks
 * the index for the candidate rows only (one stream, the neighbour kinds)
 * after the watermark and up to the head, so
 * its limit applies to candidates and a turn that follows a large import
 * of other records still sees the update on its topic. This device and
 * agent's rows are candidates too: another session of the same agent
 * name is a neighbour, and the hook drops the session's own records by
 * their session stamp (`agent-context/session-identity.ts`). What the limit
 * leaves out is counted. It also answers this device and agent's newest
 * own records, from which the hook seeds the session's topics, so an own
 * record older than any page still counts.
 *
 * Without a usable watermark (the first prompt, a state that expired, an
 * index rebuilt since) it answers the head and no candidates: the reader
 * starts in the present instead of replaying history.
 */

import { openReadOrSelfHeal } from "../pipeline/store-open.ts";
import {
  headSeq,
  neighbourRecords,
  ownRecordsTail,
  type StoredRecord,
} from "../store/brain-records.ts";
import type { ResolvedSearchConfig } from "../types.ts";
import { parseWatermark } from "./changes.ts";
import { catchUpBrainStore } from "./catch-up.ts";
import { STORE_INDEX_GENERATION_KEY } from "./constants.ts";

export interface NeighbourProbe {
  /** The head watermark: the next probe's `since`. */
  readonly watermark: string;
  /** Start at the head and report nothing (no usable `since`). */
  readonly reseed: boolean;
  /** The newest candidate rows after `since`, oldest first. */
  readonly candidates: ReadonlyArray<StoredRecord>;
  /** Candidate rows after `since` the limit left out (the oldest ones). */
  readonly skipped: number;
  /** This device and agent's newest own records, newest first. */
  readonly own: ReadonlyArray<StoredRecord>;
}

export interface NeighbourProbeOptions {
  readonly since: string | undefined;
  readonly self: { readonly device: string; readonly agent: string };
  readonly stream: string;
  readonly kinds: ReadonlyArray<string>;
  /** Most candidate rows answered. */
  readonly limit: number;
  /** Most own records answered. */
  readonly ownLimit: number;
}

/** The probe; null without a brain store or an index generation. */
export async function probeNeighbours(
  config: ResolvedSearchConfig,
  opts: NeighbourProbeOptions,
): Promise<NeighbourProbe | null> {
  if (config.brainStore === null || config.brainStore === undefined) return null;
  const since = opts.since === undefined ? null : parseWatermark(opts.since);
  const caught = await catchUpBrainStore(config);
  const index = await openReadOrSelfHeal(config);
  try {
    if (caught.skipped === "no-index" || caught.skipped === "not-current") {
      await catchUpBrainStore(config, { force: true });
    }
    const db = index.brainRecordsConnection();
    const generation = index.getState(STORE_INDEX_GENERATION_KEY);
    if (generation === null) return null;
    // The head first: every row read below is at or under it, so a
    // record committed during this read is reported by the next probe.
    const head = headSeq(db);
    const watermark = `${generation}.${head}`;
    const own = ownRecordsTail(db, opts.self, head, opts.ownLimit);
    if (since === null || since.generation !== generation) {
      return { watermark, reseed: true, candidates: [], skipped: 0, own };
    }
    const { rows, skipped } = neighbourRecords(
      db,
      {
        after: since.seq,
        upTo: head,
        stream: opts.stream,
        kinds: opts.kinds,
      },
      opts.limit,
    );
    // An empty store answers sequence 0; never step back below `since`.
    const kept = head < since.seq ? opts.since! : watermark;
    return { watermark: kept, reseed: false, candidates: rows, skipped, own };
  } finally {
    await index.close();
  }
}

/**
 * `o2b view recover <page>` (design D7 "No silent loss"): the versions of
 * a view page the writer replaced or ingested during the last 30 days
 * (human edits, racing edits, conflict copies, foreign files), newest
 * first, each with the text kept in its blob. Read-only; any machine that
 * holds the partition a version landed in can list it.
 */

import { DAY_MS } from "../store/constants.ts";
import { parseHlc } from "../store/hlc.ts";
import type { StoreHandle } from "../store/store-open.ts";
import type { StorePartition } from "../store/constants.ts";
import { catchUp } from "./catch-up.ts";
import { VIEW_RECOVER_DAYS } from "./constants.ts";
import { loadReplaced, replacedVersions } from "./view-records.ts";

export interface RecoveredVersion {
  readonly id: string;
  /** When the version was kept, ISO-8601. */
  readonly at: string;
  readonly device: string;
  readonly partition: StorePartition;
  readonly reason: string;
  readonly bytes: number;
  /** The text, or `null` while its blob has not synced to this machine. */
  readonly text: string | null;
}

/** Replaced versions of `page` from the last {@link VIEW_RECOVER_DAYS} days, newest first. */
export function listReplacedVersions(
  store: StoreHandle,
  page: string,
  now: () => number = Date.now,
): RecoveredVersion[] {
  const since = now() - VIEW_RECOVER_DAYS * DAY_MS;
  return (
    replacedVersions(catchUp(store, now), page)
      // A foreign or malformed record is not listed, never as "undefined" or NaN.
      .filter(
        (v) =>
          typeof v.record.body["reason"] === "string" &&
          typeof v.record.body["bytes"] === "number" &&
          Number.isFinite(v.record.body["bytes"]),
      )
      .filter((v) => parseHlc(v.record.hlc)!.physical >= since)
      .toReversed()
      .map((v) => ({
        id: v.record.id,
        at: new Date(parseHlc(v.record.hlc)!.physical).toISOString(),
        device: v.record.device,
        partition: v.partition,
        reason: v.record.body["reason"] as string,
        bytes: v.record.body["bytes"] as number,
        text: loadReplaced(store, v),
      }))
  );
}

/**
 * The records a topic holds, as its view page lists them (spec `topics`
 * "Topic page"): the held notes and signals, each with its text, its kind
 * and the time it happened (a migrated record's original time), read from
 * the records the view pass already holds. Nothing is read from disk here.
 *
 * The page is shared, so a record is listed only when nothing of it is
 * private: a note or signal capture in `shared` without a `<private>`
 * region, and for a signal, no record of its history in another partition
 * or with private frontmatter. A signal a removal voided, or whose
 * lifecycle ends `rejected`, is forgotten and not listed. While a signal
 * record of any partition has a body that has not arrived (or the read
 * did not count such records), no held signal is listed: the record names
 * its signal in the body, so any signal's privacy or lifecycle may hang
 * on it. Every held capture of a listed signal is listed. A record the
 * history verdict judged not human-readable (`keep: false`) is marked
 * `hidden`: the page counts it with the records it could not fit. Held
 * decision events are not listed: the page shows them as
 * decision items (`topics/held-decisions.ts`).
 */

import { isPrivateFrontmatter } from "../store/private-page.ts";
import { LOG_EVENT_KIND, SIGNAL_KIND, type StorePartition } from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { foldSignals, SIGNAL_REMOVED_KIND, SIGNAL_STATE_KIND } from "../store/fold-signals.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import { topicCandidates } from "../topics/candidates.ts";
import type { TopicFold } from "../topics/fold.ts";
import type { ViewCatchUp } from "./catch-up.ts";

/** One held record a topic page lists. */
export interface ViewHeldRecord {
  readonly id: string;
  /** `rule`: a signal; `note`: a note. */
  readonly kind: "rule" | "note";
  readonly text: string;
  /** When it happened, in ms. */
  readonly at: number;
  /** The history verdict judged it not human-readable: counted, not listed. */
  readonly hidden: boolean;
}

const HISTORY_VERDICT_KIND = "history-verdict";
const NOTE_EVENT = "note";

function frontmatterOf(record: StoreRecord): Readonly<Record<string, unknown>> {
  const value = record.body["frontmatter"];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Whether the read holds every signal record of every partition: none was
 * left out because its body has not arrived. A read that did not count
 * such records is taken as missing one.
 */
function signalHistoryComplete(read: ViewCatchUp): boolean {
  if (read.pendingKinds === undefined) return false;
  for (const kinds of read.pendingKinds.values()) {
    for (const kind of [SIGNAL_KIND, SIGNAL_STATE_KIND, SIGNAL_REMOVED_KIND]) {
      if ((kinds.get(kind) ?? 0) > 0) return false;
    }
  }
  return true;
}

/** The held notes and signals of `fold` the shared page may list, by record id. */
export function viewHeldRecords(
  read: ViewCatchUp,
  fold: TopicFold,
): ReadonlyMap<string, ViewHeldRecord> {
  const held = new Set<string>();
  for (const [record, topic] of fold.assignments) if (topic !== null) held.add(record);
  const out = new Map<string, ViewHeldRecord>();
  if (held.size === 0) return out;

  const partitionOf = new Map<string, StorePartition>();
  const signalRecords: StoreRecord[] = [];
  const hiddenOrInputs: StoreRecord[] = [];
  for (const [partition, records] of read.records) {
    for (const record of records) {
      if (
        record.kind === SIGNAL_KIND ||
        record.kind === SIGNAL_STATE_KIND ||
        record.kind === SIGNAL_REMOVED_KIND
      ) {
        partitionOf.set(record.id, partition);
        signalRecords.push(record);
      }
      if (partition !== "shared") continue;
      if (record.kind === HISTORY_VERDICT_KIND && held.has(String(record.body["record"]))) {
        hiddenOrInputs.push(record);
      } else if (
        held.has(record.id) &&
        record.kind === LOG_EVENT_KIND &&
        record.body["event_type"] === NOTE_EVENT
      ) {
        hiddenOrInputs.push(record);
      }
    }
  }

  // Signals: the lifecycle of every partition decides, failing closed on privacy.
  const signals = signalHistoryComplete(read)
    ? [...foldSignals(signalRecords).signals.values()]
    : [];
  for (const entity of signals) {
    const captures = entity.history.filter((r) => r.kind === SIGNAL_KIND && held.has(r.id));
    if (captures.length === 0 || entity.state === "rejected") continue;
    const isPrivate =
      entity.history.some(
        (r) =>
          partitionOf.get(r.id) !== "shared" ||
          valueCarriesPrivateRegion(r.body) ||
          isPrivateFrontmatter(frontmatterOf(r)),
      ) || isPrivateFrontmatter(entity.frontmatter as Record<string, unknown>);
    if (!isPrivate) hiddenOrInputs.push(...captures);
  }

  for (const candidate of topicCandidates(hiddenOrInputs, new Set())) {
    if (candidate.private || !held.has(candidate.id)) continue;
    if (candidate.kind !== "signal" && candidate.kind !== NOTE_EVENT) continue;
    out.set(candidate.id, {
      id: candidate.id,
      kind: candidate.kind === "signal" ? "rule" : "note",
      text: candidate.text,
      at: candidate.at,
      hidden: candidate.hidden === true,
    });
  }
  return out;
}

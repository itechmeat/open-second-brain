/**
 * The doctor finding for review obligations written before the reach rule
 * (change `lane-reach-residuals`, design R10): an earlier release wrote a
 * decision's review obligation in `shared` whatever the decision's
 * partition, so a review obligation of a decision now held in `private`
 * stays in `shared`, with the decision's title in its own title, and
 * every peer holding `shared` keeps it. Nothing migrates it. At local
 * reach the finding counts such obligations, names them and says how a
 * local caller moves them: a completion or a plain re-add keeps the
 * obligation in `shared`; removing it and adding it again with its notes
 * in a private region writes it in `private`. Below local reach it counts
 * none and names nothing: which decisions are held in `private` is not
 * the caller's to learn. Which decision pages are private is the verdict
 * of the owner of decision titles (`topics/decision-titles.ts`) over
 * every version of every page, so a read that may miss a version names
 * none. Read-only.
 */

import { BRAIN_ROOT_REL } from "../path-constants.ts";
import type { StorePartition } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { brainRelOfEntry } from "../../store/lane-paths.ts";
import { wholeLaneStoreFold } from "../../store/lane-fold-cache.ts";
import { configuredStore } from "../../store/read/store-entities.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import type { StoreInspection } from "../../store/store-open.ts";
import {
  isDecisionPageInput,
  pageReadComplete,
  privateDecisionTitlesOf,
} from "../../topics/decision-titles.ts";
import { withholdsPrivate } from "./store-check.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";
import { REVIEW_OBLIGATION_SHARED_CODE } from "./review-obligation-exit.ts";

/** The title a decision's review obligation stores (`decisions/record.ts`). */
const REVIEW_TITLE_PREFIX = "Review decision:";

const OBLIGATIONS_LANE = "obligations";

/** How many obligations the message names. */
const NAMED = 5;

/**
 * The titles of the decision pages of `store` whose winning version is
 * private, read through the owner of decision titles
 * (`topics/decision-titles.ts`): every page version of every partition,
 * none when that read may miss one.
 */
function privateDecisionTitles(store: StoreInspection): ReadonlySet<string> {
  const records: StoreRecord[] = [];
  const privateIds = new Set<string>();
  let unreadable = 0;
  const pending: Array<[string, number]> = [];
  for (const partition of [...store.partitions] as StorePartition[]) {
    const read = readStreamRecords(
      store.root,
      partition,
      { stream: "events" },
      { keep: isDecisionPageInput },
    );
    unreadable += read.unreadable.length;
    pending.push(...read.pendingKinds);
    for (const record of read.records) {
      records.push(record);
      if (partition === "private") privateIds.add(record.id);
    }
  }
  return privateDecisionTitlesOf({
    records,
    privateIds,
    complete: pageReadComplete(unreadable, pending),
  });
}

export const reviewObligationSharedCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    if (withholdsPrivate(ctx)) return;
    // The shared review obligations first, from the cached lane fold: with
    // none, the decision pages are not read at all.
    const fold = wholeLaneStoreFold(ctx.configPath);
    const readable = ctx.readable;
    const candidates: Array<{ readonly title: string; readonly name: string }> = [];
    for (const [key, value] of fold.entries) {
      if (value.lane !== OBLIGATIONS_LANE || fold.privateKeys.has(key)) continue;
      const title = value.fields["title"];
      if (typeof title !== "string" || !title.startsWith(REVIEW_TITLE_PREFIX)) continue;
      const rel = `${BRAIN_ROOT_REL}/${brainRelOfEntry(value.lane, value.entry)}`;
      if (readable !== undefined && !readable(rel)) continue;
      candidates.push({ title, name: value.entry.replace(/\.md$/u, "") });
    }
    if (candidates.length === 0) return;
    const store = configuredStore(ctx.configPath);
    if (store === null) return;
    const reviewTitles = new Set(
      [...privateDecisionTitles(store)].map((title) => `${REVIEW_TITLE_PREFIX} ${title}`),
    );
    const held = candidates.filter((c) => reviewTitles.has(c.title)).map((c) => c.name);
    if (held.length === 0) return;
    const sorted = held.toSorted();
    const named = sorted.slice(0, NAMED).join(", ");
    const more = sorted.length > NAMED ? `, and ${sorted.length - NAMED} more` : "";
    out.issues.push({
      severity: "warning",
      code: REVIEW_OBLIGATION_SHARED_CODE,
      path: store.root,
      message:
        `${sorted.length} review obligation(s) an earlier release wrote in the shared partition ` +
        `are for a decision now held in the private partition, so every machine holding the ` +
        `shared partition keeps the decision's title: ${named}${more}. Marking one done or ` +
        `adding it again as it is keeps it shared; to move one (its completion history starts ` +
        `anew), remove it ` +
        "(`brain_obligation` operation `remove`) and add it again locally with its notes in a " +
        "private region (operation `add`, notes `<private>...</private>`)",
    });
  },
};

/**
 * The skill-accept markers a recovery below local reach may act on
 * (change `lane-reach-residuals`, design R4).
 *
 * An accept marker is device-local machine state a crashed accept left
 * behind. One that cannot be parsed names no phase and no proposal the
 * caller could be judged against, so the caller cannot tell whether it
 * marks a sequence over an entry held in `private`; its path names the
 * proposal's slug. Below local reach the recovery therefore neither
 * discards nor names such a marker: it leaves it, silently, for a local
 * caller, and resolves the readable markers as before (each judged by
 * `journalWithheldAtReach` in `skill-proposals.ts`). The answer carries no
 * count of the markers left, since a count would say that they exist. A
 * local caller recovers and discards as before.
 */

import { privateWithheld } from "../store/caller-reach.ts";
import {
  listSkillAcceptJournals,
  readSkillAcceptJournals,
  type SkillAcceptJournalEntry,
} from "./skill-accept-journal.ts";

/**
 * The markers a recovery resolves: below local reach the readable ones,
 * an unreadable marker left unread and unnamed; at local reach every
 * marker, refusing by name on the first unreadable one, as before.
 */
export function recoverableAcceptJournals(vault: string): ReadonlyArray<SkillAcceptJournalEntry> {
  if (!privateWithheld()) return listSkillAcceptJournals(vault);
  return readSkillAcceptJournals(vault).entries;
}

/**
 * The paths of the unreadable markers a discard removes: none below local
 * reach, every unreadable marker at local reach.
 */
export function discardableAcceptJournalPaths(vault: string): ReadonlyArray<string> {
  if (privateWithheld()) return [];
  return readSkillAcceptJournals(vault).unreadable.map((entry) => entry.path);
}

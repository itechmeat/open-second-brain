/**
 * The partition a skill-proposal learn writes its rows to (moved out of
 * `skill-proposals.ts` by change `lane-reach-residuals`, package 16,
 * design R14; the rule itself is 2.0.4's).
 *
 * A learn reads continuity records and appends a verifier-rejection row
 * per rejected candidate. A row goes to `private` only when the turns it
 * was drawn from are flagged private, or when it names a private or
 * unjudgeable page, in the row or in those turns. The same rule, per
 * record, judges each continuity record the learn read.
 */

import type { ContinuityRecord } from "./continuity/store.ts";
import {
  type RowPrivacyJudge,
  rowNamesPrivatePage,
  rowPrivacyJudge,
} from "../store/reference-privacy.ts";
import { withPrivateShown } from "../store/caller-reach.ts";

/**
 * Whether a verifier-rejection row goes to `private` only: a row whose
 * turns are flagged private, or that names a private or unjudgeable page
 * (in the row or in those turns).
 */
export function verifierRejectionIsPrivate(
  vault: string,
  entry: { id: string; name_key: string; reason: string; at: string },
  sources: ReadonlyArray<ContinuityRecord>,
): boolean {
  return (
    sources.some((record) => record.private === true) ||
    rowNamesPrivatePage(vault, [entry, sources])
  );
}

/**
 * Whether one continuity record the learn read goes to `private`: flagged
 * private, or naming a private or unjudgeable page, judged on the whole
 * fold wherever it is called. The per-record form of the rule a verifier
 * rejection's turns are judged by ({@link verifierRejectionIsPrivate}),
 * and the store's own partition rule for a continuity row. One judge per
 * learn, made on first use, so a reference many records carry is judged
 * once.
 */
export function continuityPrivacyJudge(vault: string): (record: ContinuityRecord) => boolean {
  let judge: RowPrivacyJudge | undefined;
  return (record) =>
    record.private === true || withPrivateShown(() => (judge ??= rowPrivacyJudge(vault))(record));
}

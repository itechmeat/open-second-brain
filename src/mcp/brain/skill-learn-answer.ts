/**
 * `brain_skill_proposals learn` below local reach (change
 * `lane-private-partition-reach`, the write rule).
 *
 * Learning is maintenance of the machine's own proposals: it dedups each
 * candidate against the pending, accepted and rejected proposals and moves
 * a device-local watermark. Decided from a fold that cannot show a
 * `private` proposal, a name a person rejected or accepted in `private`
 * would be drafted again and the watermark would pass the evidence for
 * good. So the learn runs on the fold of every partition, whatever the
 * caller's reach, exactly as a local learn does, and only the answer is
 * narrowed here: an id stays in it only when no page of its proposal is
 * withheld from the caller, and a suppressed id only when a page of its
 * own slug is shown to the caller (a suppression by a proposal of another
 * slug names nothing the caller can see). A verifier rejection is judged
 * where the learn knows its sources: its id stays only when its ledger
 * row goes to `shared`. The scan figures (`scanned`, `watermarkFrom`,
 * `watermarkTo`) are taken over the continuity records the caller may
 * read, so the count and the time of a `private` record are not told.
 */

import { withPrivateShown, privateWithheld } from "../../core/store/caller-reach.ts";
import {
  skillProposalAcceptedPath,
  skillProposalPendingPath,
  skillProposalRejectedPath,
} from "../../core/brain/paths.ts";
import {
  learnSkillProposals,
  type SkillProposalLearnOptions,
  type SkillProposalLearnResult,
} from "../../core/brain/skill-proposals.ts";
import type { ContinuityRecord } from "../../core/brain/continuity/types.ts";
import { laneEntryInPrivate, lanePageExists } from "../../core/store/lane-pages.ts";

/** The pages of the proposal an id names, or null for an id of another shape. */
function pagesOf(vault: string, id: string): string[] | null {
  if (!id.startsWith("prop-") || id.length === "prop-".length) return null;
  const slug = id.slice("prop-".length);
  return [
    skillProposalPendingPath(vault, slug),
    skillProposalAcceptedPath(vault, slug),
    skillProposalRejectedPath(vault, slug),
  ];
}

/** What the learn read and scanned, and its privacy verdict, as its `onScanned` tells it. */
interface LearnScan {
  readonly records: ReadonlyArray<ContinuityRecord>;
  readonly scanned: ReadonlyArray<ContinuityRecord>;
  readonly isPrivate: (record: ContinuityRecord) => boolean;
}

/**
 * The learn of `vault`, run on the whole fold; its answer narrowed below
 * local reach. `configPath` selects the store the privacy checks read.
 */
export function learnAtReach(
  vault: string,
  opts: SkillProposalLearnOptions = {},
  configPath?: string,
): SkillProposalLearnResult {
  const narrow = privateWithheld();
  // The pages of a refused candidate do not exist, so its id is judged
  // where the learn holds its sources: a rejection whose ledger row goes
  // to `private` is left out of the answer.
  const privateRejections = new Set<string>();
  let scan: LearnScan | null = null;
  const result = withPrivateShown(() =>
    learnSkillProposals(
      vault,
      narrow
        ? {
            ...opts,
            onVerifierRejection: (rejection) => {
              if (rejection.private) privateRejections.add(rejection.id);
              opts.onVerifierRejection?.(rejection);
            },
            onScanned: (read) => {
              scan = read;
              opts.onScanned?.(read);
            },
          }
        : opts,
    ),
  );
  if (!narrow) return result;
  const withheld = (pages: ReadonlyArray<string>): boolean =>
    pages.some((path) => laneEntryInPrivate(vault, path, configPath));
  const kept = (ids: ReadonlyArray<string>, needShown: boolean): ReadonlyArray<string> =>
    Object.freeze(
      ids.filter((id) => {
        const pages = pagesOf(vault, id);
        if (pages === null || withheld(pages)) return false;
        return !needShown || pages.some((path) => lanePageExists(vault, path));
      }),
    );
  return {
    ...result,
    ...scanFiguresAtReach(scan),
    created: kept(result.created, false),
    merged: kept(result.merged, false),
    suppressed: kept(result.suppressed, true),
    verifierRejected: Object.freeze(
      result.verifierRejected.filter((id) => !privateRejections.has(id)),
    ),
  };
}

/**
 * `scanned`, `watermarkFrom` and `watermarkTo` over the continuity records
 * a caller below local reach may read: those of the learn's own read that
 * the learn itself does not judge `private` (flagged private, or naming a
 * private or unjudgeable page). The store is not read again. The start is
 * the newest such record the learn did not scan (at or before its
 * watermark), the end the newest such record it scanned, or the start when
 * it scanned none, as a local learn that scans nothing answers. With no
 * scan reported, nothing is told (fail closed).
 */
function scanFiguresAtReach(
  scan: LearnScan | null,
): Pick<SkillProposalLearnResult, "scanned" | "watermarkFrom" | "watermarkTo"> {
  if (scan === null) return { scanned: 0, watermarkFrom: null, watermarkTo: null };
  const shown = (record: ContinuityRecord): boolean => !scan.isPrivate(record);
  const scannedIds = new Set(scan.scanned.map((record) => record.id));
  const scanned = scan.scanned.filter(shown);
  // Newest first, so only the records down to the first shown one are judged.
  const watermarkFrom =
    scan.records
      .filter((record) => !scannedIds.has(record.id))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .find(shown)?.createdAt ?? null;
  return {
    scanned: scanned.length,
    watermarkFrom,
    watermarkTo: newest(scanned) ?? watermarkFrom,
  };
}

/** The `createdAt` of the newest of `records`, or null when there are none. */
function newest(records: ReadonlyArray<ContinuityRecord>): string | null {
  return records.reduce<string | null>(
    (latest, record) => (latest === null || record.createdAt > latest ? record.createdAt : latest),
    null,
  );
}

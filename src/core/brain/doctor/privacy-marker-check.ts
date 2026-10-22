/**
 * Informal privacy markers that are not formally stamped (write-honesty, F1).
 *
 * The read roots withhold a page saying `access: private`,
 * `confidentiality: secret` or `sensitivity: confidential` from a remote
 * caller (see `graph/privacy-markers.ts`), but the reservation lives in an
 * informal key. Nothing that reads `visibility:` - derived-page stamping,
 * an export filtering on the token, an operator auditing reservations -
 * can see it, and a page whose author believed it declared its audience
 * has a claim that only two of this tree's readers honour.
 *
 * This check is the discovery path for that gap: ONE warning carrying the
 * count and the paths, silent when there are none. The population is the
 * restamp's own candidate list ({@link planPrivacyMarkerRestamp}), so the
 * finding, its count, and the preview an operator then reads cannot drift
 * apart. A marker page already carrying `visibility: private` is not in
 * that population and does not appear here.
 *
 * A page the caller may not read is not named and does not move the count
 * (`ctx.readable`, the contract every other counting check follows): a
 * remote caller must not learn how many reserved pages exist.
 */

import { planPrivacyMarkerRestamp } from "../privacy-marker-restamp.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** Marker pages whose `visibility:` does not carry the reserved token. */
export const PRIVACY_MARKER_UNSTAMPED_CODE = "privacy-marker-unstamped";

/** How many paths one finding names before it counts the rest. */
const NAMED_PATH_LIMIT = 5;

export const privacyMarkerCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const candidates = planPrivacyMarkerRestamp(ctx.vault).candidates;
    const readable =
      ctx.readable === undefined
        ? candidates
        : candidates.filter((candidate) => ctx.readable!(candidate.path));
    if (readable.length === 0) return;

    const named = readable.slice(0, NAMED_PATH_LIMIT).map((candidate) => candidate.path);
    const unreadableRemainder = readable.length - named.length;
    const remainder = unreadableRemainder > 0 ? ` and ${unreadableRemainder} more` : "";
    out.issues.push({
      severity: "warning",
      code: PRIVACY_MARKER_UNSTAMPED_CODE,
      path: ctx.vault,
      message:
        `${readable.length} page(s) reserve themselves with an informal privacy marker ` +
        "(access / confidentiality / sensitivity) rather than a visibility: declaration: " +
        `${named.join(", ")}${remainder}. Remote reads are already denied, but tools that ` +
        "read visibility: cannot see the reservation. The preview-first restamp reports each " +
        "would-be visibility line and writes only on request, additively",
    } satisfies DoctorIssue);
  },
};

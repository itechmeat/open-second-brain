/**
 * The delivery-provenance doctor check (delivery-trust wave, lane A).
 *
 * Delivery fencing is fail-closed: a page whose provenance cannot be
 * derived is fenced at remote reads exactly like an agent-authored one.
 * The stamps that would prove otherwise already exist on every write
 * path, but nothing backfills them - both stamp modules forbid backfill
 * by design - so a legacy vault fences nearly everything on day one.
 * The design states the consequence plainly and refuses to let it be
 * silent: this check is the observable. ONE warning per pass naming how
 * many delivered pages carry no derivable provenance, with a capped
 * named-path list, silent when there is nothing to name.
 *
 * The population is the complement of {@link provenanceDerivable} over
 * the vault's page walk: pages whose delivery treatment resolves to
 * `fenced` for lack of evidence - no `origin_channel` (or only the
 * `unset` literal), no `content_class`, no `untrusted_source` marker.
 * A page a stamp WOULD fence (an agent channel, a prompt-derived class)
 * is not unknown provenance and does not appear: the check reports
 * absence of knowledge, not presence of a fence.
 *
 * Two exclusions, each deliberate:
 *
 *   - The pages the system itself renders at the Brain root - the two
 *     compiled digests (`Brain/active.md`, `Brain/lessons.md`) and the
 *     operating manual (`Brain/_BRAIN.md`) - carry the system's voice,
 *     not a record whose authorship went unstamped; counting them would
 *     warn on every vault forever.
 *   - A page the caller may not read is not named and does not move the
 *     count (`ctx.readable`, the contract every counting check follows):
 *     a remote caller must not learn how many reserved pages exist.
 */

import { listVaultPages } from "../../vault.ts";
import { vaultRelative } from "../../path-safety.ts";
import { MAINTENANCE_LANE_REACH } from "../../graph/transport-reach.ts";
import { brainRootSegments, BRAIN_MANUAL_FILE, isCompiledDigestRel } from "../path-constants.ts";
import { pageOriginFromMeta, provenanceDerivable } from "../provenance/page-origin.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** A delivered page's provenance is not derivable from any stamp. */
export const DELIVERY_PROVENANCE_UNKNOWN_CODE = "delivery-provenance-unknown";

/** How many paths one finding names before it counts the rest. */
export const DELIVERY_PROVENANCE_NAMED_PATH_LIMIT = 5;

/**
 * Whether `rel` names one of the pages the system itself renders at the
 * Brain root: the two compiled digests and the operating manual. Their
 * absence of authorship stamps is by design - the system's voice is not
 * a provenance question - and counting them would warn on every vault
 * forever. Asked with the same normalization the digest predicate uses,
 * so a case variant or dot segment cannot walk past it.
 */
function isSystemRenderedRel(rel: string): boolean {
  if (isCompiledDigestRel(rel)) return true;
  const tail = brainRootSegments(rel);
  return (
    tail !== null && tail.length === 1 && tail[0]!.toLowerCase() === BRAIN_MANUAL_FILE.toLowerCase()
  );
}

export const deliveryProvenanceCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    // The maintenance lane reads everything the filesystem offers - the
    // population is "what a delivery would shape", not one caller's view;
    // the caller's own view arrives as `ctx.readable` below.
    const unknown: string[] = [];
    for (const page of listVaultPages(ctx.vault, { reach: MAINTENANCE_LANE_REACH })) {
      const rel = vaultRelative(page.path, ctx.vault);
      if (isSystemRenderedRel(rel)) continue;
      if (provenanceDerivable(pageOriginFromMeta(page.metadata))) continue;
      unknown.push(rel);
    }

    const readable =
      ctx.readable === undefined ? unknown : unknown.filter((rel) => ctx.readable!(rel));
    if (readable.length === 0) return;
    readable.sort();

    const named = readable.slice(0, DELIVERY_PROVENANCE_NAMED_PATH_LIMIT);
    const remainder = readable.length - named.length;
    out.issues.push({
      severity: "warning",
      code: DELIVERY_PROVENANCE_UNKNOWN_CODE,
      path: ctx.vault,
      message:
        `${readable.length} delivered page(s) carry no derivable provenance - no ` +
        "origin_channel stamp, no content_class, no untrusted_source marker: " +
        `${named.join(", ")}` +
        (remainder > 0 ? ` and ${remainder} more` : "") +
        ". Remote reads fence these pages as unverified until each carries a " +
        "stamp; every write path stamps going forward, so a page re-written " +
        "through any entry point resolves its own treatment",
    } satisfies DoctorIssue);
  },
};

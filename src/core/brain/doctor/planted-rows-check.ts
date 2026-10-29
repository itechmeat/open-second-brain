/**
 * Planted structure rows in Brain pages (lane A,
 * trust-and-responsiveness-hardening, t_c2ac4fc8).
 *
 * The write-time neutralizer (`text/neutralize-markdown.ts`) keeps
 * caller text from planting wikilinks, `@osb` markers, ```osb fences and
 * ATX headings - under enforce mode, on the two seams it guards. It says
 * nothing about the vault's history or about the seams it does not
 * guard: every page captured or ingested before the gate existed, while
 * it is off, or written by a seam the gate does not cover (the
 * note-write tools), can carry rows the link graph, the marker scanners
 * and the section parsers treat as the vault's own structure. This check
 * is that audit: ONE warning carrying the count and the paths, silent
 * when there are none, read-only by contract.
 *
 * The population and the scan are the planner's
 * ({@link planPlantedRows}): the marker and osb-fence families scan
 * every readable page under `Brain/` (no Brain writer emits a live
 * marker line or osb fence, so one anywhere is planted), while the
 * wikilink and heading families stay keyed to the third-party
 * provenance lanes, whose structure the Brain's own writers render by
 * design elsewhere. On both populations the sections those writers
 * themselves render - a capture's marker-authorized `## Guidance`, a
 * source summary's `## Sources`/`## Premises`/link and derivation
 * sections - are excluded as the vault's own output, never reported.
 * The lane classification stays in the finding as
 * context: those pages are named first, and the message counts them. A
 * page the caller may not read is not named and does not move the count
 * (`ctx.readable`, the contract every other counting check follows), and
 * the same predicate rides into the planner so its staged-vs-published
 * dedupe can never drop a staged copy in favor of a twin this filter
 * would remove - that would leave the report with neither copy.
 *
 * Under the gate's `shadow` mode the finding says so: enforce would
 * escape exactly these rows on the next capture or untrusted ingest of
 * the same text, which is the preview an operator needs before turning
 * the mode on.
 */

import { planPlantedRows } from "../planted-rows.ts";
import {
  MARKDOWN_NEUTRALIZE_MODE,
  resolveMarkdownNeutralizeModeForProcess,
  type MarkdownNeutralizeMode,
} from "../text/neutralize-markdown.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** Pages carrying live structure-bearing markdown in third-party bodies. */
export const PLANTED_STRUCTURE_ROWS_CODE = "planted-structure-rows";

/** How many paths one finding names before it counts the rest. */
const NAMED_PATH_LIMIT = 5;

/**
 * The gate posture the finding's wording reflects. A misconfigured mode
 * value is refused loudly at every write seam; here it degrades to the
 * neutral wording rather than throwing - the doctor never throws.
 */
function gateModeForWording(): MarkdownNeutralizeMode {
  try {
    return resolveMarkdownNeutralizeModeForProcess();
  } catch {
    return MARKDOWN_NEUTRALIZE_MODE.off;
  }
}

export const plantedRowsCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    // The readability predicate rides into the planner: the staged-vs-
    // published dedupe must not drop a staged copy in favor of a
    // hash-equal twin this filter would remove, or both rows would
    // vanish from the report.
    const plan = planPlantedRows(ctx.vault, ctx.readable);
    const readable =
      ctx.readable === undefined ? plan.planted : plan.planted.filter((p) => ctx.readable!(p.path));
    if (readable.length === 0) return;

    // The third-party provenance lanes are named first: same rows, but
    // not equally expected, and the operator reads the paths top-down.
    const ordered = [...readable].toSorted((a, b) => {
      if (a.thirdParty !== b.thirdParty) return a.thirdParty ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    const rows = readable.reduce((sum, page) => sum + page.count, 0);
    const named = ordered.slice(0, NAMED_PATH_LIMIT).map((page) => page.path);
    const remainderCount = readable.length - named.length;
    const remainder = remainderCount > 0 ? ` and ${remainderCount} more` : "";
    const laneCount = readable.reduce((n, page) => n + (page.thirdParty ? 1 : 0), 0);
    const laneClause =
      laneCount > 0
        ? `; ${laneCount} of the page(s) sit in the third-party lanes (brain-capture captures, ` +
          "brain-source summaries, untrusted-stamped pages, quarantined entities) and are named first"
        : "";
    const shadow =
      gateModeForWording() === MARKDOWN_NEUTRALIZE_MODE.shadow
        ? " The markdown neutralization gate is in shadow mode: switching it to enforce would " +
          "escape exactly these rows on the next capture or untrusted ingest of the same text."
        : "";
    out.issues.push({
      severity: "warning",
      code: PLANTED_STRUCTURE_ROWS_CODE,
      path: ctx.vault,
      message:
        `${rows} live structure row(s) across ${readable.length} Brain page(s) ` +
        "(planted wikilinks, @osb markers, osb fences, ATX headings): " +
        `${named.join(", ")}${remainder}. The marker and osb-fence families are scanned on ` +
        "every readable page under Brain/ - no Brain writer emits a live marker line or an " +
        "osb fence, so one anywhere in the derived layer is planted. The wikilink and heading " +
        "families stay keyed to the third-party provenance lanes, where caller text lands; " +
        "the Brain's own writers render those shapes by design on other pages. Neither " +
        "population reports the sections those writers themselves render: a capture's " +
        "marker-authorized ## Guidance section and a source summary's ## Sources, " +
        "## Premises, ## Entities and ## Connections to existing notes citation sections, " +
        "plus its ## Parts and ## Table derivation headings, are this vault's own output" +
        laneClause +
        ". Nothing was changed by this check; the rows leave only by re-capturing the text " +
        "with the markdown neutralization gate in enforce mode, or by a later repair pass" +
        shadow,
    } satisfies DoctorIssue);
  },
};

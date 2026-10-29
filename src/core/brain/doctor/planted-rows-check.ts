/**
 * Planted structure rows in third-party-text pages (lane A,
 * trust-and-responsiveness-hardening, t_c2ac4fc8).
 *
 * The write-time neutralizer (`text/neutralize-markdown.ts`) keeps
 * caller text from planting wikilinks, `@osb` markers, ```osb fences and
 * ATX headings - under enforce mode, on new writes. It says nothing
 * about the vault's history: every page captured or ingested before the
 * gate existed, or while it is off, can carry rows the link graph, the
 * marker scanners and the section parsers treat as the vault's own
 * structure. This check is that audit: ONE warning carrying the count
 * and the paths, silent when there are none, read-only by contract.
 *
 * The population and the scan are the planner's
 * ({@link planPlantedRows}) - the same detection grammar the neutralizer
 * escapes with, so what this check reports is exactly what enforce mode
 * would have escaped. A page the caller may not read is not named and
 * does not move the count (`ctx.readable`, the contract every other
 * counting check follows).
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
    const plan = planPlantedRows(ctx.vault);
    const readable =
      ctx.readable === undefined ? plan.planted : plan.planted.filter((p) => ctx.readable!(p.path));
    if (readable.length === 0) return;

    const rows = readable.reduce((sum, page) => sum + page.count, 0);
    const named = readable.slice(0, NAMED_PATH_LIMIT).map((page) => page.path);
    const unreadableRemainder = readable.length - named.length;
    const remainder = unreadableRemainder > 0 ? ` and ${unreadableRemainder} more` : "";
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
        `${rows} live structure row(s) across ${readable.length} page(s) of third-party text ` +
        "(wikilinks, @osb markers, osb fences, ATX headings): " +
        `${named.join(", ")}${remainder}. These rows join the link graph, the marker scanners ` +
        "and the section parsers as the vault's own structure. Nothing was changed by this " +
        "check; the rows leave only by re-capturing the text with the markdown neutralization " +
        "gate in enforce mode, or by a later repair pass" +
        shadow,
    } satisfies DoctorIssue);
  },
};

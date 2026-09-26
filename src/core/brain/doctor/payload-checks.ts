/**
 * Payload-registry health (t_35440e83).
 *
 * Three conditions, all warnings - nothing here makes the vault wrong,
 * each makes it heavier or less recoverable than it should be:
 *
 *   - `payload-orphan`: a file under `Brain/.payloads/` that nothing in
 *     the vault references. Dead weight in every snapshot; the gc verb
 *     removes it behind a recovery point.
 *   - `payload-missing`: a ref some file holds whose payload file is
 *     gone. The placeholder still reads, but the exact content it stands
 *     for can no longer be paged back. Only a snapshot restore returns
 *     those bytes.
 *   - `continuity-row-oversized`: a continuity shard with rows far larger
 *     than any row the registry lets through - written before the
 *     registry existed, or by a writer that bypassed it. Recall scans
 *     them on every query.
 *
 * One finding per orphan / missing ref, capped so a vault with thousands
 * of them reports a count instead of flooding the report; one finding per
 * oversized SHARD, naming the row count and the worst row.
 *
 * Fail-soft: a payload scan that throws leaves the rest of the report
 * intact, because none of these conditions is structural.
 */

import { join } from "node:path";

import { BRAIN_SESSION_PAYLOAD_DEFAULTS, resolveSessionPayloadPolicy } from "../policy.ts";
import { buildPayloadInventory, findOversizedContinuityRows } from "../payload-inventory.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** A stored payload nothing references. */
export const PAYLOAD_ORPHAN_CODE = "payload-orphan";
/** A referenced payload whose file is gone. */
export const PAYLOAD_MISSING_CODE = "payload-missing";
/** A continuity shard holding rows larger than the registry allows. */
export const CONTINUITY_ROW_OVERSIZED_CODE = "continuity-row-oversized";

/** Per-code cap on individually reported findings. */
const MAX_FINDINGS_PER_CODE = 20;

/**
 * Headroom over twice the text bound before a row counts as oversized.
 * A row the registry wrote holds at most `max_text_chars` of text, which
 * JSON escaping can at worst double, plus an envelope of ids, lineage and
 * refs. A row past that was not bounded by the registry.
 */
const ROW_ENVELOPE_CHARS = 8_192;

export const payloadRegistryCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const inventory = buildPayloadInventory(ctx.vault);
    pushCapped(
      out,
      inventory.orphans.map((orphan): DoctorIssue => ({
        severity: "warning",
        code: PAYLOAD_ORPHAN_CODE,
        path: join(ctx.vault, orphan.path),
        message:
          `payload ${orphan.ref} (${orphan.bytes} bytes) is referenced by nothing in the ` +
          "vault; it is carried in every snapshot until it is collected",
      })),
      "unreferenced payloads",
    );
    pushCapped(
      out,
      inventory.missing.map((missing): DoctorIssue => {
        const first = missing.referrers[0];
        return {
          severity: "warning",
          code: PAYLOAD_MISSING_CODE,
          ...(first !== undefined ? { path: join(ctx.vault, first.path) } : {}),
          message:
            `payload ${missing.ref} is referenced by ${missing.referrers.length} ` +
            `place(s)${first !== undefined ? ` (first: ${first.path})` : ""} but its file ` +
            "is gone; the placeholder stays readable, the exact content does not",
        };
      }),
      "missing payloads",
    );

    const policy =
      ctx.config !== undefined
        ? resolveSessionPayloadPolicy(ctx.config)
        : BRAIN_SESSION_PAYLOAD_DEFAULTS;
    const bound = policy.max_text_chars * 2 + ROW_ENVELOPE_CHARS;
    for (const shard of findOversizedContinuityRows(ctx.vault, bound)) {
      out.issues.push({
        severity: "warning",
        code: CONTINUITY_ROW_OVERSIZED_CODE,
        path: join(ctx.vault, shard.path),
        message:
          `${shard.rows} continuity row(s) exceed ${bound} chars (largest ${shard.largestChars}); ` +
          "they were stored before the payload registry bounded session rows, and recall " +
          "scans them in full on every query",
      } satisfies DoctorIssue);
    }
  },
};

/**
 * Push at most {@link MAX_FINDINGS_PER_CODE} issues; the last one pushed
 * names how many more were not listed, so the count is never lost.
 */
function pushCapped(out: DoctorFindings, issues: ReadonlyArray<DoctorIssue>, noun: string): void {
  const rest = issues.length - MAX_FINDINGS_PER_CODE;
  const shown = issues.slice(0, MAX_FINDINGS_PER_CODE);
  shown.forEach((issue, index) => {
    const last = index === shown.length - 1 && rest > 0;
    out.issues.push(
      last ? { ...issue, message: `${issue.message} (and ${rest} more ${noun})` } : issue,
    );
  });
}

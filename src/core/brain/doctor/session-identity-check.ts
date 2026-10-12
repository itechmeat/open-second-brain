/**
 * Blank session identity, counted (t_22d58fa7).
 *
 * Writers across the continuity surface stamp `session_id`
 * conditionally - a lane with no session in scope writes the record with
 * the key absent - and the readers used to coerce that absence to the
 * empty string, manufacturing a phantom session no writer ever created
 * (the reader-side repair is `sessionIdOf` in `session-recall.ts`, built
 * on the orphan-session reading that a missing identity is a statement
 * that there was no session, never a pointer to a missing one). This
 * check is the vault-level mirror of that decision: one pass over the
 * continuity ledger, one issue per affected record kind carrying the
 * count of records that name no session - the key absent, a non-string
 * value, or the empty string.
 *
 * The census is scoped to the kinds whose writers stamp a session on
 * EVERY record they write (below). A record of one of those kinds that
 * names no session is a defect in the write that produced it. The rest
 * of the ledger is sessionless BY DESIGN and counts nothing: the
 * telemetry lanes run with no session in scope and stamp the key only
 * when one exists (`gate-telemetry.ts`, `recall-telemetry.ts`,
 * `observed-use.ts`, `recent-turns.ts`, `token-impact.ts`,
 * `context-pack-evidence.ts`, `context-pack-outcome.ts`,
 * `context-receipts.ts`), `appendContinuitySourceInvalidation` writes
 * only `{reason}`, and the remaining kinds correlate their session
 * outside the payload key entirely (source refs, `session_ref`,
 * `sample_id`). Warning on those would put a permanent finding on every
 * used vault, so they are excluded by name - the census over the
 * classification lives in `session-identity-check.test.ts`.
 *
 * The count is the whole finding. The check carries no `fix` and
 * rewrites nothing: a session no writer stamped cannot be restored from
 * the record, and assigning one would fabricate provenance over
 * append-only history - the repair such a rewrite would need is the
 * backup-gated posture the continuity repairs already require.
 *
 * Fail-soft: a ledger this module cannot read must cost the pass an
 * uncertainty, never a throw - and never a finding either, since a count
 * over a partial read would dress a gap in the store up as a measured
 * condition. An ABSENT ledger is the ordinary fresh-vault case and stays
 * quiet, the same absent/failed split every doctor sweep draws.
 */

import { continuityLogDir, listContinuityRecords } from "../continuity/store.ts";
import type { ContinuityRecord, ContinuityRecordKind } from "../continuity/types.ts";
import { sessionIdOf } from "../session-recall.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { reportSweptFailure, SWEEP_ORIGIN, type SweptPath } from "./unreadable-path.ts";

/** A continuity record names no session where the writers stamped one conditionally. */
export const SESSION_IDENTITY_CHECK_CODE = "blank-session-identity";

/** Subsystem name the check's sweeps report an unreadable path under. */
export const SESSION_IDENTITY_SITE = "brain.doctor.sessionIdentity";

/**
 * The kinds this census counts: the kinds whose writer carries a
 * session-scoped payload, stamping `session_id` unconditionally from a
 * REQUIRED input, so an unnamed session is a defect rather than a lane
 * running without one:
 *
 * - `session_turn` / `session_summary_node` - `session-recall.ts`
 *   (`importRawTurn` / `appendTurnRow` and the node builder; the session
 *   id is a required parameter and the payload key is unconditional).
 * - `session_summary_digest` - `session-summary.ts` (refuses a blank id
 *   before writing).
 * - `pre_compact_extract` - `pre-compact-extract.ts` (required
 *   `sessionId`, stamped into every payload).
 * - `post_compact_audit` - `post-compact-audit.ts` (required
 *   `sessionId`, stamped into every payload).
 * - `decision_model_extract_commit` - `extract-signals-prefilter.ts`
 *   (stamped from the commit result's required session id).
 *
 * The writer-shape census that keeps this list honest over the full
 * `ContinuityRecordKind` population lives in the check's test file.
 */
export const SESSION_IDENTITY_CHECKED_KINDS: ReadonlyArray<ContinuityRecordKind> = Object.freeze([
  "decision_model_extract_commit",
  "post_compact_audit",
  "pre_compact_extract",
  "session_summary_digest",
  "session_summary_node",
  "session_turn",
]);

const CHECKED_KINDS: ReadonlySet<string> = new Set(SESSION_IDENTITY_CHECKED_KINDS);

/** What the check can no longer claim for a ledger it could not read. */
const LEDGER_CONSEQUENCE =
  "no record in it had its session identity counted, so a blank-identity count for its kinds is missing from this report";

/**
 * The registered check. Count-only and fail-soft: one pass, one issue
 * per affected kind (deterministic kind order), no `fix` field, no
 * payload rewritten. Kinds whose writers are sessionless by design
 * produce no issue at all.
 */
export const sessionIdentityCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    const swept: SweptPath = {
      site: SESSION_IDENTITY_SITE,
      consequence: LEDGER_CONSEQUENCE,
      uncertain: out.uncertain,
    };
    let records: ReadonlyArray<ContinuityRecord>;
    try {
      records = listContinuityRecords(ctx.vault);
    } catch (err) {
      reportSweptFailure(
        continuityLogDir(ctx.vault),
        "continuity ledger read failed",
        err,
        swept,
        SWEEP_ORIGIN.root,
      );
      return;
    }
    const counts = new Map<string, number>();
    for (const record of records) {
      if (!CHECKED_KINDS.has(record.kind)) continue;
      if (sessionIdOf(record.payload) !== undefined) continue;
      counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
    }
    const dir = continuityLogDir(ctx.vault);
    for (const [kind, count] of [...counts].toSorted((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      out.issues.push({
        severity: "warning",
        code: SESSION_IDENTITY_CHECK_CODE,
        path: dir,
        message:
          `${count} ${kind} continuity record(s) name no session ` +
          "(session_id absent, non-string, or empty; this kind's writer stamps one on " +
          "every record); informational count only - reads treat them as unattributed " +
          "and no payload is rewritten",
      } satisfies DoctorIssue);
    }
  },
};

/**
 * The dream pass's audit trail: everything the run says about itself in
 * `Brain/log/<today>.md`.
 *
 * One reason to change: what an operator (or the digest parser, or the
 * next dream pass) must be able to read back about a run. This module
 * owns the event ORDER, the per-event timestamp cursor and the summary
 * payload's shape. It decides nothing about the vault's contents.
 *
 * Only ever invoked on the changed, non-dry-run path — a no-op run
 * writes no events at all, which is what keeps an idempotent rerun
 * byte-identical.
 */

import { preferenceSlug, type PlanState, type ScanResult } from "./dream-plan.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import { WORKRUN_PHASE, type WorkrunHandle } from "./dream-workrun.ts";
import { appendLogEvent } from "./log.ts";
import { vaultRelative } from "./paths.ts";
import type { ReconcileOutcomes } from "./reconcile-outcomes.ts";
import { writeRollupLedger, type RollupLadderPlan } from "./rollup-ladder.ts";
import { isoSecond } from "./time.ts";
import { renderPrefLink } from "./wikilink.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

/** Spacing between consecutive events so their log headings stay distinct. */
const EVENT_STAMP_STEP_MS = 1000;

/** Marks a retain-pinned event as an attempted-but-blocked retire. */
const RETIRE_BLOCKED_PINNED = "pinned";

export interface DreamReportInput {
  readonly vault: string;
  readonly now: Date;
  readonly runId: string;
  readonly scan: ScanResult;
  readonly plan: PlanState;
  readonly refresh: RefreshResult;
  readonly reconcile: ReconcileOutcomes;
  readonly rollupPlan: RollupLadderPlan;
  /** Signal ids that actually reached `processed/`. */
  readonly moved: ReadonlyArray<string>;
  /** Retires the evidence gate declined; excluded from the `retired` row. */
  readonly gatedSlugs: ReadonlySet<string>;
  /** True when the invoking agent differs from the vault's declared primary. */
  readonly isNonPrimary: boolean;
  readonly callerAgent: string;
  readonly workrun: WorkrunHandle | null;
}

/**
 * Emit the run's log entries: skip-corrupted-frontmatter first
 * (chronological sense: corruption was detected during planning), then
 * per-topic events, then the run summary last.
 */
export function writeDreamLog(input: DreamReportInput): void {
  const { vault, plan, reconcile, workrun } = input;
  const nextStamp = createStampCursor(input.now);

  for (const corrupt of input.scan.corrupted) {
    appendLogEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.skipCorruptedFrontmatter,
      body: {
        path: vaultRelative(corrupt.path, vault),
      },
    });
  }

  for (const noted of plan.notedRedundant) {
    appendLogEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.notedRedundant,
      body: {
        preference: noted.preference,
        signal: noted.signal,
      },
    });
  }

  // Reconcile phase (F3): one event per open question + per
  // auto-resolution. Persisted only on this changed path so a no-op
  // run stays byte-identical.
  for (const q of reconcile.openQuestions) {
    appendLogEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.reconcile,
      body: {
        topic: q.topic,
        domain: q.domain,
        reason: q.reason,
        ...(q.scope ? { scope: q.scope } : {}),
        positives: String(q.positive_count),
        negatives: String(q.negative_count),
      },
    });
  }
  for (const r of reconcile.autoResolved) {
    appendLogEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.reconcile,
      body: {
        topic: r.topic,
        domain: r.domain,
        resolution: "auto-resolved",
        winner_sign: r.winner_sign,
        margin_days: String(r.margin_days),
      },
    });
  }
  // Reconcile's only durable artifact is the pair of event loops just
  // above: the classification itself is in-memory and vanishes with the
  // process. The pre-mutation burst used to claim this phase complete
  // before a single preference had been written, which is precisely the
  // journal-lies failure this release removes. The marker therefore
  // trails `heal_complete` in the file - emission order is execution
  // order, not the reporting order of DREAM_PHASE_ORDER.
  workrun?.checkpoint(WORKRUN_PHASE.reconcileComplete);

  for (const suppressed of plan.signalsSuppressed) {
    appendLogEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.signalSuppressed,
      body: {
        signal: suppressed.signal,
        retired: suppressed.retired,
        topic: suppressed.topic,
        reason: suppressed.reason,
      },
    });
  }

  for (const retain of plan.retainPinned) {
    // `retain-pinned` is not in the strict BrainLogEventKind enum
    // (the design doc names a generic `retire` event with an
    // attempted-but-blocked reason). We log it as a `retire` event
    // with a `blocked: pinned` payload field so the parser
    // round-trips cleanly and the doctor command can flag it.
    appendLogEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.retire,
      body: {
        preference: retain.preference,
        reason: retain.reason,
        blocked: RETIRE_BLOCKED_PINNED,
      },
    });
  }

  appendLogEvent(vault, {
    timestamp: nextStamp(),
    eventType: BRAIN_LOG_EVENT_KIND.dream,
    body: buildSummaryBody(input),
  });

  // S3: persist the advanced rollup-ladder counters only when a rung
  // fired. A below-threshold run never touches the ledger, so its
  // absence is the byte-identical opt-out.
  if (input.rollupPlan.fired) writeRollupLedger(vault, input.rollupPlan.ledger);
}

/**
 * Monotonic per-emission timestamp source. Each event advances the cursor
 * so two events in the same run never share a log heading.
 */
function createStampCursor(now: Date): () => string {
  let cursorMs = now.getTime();
  return () => {
    const ts = new Date(cursorMs);
    cursorMs += EVENT_STAMP_STEP_MS;
    return isoSecond(ts);
  };
}

/**
 * The `dream` summary event's payload. Every row is conditional: a key
 * that would carry an empty list is omitted entirely, which is what keeps
 * a minimal run's event byte-identical to earlier releases.
 *
 * Link rendering threads the in-memory principle alongside the id so the
 * digest / Obsidian view can hover-preview the rule without an extra file
 * open.
 */
function buildSummaryBody(input: DreamReportInput): Record<string, string | ReadonlyArray<string>> {
  const { plan, refresh, rollupPlan, gatedSlugs } = input;

  const slugToPrefPrinciple = new Map<string, string>();
  for (const rec of input.scan.preferences) {
    slugToPrefPrinciple.set(preferenceSlug(rec.pref.id), rec.pref.principle);
  }
  const newUnconfirmedIds = plan.newUnconfirmed.map((p) =>
    renderPrefLink({ id: `pref-${p.slug}`, principle: p.principle }),
  );
  const confirmedIds = Array.from(refresh.confirmed.values()).map((slug) =>
    renderPrefLink({
      id: `pref-${slug}`,
      principle: refresh.updated.get(slug)?.principle ?? slugToPrefPrinciple.get(slug) ?? "",
    }),
  );
  const retiredEntries = plan.retires
    .filter((r) => !gatedSlugs.has(r.slug))
    .map((r) => `${renderPrefLink({ id: `ret-${r.slug}`, principle: r.principle })} (${r.reason})`);

  const body: Record<string, string | ReadonlyArray<string>> = {
    run_id: input.runId,
  };
  if (newUnconfirmedIds.length > 0) body["new_unconfirmed"] = newUnconfirmedIds;
  if (confirmedIds.length > 0) body["confirmed"] = confirmedIds;
  if (retiredEntries.length > 0) body["retired"] = retiredEntries;
  if (input.moved.length > 0) body["moved_to_processed"] = input.moved;
  if (plan.contradictionTopics.size > 0) {
    body["contradictions"] = Array.from(plan.contradictionTopics);
  }
  if (plan.signalsSuppressed.length > 0) {
    body["suppressed"] = plan.signalsSuppressed.map((s) => `${s.signal} ← ${s.retired}`);
  }
  if (refresh.bandDrops.length > 0) {
    // Format matches the digest's tolerant `parseShiftLine` parser:
    // `[[pref-…|principle]] <from> -> <to> (applied: N, violated: M)`.
    body["confidence_shifts"] = refresh.bandDrops.map((d) =>
      [
        renderPrefLink({ id: d.id, principle: d.principle }),
        d.previous,
        "->",
        d.next,
        `(applied: ${d.applied}, violated: ${d.violated})`,
      ].join(" "),
    );
  }
  if (input.isNonPrimary) {
    // Audit-trail row matching the structured warning. Stored
    // alongside `run_id` so a non-primary dream pass is greppable in
    // the log without parsing the structured warnings array.
    body["non_primary_agent"] = input.callerAgent;
  }
  // S3: record each fired rollup rung's counter reset in the dream
  // report. Absent below threshold, so a non-firing run's summary event
  // is byte-identical to the pre-rollup behaviour.
  if (rollupPlan.fired) {
    body["rollups"] = rollupPlan.entries.map(
      (e) => `${e.tier} -> ${e.produces} (${e.fromCount} -> ${e.toCount})`,
    );
  }
  return body;
}

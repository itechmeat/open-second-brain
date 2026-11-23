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

import { vaultRelativeOf } from "./no-vault.ts";
import { preferenceSlug, type PlanState, type ScanResult } from "./dream-plan.ts";
import { writeCrossTopicLedger, type CrossTopicLedger } from "./dream-plan-cross-topic.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import { WORKRUN_PHASE, type WorkrunHandle } from "./dream-workrun.ts";
import { appendLogEvents, type BrainLogEntry } from "./log.ts";
import type { ReconcileOutcomes } from "./reconcile-outcomes.ts";
import { writeRollupLedger, type RollupLadderPlan } from "./rollup-ladder.ts";
import { isoSecond } from "./time.ts";
import { renderPrefLink } from "./wikilink.ts";
import { effectId } from "./dream-replay/ledgers.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

/** Spacing between consecutive events so their log headings stay distinct. */
const EVENT_STAMP_STEP_MS = 1000;

/** Marks a retain-pinned event as an attempted-but-blocked retire. */
const RETIRE_BLOCKED_PINNED = "pinned";

export interface DreamReportInput {
  readonly vault: string | null;
  readonly now: Date;
  readonly runId: string;
  readonly scan: ScanResult;
  readonly plan: PlanState;
  readonly refresh: RefreshResult;
  readonly reconcile: ReconcileOutcomes;
  readonly rollupPlan: RollupLadderPlan;
  /** Keep the prior baseline when the fired work could not be fully queued. */
  readonly rollupProductionComplete?: boolean;
  /**
   * The updated cross-topic daily budget (t_642bc2b8) to persist when a
   * promotion fired this run; null when none did, so a below-threshold
   * or budgeted-out run never touches the ledger - the same
   * byte-identical opt-out the rollup ledger uses.
   */
  readonly crossTopicLedger: CrossTopicLedger | null;
  /** Signal ids that actually reached `processed/`. */
  readonly moved: ReadonlyArray<string>;
  /** Signal ids moved into `inbox/archived/` by this run. */
  readonly archived: ReadonlyArray<string>;
  /** Retires the evidence gate declined; excluded from the `retired` row. */
  readonly gatedSlugs: ReadonlySet<string>;
  /** True when the invoking agent differs from the vault's declared primary. */
  readonly isNonPrimary: boolean;
  readonly callerAgent: string;
  /** The dream owner of a brain that has one (`dream-owner/`); absent on an unbound brain. */
  readonly owner?: { readonly device: string; readonly agent: string };
  readonly workrun: WorkrunHandle | null;
  /**
   * Where a replayed window keeps its ledgers (the brain store,
   * `dream-replay/ledgers.ts`); absent, the two device-local files.
   */
  /**
   * A replayed window (`dream-replay/`): every event carries the window and
   * its effect id, and an event whose effect id the window already wrote
   * (a resumed window) is not written again.
   */
  readonly audit?: {
    readonly window: string;
    readonly existing: ReadonlySet<string>;
    /** Late applications in time for a trial already retired (design D5a). */
    readonly reconciliations: ReadonlyArray<{
      readonly rule: string;
      readonly evidence_at: ReadonlyArray<string>;
      readonly deadline: string;
    }>;
    readonly notCheckable: number;
    /** Records a rebase took as seen at this window's admission. */
    readonly rebasedSeen: number;
    /** The first replay's archived signals that may have missed a promotion. */
    readonly unrecoverable: number;
  };
  readonly ledgerSink?: (ledgers: {
    readonly crossTopicLedger: CrossTopicLedger | null;
    readonly rollupPlan: RollupLadderPlan;
    readonly rollupProductionComplete: boolean;
  }) => void;
}

/**
 * Emit the run's log entries: skip-corrupted-frontmatter first
 * (chronological sense: corruption was detected during planning), then
 * per-topic events, then the run summary last.
 */
export function writeDreamLog(input: DreamReportInput): void {
  const { vault, plan, reconcile, workrun } = input;
  const nextStamp = createStampCursor(input.now);
  // The events are appended in batches (`appendLogEvents`), not one synced
  // write each: a first pass over a migrated history notes thousands of
  // signals. A batch lands before the workrun marker that claims it.
  const raw: BrainLogEntry[] = [];
  const audit = input.audit;
  // Each event's subject names its effect: the same event of the same
  // window has the same id on every run (design D4.4).
  const subjects: string[] = [];
  const events = {
    push(entry: BrainLogEntry, subject = ""): void {
      raw.push(entry);
      subjects.push(subject);
    },
  };
  const flush = (): void => {
    if (audit === undefined) {
      appendLogEvents(vault, raw);
    } else {
      const tagged: BrainLogEntry[] = [];
      raw.forEach((entry, index) => {
        const effect = effectId(audit.window, entry.eventType, subjects[index]!);
        if (audit.existing.has(effect)) return;
        tagged.push({ ...entry, body: { ...entry.body, window: audit.window, effect } });
      });
      appendLogEvents(vault, tagged);
    }
    raw.length = 0;
    subjects.length = 0;
  };

  for (const corrupt of input.scan.corrupted) {
    events.push(
      {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.skipCorruptedFrontmatter,
        body: {
          path: vaultRelativeOf(corrupt.path, vault),
        },
      },
      vaultRelativeOf(corrupt.path, vault),
    );
  }

  for (const noted of plan.notedRedundant) {
    events.push(
      {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.notedRedundant,
        body: {
          preference: noted.preference,
          signal: noted.signal,
        },
      },
      `${noted.preference}|${noted.signal}`,
    );
  }

  // Reconcile phase (F3): one event per open question + per
  // auto-resolution. Persisted only on this changed path so a no-op
  // run stays byte-identical.
  for (const q of reconcile.openQuestions) {
    events.push(
      {
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
      },
      `${q.topic}|${q.scope ?? ""}`,
    );
  }
  for (const r of reconcile.autoResolved) {
    events.push(
      {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.reconcile,
        body: {
          topic: r.topic,
          domain: r.domain,
          resolution: "auto-resolved",
          winner_sign: r.winner_sign,
          margin_days: String(r.margin_days),
        },
      },
      `${r.topic}|auto-resolved`,
    );
  }
  // Reconcile's only durable artifact is the pair of event loops just
  // above: the classification itself is in-memory and vanishes with the
  // process. The pre-mutation burst used to claim this phase complete
  // before a single preference had been written, which is precisely the
  // journal-lies failure this release removes. The marker therefore
  // trails `heal_complete` in the file - emission order is execution
  // order, not the reporting order of DREAM_PHASE_ORDER.
  flush();
  workrun?.checkpoint(WORKRUN_PHASE.reconcileComplete);

  for (const suppressed of plan.signalsSuppressed) {
    events.push(
      {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.signalSuppressed,
        body: {
          signal: suppressed.signal,
          retired: suppressed.retired,
          topic: suppressed.topic,
          reason: suppressed.reason,
        },
      },
      suppressed.signal,
    );
  }

  for (const retain of plan.retainPinned) {
    // `retain-pinned` is not in the strict BrainLogEventKind enum
    // (the design doc names a generic `retire` event with an
    // attempted-but-blocked reason). We log it as a `retire` event
    // with a `blocked: pinned` payload field so the parser
    // round-trips cleanly and the doctor command can flag it.
    events.push(
      {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.retire,
        body: {
          preference: retain.preference,
          reason: retain.reason,
          blocked: RETIRE_BLOCKED_PINNED,
        },
      },
      retain.preference,
    );
  }

  events.push({
    timestamp: nextStamp(),
    eventType: BRAIN_LOG_EVENT_KIND.dream,
    body: buildSummaryBody(input),
  });
  flush();

  if (input.ledgerSink !== undefined) {
    input.ledgerSink({
      crossTopicLedger: input.crossTopicLedger,
      rollupPlan: input.rollupPlan,
      rollupProductionComplete: input.rollupProductionComplete !== false,
    });
    return;
  }

  // S3: persist the advanced rollup-ladder counters only when a rung
  // fired. A below-threshold run never touches the ledger, so its
  // absence is the byte-identical opt-out.
  if (input.rollupPlan.fired && input.rollupProductionComplete !== false) {
    writeRollupLedger(vault, input.rollupPlan.ledger);
  }

  // Cross-topic promotion (t_642bc2b8): persist the advanced per-owner
  // daily budget beside the rollup ledger, under the same discipline -
  // written only when a promotion actually fired, through the shared
  // atomic writer.
  if (input.crossTopicLedger) writeCrossTopicLedger(vault, input.crossTopicLedger);
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
  if (input.archived.length > 0) body["archived_signals"] = input.archived;
  if (plan.contradictionTopics.size > 0) {
    body["contradictions"] = Array.from(plan.contradictionTopics);
  }
  if (plan.signalsSuppressed.length > 0) {
    body["suppressed"] = plan.signalsSuppressed.map((s) => `${s.signal} ← ${s.retired}`);
  }
  // Folded topic keys the pass planned nothing for because two preferences
  // claim them. The run summary's warnings carry the same finding to the
  // caller; this row is the durable half, so a run that mutated something
  // else leaves the ambiguity in the audit trail rather than only on stderr.
  if (plan.topicKeyContentions.length > 0) {
    body["topic_key_contentions"] = plan.topicKeyContentions.map(
      (c) => `${c.key}: ${c.prefIds.join(", ")}`,
    );
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
  if (input.audit !== undefined) {
    // The window's late applications that came in time for a trial the
    // daily passes had already retired: named, the rule stays retired.
    if (input.audit.reconciliations.length > 0) {
      body["reconciliations"] = input.audit.reconciliations.map(
        (r) => `[[${r.rule}]] deadline ${r.deadline} <- applied ${r.evidence_at.join(", ")}`,
      );
    }
    if (input.audit.notCheckable > 0) {
      body["reconciliation_not_checkable"] = String(input.audit.notCheckable);
    }
    if (input.audit.rebasedSeen > 0) body["rebased_seen"] = String(input.audit.rebasedSeen);
    if (input.audit.unrecoverable > 0) {
      body["unrecoverable_archived"] = String(input.audit.unrecoverable);
    }
  }
  if (input.isNonPrimary) {
    // Audit-trail row matching the structured warning. Stored
    // alongside `run_id` so a non-primary dream pass is greppable in
    // the log without parsing the structured warnings array.
    body["non_primary_agent"] = input.callerAgent;
  }
  if (input.owner !== undefined) {
    // The pass ran on the owner's device; the row names the owner and the
    // agent that started it, which may be another agent on that device.
    body["dream_owner_device"] = input.owner.device;
    body["dream_owner_agent"] = input.owner.agent;
    if (input.callerAgent.length > 0) body["caller_agent"] = input.callerAgent;
  }
  // S3: record each fired rollup rung's counter reset in the dream
  // report. Absent below threshold, so a non-firing run's summary event
  // is byte-identical to the pre-rollup behaviour.
  if (rollupPlan.fired) {
    body["rollups"] = rollupPlan.entries.map(
      (e) => `${e.tier} -> ${e.produces} (${e.fromCount} -> ${e.toCount})`,
    );
  }
  // Cross-topic promotion (t_642bc2b8): each promoted rule rendered
  // like a new unconfirmed pref, with its source lineage after an arrow
  // so the audit trail shows what the rule generalises without opening
  // a single source file. Absent when nothing fired.
  if (plan.crossTopicRules.length > 0) {
    body["cross_topic_rules"] = plan.crossTopicRules.map(
      (r) =>
        `${renderPrefLink({ id: `pref-${r.slug}`, principle: r.principle })} ← ${r.related.join(", ")}`,
    );
  }
  return body;
}

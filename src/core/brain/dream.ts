/**
 * `dream` — the only mutating batch operation in the Brain layer.
 *
 * `dream` reads the current Brain state and decides which transitions
 * to apply. It is deterministic given the inputs and the configured
 * time (the `--now` parameter). The algorithm is anchored in design
 * doc §7.3 and the per-rule clarifications in §7.4.
 *
 * Outputs (high level):
 *
 *   - Pre-run snapshot under `Brain/.snapshots/<run_id>.tar.zst`,
 *     created BEFORE any state-changing write so a crash mid-run can
 *     be rolled back atomically.
 *   - New / updated files in `Brain/preferences/`.
 *   - Moves into `Brain/retired/`.
 *   - Moves from `Brain/inbox/` into `Brain/inbox/processed/`.
 *   - One appended event in `Brain/log/<today>.md` summarising the
 *     run — **only** if any state actually changed. Idempotent reruns
 *     touch nothing.
 *
 * Invariants:
 *
 *   - Same-sign signals on an active preference are noted (moved to
 *     `processed/`, log event `noted-redundant`) but do NOT create a
 *     second preference and do NOT increment `applied_count`.
 *   - Opposite-sign signals against an active preference accumulate
 *     toward a rebuttal. Hitting `candidate_threshold` retires the
 *     active preference (reason `rebutted`) UNLESS it is pinned, in
 *     which case the rebut attempt is logged as a `retain-pinned`
 *     event and the preference stays.
 *   - Corrupted frontmatter on a single file produces a
 *     `skip-corrupted-frontmatter` log event and is skipped. The run
 *     continues for the rest of the tree.
 *   - dryRun mode returns the planned summary but performs no writes.
 */

import { existsSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { regenerateActiveQuiet } from "./active.ts";
import { collectEvidenceForSlug } from "./evidence.ts";
import {
  appendLogEvent,
  parseLogDay,
  type BrainLogEntry,
} from "./log.ts";
import {
  moveToRetired,
  parsePreference,
  wouldRewritePreference,
  writePreference,
} from "./preference.ts";
import { parseSignal } from "./signal.ts";
import { isPinned } from "./pin.ts";
import {
  createSnapshot,
  pruneSnapshots,
} from "./snapshot.ts";
import { loadBrainConfig, resolveGuardrails } from "./policy.ts";
import { applySelfApprovalGuardrail } from "./trust/self-approval-guardrail.ts";
import {
  brainDirs,
  preferencePath,
  processedSignalPath,
  vaultRelative,
} from "./paths.ts";
import { isoDate, isoSecond } from "./time.ts";
import { parseWikilink, renderPrefLink } from "./wikilink.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  BRAIN_SIGNAL_SIGN,
  type BrainConfidence,
  type BrainConfig,
  type BrainPreference,
  type BrainRetiredReason,
  type BrainSignal,
  type BrainSignalSign,
} from "./types.ts";

// ----- Public types --------------------------------------------------------

/**
 * Structured non-fatal warning emitted alongside a dream summary. The
 * dream pass still completes when warnings are present; callers
 * (CLI / MCP) decide whether to surface them.
 */
export interface DreamWarning {
  readonly code: string;
  readonly message: string;
}

/**
 * Entry surfacing a step the dream pass attempted but could not
 * fully verify. Distinct from a `DreamWarning` (which flags
 * configuration smells): an `uncertain` entry means "I tried, no
 * hard error, but I cannot claim the operation completed". Consumed
 * by the trust verdict + operator summary (v0.10.16).
 */
export interface DreamUncertainEntry {
  /** Stable code identifying which sub-operation could not confirm. */
  readonly code: string;
  /** Optional topic slug or preference id this uncertainty concerns. */
  readonly topic?: string;
  /** Human-readable explanation. */
  readonly message: string;
}

/**
 * Entry surfacing a signal cluster that the self-approval guardrail
 * (v0.10.16) held back from promotion because one or more configured
 * thresholds were not met. Distinct from `suppressed` (which fires
 * on a user-rejected retired preference); a quarantined cluster
 * stays inbox-side and may promote on the next dream pass once
 * more evidence accumulates.
 */
export interface DreamQuarantinedEntry {
  /** Topic slug whose signals are held below the promotion threshold. */
  readonly topic: string;
  /** Count of accumulated same-sign signals. */
  readonly signal_count: number;
  /** Number of distinct agents that raised same-sign signals. */
  readonly distinct_agents: number;
  /** Age (in days) of the earliest signal in the cluster. */
  readonly age_days: number;
  /**
   * Which threshold(s) blocked promotion: any subset of
   * `min_signals`, `min_distinct_agents`, `min_age_days`.
   */
  readonly failed_gates: ReadonlyArray<string>;
}

export interface DreamRunSummary {
  /** `dream-YYYY-MM-DD-HHMMSS`. */
  readonly run_id: string;
  /** False on a true no-op run (no signals, no transitions, no retires). */
  readonly changed: boolean;
  /** Preference ids newly created in `unconfirmed` state. */
  readonly new_unconfirmed: ReadonlyArray<string>;
  /** Preference ids transitioning `unconfirmed → confirmed`. */
  readonly confirmed: ReadonlyArray<string>;
  /** Preferences moved to `retired/` and the reason for each. */
  readonly retired: ReadonlyArray<{ id: string; reason: BrainRetiredReason }>;
  /** Topic slugs where opposite-sign signals are accumulating but no
   *  state change happened yet (window not exceeded, or pinned). */
  readonly contradictions: ReadonlyArray<string>;
  /** Signal ids moved from inbox/ into inbox/processed/. */
  readonly moved_to_processed: ReadonlyArray<string>;
  /**
   * Signal ids dropped by §6 signal-suppression — a user-rejected
   * retired pref with the same topic blocked them from re-promotion.
   * Each entry is just the signal id (the retired wikilink + reason
   * land in the `signal-suppressed` log event).
   */
  readonly suppressed: ReadonlyArray<string>;
  /**
   * Non-fatal warnings raised during the run. Currently emitted only
   * for `non-primary-dream-run` (the runtime running dream differs
   * from `Brain/_brain.yaml.primary_agent`); the list is the
   * extension point for future advisory checks.
   */
  readonly warnings: ReadonlyArray<DreamWarning>;
  /**
   * Sub-operations the dream pass attempted but could not fully
   * verify. Empty on every clean run; populated by future
   * uncertainty-surfacing paths (v0.10.16).
   */
  readonly uncertain: ReadonlyArray<DreamUncertainEntry>;
  /**
   * Signal clusters held back from promotion by the self-approval
   * guardrail (v0.10.16). Empty when no cluster missed a threshold,
   * or when the guardrail is configured at default values that
   * match pre-v0.10.16 behaviour.
   */
  readonly quarantined: ReadonlyArray<DreamQuarantinedEntry>;
  /** Snapshot file (absent on a no-op run). */
  readonly snapshot_path?: string;
  /** Log file the run summary landed in (absent on a no-op run). */
  readonly log_path?: string;
  /** True iff the run was a dry-run (no on-disk mutations performed). */
  readonly dry_run?: boolean;
}

export interface DreamOptions {
  /** Wall clock for the run. Defaults to `new Date()`. */
  readonly now?: Date;
  /** When true, compute the plan but make no writes. */
  readonly dryRun?: boolean;
  /**
   * Identity of the agent invoking dream. Compared against
   * `Brain/_brain.yaml.primary_agent`; mismatch emits a
   * `non-primary-dream-run` warning and tags the dream summary log
   * event with `non_primary_agent: <name>`. When unset, the warning
   * never fires (back-compat with callers that have not been
   * threaded yet); the CLI always provides the value.
   */
  readonly agentName?: string;
}

// ----- Internal scan types ------------------------------------------------

interface SignalRecord {
  readonly path: string;
  readonly signal: BrainSignal;
  /** True iff the file lives in `inbox/` (not `processed/`). */
  readonly active: boolean;
}

interface PreferenceRecord {
  readonly path: string;
  readonly pref: BrainPreference;
}

interface RetiredRecord {
  readonly path: string;
  readonly topic: string;
  readonly id: string;
  readonly principle: string;
  readonly scope?: string;
  /**
   * The free-form user reason passed to `o2b brain reject --reason`.
   * Presence triggers signal-suppression for future signals on the
   * same (topic, scope) — see §6 of the OSB features summary.
   */
  readonly user_rejected_reason?: string;
}

interface CorruptedEntry {
  readonly path: string;
}

interface ScanResult {
  readonly signals: SignalRecord[];
  readonly preferences: PreferenceRecord[];
  readonly retired: RetiredRecord[];
  readonly corrupted: CorruptedEntry[];
}

// ----- Main entry ----------------------------------------------------------

export function dream(vault: string, opts: DreamOptions = {}): DreamRunSummary {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const cfg = loadBrainConfig(vault);
  const runId = formatRunId(now);
  const wikilinkToRun = `[[Brain/log/${isoDate(now)}]]`;

  // Collect non-fatal warnings raised during the run. The
  // non-primary-dream-run check is the first one: when the caller
  // declares an agent name and it differs from the vault's declared
  // primary, surface a structured warning. We do NOT abort — the
  // declaration is observability, not access control.
  const warnings: DreamWarning[] = [];
  const callerAgent = opts.agentName?.trim() ?? "";
  const isNonPrimary =
    cfg.primary_agent !== null
    && callerAgent.length > 0
    && callerAgent !== cfg.primary_agent;
  if (isNonPrimary) {
    warnings.push({
      code: "non-primary-dream-run",
      message:
        `dream run from agent '${callerAgent}', but primary is `
        + `'${cfg.primary_agent}'. Convention violation, run proceeds.`,
    });
  }

  // 0. Scan the whole Brain/ tree. Corrupted files (frontmatter
  //    parse-errors) are surfaced separately so the planning phase
  //    can emit `skip-corrupted-frontmatter` log entries without
  //    aborting.
  const scan = scanBrain(vault);

  // 1-2. Plan per-topic transitions: new unconfirmed preferences,
  //      same-sign noted-redundant moves, rebuttal accumulation.
  const plan = planTopics(scan, cfg, now, wikilinkToRun);

  // 3. Plan refresh: applied / violated / last_evidence / confidence,
  //    and unconfirmed → confirmed promotion. We need the log of all
  //    apply-evidence entries up to `now` — we read every day file
  //    referenced by `last_evidence_at` plus today's file. Since the
  //    plan doesn't yet know dates, we scan the entire log/ directory.
  const evidence = scanApplyEvidence(vault);
  const refresh = planRefresh(vault, scan, evidence, cfg, now, plan);

  // 4. Plan retires (expired-unconfirmed, stale-no-evidence). Pinned
  //    preferences get a `retain-pinned` log event instead of a real
  //    retire.
  planAutoRetires(scan, cfg, now, plan, refresh);

  // 5. Plan signal moves (inbox/ → processed/).
  planSignalMoves(scan, plan);

  // Decide if anything is going to change. We treat any of the
  // following as a state change:
  //   - a new unconfirmed pref
  //   - a refreshed pref (counters/confidence/status changed)
  //   - a retire
  //   - a same-sign signal noted on an active pref (move + log)
  //   - a corrupted frontmatter (we want the skip event recorded)
  //   - any pinned-rebut-attempt warning
  const changed =
    plan.newUnconfirmed.length > 0 ||
    refresh.confirmed.size > 0 ||
    refresh.updated.size > 0 ||
    plan.retires.length > 0 ||
    plan.notedRedundant.length > 0 ||
    plan.signalsToMove.size > 0 ||
    plan.retainPinned.length > 0 ||
    plan.signalsSuppressed.length > 0 ||
    // v0.10.16: quarantine is a recorded decision (deferred-but-noted),
    // so a run that produces only quarantine entries is still a
    // meaningful run from the operator's perspective.
    plan.quarantined.length > 0 ||
    scan.corrupted.length > 0;

  if (!changed) {
    if (!dryRun) regenerateActiveQuiet(vault, { now });
    return Object.freeze({
      run_id: runId,
      changed: false,
      new_unconfirmed: [],
      confirmed: [],
      retired: [],
      contradictions: [...plan.contradictionTopics],
      moved_to_processed: [],
      suppressed: [],
      warnings: Object.freeze([...warnings]),
      uncertain: Object.freeze([] as ReadonlyArray<DreamUncertainEntry>),
      quarantined: Object.freeze([...plan.quarantined]),
      ...(dryRun ? { dry_run: true } : {}),
    } satisfies DreamRunSummary);
  }

  // ---- Execute --------------------------------------------------------

  // Snapshot must succeed before any mutation. If it fails, the
  // function throws and nothing changes on disk.
  let snapshotPathStr: string | undefined;
  if (!dryRun) {
    const snap = createSnapshot(vault, runId);
    snapshotPathStr = snap.path;
  }

  // Order of operations matters for the on-disk invariants:
  //   1. Write new unconfirmed preferences (so signal moves can find
  //      them).
  //   2. Apply refresh (counters, confidence, promotion) to existing
  //      preferences.
  //   3. Move retiring preferences out (after the refresh has had a
  //      chance to surface the most recent counters in the retired
  //      file). NOTE: refresh skips entries that will retire.
  //   4. Move consumed signals into `processed/`.
  //   5. Emit log entries (noted-redundant, retain-pinned,
  //      skip-corrupted-frontmatter, dream summary).
  const moved: string[] = [];

  if (!dryRun) {
    for (const np of plan.newUnconfirmed) {
      // Fresh pref has no apply-evidence yet; recentApplied/recentViolated
      // start empty and stay so until the next dream pass after the
      // first `brain_apply_evidence` event.
      writePreference(
        vault,
        {
          slug: np.slug,
          topic: np.topic,
          principle: np.principle,
          created_at: isoSecond(now),
          unconfirmed_until: isoSecond(
            addDays(now, cfg.dream.unconfirmed_window_days),
          ),
          status: BRAIN_PREFERENCE_STATUS.unconfirmed,
          evidenced_by: np.evidencedBy,
          // No evidence yet → Wilson lower bound on (0, 0) is 0. Pre-
          // seed the field so refresh on the next pass does not have
          // to treat `null` as "needs update" (which would lift
          // `changed: false` no-ops into spurious rewrites).
          confidence_value: 0,
          recentApplied: [],
          recentViolated: [],
          ...(np.scope ? { scope: np.scope } : {}),
          ...(np.supersedes ? { supersedes: np.supersedes } : {}),
        },
        { overwrite: false },
      );
    }

    for (const update of refresh.updated.values()) {
      // Rebuild the evidence slice from the log on every pass so the
      // pref body stays in sync with the counters even when the
      // counters themselves stayed put (e.g. dropping the
      // v0.9.x placeholder body during a no-counter-change run).
      const ev = collectEvidenceForSlug(vault, update.slug, {
        sinceIso: update.created_at,
      });
      writePreference(
        vault,
        {
          slug: update.slug,
          topic: update.topic,
          principle: update.principle,
          created_at: update.created_at,
          unconfirmed_until: update.unconfirmed_until,
          status: update.status,
          evidenced_by: update.evidenced_by,
          confirmed_at: update.confirmed_at,
          applied_count: update.applied_count,
          violated_count: update.violated_count,
          last_evidence_at: update.last_evidence_at,
          confidence: update.confidence,
          confidence_value: update.confidence_value,
          pinned: update.pinned,
          recentApplied: ev.applied,
          recentViolated: ev.violated,
          ...(update.scope ? { scope: update.scope } : {}),
        },
        { overwrite: true },
      );
    }

    for (const r of plan.retires) {
      const fromPath = preferencePath(vault, r.slug);
      if (!existsSync(fromPath)) continue;
      try {
        moveToRetired(vault, fromPath, r.reason, {
          now,
          retired_by: wikilinkToRun,
          ...(r.supersededBy ? { superseded_by: r.supersededBy } : {}),
        });
      } catch (err) {
        // A retire failure is logged via the `skip-corrupted-frontmatter`
        // pathway only if it stemmed from a parse error during the
        // plan; here the file may have been moved already (rare race).
        // Surface the cause so an operator chasing a missing retire can
        // see which slug tripped.
        process.stderr.write(
          `warning: retire stale pref ${r.slug} failed: ${(err as Error).message}\n`,
        );
      }
    }

    for (const sig of plan.signalsToMove.values()) {
      const dest = processedSignalPath(vault, sig.date, sig.slug);
      try {
        renameSync(sig.path, dest);
        moved.push(sig.id);
      } catch (err) {
        // Best-effort: a missing source signal (already moved) is
        // benign on rerun. Still surface so a real I/O issue is visible.
        process.stderr.write(
          `warning: move signal ${sig.id} to processed/ failed: ${(err as Error).message}\n`,
        );
      }
    }
  } else {
    // Dry-run still reports the move list so the caller's summary is
    // accurate, but it does not touch disk.
    for (const sig of plan.signalsToMove.values()) moved.push(sig.id);
  }

  // Emit log entries: skip-corrupted-frontmatter first (chronological
  // sense: corruption was detected during planning), then per-topic
  // events (noted-redundant), then run summary last.
  if (!dryRun) {
    let logCursorMs = now.getTime();
    const nextStamp = (): string => {
      const ts = new Date(logCursorMs);
      logCursorMs += 1000; // increment per emission so headings stay distinct
      return isoSecond(ts);
    };

    for (const corrupt of scan.corrupted) {
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.skipCorruptedFrontmatter,
        body: {
          path: vaultRelative(corrupt.path, vault),
        },
      });
    }

    for (const noted of plan.notedRedundant) {
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.notedRedundant,
        body: {
          preference: noted.preference,
          signal: noted.signal,
        },
      });
    }

    for (const suppressed of plan.signalsSuppressed) {
      writeEvent(vault, {
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
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.retire,
        body: {
          preference: retain.preference,
          reason: retain.reason,
          blocked: "pinned",
        },
      });
    }

    // Summary event last. Link rendering threads the in-memory
    // principle alongside the id so the digest / Obsidian view can
    // hover-preview the rule without an extra file open.
    const slugToPrefPrinciple = new Map<string, string>();
    for (const rec of scan.preferences) {
      const recSlug = rec.pref.id.startsWith("pref-")
        ? rec.pref.id.slice("pref-".length)
        : rec.pref.id;
      slugToPrefPrinciple.set(recSlug, rec.pref.principle);
    }
    const newUnconfirmedIds = plan.newUnconfirmed.map((p) =>
      renderPrefLink({ id: `pref-${p.slug}`, principle: p.principle }),
    );
    const confirmedIds = Array.from(refresh.confirmed.values()).map((slug) =>
      renderPrefLink({
        id: `pref-${slug}`,
        principle:
          refresh.updated.get(slug)?.principle
          ?? slugToPrefPrinciple.get(slug)
          ?? "",
      }),
    );
    const retiredEntries = plan.retires.map(
      (r) =>
        `${renderPrefLink({ id: `ret-${r.slug}`, principle: r.principle })} (${r.reason})`,
    );
    const summaryBody: Record<string, string | ReadonlyArray<string>> = {
      run_id: runId,
    };
    if (newUnconfirmedIds.length > 0) summaryBody["new_unconfirmed"] = newUnconfirmedIds;
    if (confirmedIds.length > 0) summaryBody["confirmed"] = confirmedIds;
    if (retiredEntries.length > 0) summaryBody["retired"] = retiredEntries;
    if (moved.length > 0) summaryBody["moved_to_processed"] = moved;
    if (plan.contradictionTopics.size > 0) {
      summaryBody["contradictions"] = Array.from(plan.contradictionTopics);
    }
    if (plan.signalsSuppressed.length > 0) {
      summaryBody["suppressed"] = plan.signalsSuppressed.map(
        (s) => `${s.signal} ← ${s.retired}`,
      );
    }
    if (refresh.bandDrops.length > 0) {
      // Format matches the digest's tolerant `parseShiftLine` parser:
      // `[[pref-…|principle]] <from> -> <to> (applied: N, violated: M)`.
      summaryBody["confidence_shifts"] = refresh.bandDrops.map((d) =>
        [
          renderPrefLink({ id: d.id, principle: d.principle }),
          d.previous,
          "->",
          d.next,
          `(applied: ${d.applied}, violated: ${d.violated})`,
        ].join(" "),
      );
    }
    if (isNonPrimary) {
      // Audit-trail row matching the structured warning. Stored
      // alongside `run_id` so a non-primary dream pass is greppable in
      // the log without parsing the structured warnings array.
      summaryBody["non_primary_agent"] = callerAgent;
    }

    writeEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      body: summaryBody,
    });
  }

  // Prune snapshots after the run so the new archive itself counts
  // toward retention.
  if (!dryRun) {
    try {
      pruneSnapshots(vault, cfg.snapshots.retention_count);
    } catch (err) {
      // Pruning is a hygiene step; failure should not turn a
      // successful dream run into an error. The next run will retry.
      // Surface so an operator can spot a recurring disk/permission
      // issue instead of wondering why retention stopped.
      process.stderr.write(
        `warning: prune snapshots failed: ${(err as Error).message}\n`,
      );
    }
    regenerateActiveQuiet(vault, { now });
  }

  return Object.freeze({
    run_id: runId,
    changed: true,
    new_unconfirmed: plan.newUnconfirmed.map((p) => `pref-${p.slug}`),
    confirmed: Array.from(refresh.confirmed.values()).map((s) => `pref-${s}`),
    retired: plan.retires.map((r) => ({ id: `ret-${r.slug}`, reason: r.reason })),
    contradictions: Array.from(plan.contradictionTopics),
    moved_to_processed: moved,
    suppressed: plan.signalsSuppressed.map((s) =>
      s.signal.replace(/^\[\[/, "").replace(/\]\]$/, ""),
    ),
    warnings: Object.freeze([...warnings]),
    uncertain: Object.freeze([] as ReadonlyArray<DreamUncertainEntry>),
    quarantined: Object.freeze([...plan.quarantined]),
    ...(snapshotPathStr ? { snapshot_path: snapshotPathStr } : {}),
    ...(dryRun
      ? { dry_run: true }
      : { log_path: join(brainDirs(vault).log, `${isoDate(now)}.md`) }),
  } satisfies DreamRunSummary);
}

// ----- Scan ---------------------------------------------------------------

function scanBrain(vault: string): ScanResult {
  const dirs = brainDirs(vault);
  const signals: SignalRecord[] = [];
  const preferences: PreferenceRecord[] = [];
  const retired: RetiredRecord[] = [];
  const corrupted: CorruptedEntry[] = [];

  if (existsSync(dirs.inbox)) {
    for (const name of readdirSync(dirs.inbox)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.inbox, name);
      try {
        const sig = parseSignal(full);
        signals.push({ path: full, signal: sig, active: true });
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  if (existsSync(dirs.processed)) {
    for (const name of readdirSync(dirs.processed)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.processed, name);
      try {
        const sig = parseSignal(full);
        signals.push({ path: full, signal: sig, active: false });
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  if (existsSync(dirs.preferences)) {
    for (const name of readdirSync(dirs.preferences)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.preferences, name);
      try {
        const pref = parsePreference(full);
        preferences.push({ path: full, pref });
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  if (existsSync(dirs.retired)) {
    for (const name of readdirSync(dirs.retired)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.retired, name);
      // Retired files we only need for topic + id (for supersede
      // bookkeeping) plus the optional `user_rejected_reason` that
      // drives signal-suppression (v0.10.1, _summary §6). We do a
      // lightweight frontmatter parse to avoid the strict folder
      // invariant check failing on permissive setups.
      try {
        const [meta] = parseFrontmatter(full);
        const topic = typeof meta["topic"] === "string" ? meta["topic"] : "";
        const id = typeof meta["id"] === "string" ? meta["id"] : "";
        const principle =
          typeof meta["principle"] === "string" ? meta["principle"] : "";
        const scope = typeof meta["scope"] === "string" ? meta["scope"] : undefined;
        const userReason =
          typeof meta["user_rejected_reason"] === "string"
            ? (meta["user_rejected_reason"] as string).trim()
            : "";
        if (topic && id) {
          retired.push({
            path: full,
            topic,
            id,
            principle,
            ...(scope ? { scope } : {}),
            ...(userReason ? { user_rejected_reason: userReason } : {}),
          });
        }
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  return { signals, preferences, retired, corrupted };
}

// ----- Planning -----------------------------------------------------------

interface PlanState {
  /** Topic slug → planned new unconfirmed preference. */
  readonly newUnconfirmed: NewUnconfirmedPlan[];
  /** Preferences to retire (after refresh). */
  readonly retires: RetirePlan[];
  /** Same-sign signals on active prefs → moved + log event. */
  readonly notedRedundant: NotedRedundantPlan[];
  /** Pinned prefs that would have retired but stay because pinned. */
  readonly retainPinned: RetainPinnedPlan[];
  /** Signal id → record to move out of inbox/. */
  readonly signalsToMove: Map<string, SignalMovePlan>;
  /** Topic slugs flagged contradicted but no transition this run. */
  readonly contradictionTopics: Set<string>;
  /**
   * Signals dropped because their (topic, scope) matches a user-rejected
   * retired pref carrying a `user_rejected_reason`. Each entry produces
   * one `signal-suppressed` log event AND a move into `processed/` so
   * the inbox does not accumulate.
   */
  readonly signalsSuppressed: SignalSuppressedPlan[];
  /**
   * Signal clusters held back from promotion by the self-approval
   * guardrail (v0.10.16). The cluster passed the existing
   * `candidate_threshold` but failed one or more configured
   * thresholds in `BrainGuardrailConfig`. Preserved across the plan
   * so it surfaces on the DreamRunSummary without affecting the
   * existing move-to-processed semantics.
   */
  readonly quarantined: DreamQuarantinedEntry[];
}

interface SignalSuppressedPlan {
  readonly signal: string;
  /** Pre-rendered `[[ret-slug|principle]]` wikilink for the suppressor. */
  readonly retired: string;
  readonly reason: string;
  readonly topic: string;
}

interface NewUnconfirmedPlan {
  readonly slug: string;
  readonly topic: string;
  readonly scope: string | undefined;
  readonly principle: string;
  readonly evidencedBy: ReadonlyArray<string>;
  readonly sign: BrainSignalSign;
  /**
   * Wikilink string (`[[ret-<slug>]]` or `[[pref-<slug>]]`) to the
   * preference this new entry supersedes, if any. Threaded through to
   * `writePreference` so the resulting frontmatter carries
   * `supersedes:` for audit-trail continuity across rebuttals.
   */
  readonly supersedes?: string;
}

interface RetirePlan {
  readonly slug: string;
  /**
   * Principle of the preference being retired, captured at plan time
   * so the dream summary log payload can render a titled wikilink
   * (`[[ret-slug|principle]]`) without re-reading the file after move.
   */
  readonly principle: string;
  readonly reason: BrainRetiredReason;
  readonly supersededBy?: string;
}

interface NotedRedundantPlan {
  /** Pre-rendered `[[pref-id|principle]]` wikilink for the active pref. */
  readonly preference: string;
  readonly signal: string;
}

interface RetainPinnedPlan {
  /** Pre-rendered `[[pref-id|principle]]` wikilink for the pinned pref. */
  readonly preference: string;
  readonly reason: BrainRetiredReason;
}

interface SignalMovePlan {
  readonly id: string;
  readonly date: string;
  readonly slug: string;
  readonly path: string;
}

function emptyPlan(): PlanState {
  return {
    newUnconfirmed: [],
    retires: [],
    notedRedundant: [],
    retainPinned: [],
    signalsToMove: new Map(),
    contradictionTopics: new Set(),
    signalsSuppressed: [],
    quarantined: [],
  };
}

function planTopics(
  scan: ScanResult,
  cfg: BrainConfig,
  now: Date,
  _wikilinkToRun: string,
): PlanState {
  void _wikilinkToRun;
  const plan = emptyPlan();
  const reservedSlugs = collectReservedPreferenceSlugs(scan);

  // Group active signals by topic. We only consider active signals for
  // the create/rebut decisions; processed signals stay in the global
  // log via `evidenced_by` already.
  const byTopic = new Map<string, SignalRecord[]>();
  for (const rec of scan.signals) {
    if (!rec.active) continue;
    const topic = rec.signal.topic;
    const arr = byTopic.get(topic);
    if (arr) arr.push(rec);
    else byTopic.set(topic, [rec]);
  }

  // Index existing active preferences by topic.
  const prefByTopic = new Map<string, PreferenceRecord>();
  for (const p of scan.preferences) {
    // The first wins; design doc §7.4 invariant says "one preference per
    // topic", so a duplicate would be a doctor-level issue, not a dream
    // concern.
    if (!prefByTopic.has(p.pref.topic)) prefByTopic.set(p.pref.topic, p);
  }

  // Index retired by topic for supersede bookkeeping.
  const retiredByTopic = new Map<string, RetiredRecord[]>();
  for (const r of scan.retired) {
    const arr = retiredByTopic.get(r.topic);
    if (arr) arr.push(r);
    else retiredByTopic.set(r.topic, [r]);
  }

  for (const [topic, sigs] of byTopic) {
    const active = prefByTopic.get(topic);
    if (active) {
      handleSignalsOnActivePref(
        active,
        sigs,
        plan,
        cfg,
        now,
        scan.signals,
        reservedSlugs,
      );
      continue;
    }
    // v0.10.1 _summary §6: when a retired pref for this topic carries
    // a `user_rejected_reason`, the user explicitly rejected the rule
    // — re-growing it from fresh signals is exactly what they were
    // asking us not to do. Suppress every matching signal, emit one
    // `signal-suppressed` event per signal pointing at the retired
    // pref + the reason, and move them straight to processed.
    //
    // Per-signal scope match: an unscoped suppressor swallows every
    // signal on the topic; a scoped suppressor only swallows signals
    // sharing its scope (a signal without scope still matches an
    // unscoped suppressor but never a scoped one). Multiple retired
    // prefs on the same topic are tried in order — the first matching
    // suppressor wins. Non-matching signals fall through and remain
    // eligible for candidate-pref planning below.
    const suppressors = (retiredByTopic.get(topic) ?? []).filter(
      (r) => !!r.user_rejected_reason,
    );
    let candidateSigs: SignalRecord[] = sigs;
    if (suppressors.length > 0) {
      const remaining: SignalRecord[] = [];
      for (const sig of sigs) {
        const suppressor = suppressors.find((r) => {
          if (!r.scope) return true;
          if (!sig.signal.scope) return false;
          return r.scope === sig.signal.scope;
        });
        if (!suppressor) {
          remaining.push(sig);
          continue;
        }
        plan.signalsSuppressed.push({
          signal: `[[${sig.signal.id}]]`,
          retired: renderPrefLink({
            id: suppressor.id,
            principle: suppressor.principle,
          }),
          reason: suppressor.user_rejected_reason!,
          topic,
        });
        recordSignalMove(plan, sig);
      }
      if (remaining.length === 0) continue;
      candidateSigs = remaining;
    }
    // No active pref for this topic → either promote or note
    // contradiction.
    const windowedSigs = filterWithinWindow(
      candidateSigs,
      cfg.dream.contradiction_window_days,
      now,
    );
    const positives = windowedSigs.filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.positive);
    const negatives = windowedSigs.filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.negative);
    const dominant = positives.length >= negatives.length ? positives : negatives;
    const minoritySize = Math.min(positives.length, negatives.length);
    const dominantSize = dominant.length - minoritySize; // cancellation
    if (dominantSize >= cfg.dream.candidate_threshold) {
      // v0.10.16: extra self-approval guardrail. Defaults
      // (min_signals=2, min_distinct_agents=1, min_age_days=0) make
      // this check a no-op for clusters that already passed
      // candidate_threshold. Operators may opt into stricter
      // thresholds via `_brain.yaml:guardrails:*`. A failed gate
      // routes the cluster to `quarantined` instead of creating a
      // new unconfirmed preference; the contributing signals stay
      // in inbox/ so the cluster naturally re-evaluates on the next
      // pass once more evidence accumulates.
      const guardrails = resolveGuardrails(cfg);
      const distinctAgents = new Set(dominant.map((s) => s.signal.agent)).size;
      let earliestSignalMs = Number.POSITIVE_INFINITY;
      for (const s of dominant) {
        const t = Date.parse(s.signal.created_at);
        if (Number.isFinite(t) && t < earliestSignalMs) earliestSignalMs = t;
      }
      const ageDays =
        Number.isFinite(earliestSignalMs)
          ? Math.max(0, Math.floor((now.getTime() - earliestSignalMs) / (24 * 60 * 60 * 1000)))
          : 0;
      const verdict = applySelfApprovalGuardrail(
        {
          signal_count: dominantSize,
          distinct_agents: distinctAgents,
          age_days: ageDays,
        },
        guardrails,
      );
      if (verdict.decision === "quarantine") {
        plan.quarantined.push({
          topic,
          signal_count: dominantSize,
          distinct_agents: distinctAgents,
          age_days: ageDays,
          failed_gates: verdict.failed_gates,
        });
        continue;
      }
      // Decide supersede: if a retired pref for the same topic exists,
      // wire it through.
      const retiredForTopic = retiredByTopic.get(topic);
      const supersedes = retiredForTopic && retiredForTopic.length > 0
        ? retiredForTopic[0]!.id
        : undefined;
      const sign = dominant[0]!.signal.signal;
      // Slug from topic for the canonical filename, but reserve slugs
      // already present in retired/. Otherwise a superseding preference
      // can be created as `pref-topic` while `ret-topic` already exists;
      // its later retirement would fail trying to overwrite that retired
      // file.
      const slug = allocatePreferencePlanSlug(topic, reservedSlugs);
      const principle = dominant[0]!.signal.principle;
      const scope = dominant[0]!.signal.scope;
      // evidencedBy = wikilinks to ALL active signals (dominant + minority)
      // that contributed to this topic in the window. We deliberately
      // include the minority signals so the audit trail preserves the
      // contradiction story even after the file moves to processed/.
      const evidencedBy = windowedSigs.map((s) => `[[${s.signal.id}]]`);
      const supersedesRecord = supersedes
        ? retiredForTopic!.find((r) => r.id === supersedes)
        : undefined;
      plan.newUnconfirmed.push({
        slug,
        topic,
        scope,
        principle,
        evidencedBy,
        sign,
        ...(supersedesRecord
          ? {
              supersedes: renderPrefLink({
                id: supersedesRecord.id,
                principle: supersedesRecord.principle,
              }),
            }
          : {}),
      });
      // Every contributing signal in the window gets moved.
      for (const s of windowedSigs) {
        recordSignalMove(plan, s);
      }
    } else if (positives.length > 0 && negatives.length > 0) {
      plan.contradictionTopics.add(topic);
    }
  }
  return plan;
}

function handleSignalsOnActivePref(
  active: PreferenceRecord,
  sigs: SignalRecord[],
  plan: PlanState,
  cfg: BrainConfig,
  now: Date,
  allSignals: ReadonlyArray<SignalRecord>,
  reservedSlugs: Set<string>,
): void {
  // Determine the active preference's sign. Order of preference:
  //
  //   1. Walk `evidenced_by` wikilinks and look up each referenced
  //      signal in the global scan; the dominant sign among them is
  //      the pref's "sign of record". This is the design-correct
  //      derivation since the writer baked those evidence pointers in.
  //
  //   2. If no `evidenced_by` resolves (e.g. a hand-crafted pref or a
  //      pref whose source signals were manually pruned), look at all
  //      historical signals on the same topic in the global scan.
  //
  //   3. If still nothing, assume the active pref is on the OPPOSITE
  //      sign of the incoming dominant sign. This makes a unanimous
  //      flood of new signals always count as rebuttal — which is the
  //      conservative, fail-loud choice: the operator gets a clear
  //      rebut/retire signal and can manually intervene if the system
  //      misread their intent.
  const signCounts = (records: ReadonlyArray<SignalRecord>): { pos: number; neg: number } => {
    let pos = 0;
    let neg = 0;
    for (const r of records) {
      if (r.signal.signal === BRAIN_SIGNAL_SIGN.positive) pos++;
      else if (r.signal.signal === BRAIN_SIGNAL_SIGN.negative) neg++;
    }
    return { pos, neg };
  };

  const evidenceIds = new Set(
    active.pref.evidenced_by
      .map((wl) => parseWikilink(wl))
      .filter((s): s is string => !!s),
  );
  const evidenceRecords = allSignals.filter((r) => evidenceIds.has(r.signal.id));
  const topicRecords = allSignals.filter((r) => r.signal.topic === active.pref.topic);

  let activeSign: BrainSignalSign;
  if (evidenceRecords.length > 0) {
    const c = signCounts(evidenceRecords);
    activeSign = c.pos >= c.neg ? BRAIN_SIGNAL_SIGN.positive : BRAIN_SIGNAL_SIGN.negative;
  } else if (topicRecords.length > sigs.length) {
    // There are processed signals for this topic that are NOT among
    // the active inbox set — use them.
    const historical = topicRecords.filter((r) => !sigs.includes(r));
    const c = signCounts(historical);
    activeSign = c.pos >= c.neg ? BRAIN_SIGNAL_SIGN.positive : BRAIN_SIGNAL_SIGN.negative;
  } else {
    // Fallback: assume the active pref is OPPOSITE to the incoming
    // dominant sign. A unanimous flood thus reads as rebuttal.
    const c = signCounts(sigs);
    activeSign =
      c.pos > c.neg ? BRAIN_SIGNAL_SIGN.negative : BRAIN_SIGNAL_SIGN.positive;
  }

  const oppositeSign: BrainSignalSign =
    activeSign === BRAIN_SIGNAL_SIGN.positive
      ? BRAIN_SIGNAL_SIGN.negative
      : BRAIN_SIGNAL_SIGN.positive;

  const windowed = filterWithinWindow(sigs, cfg.dream.contradiction_window_days, now);
  const sameSign = windowed.filter((s) => s.signal.signal === activeSign);
  const opposing = windowed.filter((s) => s.signal.signal === oppositeSign);

  // Same-sign → note redundant + move to processed.
  for (const s of sameSign) {
    plan.notedRedundant.push({
      preference: renderPrefLink({
        id: active.pref.id,
        principle: active.pref.principle,
      }),
      signal: `[[${s.signal.id}]]`,
    });
    recordSignalMove(plan, s);
  }

  // Opposite-sign → accumulate toward rebuttal.
  if (opposing.length >= cfg.dream.candidate_threshold) {
    const slug = active.pref.id.startsWith("pref-")
      ? active.pref.id.slice("pref-".length)
      : active.pref.id;
    if (isPinned(active.pref)) {
      plan.retainPinned.push({
        preference: renderPrefLink({
          id: active.pref.id,
          principle: active.pref.principle,
        }),
        reason: BRAIN_RETIRED_REASON.rebutted,
      });
      // Rebuttal signals on a pinned pref still get moved out — they
      // were addressed (the system saw them) and clogging the inbox
      // doesn't help.
      for (const s of opposing) recordSignalMove(plan, s);
    } else {
      plan.retires.push({
        slug,
        principle: active.pref.principle,
        reason: BRAIN_RETIRED_REASON.rebutted,
      });
      for (const s of opposing) recordSignalMove(plan, s);
      // Create a new unconfirmed pref for the new direction.
      // Build a fresh slug to avoid filename collision with the
      // retiring pref (which lives under preferences/<slug>.md and
      // will move to retired/<slug>.md). The simplest scheme: the
      // same slug, since `moveToRetired` unlinks the source first.
      // For safety against a half-completed move, we suffix with
      // `-rebut`.
      const newSlug = allocatePreferencePlanSlug(`${slug}-rebut`, reservedSlugs);
      const principle = opposing[0]!.signal.principle;
      const scope = opposing[0]!.signal.scope;
      const evidencedBy = opposing.map((s) => `[[${s.signal.id}]]`);
      plan.newUnconfirmed.push({
        slug: newSlug,
        topic: active.pref.topic,
        scope,
        principle,
        evidencedBy,
        sign: oppositeSign,
        supersedes: renderPrefLink({
          id: active.pref.id,
          principle: active.pref.principle,
        }),
      });
    }
  } else if (opposing.length > 0) {
    plan.contradictionTopics.add(active.pref.topic);
  }
}

function collectReservedPreferenceSlugs(scan: ScanResult): Set<string> {
  const out = new Set<string>();
  for (const p of scan.preferences) {
    const slug = preferenceSlugFromId(p.pref.id, "pref-");
    if (slug) out.add(slug);
  }
  for (const r of scan.retired) {
    const slug = preferenceSlugFromId(r.id, "ret-");
    if (slug) out.add(slug);
  }
  return out;
}

function preferenceSlugFromId(id: string, prefix: "pref-" | "ret-"): string | null {
  return id.startsWith(prefix) && id.length > prefix.length
    ? id.slice(prefix.length)
    : null;
}

function allocatePreferencePlanSlug(base: string, reserved: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  reserved.add(candidate);
  return candidate;
}

function recordSignalMove(plan: PlanState, rec: SignalRecord): void {
  if (!rec.active) return;
  const id = rec.signal.id;
  if (plan.signalsToMove.has(id)) return;
  // Derive date + slug from the id (`sig-YYYY-MM-DD-<slug>`).
  const m = /^sig-(\d{4}-\d{2}-\d{2})-(.+)$/.exec(id);
  if (!m) return;
  plan.signalsToMove.set(id, {
    id,
    date: m[1]!,
    slug: m[2]!,
    path: rec.path,
  });
}

function filterWithinWindow(
  sigs: SignalRecord[],
  windowDays: number,
  now: Date,
): SignalRecord[] {
  const minTime = now.getTime() - windowDays * 24 * 3600 * 1000;
  return sigs.filter((s) => {
    const t = Date.parse(s.signal.created_at);
    return Number.isFinite(t) && t >= minTime;
  });
}

// ----- Refresh + promote --------------------------------------------------

interface RefreshUpdate {
  readonly slug: string;
  readonly topic: string;
  readonly scope?: string;
  readonly principle: string;
  readonly created_at: string;
  readonly unconfirmed_until: string;
  readonly status: typeof BRAIN_PREFERENCE_STATUS[keyof typeof BRAIN_PREFERENCE_STATUS];
  readonly evidenced_by: ReadonlyArray<string>;
  readonly confirmed_at: string | null;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly last_evidence_at: string | null;
  readonly confidence: BrainConfidence;
  readonly confidence_value: number;
  readonly pinned: boolean;
}

/**
 * Pref → recorded band drop within the current dream pass. Captured
 * during refresh so the digest can render a `## Confidence drops`
 * section without re-deriving transitions from the log.
 */
export interface RefreshBandDrop {
  readonly id: string;
  readonly principle: string;
  readonly previous: BrainConfidence;
  readonly next: BrainConfidence;
  readonly applied: number;
  readonly violated: number;
  readonly previous_value: number | null;
  readonly next_value: number;
}

interface RefreshResult {
  /** Slugs transitioning unconfirmed → confirmed in THIS run. */
  readonly confirmed: Set<string>;
  /** Slug → full updated frontmatter to write. */
  readonly updated: Map<string, RefreshUpdate>;
  /**
   * Preferences whose `confidence` band dropped (e.g. `high → medium`)
   * during the refresh phase. Newest-first stable order (insertion
   * order at construction).
   */
  readonly bandDrops: RefreshBandDrop[];
}

interface ApplyEvidenceEntry {
  readonly pref_slug: string;
  readonly timestamp: string;
  readonly result: typeof BRAIN_APPLY_RESULT[keyof typeof BRAIN_APPLY_RESULT];
}

function scanApplyEvidence(vault: string): ApplyEvidenceEntry[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return [];
  const out: ApplyEvidenceEntry[] = [];
  const mergeAliases = new Map<string, string>();
  for (const name of readdirSync(dirs.log)) {
    if (!name.endsWith(".md")) continue;
    const date = name.slice(0, -3);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const { entries } = parseLogDay(vault, date);
    for (const e of entries) {
      if (e.eventType === BRAIN_LOG_EVENT_KIND.merge) {
        const keep = parseWikilinkFromBodyValue(e.body["keep"]);
        const drop = parseWikilinkFromBodyValue(e.body["drop"]);
        if (keep?.startsWith("pref-") && drop?.startsWith("pref-")) {
          mergeAliases.set(
            drop.slice("pref-".length),
            resolveMergeAlias(keep.slice("pref-".length), mergeAliases),
          );
        }
        continue;
      }
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      const prefRaw = e.body["preference"];
      const result = e.body["result"];
      if (typeof prefRaw !== "string" || typeof result !== "string") continue;
      if (
        result !== BRAIN_APPLY_RESULT.applied &&
        result !== BRAIN_APPLY_RESULT.violated &&
        result !== BRAIN_APPLY_RESULT.outdated
      ) continue;
      // Parse `[[pref-slug]]` → slug.
      const target = parseWikilink(prefRaw);
      if (!target || !target.startsWith("pref-")) continue;
      out.push({
        pref_slug: target.slice("pref-".length),
        timestamp: e.timestamp,
        result: result as ApplyEvidenceEntry["result"],
      });
    }
  }
  const resolved = out.map((entry) => ({
    ...entry,
    pref_slug: resolveMergeAlias(entry.pref_slug, mergeAliases),
  }));
  // Stable order: by timestamp ascending. Multiple entries at the same
  // second keep their parse order (parseLogDay returns insertion order).
  resolved.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return resolved;
}

function parseWikilinkFromBodyValue(value: unknown): string | null {
  return typeof value === "string" ? parseWikilink(value) : null;
}

function resolveMergeAlias(
  slug: string,
  aliases: ReadonlyMap<string, string>,
): string {
  let current = slug;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliases.get(current);
    if (!next) return current;
    current = next;
  }
  return current;
}

function planRefresh(
  vault: string,
  scan: ScanResult,
  evidence: ApplyEvidenceEntry[],
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
): RefreshResult {
  const confirmed = new Set<string>();
  const updated = new Map<string, RefreshUpdate>();
  const bandDrops: RefreshBandDrop[] = [];

  // Index evidence by slug.
  const bySlug = new Map<string, ApplyEvidenceEntry[]>();
  for (const e of evidence) {
    const arr = bySlug.get(e.pref_slug);
    if (arr) arr.push(e);
    else bySlug.set(e.pref_slug, [e]);
  }

  // Slugs that will retire this run — we skip refresh for those so the
  // retired/ snapshot reflects the pre-refresh counters (which is the
  // existing test expectation in moveToRetired).
  const retiringSlugs = new Set(plan.retires.map((r) => r.slug));

  for (const rec of scan.preferences) {
    const slug = rec.pref.id.startsWith("pref-")
      ? rec.pref.id.slice("pref-".length)
      : rec.pref.id;
    if (retiringSlugs.has(slug)) continue;

    const ev = bySlug.get(slug) ?? [];
    const applied = ev.filter((e) => e.result === BRAIN_APPLY_RESULT.applied).length;
    const violated = ev.filter((e) => e.result === BRAIN_APPLY_RESULT.violated).length;
    const outdatedCount = ev.filter((e) => e.result === BRAIN_APPLY_RESULT.outdated).length;
    const lastEvidence = ev.length > 0 ? ev[ev.length - 1]!.timestamp : null;
    const firstApplied = ev.find((e) => e.result === BRAIN_APPLY_RESULT.applied);

    // `outdated` is a context-driven retire signal: a single event
    // means the rule's scope still matches but the artifact shows
    // the rule itself is obsolete (framework migration, convention
    // change). Pin protects against decay-based retires but NOT
    // against context-driven ones — pinning means "I want this
    // rule"; an `outdated` event means "context says this rule no
    // longer applies anywhere." Honour the explicit signal.
    //
    // Idempotency: once retired, the pref moves to `retired/` and
    // future dream passes don't re-process it from `preferences/`.
    if (outdatedCount > 0) {
      plan.retires.push({
        slug,
        principle: rec.pref.principle,
        reason: BRAIN_RETIRED_REASON.supersededByContext,
      });
      continue;
    }

    let status = rec.pref.status;
    let confirmedAt = rec.pref.confirmed_at;
    if (status === BRAIN_PREFERENCE_STATUS.unconfirmed && firstApplied) {
      status = BRAIN_PREFERENCE_STATUS.confirmed;
      confirmedAt = firstApplied.timestamp;
      confirmed.add(slug);
    }

    // Quarantine transitions — only applicable to already-confirmed
    // and already-quarantined preferences. An unconfirmed pref still
    // promotes via the firstApplied branch above; quarantine entry is
    // measured against `confirmed` counts. Detailed semantics live on
    // `BRAIN_PREFERENCE_STATUS.quarantine` in `types.ts`.
    if (
      status === BRAIN_PREFERENCE_STATUS.confirmed &&
      violated >= applied &&
      applied > cfg.confidence.low_max_applied
    ) {
      status = BRAIN_PREFERENCE_STATUS.quarantine;
    } else if (status === BRAIN_PREFERENCE_STATUS.quarantine) {
      const newViolated = violated > rec.pref.violated_count;
      if (newViolated) {
        if (isPinned(rec.pref)) {
          plan.retainPinned.push({
            preference: renderPrefLink({
              id: rec.pref.id,
              principle: rec.pref.principle,
            }),
            reason: BRAIN_RETIRED_REASON.quarantineViolated,
          });
        } else {
          plan.retires.push({
            slug,
            principle: rec.pref.principle,
            reason: BRAIN_RETIRED_REASON.quarantineViolated,
          });
          // Skip refresh — moveToRetired will read the on-disk
          // counters when it builds the retired snapshot.
          continue;
        }
      } else if (applied > violated) {
        status = BRAIN_PREFERENCE_STATUS.confirmed;
      }
    }

    const confidence = computeConfidence(
      applied,
      violated,
      lastEvidence,
      cfg,
      now,
    );

    // Idempotency on a no-op rerun: skip refresh for prefs where
    // counters AND status are unchanged AND the on-disk body already
    // matches what we would render with current evidence. The second
    // half (body comparison) is what carries the v0.10.1 migration
    // forward — a pref whose counters are stable but whose body
    // still has the v0.9.x placeholder will fail the body check and
    // get rewritten on the next pass.
    const previousValue = rec.pref.confidence_value;
    // For numeric drift, `null` on disk (legacy pre-v0.10.3 file) is
    // treated as "matches whatever we just computed" so a no-op
    // rerun stays a no-op. The body-bytes check in
    // `wouldRewritePreference` below still triggers the one-off
    // migration write because the legacy frontmatter shape will not
    // match the new one byte-for-byte.
    const valueDifferent =
      previousValue !== null
      && Math.abs(previousValue - confidence.value) > 1e-6;
    const countersChanged =
      applied !== rec.pref.applied_count ||
      violated !== rec.pref.violated_count ||
      lastEvidence !== rec.pref.last_evidence_at ||
      status !== rec.pref.status ||
      confirmedAt !== rec.pref.confirmed_at ||
      confidence.band !== rec.pref.confidence ||
      valueDifferent;

    const prospective = {
      slug,
      topic: rec.pref.topic,
      ...(rec.pref.scope ? { scope: rec.pref.scope } : {}),
      principle: rec.pref.principle,
      created_at: rec.pref.created_at,
      unconfirmed_until: rec.pref.unconfirmed_until,
      status,
      evidenced_by: rec.pref.evidenced_by,
      confirmed_at: confirmedAt,
      applied_count: applied,
      violated_count: violated,
      last_evidence_at: lastEvidence,
      confidence: confidence.band,
      confidence_value: confidence.value,
      pinned: rec.pref.pinned,
    };

    if (!countersChanged) {
      const ev2 = collectEvidenceForSlug(vault, slug, {
        sinceIso: rec.pref.created_at,
      });
      if (
        !wouldRewritePreference(vault, {
          ...prospective,
          recentApplied: ev2.applied,
          recentViolated: ev2.violated,
        })
      ) {
        // Counters and body both unchanged — true no-op for this pref.
        continue;
      }
    }

    updated.set(slug, prospective);

    // Capture band drops for the digest. A drop is any transition
    // where the new band ranks lower than the previous (high →
    // medium, medium → low, high → low). Stable across re-runs as
    // long as the underlying counters do — the digest only renders
    // it when a real transition occurred in this pass.
    if (BAND_RANK[confidence.band] < BAND_RANK[rec.pref.confidence]) {
      bandDrops.push(
        Object.freeze({
          id: rec.pref.id,
          principle: rec.pref.principle,
          previous: rec.pref.confidence,
          next: confidence.band,
          applied,
          violated,
          previous_value: rec.pref.confidence_value,
          next_value: confidence.value,
        }),
      );
    }
  }

  return { confirmed, updated, bandDrops };
}

/**
 * Confidence computation. Returns both the categorical band (the
 * existing agent-visible contract) and the numeric value behind it
 * (§10 Tier-A addition).
 *
 * The numeric value is `Wilson 95% lower bound × freshness decay`:
 *
 *   - `wilson_low(applied, n)` where `n = applied + violated` —
 *     a conservative lower bound on the application rate. `n == 0`
 *     yields `0`.
 *   - `freshness` linearly decays from `1.0` at age 0 to `0.0` at
 *     `retire.stale_evidence_days`. `null` last_evidence_at → `0`.
 *
 * Band derivation is the **max** of two views:
 *
 *   1. The legacy step-function (kept verbatim) — preserves every
 *      published boundary so existing tests and agent contracts stay
 *      intact: `applied <= low_max_applied` ⇒ `low`,
 *      `violated >= applied` ⇒ `low`, `applied >= high_min_applied ∧
 *      violated == 0 ∧ fresh` ⇒ `high`, else `medium`.
 *   2. The numeric thresholds (`medium_min`, `high_min`) applied to
 *      `value` — gives a `low | medium | high` view that can only
 *      lift the legacy band, never lower it.
 *
 * Taking the max means a future operator can lower `high_min` to
 * promote `medium` prefs to `high` based on observed performance,
 * without ever demoting a pref that the legacy view already calls
 * `high` (because the legacy floor sticks). The numeric value is
 * always returned and is what the digest's drop tracker compares
 * across runs.
 */
export interface ConfidenceComputeResult {
  readonly value: number;
  readonly band: BrainConfidence;
}

const BAND_RANK: Readonly<Record<BrainConfidence, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

export function computeConfidence(
  applied: number,
  violated: number,
  lastEvidenceAt: string | null,
  cfg: BrainConfig,
  now: Date,
): ConfidenceComputeResult {
  const n = applied + violated;
  let wilsonLow = 0;
  if (n > 0) {
    const z = 1.96;
    const z2 = z * z;
    const pHat = applied / n;
    const denom = 1 + z2 / n;
    const centre = (pHat + z2 / (2 * n)) / denom;
    const margin =
      (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
    wilsonLow = Math.max(0, centre - margin);
  }
  let freshness = 0;
  if (lastEvidenceAt) {
    const ageMs = now.getTime() - Date.parse(lastEvidenceAt);
    if (Number.isFinite(ageMs)) {
      const limitMs = cfg.retire.stale_evidence_days * 24 * 3600 * 1000;
      if (limitMs > 0) {
        freshness = Math.max(0, Math.min(1, 1 - ageMs / limitMs));
      }
    }
  }
  const rawValue = wilsonLow * freshness;
  const value = Math.round(rawValue * 10000) / 10000;

  // Legacy step-function band (the published contract).
  let legacyBand: BrainConfidence = BRAIN_CONFIDENCE.medium;
  if (applied <= cfg.confidence.low_max_applied) {
    legacyBand = BRAIN_CONFIDENCE.low;
  } else if (applied > 0 && violated >= applied) {
    legacyBand = BRAIN_CONFIDENCE.low;
  } else {
    let highEligibleFresh = false;
    if (lastEvidenceAt) {
      const ageMs = now.getTime() - Date.parse(lastEvidenceAt);
      const freshLimitMs =
        cfg.retire.stale_evidence_days *
        cfg.confidence.high_freshness_factor *
        24 *
        3600 *
        1000;
      highEligibleFresh = Number.isFinite(ageMs) && ageMs < freshLimitMs;
    }
    if (
      applied >= cfg.confidence.high_min_applied
      && violated === 0
      && highEligibleFresh
    ) {
      legacyBand = BRAIN_CONFIDENCE.high;
    } else {
      legacyBand = BRAIN_CONFIDENCE.medium;
    }
  }

  // Numeric-threshold band (can only lift legacy when paired via max).
  let numericBand: BrainConfidence;
  if (value >= cfg.confidence.high_min) {
    numericBand = BRAIN_CONFIDENCE.high;
  } else if (value >= cfg.confidence.medium_min) {
    numericBand = BRAIN_CONFIDENCE.medium;
  } else {
    numericBand = BRAIN_CONFIDENCE.low;
  }

  const band =
    BAND_RANK[numericBand] > BAND_RANK[legacyBand] ? numericBand : legacyBand;
  return Object.freeze({ value, band });
}

// ----- Auto-retires (expired-unconfirmed, stale-no-evidence) --------------

function planAutoRetires(
  scan: ScanResult,
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
  refresh: RefreshResult,
): void {
  for (const rec of scan.preferences) {
    const slug = rec.pref.id.startsWith("pref-")
      ? rec.pref.id.slice("pref-".length)
      : rec.pref.id;
    // Already planned to retire (rebutted)? Skip.
    if (plan.retires.some((r) => r.slug === slug)) continue;

    // Use the refreshed status/confirmed_at if available — a pref
    // promoted to confirmed in THIS run should be eligible for stale
    // retire only if its (yet-to-be-refreshed) last_evidence_at is
    // actually old. We branch on the post-refresh shape.
    const refreshed = refresh.updated.get(slug);
    const effectiveStatus = refreshed ? refreshed.status : rec.pref.status;
    const effectiveLastEvidence = refreshed
      ? refreshed.last_evidence_at
      : rec.pref.last_evidence_at;

    if (effectiveStatus === BRAIN_PREFERENCE_STATUS.unconfirmed) {
      const deadline = Date.parse(rec.pref.unconfirmed_until);
      if (Number.isFinite(deadline) && now.getTime() > deadline) {
        if (isPinned(rec.pref)) {
          plan.retainPinned.push({
            preference: renderPrefLink({
              id: rec.pref.id,
              principle: rec.pref.principle,
            }),
            reason: BRAIN_RETIRED_REASON.expiredUnconfirmed,
          });
        } else {
          plan.retires.push({
            slug,
            principle: rec.pref.principle,
            reason: BRAIN_RETIRED_REASON.expiredUnconfirmed,
          });
          // Remove the refresh update — no point writing immediately
          // before moving to retired/.
          refresh.updated.delete(slug);
        }
      }
      continue;
    }

    // Confirmed/quarantine → stale-no-evidence check. Quarantine
    // is "still active" (design summary §20) so the time-based decay
    // applies to it identically — a pref sitting idle with no
    // evidence eventually retires whether confidence was healthy or
    // probationary at the time the clock ran out.
    if (
      effectiveStatus === BRAIN_PREFERENCE_STATUS.confirmed ||
      effectiveStatus === BRAIN_PREFERENCE_STATUS.quarantine
    ) {
      if (!effectiveLastEvidence) {
        // Confirmed with no evidence at all? Shouldn't happen, but
        // gate on the same staleness rule using `confirmed_at`. We
        // measure from confirmation in that case (cheaper than a
        // hand-crafted invariant check).
        const confirmedAt = refreshed
          ? refreshed.confirmed_at
          : rec.pref.confirmed_at;
        if (!confirmedAt) continue;
        const days = daysBetween(Date.parse(confirmedAt), now.getTime());
        if (days > cfg.retire.stale_evidence_days) {
          if (isPinned(rec.pref)) {
            plan.retainPinned.push({
              preference: renderPrefLink({
                id: rec.pref.id,
                principle: rec.pref.principle,
              }),
              reason: BRAIN_RETIRED_REASON.staleNoEvidence,
            });
          } else {
            plan.retires.push({
              slug,
              principle: rec.pref.principle,
              reason: BRAIN_RETIRED_REASON.staleNoEvidence,
            });
            refresh.updated.delete(slug);
          }
        }
        continue;
      }
      const days = daysBetween(Date.parse(effectiveLastEvidence), now.getTime());
      if (days > cfg.retire.stale_evidence_days) {
        if (isPinned(rec.pref)) {
          plan.retainPinned.push({
            preference: renderPrefLink({
              id: rec.pref.id,
              principle: rec.pref.principle,
            }),
            reason: BRAIN_RETIRED_REASON.staleNoEvidence,
          });
        } else {
          plan.retires.push({
            slug,
            principle: rec.pref.principle,
            reason: BRAIN_RETIRED_REASON.staleNoEvidence,
          });
          refresh.updated.delete(slug);
        }
      }
    }
  }
}

// ----- Signal moves -------------------------------------------------------

function planSignalMoves(scan: ScanResult, plan: PlanState): void {
  // All active signals whose topic now corresponds to a planned new
  // pref or an active pref were already enqueued by the topic-loop /
  // active-pref handler. This function exists for the §7.3 step that
  // says "Move consumed signals out of inbox/": we cover the case
  // where a signal references a preference that already exists (the
  // active-pref path), and the case where a signal is part of a fresh
  // new_unconfirmed (the topic-loop path). Both already populated
  // `plan.signalsToMove`. Nothing additional needed here today.
  void scan;
  void plan;
}

// ----- Helpers ------------------------------------------------------------

function writeEvent(vault: string, event: BrainLogEntry): void {
  appendLogEvent(vault, event);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 3600 * 1000);
}

function daysBetween(thenMs: number, nowMs: number): number {
  if (!Number.isFinite(thenMs)) return 0;
  return (nowMs - thenMs) / (24 * 3600 * 1000);
}

function formatRunId(d: Date): string {
  // dream-YYYY-MM-DD-HHMMSS
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `dream-${yyyy}-${mm}-${dd}-${hh}${mi}${ss}`;
}

// Silence "unused" warnings for symbols exported only via barrel.
void basename;

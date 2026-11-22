/**
 * The dream pass's mutation stage: turn a decided plan into disk state.
 *
 * One reason to change: the ORDER and mechanics of the writes. Nothing
 * here decides anything about the vault's contents — every choice was
 * already made by the planning stages. What this module owns is the
 * sequence that keeps the on-disk invariants true:
 *
 *   1. Write new unconfirmed preferences (so signal moves can find
 *      them).
 *   2. Apply refresh (counters, confidence, promotion) to existing
 *      preferences.
 *   3. Move retiring preferences out (after the refresh has had a
 *      chance to surface the most recent counters in the retired
 *      file). NOTE: refresh skips entries that will retire.
 *   4. Move consumed signals into `processed/`.
 *
 * Log emission is stage 5 and lives in `dream-report.ts`.
 *
 * Workrun checkpoints are emitted here rather than by the orchestrator
 * because a marker must mean "every durable effect attributed to that
 * phase is already on disk" — only the code that performs the writes
 * knows where that point is.
 */

import { sameDevIno } from "../fs-identity.ts";
import { legacyVaultOf } from "./no-vault.ts";
import type { Authority } from "../store/constants.ts";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename } from "node:path";

import { openReceiptBatch } from "./decisions/receipts.ts";
import { preferenceSlug, type PlanState } from "./dream-plan.ts";
import { SafeguardAbortError, SafeguardTimeoutError, type Safeguard } from "./safeguard.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import type { DreamGatedRetireEntry } from "./dream-types.ts";
import { WORKRUN_PHASE, type WorkrunHandle } from "./dream-workrun.ts";
import { runHealEnrichment } from "./heal-run.ts";
import { CHAIN_DECAY_STALE_DAYS } from "./inject-governor.ts";
import { appendLogEvent } from "./log.ts";
import { archivedSignalPath, brainDirs, preferencePathOf, processedSignalPath } from "./paths.ts";
import { loadPreference, moveToRetired, preferenceFromStoreEntry } from "./preference.ts";
import { isRetiredEntry, preferencesStoreOnly, storePreferenceEntry } from "./preference-store.ts";
import { writePreferenceTxn } from "./preference-txn.ts";
import { isoSecond } from "./time.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainConfig,
  type BrainPreference,
  type BrainRetiredReason,
} from "./types.ts";
import { renameWithRetry } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { routeSignalState, signalsStoreOnly, writeStoreSignalStates } from "./signal-state.ts";
import {
  configuredStore,
  holdStoreEntities,
  readStoreEntities,
  type HeldEntities,
  type StorePreference,
} from "../store/read/store-entities.ts";
import { readShard, shardReadGap } from "../store/reader.ts";
import { listShards } from "../store/shard-list.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { partitionDir } from "../store/store-paths.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import type { WindowContext, WindowEvidence } from "./dream-replay/window.ts";

/**
 * The authority of every dream write under brain store dual writes: dream
 * is an automatic pass, so it decides as an agent even when an operator
 * started it from the CLI.
 */
const DREAM_AUTHORITY = "agent" satisfies Authority;

const DAY_MS = 24 * 3600 * 1000;

/** Agent of record when the caller declared no name. */
const DEFAULT_DREAM_AGENT = "dream";

export interface DreamApplyInput {
  readonly vault: string | null;
  readonly cfg: BrainConfig;
  readonly plan: PlanState;
  readonly refresh: RefreshResult;
  readonly window: WindowContext<WindowEvidence>;
  /** Identity threaded into edit-history and decision receipts. */
  readonly agentName: string | undefined;
  /** `[[Brain/log/<date>]]`, stamped as `retired_by` on each move. */
  readonly wikilinkToRun: string;
  /** Resolved `dream.heal_enrich` gate for this run. */
  readonly healEnrichEnabled: boolean;
  /**
   * The pass's cooperative deadline, forwarded to the one sub-unit here
   * that is unbounded in the vault's size: the opt-in heal enrichment,
   * which reads and rewrites every user page outside `Brain/`. Nothing
   * else in this module iterates over anything but the decided plan, so
   * nothing else needs it.
   */
  readonly safeguard?: Safeguard;
  readonly workrun: WorkrunHandle | null;
}

export interface DreamApplyResult {
  /** Signal ids actually moved into `processed/`. */
  readonly moved: string[];
  /** Signal ids actually moved into `inbox/archived/`. */
  readonly archived: string[];
  /** Retires the destructive-from-confirmed gate declined. */
  readonly gatedRetires: DreamGatedRetireEntry[];
  /** User pages the opt-in heal phase enriched. */
  readonly healEnriched: number;
}

/**
 * Signal ids a dry run WOULD move. Reported so the caller's summary is
 * accurate without touching disk.
 */
export function plannedSignalMoveIds(plan: PlanState): string[] {
  return Array.from(plan.signalsToMove.values(), (sig) => sig.id);
}

/** Signal ids a dry run WOULD archive; the archive step's dry-run count. */
export function plannedSignalArchiveIds(plan: PlanState): string[] {
  return Array.from(plan.signalsToArchive.values(), (sig) => sig.id);
}

export function applyDreamPlan(input: DreamApplyInput): DreamApplyResult {
  const { vault, cfg, plan, refresh, wikilinkToRun, workrun } = input;
  const now = input.window.instant;
  const agent = input.agentName ?? DEFAULT_DREAM_AGENT;

  // This module renames signal files directly, so it owes the vault-identity
  // assertion on its own entry rather than trusting whoever called it. The
  // check is an idempotent in-memory pin and the caller's `openWorkrun` has
  // already satisfied it for this root, so it never fires twice in anger.
  // With no vault the store writes check the store identity (D14 item 13).
  if (vault !== null) assertVaultIdentityForWrite(vault);

  // Each rewrite's confidence receipt is written right after it, so a pass
  // stopped at its deadline between two rewrites still leaves the receipt
  // of every band change it wrote (the next pass sees the new band and
  // plans no receipt for it); the rest are written after the loop.
  const receipts = confidenceReceipts(vault, refresh, agent, now);
  writePreferences(input, agent, receipts);
  receipts.rest();

  // Synthesize is durable here and nowhere earlier: every new
  // unconfirmed preference, every refreshed preference and every
  // confidence receipt has landed. `promote_complete` is the pre-F2
  // name for the same writes, so it moves with it rather than being
  // left behind claiming a batch that had not started.
  workrun?.checkpoint(WORKRUN_PHASE.promoteComplete);
  workrun?.checkpoint(WORKRUN_PHASE.synthesizeComplete);

  const gatedRetires = executeRetires(
    vault,
    cfg,
    now,
    plan,
    wikilinkToRun,
    input.window,
    input.safeguard,
  );

  // Every planned retire has been moved (or explicitly gated) by here.
  workrun?.checkpoint(WORKRUN_PHASE.retireComplete);

  const moved = moveConsumedSignals(vault, plan);
  const archived = archiveStaleSignals(vault, plan);
  const healEnriched = input.healEnrichEnabled
    ? runHealEnrichmentSafely(vault, input.safeguard)
    : 0;

  // Heal's second half (the optional enrichment) is durable here; its
  // first half was the retire loop above. The marker sits at the later
  // of the two, so it is never a claim about work still to come.
  workrun?.checkpoint(WORKRUN_PHASE.healComplete);

  return { moved, archived, gatedRetires, healEnriched };
}

/**
 * Steps 1 and 2: create the freshly-promoted preferences, then rewrite
 * the refreshed ones.
 *
 * Edit-history (F4): every dream-pass write records its content
 * before/after so a preference's evolution stays auditable. The agent of
 * record is whoever invoked the dream run.
 *
 * v0.12.0 Brain Integrity Suite: both loops route through
 * `writePreferenceTxn` so `_revision` auto-stamps and `_content_hash`
 * lands automatically on confirmed promotions. The empty expectations
 * array is deliberate - dream's plan-time logic has already decided to
 * proceed; the txn just owns the bookkeeping.
 */
function writePreferences(
  input: DreamApplyInput,
  agent: string,
  receipts: ConfidenceReceipts,
): void {
  const { vault, cfg, plan, refresh } = input;
  const now = input.window.instant;
  const historyOpts = { agent, now: () => now };

  for (const np of plan.newUnconfirmed) {
    // Fresh pref has no apply-evidence yet; recentApplied/recentViolated
    // start empty and stay so until the next dream pass after the
    // first `brain_apply_evidence` event.
    writePreferenceTxn(
      vault,
      {
        slug: np.slug,
        topic: np.topic,
        principle: np.principle,
        created_at: isoSecond(now),
        unconfirmed_until: isoSecond(addDays(now, cfg.dream.unconfirmed_window_days)),
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
        // The scope is read back from stored signals: a legacy value
        // must not abort the pass (see `lenientScopeTags`).
        lenientScopeTags: true,
        ...(np.supersedes ? { supersedes: np.supersedes } : {}),
        // F5: bi-temporal validity extracted from the source signal.
        ...(np.valid_from ? { valid_from: np.valid_from } : {}),
        ...(np.valid_until ? { valid_until: np.valid_until } : {}),
        // The strictest visibility of the records it was drafted from.
        ...(np.visibility.length > 0 ? { visibility: np.visibility } : {}),
      },
      [],
      { overwrite: false, authority: DREAM_AUTHORITY },
      historyOpts,
    );
  }

  // Cross-topic rule promotion (t_642bc2b8): the planned rule is an
  // ordinary unconfirmed preference through the same txn chokepoint -
  // `inferred` provenance plus the evidence wikilinks and `related`
  // lineage are what make it a promotion rather than a new claim.
  // `overwrite: false` like the topic plan: the planner's content-slug
  // dedup already decided the file is new, and a surprise collision
  // must fail loudly rather than clobber.
  for (const ct of plan.crossTopicRules) {
    writePreferenceTxn(
      vault,
      {
        slug: ct.slug,
        topic: ct.topic,
        principle: ct.principle,
        created_at: isoSecond(now),
        unconfirmed_until: isoSecond(addDays(now, cfg.dream.unconfirmed_window_days)),
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        evidenced_by: ct.evidencedBy,
        // No evidence yet, matching the topic plan's pre-seeding.
        confidence_value: 0,
        recentApplied: [],
        recentViolated: [],
        provenance: "inferred",
        related: ct.related,
        // The strictest visibility of the sources (review finding 63):
        // the rule restates a source's principle verbatim, so it may
        // never land at default visibility behind a restricted source.
        // Written only when non-empty, like the topic plan's stamp.
        ...(ct.visibility.length > 0 ? { visibility: ct.visibility } : {}),
        // The sources' shared owner token, so owner-scoped recall keeps
        // the rule as private as its sources; ownerless rules omit it.
        ...(ct.owner ? { owner: ct.owner } : {}),
      },
      [],
      { overwrite: false, authority: DREAM_AUTHORITY },
      historyOpts,
    );
  }

  for (const update of refresh.updated.values()) {
    // Between rewrites: each is a whole write of one preference that the
    // next pass plans again from what is on disk, so a pass past its
    // deadline stops here with what it wrote kept, rather than after the
    // last of hundreds of rewrites on a migrated store.
    input.safeguard?.checkpoint();
    // Rebuild the evidence slice from the log on every pass so the
    // pref body stays in sync with the counters even when the
    // counters themselves stayed put (e.g. dropping the
    // v0.9.x placeholder body during a no-counter-change run).
    const ev = input.window.evidence.lookup(update.slug, {
      sinceIso: update.created_at,
    });
    // The freshness trend was classified at PLAN time (planRefresh)
    // so the no-op pre-flight rendered these exact bytes.
    writePreferenceTxn(
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
        ...(update.freshness_trend !== undefined
          ? { freshness_trend: update.freshness_trend }
          : {}),
        // Derived-fact fields (finding 77): the update carries a promoted
        // rule's provenance and lineage through its counter changes, in
        // the same render position the writer uses, so the bytes match
        // the no-op pre-flight and the fields survive every rewrite.
        ...(update.provenance !== undefined ? { provenance: update.provenance } : {}),
        ...(update.related !== undefined && update.related.length > 0
          ? { related: update.related }
          : {}),
        // The record's `visibility:` tokens (review round 2), threaded like
        // provenance and related: the update write is the only thing that
        // keeps the line on a restricted rule through its counter changes,
        // and the no-op pre-flight needs the input to carry it to match the
        // bytes on disk. Written only when non-empty, like every stamp.
        ...(update.visibility !== undefined && update.visibility.length > 0
          ? { visibility: update.visibility }
          : {}),
        ...(update.scope ? { scope: update.scope } : {}),
        lenientScopeTags: true,
      },
      [],
      { overwrite: true, authority: DREAM_AUTHORITY },
      historyOpts,
    );
    receipts.of(update.slug);
  }
}

/**
 * Belief lifecycle suite (B4): the preference-confidence update path
 * emits a decision-change receipt for each material confidence band
 * change captured this pass. `bandDrops` is the existing, already-
 * computed set of material weakenings (a band actually dropped), so
 * this rides on data the refresh already produced without touching its
 * byte-identical no-op guarantees. The receipt's idempotency key
 * (subject + before + after) makes a re-run a no-op. Fail-soft.
 */
interface ConfidenceReceipts {
  /** Write the receipts of preference `slug`'s band changes, once. */
  of(slug: string): void;
  /** Write every receipt not yet written. */
  rest(): void;
}

/**
 * The pass's confidence receipts, written through one receipts batch: the
 * ledger is read once for the whole pass, not once per drop. That widens
 * the idempotency window from one receipt to the whole pass: another
 * writer appending the same receipt (subject, before and after) while the
 * pass runs is not seen, so the worst case is one duplicate ledger line,
 * which every reader dedupes by its idempotency key.
 */
function confidenceReceipts(
  vault: string | null,
  refresh: RefreshResult,
  agent: string,
  now: Date,
): ConfidenceReceipts {
  // Decision-change receipts are a vault lane until the decisions lane has
  // a record kind (design D14 item 2); with no vault they are not written.
  const pending = vault === null ? [] : [...refresh.bandDrops];
  let batch: ReturnType<typeof openReceiptBatch> | null = null;
  const write = (d: RefreshResult["bandDrops"][number]): void => {
    const before = `confidence:${d.previous}${d.previous_value !== null ? `(${d.previous_value.toFixed(2)})` : ""}`;
    const after = `confidence:${d.next}(${d.next_value.toFixed(2)})`;
    try {
      batch ??= openReceiptBatch(vault!);
      batch.append({
        subject: d.id,
        before,
        after,
        confidenceDelta: d.previous_value !== null ? d.next_value - d.previous_value : null,
        actor: agent,
        rationale: `applied ${d.applied} / violated ${d.violated}`,
        reasonCode: "confidence-refresh",
        ts: now.toISOString(),
      });
    } catch {
      // Accountability mirror is best-effort; the refreshed preference
      // bytes remain authoritative.
    }
  };
  const take = (match: (d: RefreshResult["bandDrops"][number]) => boolean): void => {
    for (let i = 0; i < pending.length;) {
      if (match(pending[i]!)) write(pending.splice(i, 1)[0]!);
      else i += 1;
    }
  };
  return {
    of: (slug) => take((d) => d.id === `pref-${slug}`),
    rest: () => take(() => true),
  };
}

/** Step 3: move each planned retire into `retired/`, honouring the evidence gate. */
function executeRetires(
  vault: string | null,
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
  wikilinkToRun: string,
  window: WindowContext<WindowEvidence>,
  safeguard?: Safeguard,
): DreamGatedRetireEntry[] {
  // v0.12.0 Brain Integrity Suite: declined retires accumulate here.
  // Always an array (even when no gate is configured) so the eventual
  // DreamRunSummary.gated_retires field is consistently shaped.
  const gatedRetires: DreamGatedRetireEntry[] = [];
  const gateThreshold = cfg.retire.confirmed_evidence_min_threshold;
  // The store's fold is read once for the whole loop, not once per retire:
  // a retire changes only its own preference, and that one is noted here,
  // so the snapshot answers every later slug as a fresh read would. What
  // it does not see is another machine's record that arrives while the
  // loop runs, so before each retire the bytes appended to the `events`
  // shards since the snapshot are checked for a record about that
  // preference, and when one is there the fold is read afresh (below).
  // The evidence gate keeps reading the snapshot: its counters decide
  // only whether to skip, never what to write.
  const held = heldPreferences(vault);
  const retiredHere = new Set<string>();

  for (const r of plan.retires) {
    // Between retires, like the rewrites above: a retire not reached is
    // planned again by the next pass.
    safeguard?.checkpoint();
    const fromPath = preferencePathOf(vault, r.slug);
    // The page on an unswitched machine, the store's fold once switched.
    if (
      held === null ? !existsSync(fromPath) : !held.entries.has(r.slug) || retiredHere.has(r.slug)
    ) {
      continue;
    }
    // v0.12.0 Brain Integrity Suite: destructive-from-confirmed gate.
    // When the operator has set retire.confirmed_evidence_min_threshold,
    // refuse to retire a confirmed (unpinned) pref whose accumulated
    // evidence count is below the configured floor. Operator-initiated
    // retires bypass.
    if (gateThreshold !== undefined && gateThreshold > 0) {
      try {
        // From the loop's snapshot when the store holds it: loading it
        // again would rebuild the fold after the previous retire's append.
        const entry = held?.entries.get(r.slug);
        const existing =
          entry !== undefined
            ? preferenceFromStoreEntry(vault, r.slug, entry)
            : loadPreference(vault, r.slug);
        if (existing !== null && shouldGateRetireFromConfirmed(existing, r.reason, gateThreshold)) {
          gatedRetires.push({
            pref_id: existing.id,
            topic: existing.topic,
            applied_count: existing.applied_count,
            violated_count: existing.violated_count,
            threshold: gateThreshold,
            attempted_reason: r.reason,
          });
          continue;
        }
      } catch {
        // Parse failure - fall through to the normal retire path
        // (moveToRetired will surface the error through stderr below).
      }
    }
    // The entry the retire writes from: the snapshot's, unless a record
    // about this preference arrived since the snapshot (another machine's
    // removal or retire, a person's edit), or the check cannot tell; then
    // the fold is read afresh, and a preference no longer active is left
    // alone. A stale entry would otherwise propose, with the snapshot's
    // fields, that a removed preference exists again.
    let storeEntry = held?.entries.get(r.slug);
    if (held !== null && storeEntry !== undefined) {
      const touched =
        held.mark === null ? null : preferenceTouchedSince(held.mark, `pref-${r.slug}`);
      if (touched !== false) {
        const fresh = storePreferenceEntry(r.slug);
        if (fresh === undefined || isRetiredEntry(fresh)) continue;
        storeEntry = fresh;
      }
    }
    try {
      const createdAt = window.signals.preferences.find(
        (entry) => entry.pref.id === `pref-${r.slug}`,
      )?.pref.created_at;
      const evidence = window.evidence.lookup(r.slug, { sinceIso: createdAt ?? "" });
      moveToRetired(vault, fromPath, r.reason, {
        now,
        authority: DREAM_AUTHORITY,
        retired_by: wikilinkToRun,
        evidenceApplied: evidence.applied,
        evidenceViolated: evidence.violated,
        ...(r.supersededBy ? { superseded_by: r.supersededBy } : {}),
        ...(storeEntry !== undefined ? { storeEntry } : {}),
      });
      retiredHere.add(r.slug);
      // Belief lifecycle suite (A4): record the accelerated retirement of
      // a low-recall superseded ancestor as a dedicated audit event.
      if (r.chainDecay) {
        appendLogEvent(vault, {
          timestamp: isoSecond(now),
          eventType: BRAIN_LOG_EVENT_KIND.chainDecay,
          body: {
            preference: `[[ret-${r.slug}]]`,
            reason: r.reason,
            stale_days: String(CHAIN_DECAY_STALE_DAYS),
          },
        });
      }
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
  return gatedRetires;
}

/**
 * The slugs of the active preferences the store's fold holds, read once;
 * `null` on an unswitched machine, where each page is asked on disk.
 */
function heldPreferences(vault: string | null): HeldPreferences | null {
  if (!preferencesStoreOnly(vault)) return null;
  // Marked before the read: a record that lands between the two is seen as
  // appended since, so it is checked rather than missed.
  const store = configuredStore();
  const mark = store === null ? null : markEvents(store);
  const entries = new Map<string, StorePreference>();
  for (const [id, entry] of readStoreEntities()?.preferences ?? []) {
    if (!id.startsWith("pref-") || !entry.state.exists || isRetiredEntry(entry)) continue;
    entries.set(id.slice("pref-".length), entry);
  }
  return { entries, mark };
}

/** The loop's snapshot of the active preferences, and where the `events` shards ended when it was read. */
interface HeldPreferences {
  readonly entries: ReadonlyMap<string, StorePreference>;
  readonly mark: EventsMark | null;
}

/** Each `events` shard as it was at a moment: its identity and the bytes it held. */
interface EventsMark {
  readonly shards: ReadonlyArray<{
    readonly path: string;
    readonly partitionRoot: string;
    /** null: the shard did not exist then (read whole now). */
    /** Device and inode as `bigint` (`fs-identity.ts`), and the size the mark saw. */
    readonly stamp: { readonly ino: bigint; readonly dev: bigint; readonly size: bigint } | null;
  }>;
  readonly store: StoreInspection;
}

function markEvents(store: StoreInspection): EventsMark {
  const shards: Array<EventsMark["shards"][number]> = [];
  for (const partition of store.partitions) {
    const partitionRoot = partitionDir(store.root, partition);
    for (const shard of listShards(partitionRoot, { stream: "events" })) {
      try {
        const st = lstatSync(shard.path, { bigint: true });
        shards.push({
          path: shard.path,
          partitionRoot,
          stamp: { ino: st.ino, dev: st.dev, size: st.size },
        });
      } catch {
        shards.push({ path: shard.path, partitionRoot, stamp: null });
      }
    }
  }
  return { shards, store };
}

/**
 * Whether a record about preference `id` (a set, a removal, evidence) was
 * appended to the `events` stream since `mark`: only the bytes after the
 * mark are read, so the check costs what arrived, not the stream. `null`
 * when it cannot tell (a shard replaced, shorter, unreadable, or one that
 * appeared since): the caller then reads the fold afresh.
 */
function preferenceTouchedSince(mark: EventsMark, id: string): boolean | null {
  const known = new Set(mark.shards.map((s) => s.path));
  for (const partition of mark.store.partitions) {
    const partitionRoot = partitionDir(mark.store.root, partition);
    try {
      for (const shard of listShards(partitionRoot, { stream: "events" })) {
        if (!known.has(shard.path)) return null;
      }
    } catch {
      return null;
    }
  }
  for (const shard of mark.shards) {
    if (shard.stamp === null) return null;
    let read: ReturnType<typeof readShard>;
    try {
      const st = lstatSync(shard.path, { bigint: true });
      if (!sameDevIno(st, shard.stamp) || st.size < shard.stamp.size) {
        return null;
      }
      if (st.size === shard.stamp.size) continue;
      read = readShard(shard.path, {
        partitionRoot: shard.partitionRoot,
        offset: Number(shard.stamp.size),
      });
    } catch {
      return null;
    }
    if (shardReadGap(read) !== null) return null;
    if (read.records.some((r) => r.record.body["preference"] === id)) return true;
  }
  return false;
}

/**
 * Step 4: move every consumed signal out of `inbox/`. On a store-only
 * machine (task 2.10) a move is a `signal-state` record (`consumed`) and no
 * file moves; an unswitched machine renames the file and dual-writes the
 * record.
 */
function moveConsumedSignals(vault: string | null, plan: PlanState): string[] {
  const moved: string[] = [];
  const storeOnly = signalsStoreOnly(vault);
  // Held across the moves: recording one signal's move does not change
  // whether another is live or private, and each append would otherwise
  // rebuild the fold to judge the next one. Another writer's change reads
  // the store again (`holdStoreEntities`).
  const held = storeOnly ? holdStoreEntities() : null;
  if (held !== null) {
    return storeSignalMoves(
      vault,
      plan.signalsToMove.values(),
      held,
      "consumed",
      "move signal",
      "to processed/",
    );
  }
  for (const sig of plan.signalsToMove.values()) {
    // The legacy destination, resolved only by the legacy move.
    const dest = (): string =>
      processedSignalPath(legacyVaultOf(vault, "moveConsumedSignals"), sig.date, sig.slug);
    try {
      // Judged before the move, from the page the scan read.
      const meta = storeOnly ? undefined : readFrontmatterOf(sig.path);
      routeSignalState({
        vault,
        id: sig.id,
        state: "consumed",
        authority: DREAM_AUTHORITY,
        legacyFrontmatter: meta,
        legacy: () => renameWithRetry(sig.path, dest()),
      });
      moved.push(sig.id);
    } catch (err) {
      // Best-effort: a missing source signal (already moved) is
      // benign on rerun. Still surface so a real I/O issue is visible.
      process.stderr.write(
        `warning: move signal ${sig.id} to processed/ failed: ${(err as Error).message}\n`,
      );
    }
  }
  return moved;
}

/**
 * Step 4b: move every signal the archive policy selected (see
 * `signal-archive.ts`) from `inbox/` to `inbox/archived/`, byte for byte.
 *
 * Never overwrites: a destination that exists is left alone and the signal
 * stays in the inbox (the planner already skips names it saw in the
 * archive; this covers a file that appeared since the scan). A failed move
 * is reported and the signal stays where it was, so a rerun picks it up.
 *
 * On a store-only machine (task 2.10) the archive is a `signal-state`
 * record (`archived`); no folder is created and no file moves.
 *
 * No deadline checkpoint inside the loop, like the processed/ move above: a
 * pass stopped half way would leave archived files the run's log never
 * names. The pass's own post-mutation checkpoint follows immediately.
 */
function archiveStaleSignals(vault: string | null, plan: PlanState): string[] {
  const archived: string[] = [];
  if (plan.signalsToArchive.size === 0) return archived;
  const storeOnly = signalsStoreOnly(vault);
  const held = storeOnly ? holdStoreEntities() : null;
  if (held !== null) {
    return storeSignalMoves(
      vault,
      plan.signalsToArchive.values(),
      held,
      "archived",
      "archive signal",
      "to inbox/archived/",
    );
  }
  // The legacy destination, resolved only off the store-only path.
  const archivedPath = (path: string): string =>
    archivedSignalPath(legacyVaultOf(vault, "archiveStaleSignals"), basename(path));
  if (!storeOnly) {
    mkdirSync(brainDirs(legacyVaultOf(vault, "archiveStaleSignals")).archived, {
      recursive: true,
    });
  }
  for (const sig of plan.signalsToArchive.values()) {
    try {
      const dest = archivedPath(sig.path);
      if (existsSync(dest)) {
        process.stderr.write(
          `warning: archive signal ${sig.id}: ${basename(dest)} already exists in ` +
            `inbox/archived/; left in the inbox\n`,
        );
        continue;
      }
      routeSignalState({
        vault,
        id: sig.id,
        state: "archived",
        authority: DREAM_AUTHORITY,
        legacyFrontmatter: storeOnly ? undefined : readFrontmatterOf(sig.path),
        legacy: () => renameWithRetry(sig.path, archivedPath(sig.path)),
      });
      archived.push(sig.id);
    } catch (err) {
      process.stderr.write(
        `warning: archive signal ${sig.id} to inbox/archived/ failed: ${(err as Error).message}\n`,
      );
    }
  }
  return archived;
}

/**
 * The store-only moves of steps 4 and 4b: the live signals' records in
 * batches (`writeStoreSignalStates`), one clock write and one synced
 * write per shard per batch instead of two synced writes per signal. A
 * signal no longer live (a pass that stopped part way already moved it)
 * is skipped, so a rerun completes the moves without duplicates. A move
 * that fails is reported, and the signal stays where it was.
 */
function storeSignalMoves(
  vault: string | null,
  signals: Iterable<{ readonly id: string }>,
  held: HeldEntities,
  state: "consumed" | "archived",
  verb: string,
  where: string,
): string[] {
  const moves: Array<{ id: string; state: "consumed" | "archived" }> = [];
  for (const sig of signals) {
    try {
      if (isLiveStoreSignal(held, sig.id)) moves.push({ id: sig.id, state });
    } catch (err) {
      process.stderr.write(
        `warning: ${verb} ${sig.id} ${where} failed: ${(err as Error).message}\n`,
      );
    }
  }
  const result = writeStoreSignalStates({ vault, moves, authority: DREAM_AUTHORITY, held });
  for (const { id, error } of result.failed) {
    process.stderr.write(`warning: ${verb} ${id} ${where} failed: ${error.message}\n`);
  }
  return [...result.written];
}

/**
 * Whether the store's signal fold holds `id` in the inbox (store-only
 * moves). The held read misses only this pass's own moves, each of one
 * other signal, so it still answers for `id`.
 */
function isLiveStoreSignal(held: HeldEntities, id: string): boolean {
  return held.current()?.signals.get(id)?.state === "active";
}

/**
 * The frontmatter of a signal page, judged for the dual write before it
 * moves. A page that cannot be read is judged private (fail closed).
 */
function readFrontmatterOf(path: string): Record<string, unknown> {
  try {
    return parseFrontmatter(path)[0];
  } catch {
    return { visibility: [REMOTE_DENY_VISIBILITY_TOKEN] };
  }
}

/**
 * Heal phase (F6): opt-in deterministic vault enrichment, run after the
 * retire/move mutations (heal-after-mutations). Off by default so the
 * default install stays byte-identical; a failure is a warning, never
 * fatal to the dream pass.
 *
 * A SAFEGUARD STOP IS NOT SUCH A FAILURE, and the difference is the whole
 * reason this catch is narrowed. "Heal could not enrich a page" is a
 * hygiene miss the pass survives; "the operator cancelled" and "the pass
 * is past its budget" are decisions about the RUN, and swallowing either
 * into a stderr warning plus `0` would report a pass that enriched
 * nothing where the truth is a pass that was stopped. The pass's own
 * post-mutation checkpoint would throw an instant later anyway - so
 * absorbing it here only ever bought a wrong `heal_enriched: 0` on the
 * way to the same error.
 */
function runHealEnrichmentSafely(vault: string | null, safeguard: Safeguard | undefined): number {
  // Heal enrichment rewrites user notes; with no vault there are none.
  if (vault === null) return 0;
  try {
    return runHealEnrichment(vault, safeguard ? { safeguard } : {}).enriched;
  } catch (err) {
    if (err instanceof SafeguardTimeoutError || err instanceof SafeguardAbortError) throw err;
    process.stderr.write(`warning: heal enrichment failed: ${(err as Error).message}\n`);
    return 0;
  }
}

/**
 * Brain Integrity Suite (v0.12.0). Pure decision function for the
 * destructive-from-confirmed gate. Exported so the gate logic can be
 * unit-tested without driving a full dream run.
 *
 * Returns `true` when the candidate retire MUST be held back. The
 * caller is responsible for recording a {@link DreamGatedRetireEntry}
 * and skipping the actual `moveToRetired` call.
 */
export function shouldGateRetireFromConfirmed(
  existing: BrainPreference,
  reason: BrainRetiredReason,
  threshold: number | undefined,
): boolean {
  if (threshold === undefined || threshold <= 0) return false;
  if (reason === BRAIN_RETIRED_REASON.userRejected) return false;
  if (reason === BRAIN_RETIRED_REASON.mergedInto) return false;
  if (existing.status !== BRAIN_PREFERENCE_STATUS.confirmed) return false;
  if (existing.pinned) return false;
  const evidenceCount = (existing.applied_count ?? 0) + (existing.violated_count ?? 0);
  return evidenceCount < threshold;
}

/**
 * Slugs whose retire the gate declined. The log body and the
 * DreamRunSummary must agree on this set, or the next dream pass would
 * parse a `pref-foo` log claiming the pref was retired while the file is
 * still in `preferences/`.
 */
export function gatedRetireSlugs(gatedRetires: ReadonlyArray<DreamGatedRetireEntry>): Set<string> {
  return new Set(gatedRetires.map((g) => preferenceSlug(g.pref_id)));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

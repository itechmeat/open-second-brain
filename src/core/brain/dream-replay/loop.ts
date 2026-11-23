/**
 * The window loop of a live pass on a brain served from the store (design
 * D1, D3, D5, D6): the days from the one after the last covered day
 * through today, oldest first. Each window is admitted (its record
 * written before anything depends on it), planned (the plan record, with
 * every payload frozen, written before the first effect), applied,
 * audited and covered. A window whose admission has a gap is not
 * evaluated: the pass stops there and the next one admits it again from
 * the same positions. A window found open (admitted and not covered) is
 * finished first: from its plan when it has one, never planned again.
 *
 * Today's window may be evaluated again by a later pass of the same day:
 * that evaluation is its own window, `<day>#<n>`.
 *
 * The pass has a budget (`dream.replay_budget_ms`): it is checked before
 * each window and at every checkpoint inside one; a pass that spends it
 * ends normally, its finished effects durable, and the next pass
 * continues the open window.
 */

import { SafeguardAbortError, type Safeguard } from "../safeguard.ts";
import type { CrossTopicLedger } from "../dream-plan-cross-topic.ts";
import type { DreamOptions, DreamRunSummary, DreamWarning } from "../dream-types.ts";
import type { RollupLadderPlan, RollupLedger } from "../rollup-ladder.ts";
import { isoDate } from "../time.ts";
import type { BrainConfig } from "../types.ts";
import { readStoreLogEvents } from "../../store/read/log-events.ts";
import { withStoreReadView } from "../../store/read/read-view.ts";
import { readStoreEntities } from "../../store/read/store-entities.ts";
import { admitWindow, isPlainAdmission } from "./admission.ts";
import { windowName, type DreamReplayState } from "./fold.ts";
import {
  crossTopicLedgerOn,
  importedLedgerRecords,
  rollupLedgerOf,
  windowLedgerRecords,
} from "./ledgers.ts";
import { readReplayState, writeReplayRecord, type DreamReplayPass } from "./pass.ts";
import { namesPrivate, privateNamesOf } from "./privacy.ts";
import {
  decodeFrozen,
  effectsOf,
  encodeFrozen,
  policyDigest,
  WINDOW_PLAN_VERSION,
  type FrozenWindow,
  type WindowPlanBody,
} from "./plan.ts";
import { reconcileLateEvidence } from "./reconcile.ts";
import { mergeWindowSummaries } from "../dream-summary.ts";
import { BootstrapIncompleteError, runBootstrap } from "./bootstrap.ts";
import { waitForSync } from "./transfer.ts";
import {
  DEFAULT_REPLAY_BUDGET_MS,
  DREAM_ADMISSION_KIND,
  DREAM_ADMISSION_PRIVATE_KIND,
  DREAM_COVERAGE_KIND,
  DREAM_WINDOW_PLAN_KIND,
  daysFrom,
  nextDay,
  windowBounds,
  type DreamAdmissionBody,
} from "./records.ts";

/** Version of the engine a plan was made by, recorded for doctor (design D5). */
export const DREAM_ENGINE_VERSION = "dream-replay/1";

/** The ledgers a window plans against, and where its own go (`ledgers.ts`). */
export interface WindowLedgers {
  readonly crossTopic: CrossTopicLedger | null;
  readonly rollup: RollupLedger | null;
  readonly write: (written: {
    readonly crossTopicLedger: CrossTopicLedger | null;
    readonly rollupPlan: RollupLadderPlan;
    readonly rollupProductionComplete: boolean;
  }) => void;
}

/** One window as the pass evaluates it. */
export interface ReplayWindow {
  readonly day: string;
  readonly window: string;
  readonly instant: Date;
  readonly replay: true;
  /** The options of the window: the pass's, with the budget in its safeguard. */
  readonly opts: DreamOptions;
  /** Called right before the window's first effect: admission and plan are written by then. */
  readonly beforeEffects: (frozen: FrozenWindow) => void;
  readonly ledgers: WindowLedgers;
  readonly resume?: FrozenWindow;
  readonly reconcileLate: () => ReturnType<typeof reconcileLateEvidence>;
  readonly rebasedSeen: number;
  /** The first window of the first replay: archived signals that may have missed a promotion. */
  readonly unrecoverable: number;
  readonly auditWritten: () => ReadonlySet<string>;
  readonly pass: { snapshotTaken: boolean };
}

/** What a replay of windows tells the caller beside the last window's summary. */
export interface ReplayWindows {
  /** Windows evaluated and covered by this pass. */
  readonly covered: number;
  /** Windows still behind when the pass ended. */
  readonly behind: number;
  /** The window the pass stopped at, if any (a gap, the budget). */
  readonly stoppedAt: string | null;
  /** The newest covered day after the pass. */
  readonly lastCovered: string | null;
  /** The pass ran no window: this device waits for the last owner's records to sync. */
  readonly waitingForSync?: boolean;
}

/** The days a pass replays: from the one after the last covered day through today. */
export function daysToReplay(state: DreamReplayState, today: string): string[] {
  const open = state.open?.body.day ?? null;
  if (open !== null) return daysFrom(open <= today ? open : today, today);
  if (state.lastCovered === null) return [today];
  const first = nextDay(state.lastCovered);
  return daysFrom(first <= today ? first : today, today);
}

/** The pass spent its replay budget (design D6): it ends normally. */
export class ReplayBudgetSpent extends SafeguardAbortError {
  constructor() {
    super("dream replay");
    this.name = "ReplayBudgetSpent";
  }
}

/** `opts` with a safeguard that also stops at the end of the budget. */
function budgeted(opts: DreamOptions, deadline: number): DreamOptions {
  const outer = opts.safeguard;
  const safeguard: Safeguard = {
    operation: outer?.operation ?? "dream",
    timeoutMs: outer?.timeoutMs ?? null,
    checkpoint() {
      outer?.checkpoint();
      if (Date.now() > deadline) throw new ReplayBudgetSpent();
    },
  };
  return { ...opts, safeguard };
}

/** The effect ids of the audit events window `window` of `day` already wrote. */
function auditEffects(day: string, window: string, configPath?: string): Set<string> {
  // Events are stamped from the window's instant a second apart, so a
  // window at the end of its day writes into the next ones.
  const to = nextDay(nextDay(day));
  const out = new Set<string>();
  for (const { entry } of readStoreLogEvents(
    { from: day, to },
    { vault: null, ...(configPath !== undefined ? { configPath } : {}) },
  ) ?? []) {
    if (entry.body["window"] !== window) continue;
    const effect = entry.body["effect"];
    if (typeof effect === "string") out.add(effect);
  }
  return out;
}

/** The frozen window of a plan record: null for a plan of no effect, undefined for none. */
function frozenOf(
  plan: { readonly body: Record<string, unknown> } | undefined,
): FrozenWindow | null | undefined {
  if (plan === undefined) return undefined;
  const body = plan.body as unknown as Partial<WindowPlanBody>;
  if (body.version !== WINDOW_PLAN_VERSION) return undefined;
  return body.frozen === null || body.frozen === undefined
    ? null
    : (decodeFrozen(body.frozen) as FrozenWindow);
}

/**
 * Run every window the pass owes, oldest first. `evaluate` runs one
 * window's body (the existing pass, judged at the window's instant) and
 * returns its summary; the summary of the last window evaluated is the
 * pass's, with the replay's warnings.
 */
export function replayWindows(input: {
  readonly vault: string | null;
  readonly pass: DreamReplayPass;
  readonly opts: DreamOptions;
  readonly cfg: BrainConfig;
  readonly evaluate: (window: ReplayWindow) => DreamRunSummary;
  readonly noWindow: () => DreamRunSummary;
}): { readonly summary: DreamRunSummary; readonly windows: ReplayWindows } {
  const { pass, vault } = input;
  const deadline = Date.now() + (input.cfg.dream.replay_budget_ms ?? DEFAULT_REPLAY_BUDGET_MS);
  const today = isoDate(pass.now);
  let state = readReplayState(pass);
  // A clock that reads earlier than a window this brain already admitted
  // or covered would evaluate an earlier day after a later one: the pass
  // evaluates nothing and writes nothing until the clock reaches that day.
  const latest = [state.open?.body.day ?? null, state.lastCovered]
    .filter((day): day is string => day !== null)
    .toSorted()
    .at(-1);
  if (latest !== undefined && latest > today) {
    const last = input.noWindow();
    const what = state.open?.body.day === latest ? "is open" : "is covered";
    return {
      summary: {
        ...last,
        warnings: [
          ...last.warnings,
          {
            code: "dream-replay-clock-behind",
            message: `the clock reads ${today}, but the window of ${latest} ${what}; no window is evaluated until the clock reaches ${latest}`,
          },
        ],
      },
      windows: { covered: 0, behind: 0, stoppedAt: null, lastCovered: state.lastCovered },
    };
  }
  // The first replay on this brain takes over this device's ledger files,
  // once: only the owner's device ran passes before (design D7.1).
  if (state.coverage.size === 0 && !state.ledgers.any) {
    for (const record of importedLedgerRecords(vault)) {
      writeReplayRecord(pass, record.kind, record.body);
    }
    state = readReplayState(pass);
  }
  const opts = budgeted(input.opts, deadline);
  // A device that became the owner through a release runs no window until
  // the window that release names, and what it read, have synced (D8); a
  // device that holds `private` waits for every private part its
  // admissions name.
  const waiting = waitForSync(pass.store, state);
  if (waiting !== null) {
    const last = input.noWindow();
    return {
      summary: {
        ...last,
        warnings: [...last.warnings, { code: "dream-replay-waiting-sync", message: waiting }],
      },
      windows: {
        covered: 0,
        behind: 0,
        stoppedAt: null,
        lastCovered: state.lastCovered,
        waitingForSync: true,
      },
    };
  }
  // The first replay on a brain inventories its retained inputs, page by
  // page, and starts at the oldest that can still change an outcome
  // (design D7). An interrupted inventory continues from its page.
  let unrecoverable = 0;
  let start: string | null = null;
  if (state.coverage.size === 0 && state.open === null) {
    try {
      const done = runBootstrap({
        vault,
        pass,
        cfg: input.cfg,
        previous: state.bootstrap,
        checkpoint: () => opts.safeguard?.checkpoint(),
      });
      start = done.start;
      // Reported once, by the first window.
      if (state.bootstrap?.done !== true) unrecoverable = done.unrecoverable;
    } catch (error) {
      if (error instanceof BootstrapIncompleteError) {
        const last = input.noWindow();
        return {
          summary: {
            ...last,
            warnings: [...last.warnings, { code: "dream-replay-gap", message: error.message }],
          },
          windows: { covered: 0, behind: 0, stoppedAt: null, lastCovered: null },
        };
      }
      if (!(error instanceof ReplayBudgetSpent)) throw error;
      const last = input.noWindow();
      return {
        summary: {
          ...last,
          warnings: [
            ...last.warnings,
            {
              code: "dream-replay-budget",
              message:
                "the replay budget was spent in the first inventory; the next pass continues it",
            },
          ],
        },
        windows: { covered: 0, behind: 0, stoppedAt: null, lastCovered: null },
      };
    }
    state = readReplayState(pass);
  }
  const days =
    start !== null ? daysFrom(start <= today ? start : today, today) : daysToReplay(state, today);
  const shared = { snapshotTaken: false };
  const policy = policyDigest(input.cfg);
  let summary: DreamRunSummary | null = null;
  const summaries: DreamRunSummary[] = [];
  const warnings: DreamWarning[] = [];
  let covered = 0;
  let stoppedAt: string | null = null;
  for (const [index, day] of days.entries()) {
    summary = null;
    const final = day === today;
    const open = state.open !== null && state.open.body.day === day ? state.open : null;
    const window = open?.body.window ?? windowName(day, state.evaluations.get(day) ?? 0);
    if (index > 0 && Date.now() > deadline) {
      stoppedAt = window;
      warnings.push({
        code: "dream-replay-budget",
        message: `the replay budget was spent before the window of ${day}; the next pass continues`,
      });
      break;
    }
    let admission: { readonly id: string; readonly body: DreamAdmissionBody } | null = open;
    const admitted =
      open !== null
        ? { body: open.body, privateIds: state.privateAdmitted, fresh: 0 }
        : admitWindow({
            root: pass.store.root,
            partitions: pass.store.partitions,
            day,
            window,
            lastCovered: state.lastCovered,
            positions: state.positions ?? [],
            now: pass.now,
            previous: state.latestAdmission?.body ?? null,
            run: pass.run,
          });
    const body = admitted.body;
    // A later evaluation of a covered day whose admission gives nothing new
    // writes its records only if it changes something: a rerun that
    // changes nothing writes nothing, as before the replay. An admission
    // that read a new input record is written anyway: its positions are
    // past that record, and without them the next day would read it
    // again as late.
    const lazy =
      admission === null &&
      day === state.lastCovered &&
      isPlainAdmission(body) &&
      admitted.fresh === 0;
    // The late and clamped records read from `private` are named only in
    // the admission's private part (`privacy.ts`). The part is written
    // first and the admission names it: the admission is what advances the
    // positions, so a pass stopped between the two leaves only a part no
    // admission names, and the next pass admits the window again from the
    // same positions.
    const admit = (): { readonly id: string; readonly body: DreamAdmissionBody } => {
      if (admission !== null) return admission;
      const { privateIds } = admitted;
      const late = body.late.filter((entry) => privateIds.has(entry.id));
      const clamped = body.clamped.filter((entry) => privateIds.has(entry.id));
      const part =
        late.length > 0 || clamped.length > 0
          ? writeReplayRecord(
              pass,
              DREAM_ADMISSION_PRIVATE_KIND,
              { day, window, late, clamped, run: pass.run },
              true,
            )
          : null;
      const id = writeReplayRecord(pass, DREAM_ADMISSION_KIND, {
        ...body,
        late: body.late.filter((entry) => !privateIds.has(entry.id)),
        clamped: body.clamped.filter((entry) => !privateIds.has(entry.id)),
        ...(part !== null ? { private_part: part } : {}),
      });
      admission = { id, body };
      return admission;
    };
    if (!lazy) admit();
    if (body.gaps.length > 0) {
      // Unknown is not empty: the window is not evaluated, and the next
      // pass admits it again from the same positions.
      stoppedAt = window;
      warnings.push({
        code: "dream-replay-gap",
        message:
          `the window of ${day} was not evaluated: ` +
          body.gaps.map((gap) => `${gap.partition}/${gap.shard} (${gap.reason})`).join(", "),
      });
      break;
    }
    const effective = new Map(state.effective);
    for (const entry of [...body.late, ...body.clamped]) effective.set(entry.id, entry.at);
    const instant = final ? pass.now : new Date(windowBounds(day).to);
    const before = state;
    const resume = frozenOf(state.plans.get(window));
    let planId: string | null = state.plans.get(window)?.id ?? null;
    const writePlan = (frozen: FrozenWindow | null): void => {
      if (planId !== null) return;
      admit();
      const planBody: WindowPlanBody = {
        day,
        window,
        bounds: windowBounds(day),
        instant: instant.toISOString(),
        version: WINDOW_PLAN_VERSION,
        effects: frozen === null ? [] : effectsOf(window, frozen),
        frozen: frozen === null ? null : encodeFrozen(frozen),
        engine_version: DREAM_ENGINE_VERSION,
        policy_digest: policy,
        run: pass.run,
      };
      // A plan that names what the window read from private records goes
      // to `private` (`privacy.ts`).
      const names = privateNamesOf(readStoreEntities(pass.configPath), [
        ...state.privateAdmitted,
        ...admitted.privateIds,
      ]);
      planId = writeReplayRecord(
        pass,
        DREAM_WINDOW_PLAN_KIND,
        planBody,
        namesPrivate(planBody, names),
      );
    };
    const view = {
      token: `${pass.run}\n${window}\n${body.admitted_at}`,
      boundary: body.positions,
      instant,
      effective,
    };
    // Queueing the rollup work the plan fired is one of its effects: a
    // window whose work was not all queued stays open, and the pass that
    // resumes it queues the rest from the same frozen plan.
    let rollupQueued = true;
    try {
      // A window whose plan planned nothing only misses its coverage.
      if (resume !== null) {
        summary = withStoreReadView(view, () =>
          input.evaluate({
            day,
            window,
            instant,
            replay: true,
            opts,
            beforeEffects: (frozen) => writePlan(frozen),
            ledgers: {
              crossTopic: crossTopicLedgerOn(before.ledgers, day),
              rollup: rollupLedgerOf(before.ledgers),
              write: (written) => {
                rollupQueued = written.rollupProductionComplete;
                // A resumed window's ledger records may already be there.
                const now = readReplayState(pass).ledgers;
                for (const record of windowLedgerRecords({
                  window,
                  day,
                  before: before.ledgers,
                  ...written,
                })) {
                  if (now.effects.has(record.body.effect)) continue;
                  writeReplayRecord(pass, record.kind, record.body);
                }
              },
            },
            ...(resume !== undefined ? { resume } : {}),
            reconcileLate: () =>
              reconcileLateEvidence(window, body.late, readStoreEntities(pass.configPath)),
            rebasedSeen: body.rebased?.seen ?? 0,
            unrecoverable: index === 0 ? unrecoverable : 0,
            auditWritten: () => auditEffects(day, window, pass.configPath),
            pass: shared,
          }),
        );
      }
    } catch (error) {
      if (!(error instanceof ReplayBudgetSpent)) throw error;
      stoppedAt = window;
      warnings.push({
        code: "dream-replay-budget",
        message: `the replay budget was spent in the window of ${day}; the next pass continues it`,
      });
      break;
    }
    if (summary !== null) summaries.push(summary);
    if (!rollupQueued) {
      stoppedAt = window;
      warnings.push({
        code: "dream-replay-rollup-pending",
        message: `the rollup work of the window of ${day} was not all queued; the next pass continues it`,
      });
      break;
    }
    if (lazy && admission === null && summary !== null && !summary.changed) {
      // Nothing changed and nothing was written: no plan, no coverage.
      state = readReplayState(pass);
      continue;
    }
    writePlan(null);
    const written = admit();
    writeReplayRecord(pass, DREAM_COVERAGE_KIND, {
      day,
      window,
      admission: written.id,
      plan: planId,
      owner: pass.owner,
      run: pass.run,
      behind: days.length - index - 1,
    });
    covered += 1;
    state = readReplayState(pass);
  }
  const behind = stoppedAt === null ? 0 : days.length - covered;
  // The pass reports every window it evaluated (a summary per window
  // would hide what the earlier windows of a replay did).
  const last = summaries.length > 0 ? mergeWindowSummaries(summaries) : input.noWindow();
  return {
    summary: warnings.length > 0 ? { ...last, warnings: [...last.warnings, ...warnings] } : last,
    windows: { covered, behind, stoppedAt, lastCovered: state.lastCovered },
  };
}

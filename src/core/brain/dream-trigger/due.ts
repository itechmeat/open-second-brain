/**
 * The due path of the dream day check (change `dream-session-trigger`,
 * design D2 items 3 to 6): reached only when the day record does not
 * close the question by itself, so at most once a day per machine, plus
 * once per retry. Loaded on demand by `check.ts`: a session on a closed
 * day never loads the store, the owner fold or the spawn helper.
 *
 *  1. Open the store, read the shared setting `dream.auto` and fold the
 *     dream owner; write what was learned into the record. No store, no
 *     owner, another owner, or automatic dream off: return (another
 *     owner's machine may get its one line, `line.ts`).
 *  2. A pass running here (the pass lock held by a live process): return.
 *  3. Claim, as the last step before the spawn: create the claim file
 *     exclusively. A claim already there whose worker (the pid it wrote
 *     into the claim) lives, or younger than the pass deadline plus two
 *     minutes, means a worker was started: return. One no worker ever
 *     proved, two minutes old, whose maker is gone, was abandoned before
 *     its spawn: it is removed without a failure. An older one whose
 *     worker does not hold the pass lock is a lost worker: it is removed,
 *     a failed attempt is recorded, and nothing starts in this check.
 *  4. Under the claim, read the record again: a day another pass closed,
 *     or a retry time that has not come, gives the claim back.
 *  5. Start the worker, `o2b dream run --claim <token>`, detached; its
 *     error output goes to a capped device-local log, one header per
 *     attempt. A spawn that throws gives the claim back and records a
 *     failed attempt.
 *
 * Unknown is never read as an answer: a settings stream or an owner fold
 * that cannot be read completely starts nothing and caches nothing.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveVault } from "../../config.ts";
import { o2bCommand, spawnSelfDetached } from "../../maintenance/o2b-command.ts";
import { beginWorkerLogAttempt, workerLogAttemptHeader } from "../../store-migration/worker-log.ts";
import { isLockContention } from "../../store/local-lock.ts";
import { processLockHeld } from "../../store/process-lock.ts";
import { processAlive } from "../../store-migration/holder-liveness.ts";
import type { StoreHandle } from "../../store/store-open.ts";
import type { ConfigDiscovery } from "../../types.ts";
import { openDreamOwnerStore } from "../dream-owner/gate.ts";
import type { DreamOwner } from "../dream-owner/fold.ts";
import { dreamPassLockTarget, readDreamOwner } from "../dream-owner/owner.ts";
import {
  OPERATION,
  resolveSafeguardTimeoutMs,
  SAFEGUARD_DEFAULT_TIMEOUT_SECONDS,
} from "../safeguard.ts";
import { isoDate } from "../time.ts";
import { readDreamAuto } from "./auto.ts";
import { claimMadeAt, createClaim, releaseClaim, removeClaimIf, type ClaimSeen } from "./claim.ts";
import { DREAM_RUN_CLAIM_FLAG, DREAM_TRIGGER_CLAIM_GRACE_MS } from "./constants.ts";
import { silentOwnerLineFor } from "./line.ts";
import { retryDelayMs } from "./outcome.ts";
import {
  dreamDayRecordWaits,
  dreamTriggerClaimPath,
  readDreamTriggerRecord,
  unshowLine,
  updateDreamTriggerRecord,
  type DreamTriggerRecord,
} from "./record.ts";

/** What a check did. */
export interface DreamDayCheckResult {
  /** A worker was started. */
  readonly started: boolean;
  /** One line for the session (shown at most once a day), when one is due. */
  readonly note?: string;
  /**
   * With a note: mark it not shown again, for a caller that could not
   * deliver it, so a later session of the day shows it. Never throws.
   */
  readonly unshow?: () => void;
}

export const NOTHING: DreamDayCheckResult = Object.freeze({ started: false });

export interface DueCheckInput {
  readonly config: ConfigDiscovery;
  readonly storeRoot: string;
  readonly recordPath: string;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a note may be shown (and so counted as shown) by this check. */
  readonly notes: boolean;
  /** The vault the caller serves; absent: the one the machine config resolves to. */
  readonly vault?: string | null;
}

/** The device-local log of the dream worker of `store`. */
export function dreamWorkerLogPath(store: StoreHandle): string {
  return join(store.deviceStateDir, "dream", "worker.log");
}

/** How long a claim may stand before its worker counts as lost. */
export function claimGraceMs(configPath: string): number {
  const deadline =
    resolveSafeguardTimeoutMs(OPERATION.dream, configPath) ??
    SAFEGUARD_DEFAULT_TIMEOUT_SECONDS * 1000;
  return deadline + DREAM_TRIGGER_CLAIM_GRACE_MS;
}

function failedAttempt(
  r: DreamTriggerRecord,
  now: number,
  reason: string,
  lost: boolean,
): DreamTriggerRecord {
  const failures = r.failures + 1;
  return {
    ...r,
    closed: false,
    reason,
    failures,
    retry_at: new Date(now + retryDelayMs(failures)).toISOString(),
    open_since: r.open_since ?? new Date(now).toISOString(),
    last_run: {
      started_at: r.last_run?.started_at ?? null,
      ended_at: new Date(now).toISOString(),
      outcome: lost ? "lost" : "failed",
      by: "worker",
    },
    ...(lost ? { lost_worker_at: new Date(now).toISOString() } : {}),
  };
}

function ownerOf(owner: DreamOwner | null, mine: boolean): DreamTriggerRecord["owner"] {
  return {
    device: owner?.device ?? null,
    agent: owner?.agent ?? null,
    revision: owner?.revision ?? null,
    mine,
  };
}

/**
 * What a claim already there means: `standing`, a worker was started and
 * may still run; `lost`, its worker ended without recording an outcome
 * (a failed attempt); `abandoned`, no worker was ever started (the check
 * that made it was cut before its spawn), removed without a failure.
 */
export type ClaimVerdict = "standing" | "lost" | "abandoned";

export function judgeClaim(
  seen: ClaimSeen,
  nowMs: number,
  grace: number,
  passLockHeld: () => boolean,
): ClaimVerdict {
  if (seen.kind === "absent") return "standing";
  const age = nowMs - claimMadeAt(seen);
  if (seen.kind === "claim") {
    const worker = seen.claim.worker_pid;
    // A worker that proved the token and still lives is never lost.
    if (worker !== null && processAlive(worker)) return "standing";
    // No worker proved the token within the start window and the process
    // that made the claim is gone: nothing was started.
    if (worker === null && age >= DREAM_TRIGGER_CLAIM_GRACE_MS && !processAlive(seen.claim.pid)) {
      return "abandoned";
    }
  }
  return age >= grace && !passLockHeld() ? "lost" : "standing";
}

/** The due path. Throws only what the caller swallows; never waits for a lock holder. */
export function dueDreamDayCheck(input: DueCheckInput): DreamDayCheckResult {
  const { config, storeRoot, recordPath } = input;
  const nowMs = input.now();
  const today = isoDate(new Date(nowMs));
  const update = (change: (r: DreamTriggerRecord) => DreamTriggerRecord | null) =>
    updateDreamTriggerRecord(recordPath, storeRoot, change);

  const vault = input.vault !== undefined ? input.vault : resolveVault(config.path);
  const opened = openDreamOwnerStore(vault, config.path);
  if (opened.store === null || !opened.store.partitions.has("shared")) {
    // Nothing here can be started today: no store, a legacy tree, no
    // device id, or no shared partition. Cached for the day.
    update((r) => ({ ...r, owner: ownerOf(null, false), owner_checked_day: today }));
    return NOTHING;
  }
  const store = opened.store;
  const auto = readDreamAuto(store.root);
  if (auto === null) return NOTHING;
  let owner: DreamOwner | null;
  try {
    owner = readDreamOwner(store).owner;
  } catch {
    return NOTHING;
  }
  const mine = owner !== null && owner.device === store.device;
  if (!mine) {
    const text = owner === null ? null : silentOwnerLineFor(vault, config.path, owner, nowMs);
    let note: string | undefined;
    let unshow: (() => void) | undefined;
    update((r) => {
      const show = input.notes && text !== null && r.line.shown_day !== today;
      if (show) {
        note = text;
        unshow = unshowLine(recordPath, storeRoot, today, { text, shown_day: r.line.shown_day });
      }
      return {
        ...r,
        auto,
        owner: ownerOf(owner, false),
        owner_checked_day: today,
        line: { text, shown_day: show ? today : r.line.shown_day },
      };
    });
    return note === undefined || unshow === undefined ? NOTHING : { started: false, note, unshow };
  }
  update((r) => ({ ...r, auto, owner: ownerOf(owner, true), owner_checked_day: today }));
  if (!auto) return NOTHING;

  // A pass is running here (started by a person, a scheduler or a worker).
  const passLock = dreamPassLockTarget(store);
  if (processLockHeld(passLock, input.now)) return NOTHING;

  // Everything the spawn needs is ready before the claim is taken, so a
  // check cut between the claim and the spawn leaves as little as can be.
  const claimPath = dreamTriggerClaimPath(recordPath);
  mkdirSync(dirname(claimPath), { recursive: true });
  const log = dreamWorkerLogPath(store);
  mkdirSync(dirname(log), { recursive: true });
  const command = o2bCommand();
  const token = createClaim(claimPath, nowMs);
  if (token === null) {
    const grace = claimGraceMs(config.path);
    // Judged again under the claim's lock: a claim replaced since, or a
    // worker that took the pass lock since, is not lost.
    let verdict = "standing" as ClaimVerdict;
    let unreadable = false;
    let judged = false;
    try {
      removeClaimIf(claimPath, (seen) => {
        judged = true;
        unreadable = seen.kind === "unreadable";
        verdict = judgeClaim(seen, nowMs, grace, () => processLockHeld(passLock, input.now));
        return verdict !== "standing";
      });
    } catch (err) {
      // The claim's lock stayed held past the wait before the claim was
      // judged: that says nothing about its worker. Nothing is recorded,
      // and the next check looks again.
      if (!judged && isLockContention(err)) return NOTHING;
      // A claim judged lost that cannot be removed would block every day
      // in silence: it is a failed attempt, named, with its retry time.
      const message = err instanceof Error ? err.message : String(err);
      update((r) =>
        failedAttempt(
          r,
          nowMs,
          `the dream trigger's claim ${claimPath} cannot be removed: ${message}`,
          false,
        ),
      );
      return NOTHING;
    }
    if (verdict === "lost") {
      update((r) =>
        unreadable
          ? failedAttempt(
              r,
              nowMs,
              `the dream trigger's claim ${claimPath} could not be read; it was removed`,
              false,
            )
          : failedAttempt(r, nowMs, "the dream worker ended without recording an outcome", true),
      );
    }
    return NOTHING;
  }

  // Under the claim: a day another pass closed, or a retry time that has
  // not come (written since the fast path read the record), starts nothing.
  const current = readDreamTriggerRecord(recordPath, storeRoot);
  if (current !== null && dreamDayRecordWaits(current, nowMs)) {
    releaseClaim(claimPath, token);
    return NOTHING;
  }

  // The attempt is recorded before its worker starts, so the worker's
  // outcome, written when its pass ends, is the last word on it.
  update((r) => ({
    ...r,
    last_run: {
      started_at: new Date(nowMs).toISOString(),
      ended_at: null,
      outcome: null,
      by: "worker",
    },
  }));
  try {
    beginWorkerLogAttempt(
      log,
      workerLogAttemptHeader(new Date(nowMs), `started by process ${process.pid}`),
    );
    // The worker runs on the vault the check served, not the one its own
    // config would resolve to.
    const vaultArgs =
      input.vault !== undefined && input.vault !== null ? ["--vault", input.vault] : [];
    spawnSelfDetached([...command, "dream", "run", ...vaultArgs, DREAM_RUN_CLAIM_FLAG, token], {
      env: { ...input.env, OPEN_SECOND_BRAIN_CONFIG: config.path },
      stderrLog: log,
      appendStderrLog: true,
    });
  } catch (err) {
    releaseClaim(claimPath, token);
    const message = err instanceof Error ? err.message : String(err);
    update((r) =>
      failedAttempt(r, nowMs, `the dream worker could not be started: ${message}`, false),
    );
    return NOTHING;
  }
  return { started: true };
}

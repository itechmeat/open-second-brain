/**
 * The dream day check (change `dream-session-trigger`, design D2, spec
 * "The check at session entry is nearly free on a closed day"): run at
 * session entry, by the session start hook and by the MCP server at
 * `initialize` and at the first tool call of a new UTC day. It decides
 * whether a dream pass is due on this machine and, on the owner's device,
 * starts one detached worker that runs it; the session never waits.
 *
 * The closed-day path costs the machine config the caller already loaded
 * and one small device-local file (`record.ts`): it returns when the day
 * is closed, the retry time has not come, automatic dream is off, or this
 * device is not the owner as read today. Only otherwise does it load the
 * due path (`due.ts`), which opens the store.
 *
 * It never fails its caller: every throw is swallowed and named on the
 * standard error stream. It does not run inside a dream session (the
 * marker of `dream-queue/dream-session.ts`), nor on a machine whose
 * environment turns automatic dream off (`OPEN_SECOND_BRAIN_DREAM_AUTO`).
 */

import { statSync } from "node:fs";

import type { ConfigDiscovery } from "../../types.ts";
import { insideDreamSession } from "../dream-queue/dream-session.ts";
import { isoDate } from "../time.ts";
import { dreamAutoOffByEnv } from "./constants.ts";
import type { DreamDayCheckResult } from "./due.ts";
import {
  configuredTriggerStoreRoot,
  dreamDayClosed,
  dreamDayRecordWaits,
  dreamTriggerRecordPath,
  dreamTriggerStoreExists,
  readDreamTriggerRecord,
  showLineOnce,
} from "./record.ts";

export type { DreamDayCheckResult } from "./due.ts";

type DueModule = typeof import("./due.ts");

export interface DreamDayCheckOptions {
  /** Wall clock (default `Date.now`). */
  readonly now?: () => number;
  /** The environment the check reads and a worker inherits (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Whether the caller shows a note to the session (the hook, `initialize`):
   * a note is counted as shown only then. A tool call shows none.
   */
  readonly notes?: boolean;
  /**
   * The vault the caller serves (an MCP server started with `--vault`);
   * absent: the vault the machine config resolves to. The owner check,
   * the line and the worker's pass all run on it.
   */
  readonly vault?: string | null;
}

const NOTHING: DreamDayCheckResult = Object.freeze({ started: false });

function due(): DueModule {
  // Loaded only when the record does not answer: the closed-day path
  // never pays for the store, the owner fold or the spawn helper.
  return require("./due.ts") as DueModule;
}

function check(config: ConfigDiscovery, options: DreamDayCheckOptions): DreamDayCheckResult {
  const env = options.env ?? process.env;
  if (insideDreamSession(env) || dreamAutoOffByEnv(env)) return NOTHING;
  const now = options.now ?? Date.now;
  const notes = options.notes === true;
  // The store root and the record's state root both from the caller's
  // environment: the one the store's own device-local state follows.
  const storeRoot = configuredTriggerStoreRoot(config, env);
  const recordPath = dreamTriggerRecordPath(storeRoot, env);
  const nowMs = now();
  const today = isoDate(new Date(nowMs));
  const record = readDreamTriggerRecord(recordPath, storeRoot);
  if (record !== null) {
    const checkedToday = record.owner_checked_day === today;
    const lineDue = notes && record.line.text !== null && record.line.shown_day !== today;
    const withLine = (): DreamDayCheckResult => {
      if (!lineDue) return NOTHING;
      const shown = showLineOnce(recordPath, storeRoot, today);
      return shown === undefined
        ? NOTHING
        : { started: false, note: shown.text, unshow: shown.unshow };
    };
    // Not the owner (or no owner), as read today.
    if (checkedToday && record.owner !== null && !record.owner.mine) return withLine();
    if (checkedToday && record.auto === false) return NOTHING;
    // A closed day ahead of the clock counts as closed (`dreamDayClosed`).
    if (dreamDayClosed(record, today)) return withLine();
    if (dreamDayRecordWaits(record, nowMs)) return NOTHING;
  }
  // No store at the configured root: nothing to start, and no state is
  // kept for a store that does not exist. One look, no store module.
  if (!dreamTriggerStoreExists(storeRoot)) return NOTHING;
  return due().dueDreamDayCheck({
    config,
    storeRoot,
    recordPath,
    now,
    env,
    notes,
    ...(options.vault !== undefined ? { vault: options.vault } : {}),
  });
}

/**
 * Check whether a dream pass is due and start it when it is. `config` is
 * the machine config the caller loaded (`null`: none could be read, and
 * nothing is checked).
 */
export function dreamDayCheck(
  config: ConfigDiscovery | null,
  options: DreamDayCheckOptions = {},
): DreamDayCheckResult {
  if (config === null) return NOTHING;
  try {
    return check(config, options);
  } catch (err) {
    try {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`open-second-brain: the dream day check failed: ${message}\n`);
    } catch {
      // a closed stream: nothing more to say
    }
    return NOTHING;
  }
}

/**
 * The version of this machine's day record for `config`: its file's
 * modification time, `null` when there is none (or no config). One
 * `stat`; never throws. A long-lived caller that checked once today
 * compares it to know whether anything wrote the record since.
 */
export function dreamDayRecordStamp(
  config: ConfigDiscovery | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  if (config === null) return null;
  try {
    return statSync(dreamTriggerRecordPath(configuredTriggerStoreRoot(config, env), env)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether the record no longer holds today's owner check: a verb on this
 * machine took or gave up the dream owner role, or set `dream.auto`, and
 * cleared it (`forget.ts`), so the next check looks again. Never throws.
 */
export function dreamOwnerCheckForgotten(
  config: ConfigDiscovery | null,
  today: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (config === null) return false;
  try {
    const storeRoot = configuredTriggerStoreRoot(config, env);
    const record = readDreamTriggerRecord(dreamTriggerRecordPath(storeRoot, env), storeRoot);
    return record !== null && record.owner_checked_day !== today;
  } catch {
    return false;
  }
}

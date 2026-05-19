import { existsSync } from "node:fs";
import { join } from "node:path";

import { BrainConfigError, loadBrainConfig } from "../brain/policy.ts";
import { countBrainEvents, type BrainEventCounts } from "./log-counts.ts";
import { gitActivity } from "./activity-git.ts";
import { mtimeActivity } from "./activity-mtime.ts";
import { vaultDelta } from "./vault-delta.ts";
import { decideStatus, type ActivitySummary, type DisciplineStatus, type RepoActivityRow, type NonRepoActivityRow } from "./decision.ts";
import { renderReport } from "./render.ts";
import { yesterdayWindow } from "./window.ts";

export interface RunDisciplineReportOpts {
  readonly vault: string;
  readonly now?: Date;
}

export interface DisciplineReportResult {
  readonly status: DisciplineStatus | "disabled";
  readonly text: string;
  readonly localDate: string | null;
  readonly events: BrainEventCounts | null;
  readonly activity: ActivitySummary | null;
}

export function runDisciplineReport(opts: RunDisciplineReportOpts): DisciplineReportResult {
  // A vault without Brain/_brain.yaml (legacy bare vault, or fresh `o2b
  // init` without `o2b brain init`) used to crash the report path here.
  // Downgrade to the `disabled` shape — same as an explicit `enabled:
  // false` — so the Hermes cron stays silent instead of posting empty
  // messages on every tick.
  let cfg;
  try {
    cfg = loadBrainConfig(opts.vault);
  } catch (e) {
    if (e instanceof BrainConfigError) {
      return { status: "disabled", text: "", localDate: null, events: null, activity: null };
    }
    throw e;
  }
  const d = cfg.discipline_report;
  if (!d || !d.enabled) {
    return { status: "disabled", text: "", localDate: null, events: null, activity: null };
  }
  const now = opts.now ?? new Date();
  const win = yesterdayWindow(now, d.timezone);
  const events = countBrainEvents(opts.vault, win.localDate, d.known_agents);

  const repo: RepoActivityRow[] = [];
  const nonRepo: NonRepoActivityRow[] = [];
  for (const p of d.watched_paths) {
    const g = gitActivity(p, win);
    if (g !== null) {
      repo.push({ path: p, git: g });
    } else if (existsSync(p)) {
      const m = mtimeActivity(p, win);
      nonRepo.push({ path: p, modifiedFiles: m.modifiedFiles });
    }
  }
  const vd = vaultDelta(opts.vault, win);

  const activity: ActivitySummary = { repo, nonRepo, vaultDelta: vd };
  const status = decideStatus(events, activity);
  const text = renderReport({
    localDate: win.localDate,
    timezone: d.timezone,
    status,
    events,
    activity,
  });
  return { status, text, localDate: win.localDate, events, activity };
}

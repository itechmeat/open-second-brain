import { existsSync } from "node:fs";

import { loadBrainConfig } from "../brain/policy.ts";
import { brainConfigPath } from "../brain/paths.ts";
import { countBrainEvents, type BrainEventCounts } from "./log-counts.ts";
import { gitActivity } from "./activity-git.ts";
import { mtimeActivity } from "./activity-mtime.ts";
import { vaultDelta } from "./vault-delta.ts";
import {
  buildComplexityReport,
  complexityPathFactors,
  type ComplexityChangedPath,
} from "./complexity.ts";
import {
  decideStatus,
  type ActivitySummary,
  type DisciplineStatus,
  type NonRepoActivityRow,
  type RepoActivityRow,
} from "./decision.ts";
import { renderReport } from "./render.ts";
import { yesterdayWindow } from "./window.ts";
import { collectTranscriptActivity } from "./transcripts/index.ts";

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
  if (!existsSync(brainConfigPath(opts.vault))) {
    return {
      status: "disabled",
      text: "",
      localDate: null,
      events: null,
      activity: null,
    };
  }
  const cfg = loadBrainConfig(opts.vault);
  const d = cfg.discipline_report;
  if (!d || !d.enabled) {
    return {
      status: "disabled",
      text: "",
      localDate: null,
      events: null,
      activity: null,
    };
  }
  const now = opts.now ?? new Date();
  const win = yesterdayWindow(now, d.timezone);
  const events = countBrainEvents(opts.vault, win.localDate, d.known_agents);

  const repo: RepoActivityRow[] = [];
  const nonRepo: NonRepoActivityRow[] = [];
  const changedPaths: ComplexityChangedPath[] = [];
  for (const p of d.watched_paths) {
    const g = gitActivity(p, win);
    if (g !== null) {
      repo.push({ path: p, git: g });
      for (const relativePath of g.pathsChanged ?? []) {
        changedPaths.push({ root: p, relativePath });
      }
    } else if (existsSync(p)) {
      const m = mtimeActivity(p, win);
      nonRepo.push({ path: p, modifiedFiles: m.modifiedFiles });
      for (const relativePath of m.modifiedPaths) {
        changedPaths.push({ root: p, relativePath });
      }
    }
  }
  const vd = vaultDelta(opts.vault, win);

  // Per-runtime session-transcript activity (v0.10.11). Hardened: if
  // a resolver throws (unreadable home, missing perms), we degrade
  // to zero counts rather than failing the whole report.
  let transcripts;
  try {
    transcripts = collectTranscriptActivity({
      dayStartMs: win.startUtc.getTime(),
      dayEndMs: win.endUtc.getTime(),
    });
  } catch {
    transcripts = { byRuntime: [], totalFiles: 0 };
  }

  const structuralFilesChanged =
    repo.reduce((total, row) => total + row.git.filesChanged, 0) +
    nonRepo.reduce((total, row) => total + row.modifiedFiles, 0);
  const pathFactors = complexityPathFactors(changedPaths);
  const complexity = buildComplexityReport(
    {
      thinkingActivity: countTasteEvents(events),
      structuralFilesChanged,
      ...pathFactors,
    },
    { now },
  );

  const activity: ActivitySummary = {
    repo,
    nonRepo,
    vaultDelta: vd,
    transcripts,
    complexity,
  };
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

function countTasteEvents(events: BrainEventCounts): number {
  let total = 0;
  for (const counts of Object.values(events.byAgent)) {
    total += counts.feedback + counts.apply_evidence;
  }
  for (const unknown of events.unknownAgents) {
    total += unknown.counts.feedback + unknown.counts.apply_evidence;
  }
  return total;
}

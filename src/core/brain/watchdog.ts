import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { appendAuditRecord } from "../reliability/audit.ts";
import { buildProbeReport, type ProbeCheck, type ProbeReport } from "../reliability/probe.ts";
import { resolveIndexPath } from "../search/paths.ts";
import {
  BRAIN_CONFIG_FILE,
  BRAIN_INBOX_REL,
  BRAIN_LOG_REL,
  BRAIN_PREFERENCES_REL,
  BRAIN_PROCESSED_REL,
  BRAIN_RETIRED_REL,
  brainConfigPath,
  brainDirs,
} from "./paths.ts";

export interface WatchdogOptions {
  readonly remediate?: boolean;
  readonly dryRun?: boolean;
  readonly restoreRunId?: string;
  readonly forceRestore?: boolean;
  readonly attempt?: number;
  readonly now?: Date;
}

export interface WatchdogRemediation {
  readonly action: "create-dir" | "run-command" | "restore-snapshot";
  readonly target?: string;
  readonly command?: string;
  readonly safe: boolean;
  readonly applied?: boolean;
}

export interface WatchdogRestoreState {
  readonly requested: boolean;
  readonly refused: boolean;
  readonly run_id?: string;
  readonly command?: string;
  readonly reason?: string;
}

export interface WatchdogBackoff {
  readonly attempt: number;
  readonly base_delay_ms: number;
  readonly next_delay_ms: number;
  readonly max_delay_ms: number;
}

export interface BrainWatchdogResult {
  readonly report: ProbeReport;
  readonly remediation_plan: ReadonlyArray<WatchdogRemediation>;
  readonly applied_remediations: ReadonlyArray<WatchdogRemediation>;
  readonly restore: WatchdogRestoreState;
  readonly backoff: WatchdogBackoff;
  readonly audit_path: string;
}

const REQUIRED_DIRS: ReadonlyArray<{
  rel: string;
  pathKey: keyof ReturnType<typeof brainDirs>;
}> = [
  { rel: BRAIN_PREFERENCES_REL, pathKey: "preferences" },
  { rel: BRAIN_RETIRED_REL, pathKey: "retired" },
  { rel: BRAIN_INBOX_REL, pathKey: "inbox" },
  { rel: BRAIN_PROCESSED_REL, pathKey: "processed" },
  { rel: BRAIN_LOG_REL, pathKey: "log" },
];

export function runBrainWatchdog(vault: string, opts: WatchdogOptions = {}): BrainWatchdogResult {
  const now = opts.now ?? new Date();
  const checks: ProbeCheck[] = [];
  const remediationPlan: WatchdogRemediation[] = [];
  const applied: WatchdogRemediation[] = [];
  const dirs = brainDirs(vault);

  const configPath = brainConfigPath(vault);
  if (existsSync(configPath)) {
    checks.push({
      name: "brain-config",
      status: "ok",
      message: `${BRAIN_CONFIG_FILE} exists`,
    });
  } else {
    checks.push({
      name: "brain-config",
      status: "critical",
      message: `${BRAIN_CONFIG_FILE} is missing`,
      remediation: "run o2b brain init",
    });
    remediationPlan.push({
      action: "run-command",
      command: "o2b brain init",
      safe: false,
    });
  }

  for (const dir of REQUIRED_DIRS) {
    const abs = dirs[dir.pathKey];
    if (existsSync(abs)) {
      checks.push({
        name: `dir:${dir.rel}`,
        status: "ok",
        message: `${dir.rel} exists`,
      });
      continue;
    }
    checks.push({
      name: `dir:${dir.rel}`,
      status: "warning",
      message: `${dir.rel} is missing`,
      remediation: `create ${dir.rel}`,
    });
    const remediation: WatchdogRemediation = {
      action: "create-dir",
      target: dir.rel,
      safe: true,
    };
    remediationPlan.push(remediation);
    if (opts.remediate && !opts.dryRun) {
      mkdirSync(abs, { recursive: true });
      applied.push({ ...remediation, applied: true });
    }
  }

  const indexPath = resolveIndexPath(vault, null);
  if (existsSync(indexPath)) {
    checks.push({
      name: "search-index",
      status: "ok",
      message: "search index exists",
    });
  } else {
    checks.push({
      name: "search-index",
      status: "warning",
      message: "search index is missing or not yet built",
      remediation: "run o2b search index",
    });
    remediationPlan.push({
      action: "run-command",
      command: "o2b search index",
      safe: true,
    });
  }

  const restore = buildRestoreState(opts.restoreRunId, opts.forceRestore === true);
  if (restore.requested) {
    checks.push({
      name: "snapshot-restore",
      status: restore.refused ? "critical" : "warning",
      message: restore.refused
        ? "snapshot restore refused without --force-restore"
        : "snapshot restore is explicit and force-enabled; delegate to rollback command",
      remediation: restore.command,
    });
    if (restore.command) {
      remediationPlan.push({
        action: "restore-snapshot",
        command: restore.command,
        safe: false,
      });
    }
  }

  const report = buildProbeReport(checks);
  const backoff = buildBackoff(opts.attempt ?? 0);
  const auditPath = appendAuditRecord(join(dirs.log, "watchdog"), {
    timestamp: now.toISOString(),
    actor: "watchdog",
    action: "brain_watchdog",
    target: "Brain",
    ok: report.counts.critical === 0,
    details: {
      counts: report.counts,
      remediate: opts.remediate === true,
      dry_run: opts.dryRun === true,
      applied: applied.length,
      restore,
      backoff,
    },
  });

  return {
    report,
    remediation_plan: Object.freeze(remediationPlan),
    applied_remediations: Object.freeze(applied),
    restore,
    backoff,
    audit_path: auditPath,
  };
}

function buildRestoreState(runId: string | undefined, force: boolean): WatchdogRestoreState {
  if (runId === undefined || runId.trim() === "") return { requested: false, refused: false };
  const trimmed = runId.trim();
  if (!force) {
    return {
      requested: true,
      refused: true,
      run_id: trimmed,
      reason:
        "snapshot restore requires --force-restore and should normally be run through rollback",
    };
  }
  return {
    requested: true,
    refused: false,
    run_id: trimmed,
    command: `o2b brain rollback ${trimmed} --yes --force-rollback`,
  };
}

function buildBackoff(attempt: number): WatchdogBackoff {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const base = 1000;
  const max = 60_000;
  return {
    attempt: safeAttempt,
    base_delay_ms: base,
    next_delay_ms: Math.min(max, base * 2 ** safeAttempt),
    max_delay_ms: max,
  };
}

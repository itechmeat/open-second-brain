import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { brainConfigExists } from "../../brain/policy/load.ts";
import { loadBrainConfig } from "../../brain/policy.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { findLegacyDisciplineJobs } from "../../discipline/legacy-jobs.ts";
import * as disciplineReport from "../../discipline/report.ts";
import { yesterdayWindow } from "../../discipline/window.ts";
import { acquireProcessLock } from "../../store/process-lock.ts";
import { storesStateDir } from "../../store/store-paths.ts";
import { vaultKey } from "../../state/machine-state.ts";
import { shellQuote } from "../../shell-quote.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";
import { withholdsPrivate } from "./store-check.ts";

const VALID_STATUSES = new Set(["ok", "info", "alert"]);
const DISCIPLINE_ALERT_CODE = "discipline-alert";
const DISCIPLINE_INFO_CODE = "discipline-info";

function cachePath(vault: string, date: string): string {
  return join(storesStateDir(), "discipline-report", vaultKey(vault), `${date}.json`);
}

function cachedStatus(path: string, date: string): "ok" | "info" | "alert" | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const record = value as { localDate?: unknown; status?: unknown };
    return record.localDate === date &&
      typeof record.status === "string" &&
      VALID_STATUSES.has(record.status)
      ? (record.status as "ok" | "info" | "alert")
      : null;
  } catch {
    return null;
  }
}

function emit(
  status: "ok" | "info" | "alert",
  date: string,
  vault: string,
  out: DoctorFindings,
): void {
  const code = status === "alert" ? DISCIPLINE_ALERT_CODE : DISCIPLINE_INFO_CODE;
  out.uncertain.push({
    code: code,
    path: vault,
    message: `Open Second Brain discipline report for ${date}: ${status}. Run o2b discipline report --vault ${shellQuote(vault)} for details.`,
  });
}

export const disciplineDoctorCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    if (withholdsPrivate(ctx)) return;
    if (ctx.vault === null || !brainConfigExists(ctx.vault)) return;
    const config = loadBrainConfig(ctx.vault).discipline_report;
    if (!config?.enabled) return;
    const date = yesterdayWindow(ctx.now, config.timezone).localDate;
    const path = cachePath(ctx.vault, date);
    const before = cachedStatus(path, date);
    if (before !== null) {
      emit(before, date, ctx.vault, out);
      return;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      const release = acquireProcessLock(`${path}.lock`, {
        label: "discipline report cache lock",
        remedy: "retry doctor after the discipline report finishes",
      });
      try {
        const status = cachedStatus(path, date);
        if (status !== null) {
          emit(status, date, ctx.vault, out);
          return;
        }
        const result = disciplineReport.runDisciplineReport({ vault: ctx.vault, now: ctx.now });
        if (result.status === "disabled" || result.localDate !== date) return;
        atomicWriteFileSync(
          path,
          JSON.stringify({ localDate: date, status: result.status }) + "\n",
        );
        emit(result.status, date, ctx.vault, out);
      } finally {
        release();
      }
    } catch {
      return;
    }
  },
};

export const legacyDisciplineJobsCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    // The jobs file and its job ids are this machine's own: a caller below
    // local reach gets neither.
    if (withholdsPrivate(ctx)) return;
    const found = findLegacyDisciplineJobs();
    if (found === null) return;
    out.uncertain.push({
      code: "discipline-legacy-jobs",
      path: found.file,
      message: `Legacy Hermes jobs remain in ${found.file}: ${found.ids.join(", ")}. Remove them with hermes cron remove <id>.`,
    });
  },
};

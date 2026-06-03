/**
 * Optional external judge bridge (Memory Observability Suite,
 * t_882c396a).
 *
 * The Brain core stays deterministic: no LLM ever runs inside the
 * harness. When `bench_judge_cmd` is configured, the command receives
 * the evaluated questions as JSON on stdin and may return
 * `{ "verdicts": { "<question-id>": true|false } }` on stdout. The
 * judge is advisory - deterministic evaluation stays canonical, the
 * verdicts land in the report for comparison. Absent config means the
 * judge phase is skipped and marked as such; a failing command marks
 * `error` without failing the run (fail-open, like all telemetry).
 */

import { spawnSync } from "node:child_process";

import type { BenchQuestionResult, BenchReport } from "./types.ts";

export interface JudgeOutcome {
  readonly status: BenchReport["judge"]["status"];
  readonly detail?: string;
  readonly verdicts?: Readonly<Record<string, boolean>>;
}

export function runJudge(
  cmd: string | undefined,
  questions: ReadonlyArray<BenchQuestionResult>,
): JudgeOutcome {
  if (cmd === undefined || cmd.trim() === "") return Object.freeze({ status: "skipped" });
  try {
    const proc = spawnSync("sh", ["-c", cmd], {
      input: JSON.stringify({ questions }),
      encoding: "utf8",
      timeout: 60_000,
    });
    if (proc.status !== 0) {
      return Object.freeze({
        status: "error",
        detail: `judge command exited ${proc.status ?? "by signal"}`,
      });
    }
    const parsed = JSON.parse(proc.stdout) as { verdicts?: Record<string, unknown> };
    const verdicts: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed.verdicts ?? {})) {
      if (typeof value === "boolean") verdicts[id] = value;
    }
    return Object.freeze({ status: "ran", verdicts: Object.freeze(verdicts) });
  } catch (error) {
    return Object.freeze({
      status: "error",
      detail: error instanceof Error ? error.message : "judge command failed",
    });
  }
}

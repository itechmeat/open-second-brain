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
 *
 * Spawn/timeout/JSON plumbing lives in the shared
 * `runJsonCommandBridge` (reliability/command-bridge.ts); this module
 * keeps only the verdict-shape validation.
 */

import { runJsonCommandBridge } from "../reliability/command-bridge.ts";

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
  const result = runJsonCommandBridge(cmd, { questions }, { label: "judge command" });
  if (result.status === "skipped") return Object.freeze({ status: "skipped" });
  if (result.status === "error") {
    return Object.freeze({ status: "error", detail: result.detail });
  }
  if (result.output === null || typeof result.output !== "object") {
    return Object.freeze({ status: "error", detail: "judge output is not an object" });
  }
  const parsed = result.output as { verdicts?: Record<string, unknown> };
  const verdicts: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(parsed.verdicts ?? {})) {
    if (typeof value === "boolean") verdicts[id] = value;
  }
  return Object.freeze({ status: "ran", verdicts: Object.freeze(verdicts) });
}

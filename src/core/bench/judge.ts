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

import type { BenchJudgeInput, BenchQuestionResult, BenchReport } from "./types.ts";

export interface JudgeOutcome {
  readonly status: BenchReport["judge"]["status"];
  readonly detail?: string;
  readonly verdicts?: Readonly<Record<string, boolean>>;
}

/**
 * Evaluate the questions, optionally enriched with the suite-provided
 * judge input.
 *
 * The stdin payload stays `{ questions: [...] }`; a question whose
 * suite provides {@link BenchJudgeInput} carries three extra fields -
 * `question`, `answer` (when the dataset states one) and `gold` - and a
 * question without one keeps the exact pre-existing shape, so payloads
 * for suites without judge input are unchanged byte for byte. The
 * suite's prompt constants are self-written (see
 * `LONGMEMEVAL_PROMPT_PROVENANCE`); nothing upstream pins them.
 */
export function runJudge(
  cmd: string | undefined,
  questions: ReadonlyArray<BenchQuestionResult>,
  judgeInputs?: ReadonlyMap<string, BenchJudgeInput>,
): JudgeOutcome {
  const payload = {
    questions: questions.map((result) => {
      const input = judgeInputs?.get(result.id);
      if (input === undefined) return result;
      return {
        ...result,
        question: input.question,
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        gold: [...input.gold],
        ...(input.evidence !== undefined
          ? { evidence: input.evidence.map((e) => ({ path: e.path, text: e.text })) }
          : {}),
      };
    }),
  };
  const result = runJsonCommandBridge(cmd, payload, { label: "judge command" });
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

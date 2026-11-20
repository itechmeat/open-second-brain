/**
 * The steps at the tail of a dream pass that belong to the brain store:
 * topic planning (design D9) and then the render of the human view
 * (design D7). Both run only where the store is in use, never on a dry
 * run, and fail open, so a summary on a machine without a store is
 * byte-identical to before.
 */

import { describeTopicPlanning, runAutoTopicPlanning } from "../topics/planning.ts";
import { describeAutoView, runAutoViewPass } from "../view/auto-render.ts";
import { VIEW_DREAM_BUDGET_MS } from "../view/constants.ts";
import type { DreamOptions, DreamRunSummary } from "./dream-types.ts";

/**
 * A progress stage a tail step reports as: `start` when the step is known
 * to run here (the store is in use), `done` when it returns.
 */
export interface TailStage {
  start(): void;
  done(): void;
  /** The step stopped at the pass's deadline (or an abort): `error` is the checkpoint's throw. */
  stopped(error: unknown): void;
}

/**
 * Plan topics before the render (design D9): on the view writer, route
 * unassigned records and create topics from recurring clusters; any other
 * machine plans nothing and its summary names the writer. Fail-open, and
 * absent when the brain store is not in use here or on a dry run.
 */
export function withTopicPass(
  summary: DreamRunSummary,
  opts: DreamOptions,
  stage?: TailStage,
): DreamRunSummary {
  if (opts.dryRun === true) return summary;
  let started = false;
  let deadline: unknown;
  // The run's deadline holds here too, where the store is in use: a pass
  // whose deadline passed plans nothing and leaves topics to the next one.
  const safeguard = opts.safeguard;
  const runAt = opts.now;
  const report = runAutoTopicPlanning({
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    // The run's own clock, when it has one: quiet topics and record times
    // follow the date the run is for.
    ...(runAt !== undefined ? { now: () => runAt.getTime() } : {}),
    ...(opts.topicVerdicts !== undefined ? { topicVerdicts: opts.topicVerdicts } : {}),
    // Asked once the store is known to be in use, before the read: the
    // stage opens there, so a machine without a store reports none.
    mayPlan: () => {
      if (!started) {
        started = true;
        stage?.start();
      }
      if (safeguard === undefined) return true;
      try {
        safeguard.checkpoint();
        return true;
      } catch (error) {
        // Planning leaves topics to the next pass, and the stream says the
        // pass stopped here, with the reason, rather than that it finished.
        deadline = error;
        return false;
      }
    },
  });
  if (deadline !== undefined) stage?.stopped(deadline);
  else if (started) stage?.done();
  if (report === null) return summary;
  // Topics created, records routed and model verdict records are writes
  // of this pass. A pass that failed midway counts what it wrote before
  // the failure.
  const wrote =
    (report.status === "planned" || report.status === "error") &&
    report.created.length +
      report.routed.length +
      report.derived +
      report.resolutions +
      report.completions +
      report.hidden +
      report.kept >
      0;
  return {
    ...summary,
    ...(wrote ? { changed: true } : {}),
    topics: { summary: describeTopicPlanning(report), report },
  };
}

/**
 * Render the human view at the end of a pass that wrote (design D7): the
 * view writer keeps its pages current, any other machine writes none and
 * its summary names the writer. Bounded by a time budget: pages it does
 * not reach are deferred to the next pass and counted. Fail-open, and
 * absent when the brain store is not in use here, so such a summary is
 * byte-identical to before.
 */
export function withViewPass(
  summary: DreamRunSummary,
  opts: DreamOptions,
  stage?: TailStage,
): DreamRunSummary {
  if (opts.dryRun === true) return summary;
  let started = false;
  const result = runAutoViewPass({
    trigger: "dream",
    onStart: () => {
      started = true;
      stage?.start();
    },
    budgetMs: opts.viewBudgetMs ?? VIEW_DREAM_BUDGET_MS,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  if (started) stage?.done();
  if (result === null) return summary;
  return {
    ...summary,
    view: {
      status: result.status,
      summary: describeAutoView(result),
      ...(result.status === "not-writer" ? { writer: result.writer } : {}),
      ...(result.status === "rendered"
        ? { deferred: result.pages.filter((p) => p.status === "deferred").length }
        : {}),
    },
  };
}

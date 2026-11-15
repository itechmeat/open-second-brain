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
 * Plan topics before the render (design D9): on the view writer, route
 * unassigned records and create topics from recurring clusters; any other
 * machine plans nothing and its summary names the writer. Fail-open, and
 * absent when the brain store is not in use here or on a dry run.
 */
export function withTopicPass(summary: DreamRunSummary, opts: DreamOptions): DreamRunSummary {
  if (opts.dryRun === true) return summary;
  // The run's deadline holds here too, where the store is in use: a pass
  // whose deadline passed plans nothing and leaves topics to the next one.
  const safeguard = opts.safeguard;
  const runAt = opts.now;
  const report = runAutoTopicPlanning({
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    // The run's own clock, when it has one: quiet topics and record times
    // follow the date the run is for.
    ...(runAt !== undefined ? { now: () => runAt.getTime() } : {}),
    ...(safeguard !== undefined
      ? {
          mayPlan: () => {
            try {
              safeguard.checkpoint();
              return true;
            } catch {
              return false;
            }
          },
        }
      : {}),
  });
  if (report === null) return summary;
  // Topics created or records routed are writes of this pass.
  // A pass that failed midway lists what it wrote before the failure.
  const wrote =
    (report.status === "planned" || report.status === "error") &&
    report.created.length + report.routed.length > 0;
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
export function withViewPass(summary: DreamRunSummary, opts: DreamOptions): DreamRunSummary {
  if (opts.dryRun === true) return summary;
  const result = runAutoViewPass({
    trigger: "dream",
    budgetMs: opts.viewBudgetMs ?? VIEW_DREAM_BUDGET_MS,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
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

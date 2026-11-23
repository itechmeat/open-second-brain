/**
 * The dream work queue inside a live pass (design D4, D7): the pass on
 * the owner's device of a brain served from the store applies accepted
 * answers at its start and queues the model work of the rungs it fired
 * beside its log write. A dry run or a preview never gets here: the owner
 * gate answers them as previews, and only an owner's live pass opens one.
 *
 * A queue failure never fails the pass: it is carried on the summary as a
 * warning, and the next pass tries again.
 */

import type { StoreHandle } from "../../store/store-open.ts";
import type { DreamOwner } from "../dream-owner/fold.ts";
import type {
  ClosedQuestionsRun,
  DreamOptions,
  DreamRunSummary,
  DreamWarning,
} from "../dream-types.ts";
import type { RollupLadderPlan } from "../rollup-ladder.ts";
import { applyAccepted, dreamQueueForPass, readDreamWork, type DreamQueue } from "./queue.ts";
import { produceRollupWork } from "./rollup-work.ts";

export interface DreamQueuePass {
  readonly queue: DreamQueue;
  produced: number;
  applied: number;
  /** Closed-question answers topic planning applied that decided nothing. */
  abstained: number;
  /** What the front door produced and asked before the pass (`decide-auto.ts`). */
  readonly front?: ClosedQuestionsRun;
  readonly warnings: DreamWarning[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The queue of a live pass that passed the owner gate on this device. */
export function openQueuePass(
  vault: string | null,
  store: StoreHandle,
  owner: DreamOwner,
  opts: DreamOptions,
): DreamQueuePass {
  const front = opts.closedQuestions;
  const writer = opts.agentName?.trim() || "o2b";
  return {
    queue: dreamQueueForPass(store, owner, {
      vault,
      writer,
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    }),
    produced: 0,
    applied: 0,
    abstained: 0,
    ...(front !== undefined ? { front } : {}),
    warnings: [],
  };
}

/** Apply the answers accepted since the last pass (top of the pass). */
export function applyAtPassStart(pass: DreamQueuePass): void {
  try {
    const result = applyAccepted(pass.queue);
    pass.applied += result.applied.length;
    for (const failure of result.failed) {
      pass.warnings.push({
        code: "dream-queue-apply-failed",
        message: `dream work ${failure.item} was not applied: ${failure.reason}`,
      });
    }
  } catch (err) {
    pass.warnings.push({ code: "dream-queue-apply-failed", message: message(err) });
  }
}

/** Queue the model work of every rung the pass fired (beside the log write). */
export function produceAtPassEnd(
  pass: DreamQueuePass,
  input: {
    readonly plan: RollupLadderPlan;
    readonly admittedIds: ReadonlyArray<string>;
    readonly day: string;
  },
): boolean {
  if (!input.plan.fired) return true;
  try {
    const result = produceRollupWork(pass.queue, input, () => (pass.produced += 1));
    if (result.left > 0) {
      pass.warnings.push({
        code: "dream-queue-evidence-bounded",
        message:
          `${result.left} admitted fact(s) were carried into follow-up items in this pass; ` +
          "each item carries a bounded number of facts",
      });
    }
    return true;
  } catch (err) {
    pass.warnings.push({ code: "dream-queue-produce-failed", message: message(err) });
    return false;
  }
}

/** `summary` with the pass's `model_work` counts and queue warnings. */
export function withModelWork(summary: DreamRunSummary, pass: DreamQueuePass): DreamRunSummary {
  let waiting = 0;
  try {
    const state = readDreamWork(pass.queue.store);
    for (const item of state.items.values()) {
      if (item.state !== "finished" && item.state !== "closed") waiting += 1;
    }
    if (state.unreadable.length > 0) {
      pass.warnings.push({
        code: "dream-queue-read-failed",
        message: `waiting count is partial; unreadable queue data: ${state.unreadable.join(", ")}`,
      });
    }
  } catch (err) {
    pass.warnings.push({ code: "dream-queue-read-failed", message: message(err) });
  }
  const front = pass.front;
  return {
    ...summary,
    warnings: [...summary.warnings, ...pass.warnings],
    model_work: {
      produced: pass.produced + (front?.produced ?? 0),
      waiting,
      applied: pass.applied,
      abstained: pass.abstained,
      ...(front !== undefined ? { asked: front.asked } : {}),
    },
  };
}

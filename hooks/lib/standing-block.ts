/**
 * The standing-rules block renderer shared by both injection lanes
 * (context-injection-pipeline).
 *
 * hooks/active-inject.ts puts the block first in the session-start
 * preamble; hooks/subagent-inject.ts delivers the same bytes into a
 * delegated sub-agent's first write-shaped tool call. Extracted from
 * hooks/active-inject.ts so both lanes render the operator's
 * constitution through exactly one code path - one renderer, one cap
 * policy, never a second opinion about what the operator's rules say.
 *
 * ABSENCE AND FAILURE ARE DIFFERENT ANSWERS, and this module is where
 * that distinction lives. An absent or empty `Brain/standing-rules.md`
 * yields "" and the caller stays silent (the steady state is an
 * operator who wrote no rules). A read that FAILED yields the explicit
 * failure block naming the path and the reason: an agent must never be
 * able to mistake "the operator wrote no rules" for "the rules could
 * not be read", and there is no second channel an operator would see.
 *
 * The {@link InjectionMeter} parameter is optional: the session-start
 * lane passes one so the context receipt can attribute the block, while
 * the subagent carrier passes none - the meter feeds the session-start
 * receipt, not the carrier.
 */

import { brainStandingRulesPath } from "../../src/core/brain/paths.ts";
import { RECEIPT_ITEM_STANDING_RULES } from "../../src/core/brain/context-receipts.ts";
import {
  readStandingRules,
  renderStandingRules,
  renderStandingRulesFailure,
} from "../../src/core/brain/standing-rules.ts";

/**
 * Which ceiling a sub-body was charged against, and whether it was
 * emitted at all when the memory assembly failed.
 *
 *   - EXEMPT: produced outside the fail-open boundary. Charged against
 *     its own cap, not `inject_budget_chars`, and emitted whatever the
 *     memory layer does - so it is the one lane still real in a
 *     degraded injection.
 *   - BUDGETED: charged against `inject_budget_chars`. The scoped rules
 *     are charged first and their length is subtracted; the active and
 *     lessons bodies are each charged against what is left, which is why
 *     the receipt records the count and the scoped length.
 *   - UNBUDGETED: assembled inside the boundary but not charged (the
 *     runtime notices, which are bounded by the number of conditions
 *     that can hold rather than by a character count).
 */
export const LANE_EXEMPT = "exempt";
export const LANE_BUDGETED = "budgeted";
export const LANE_UNBUDGETED = "unbudgeted";

type InjectionLane = typeof LANE_EXEMPT | typeof LANE_BUDGETED | typeof LANE_UNBUDGETED;

/**
 * One injected sub-body, captured while it is still a separate string.
 *
 * The parts are joined into one string before emission, so this is the
 * only point at which per-source attribution exists at all. The name is
 * a stable structural identifier, never derived from content.
 */
interface InjectionSource {
  readonly name: string;
  readonly text: string;
  readonly lane: InjectionLane;
  /**
   * Produced outside the fail-open boundary (the standing and scoped
   * rules), so it reached the payload even when the memory body was
   * replaced by the cache, and stays in a degraded receipt.
   */
  readonly outsideBoundary: boolean;
}

/** Mutable accumulator threaded through the assembly, read after it returns. */
export interface InjectionMeter {
  readonly sources: InjectionSource[];
  /** The configured `inject_budget_chars`, before the scoped rules are charged. */
  readonly configuredBudgetChars: number;
  /**
   * The configured `inject_budget_chars` once a budgeted body was measured
   * under it; `null` while nothing was.
   */
  budgetChars: number | null;
  /** Length of the rendered scoped-rules block, subtracted from the budget; 0 when absent. */
  scopedRulesChars: number;
}

/** Sub-body identifier recorded for the standing-rules block. */
const SOURCE_STANDING_RULES = RECEIPT_ITEM_STANDING_RULES;

/**
 * Render the operator's standing-rules block, or the explicit statement
 * that it is unavailable.
 *
 * An absent or empty file yields "" and the lane simply does not appear.
 * A read that FAILED yields a block naming the path and the reason: the
 * agent must never be able to mistake "the operator wrote no rules" for
 * "the rules could not be read", and this is the surface where that
 * distinction has to be made, because there is no second channel the
 * operator would see.
 *
 * The meter is optional (see the module note): pass one to have the
 * block recorded for the context receipt, none when the block goes
 * straight to its consumer.
 */
export function renderStandingBlock(
  vault: string,
  maxChars: number,
  meter?: InjectionMeter,
): string {
  const path = brainStandingRulesPath(vault);
  let block: string;
  try {
    const rules = readStandingRules(vault, { maxChars });
    if (rules === null) return "";
    block = renderStandingRules(rules);
  } catch (err) {
    block = renderStandingRulesFailure(path, err);
  }
  meter?.sources.push({
    name: SOURCE_STANDING_RULES,
    text: block,
    lane: LANE_EXEMPT,
    outsideBoundary: true,
  });
  return block;
}

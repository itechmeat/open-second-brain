/**
 * Question texts and thresholds for the `skills` use (two-stage skill
 * selection for `skills_attach`, issue #213 Part 3).
 *
 * Re-exported from `questions.ts`, which stays the one place to review
 * every question a model is asked. Thresholds are conservative starting points, to be
 * tuned per provider profile from shadow data.
 */

import type { DecisionChoiceQuestion, DecisionNoulQuestion } from "./contract.ts";

/** Longest BM25 shortlist stage 1 chooses from. Never above 254 (255 options with `none`). */
export const SKILLS_SHORTLIST_MAX = 40;

/** Below this `needs_any_skill` probability, enforce offers nothing. */
export const SKILLS_NEEDS_ANY_MIN = 0.2;

/** A stage-2 finalist is offered at or above this probability. */
export const SKILLS_FINAL_MIN = 0.5;

/** Most finalists stage 2 judges (further capped by `max_skills`). */
export const SKILLS_STAGE2_MAX_FINALISTS = 3;

/**
 * Stage 2 is skipped (and the BM25 block returned) when less than this
 * remains of `decision_model_timeout_ms` after stage 1.
 */
export const SKILLS_STAGE2_MIN_REMAINING_MS = 250;

/** Clip of the turn text sent in both stages. */
export const SKILLS_TURN_CLIP_CHARS = 2000;

/** Per-skill clip of the stage-1 line (name and one-line description). */
export const SKILLS_STAGE1_CLIP_CHARS = 240;

/** Per-skill clip of the stage-2 text (description and SKILL.md body). */
export const SKILLS_STAGE2_CLIP_CHARS = 1500;

export const SKILLS_QUESTIONS = Object.freeze({
  /** Mask prefix for stage-1 shortlist entries. */
  shortlistPrefix: "S",
  /** Mask prefix for stage-2 finalists. */
  finalistPrefix: "F",
  pickId: "pick",
  noneKey: "none",
  needsAnyId: "needs_any_skill",
  appliesId: (k: number): string => `applies_${k}`,
  pick(keys: ReadonlyArray<string>): DecisionChoiceQuestion {
    const criteria: Record<string, string | null> = {};
    for (const key of keys) criteria[key] = `The skill \`skills.${key}\` fits the turn best.`;
    criteria["none"] = "None of the listed skills fits the turn.";
    return {
      type: "choice",
      instructions: "Which skill in `skills` best fits the work `turn` asks for?",
      criteria,
    };
  },
  needsAny(): DecisionNoulQuestion {
    return {
      type: "noul",
      instructions: "Does `turn` ask for work that a specialised skill would help with?",
      criteria: {
        true: "The turn asks for a task where a dedicated procedure or tool guide would help.",
        false: "The turn is casual chat, a simple question, or needs no specialised procedure.",
      },
    };
  },
  applies(k: number): DecisionNoulQuestion {
    return {
      type: "noul",
      instructions: `Does the skill described in \`skills.F${k}\` apply to \`turn\`?`,
      criteria: {
        true: "Loading this skill would help with the work the turn asks for.",
        false: "The skill is unrelated, or only shares words with the turn.",
      },
    };
  },
});

/**
 * Question texts, thresholds, versions and limits for the nine topic and
 * agent-context uses of the brain-store change (design D10). Re-exported
 * from `questions.ts`, which stays the one place to review every question
 * a model is asked.
 *
 * Every use refines a deterministic result (the topic planner, the
 * session-start digest, the neighbour lane): the fallback is that
 * result, and a failure keeps it. Thresholds are conservative starting
 * points, to be tuned per model from shadow data; none of the nine uses
 * is covered by the shipped `jev-1.13` baseline, so `enforce` needs a
 * thresholds-store entry or a measured mark first (D20).
 *
 * Question texts refer to state fields with backticked paths
 * (`records.R0`, `topics.T0`), the convention the `systemone` wire
 * format documents.
 */

import type { DecisionChoiceQuestion, DecisionNoulQuestion } from "./contract.ts";

/**
 * The nine uses this phase registered, in contract order. The type is the
 * literal union so `Record<typeof TOPIC_USES[number], T>` stays exact.
 */
export const TOPIC_USES = Object.freeze([
  "topic_route",
  "event_kind",
  "human_readable",
  "topic_new",
  "topic_same",
  "question_resolved",
  "milestone_done",
  "head_select",
  "neighbour_relevant",
] as const);

export type TopicUse = (typeof TOPIC_USES)[number];

/**
 * The seven uses the dream-time decide pass runs (`decide.ts`): they
 * refine the topic planner on the view writer, before the synchronous
 * dream pass. The other two (`head_select`, `neighbour_relevant`) run at
 * hook time.
 */
export const DREAM_TOPIC_USES = Object.freeze([
  "topic_route",
  "event_kind",
  "human_readable",
  "topic_new",
  "topic_same",
  "question_resolved",
  "milestone_done",
] as const);

// ----- per-use thresholds ------------------------------------------------------

/** A `topic_route` answer acts when the chosen topic reaches this. */
export const TOPIC_ROUTE_MIN = 0.6;

/** An `event_kind` answer derives an item when it reaches this. */
export const EVENT_KIND_MIN = 0.7;

/** A note whose `history_<k>` p(yes) is below this is hidden from the weekly history. */
export const HUMAN_READABLE_HIDE_BELOW = 0.3;

/** A qualifying group whose `new_<k>` p(yes) is below this is not created this pass. */
export const TOPIC_NEW_VETO_BELOW = 0.3;

/** A `topic_same` pair verdict counts when it reaches this. */
export const TOPIC_SAME_MIN = 0.7;

/** A `question_resolved` answer proposes a resolution when it reaches this. */
export const QUESTION_RESOLVED_MIN = 0.7;

/** A `milestone_done` answer proposes completion when it reaches this. */
export const MILESTONE_DONE_MIN = 0.8;

/** A head whose `relevant_<k>` p(yes) is below this is left out of the digest. */
export const HEAD_SELECT_DROP_BELOW = 0.1;

/** A neighbour candidate is injected when its `matters_<k>` p(yes) reaches this. */
export const NEIGHBOUR_INJECT_MIN = 0.5;

/**
 * The question set that was asked, per use: the `version` field of a
 * stored verdict (design D20). Every value started at 1; bump one when the
 * use's question texts change meaning. Version 2: each question names its
 * own masked field (`records.R<k>`, `topics.T<k>`, `pairs.A<i>`).
 */
export const TOPIC_USE_QUESTION_VERSION: Readonly<Record<TopicUse, number>> = Object.freeze({
  topic_route: 2,
  event_kind: 2,
  human_readable: 2,
  topic_new: 1,
  topic_same: 2,
  question_resolved: 2,
  milestone_done: 2,
  head_select: 2,
  neighbour_relevant: 2,
});

/**
 * Shared limits of the topic and agent-context uses. One request never
 * carries more than `recordsPerRequest` record questions, and one pass
 * never sends more than `recordsPerPass` records to the model (design
 * D10: bounded fan-out).
 */
export const TOPIC_DECISION_LIMITS = Object.freeze({
  /** Most records one decide pass sends questions about. */
  recordsPerPass: 50,
  /** Most record questions one request carries. */
  recordsPerRequest: 10,
  /** Most topic options one routing question carries (plus `none`). */
  topicOptionsPerQuestion: 20,
  /** Clip of a record's text in any state. */
  recordClipChars: 900,
  /** Clip of one topic head field (title, description, goal). */
  headFieldClipChars: 300,
  /** Most topic pairs one decide pass sends. */
  pairsPerPass: 20,
  /** Most groups one decide pass asks about. */
  groupsPerPass: 10,
  /** Most member texts shown for one group. */
  groupMembersShown: 10,
  /** Clip of one member text shown for a group. */
  groupMemberClipChars: 300,
  /** Most history notes one decide pass asks about. */
  historyNotesPerPass: 50,
  /** Most topic heads one head_select request carries. */
  headsPerRequest: 40,
  /** Most neighbour candidates one turn considers. */
  neighbourCandidatesPerTurn: 20,
});

// ----- topic_route -------------------------------------------------------------

export const TOPIC_ROUTE_QUESTIONS = Object.freeze({
  /** Mask prefix for the candidate records. */
  recordPrefix: "R",
  /** Mask prefix for the topic options. */
  topicPrefix: "T",
  /** The option meaning "no listed topic fits". */
  noneOption: "none",
  routeMin: TOPIC_ROUTE_MIN,
  routeId: (k: number): string => `route_${k}`,
  /**
   * One question per unassigned candidate record. The options are the
   * candidate's scope's active topics, the deterministic best first,
   * then by shared-word count, then by creation; `none` always last.
   */
  route(k: number, topicKeys: ReadonlyArray<string>): DecisionChoiceQuestion {
    const criteria: Record<string, string | null> = {};
    for (const key of topicKeys) criteria[key] = `Record this under topic \`topics.${key}\`.`;
    criteria["none"] = "None of the listed topics fits; the record belongs to no topic.";
    return {
      type: "choice",
      instructions:
        `Which topic in \`topics\` does the record \`records.R${k}\` belong to? ` +
        "Judge the record on its own; the topics are described by their " +
        "`title`, `description` and `goal`.",
      criteria,
    };
  },
});

// ----- event_kind ------------------------------------------------------------

/** The option keys of an `event_kind` question, in the order they are offered. */
export const EVENT_KIND_OPTIONS = Object.freeze([
  "decision",
  "open_question",
  "correction",
  "blocker",
  "reframing",
  "rejected",
  "routine",
] as const);

export type EventKindOption = (typeof EVENT_KIND_OPTIONS)[number];

export const EVENT_KIND_QUESTIONS = Object.freeze({
  /** Mask prefix for the candidate records. */
  recordPrefix: "R",
  kindMin: EVENT_KIND_MIN,
  kindId: (k: number): string => `kind_${k}`,
  kind(k: number): DecisionChoiceQuestion {
    return {
      type: "choice",
      instructions:
        `What kind of topic event is the record \`records.R${k}\`? The record was filed on a ` +
        "topic; judge which of the kinds describes what it contributes to that topic.",
      criteria: {
        decision: "It records a decision the topic's work now follows.",
        open_question: "It raises a question the topic's work needs answered.",
        correction: "It corrects something earlier recorded on the topic.",
        blocker: "It records something that blocks the topic's work.",
        reframing: "It reframes what the topic is about or how its work should proceed.",
        rejected: "It records an idea or course of action that was considered and rejected.",
        routine: "It is ordinary progress or bookkeeping with no lasting content.",
      },
    };
  },
});

// ----- human_readable ----------------------------------------------------------

export const HUMAN_READABLE_QUESTIONS = Object.freeze({
  /** Mask prefix for the weekly-history candidate notes. */
  notePrefix: "R",
  hideBelow: HUMAN_READABLE_HIDE_BELOW,
  historyId: (k: number): string => `history_${k}`,
  history(k: number): DecisionNoulQuestion {
    return {
      type: "noul",
      instructions:
        `Would the person want the note \`records.R${k}\` in their weekly history page - the ` +
        "short recap of the week's work they actually read?",
      criteria: {
        true: "The note is part of what happened this week and reads as history.",
        false:
          "The note is interim bookkeeping - a progress log line, a routine heartbeat - " +
          "whose absence would not change the recap.",
      },
    };
  },
});

// ----- topic_new ---------------------------------------------------------------

export const TOPIC_NEW_QUESTIONS = Object.freeze({
  /** Mask prefix for the draft groups. */
  groupPrefix: "G",
  vetoBelow: TOPIC_NEW_VETO_BELOW,
  newId: (k: number): string => `new_${k}`,
  fresh(): DecisionNoulQuestion {
    return {
      type: "noul",
      instructions:
        "Do the records in `groups` describe one recurring subject that deserves its own " +
        "topic, or only a one-off batch of work?",
      criteria: {
        true:
          "The records circle one subject that will recur - a project, an ongoing concern, " +
          "a standing responsibility - and a topic would help track it.",
        false: "The records are a one-off batch, unrelated side by side, or too thin to track.",
      },
    };
  },
});

// ----- topic_same --------------------------------------------------------------

export const TOPIC_SAME_QUESTIONS = Object.freeze({
  clipChars: TOPIC_DECISION_LIMITS.headFieldClipChars,
  options: Object.freeze(["same", "different"] as const),
  /** Head-token Jaccard above which a pair is asked about at all. */
  pairJaccard: 0.2,
  sameMin: TOPIC_SAME_MIN,
  question(i: number): DecisionChoiceQuestion {
    return {
      type: "choice",
      instructions:
        `Do the two topics \`pairs.A${i}\` and \`pairs.B${i}\` describe the same subject, ` +
        "so that one merged topic would track it better than two?",
      criteria: {
        same: "Both topics track one subject; one merged topic would serve.",
        different: "They are distinct subjects that share vocabulary but not the work.",
      },
    };
  },
});

// ----- question_resolved -------------------------------------------------------

export const QUESTION_RESOLVED_QUESTIONS = Object.freeze({
  /** Mask prefix for the candidate records. */
  recordPrefix: "R",
  /** Mask prefix for the topic's open questions. */
  questionPrefix: "Q",
  /** The option meaning "this record answers nothing". */
  noneOption: "none",
  resolvedMin: QUESTION_RESOLVED_MIN,
  answersId: (k: number): string => `answers_${k}`,
  answers(k: number, questionKeys: ReadonlyArray<string>): DecisionChoiceQuestion {
    const criteria: Record<string, string | null> = {};
    for (const key of questionKeys) {
      criteria[key] = `The record answers open question \`questions.${key}\`.`;
    }
    criteria["none"] = "The record answers none of the listed questions.";
    return {
      type: "choice",
      instructions:
        `Does the record \`records.R${k}\` answer one of the open questions in \`questions\`? ` +
        "A question counts as answered only if the record settles it, not merely discusses it.",
      criteria,
    };
  },
});

// ----- milestone_done ----------------------------------------------------------

export const MILESTONE_DONE_QUESTIONS = Object.freeze({
  /** Mask prefix for the milestones. */
  milestonePrefix: "M",
  /** Mask prefix for the held record texts shown beside a milestone. */
  recordPrefix: "R",
  doneMin: MILESTONE_DONE_MIN,
  doneId: (k: number): string => `done_${k}`,
  done(k: number): DecisionNoulQuestion {
    return {
      type: "noul",
      instructions:
        `Is the milestone \`milestones.M${k}\` done, judged by what the records in \`records\` ` +
        "show was accomplished since it was set?",
      criteria: {
        true: "The records show the milestone's goal reached; the work it asked for is complete.",
        false:
          "The records show progress, but the milestone's goal is not reached, or the " +
          "records do not show enough to tell.",
      },
    };
  },
});

// ----- head_select -------------------------------------------------------------

export const HEAD_SELECT_QUESTIONS = Object.freeze({
  /** Mask prefix for the topic heads. */
  headPrefix: "T",
  dropBelow: HEAD_SELECT_DROP_BELOW,
  relevantId: (k: number): string => `relevant_${k}`,
  relevant(k: number): DecisionNoulQuestion {
    return {
      type: "noul",
      instructions:
        `Given \`project\` and \`branch\`, is the topic head \`topics.T${k}\` worth putting in ` +
        "front of an agent at session start - live work it should know about?",
      criteria: {
        true: "The topic is live work this session's project and branch plausibly touches.",
        false:
          "The topic is unrelated to this session's project and branch, or is stale bookkeeping.",
      },
    };
  },
});

// ----- neighbour_relevant ------------------------------------------------------

export const NEIGHBOUR_RELEVANT_QUESTIONS = Object.freeze({
  /** Mask prefix for the neighbour records. */
  recordPrefix: "R",
  promptClipChars: 2000,
  recordClipChars: 300,
  injectMin: NEIGHBOUR_INJECT_MIN,
  mattersId: (k: number): string => `matters_${k}`,
  matters(k: number): DecisionNoulQuestion {
    return {
      type: "noul",
      instructions:
        `Is the record \`records.R${k}\` worth interrupting the agent with before it acts on ` +
        "`prompt` - does it change what the agent should do right now?",
      criteria: {
        true:
          "The record changes what the agent should do on this prompt: a decision that " +
          "binds shared work, a new blocker or question on it.",
        false:
          "The record is context at best: routine progress on someone else's thread, or " +
          "anything the prompt does not touch.",
      },
    };
  },
});

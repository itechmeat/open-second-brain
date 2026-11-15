/**
 * Names of topics (design D8, spec `topics`): the one place that spells
 * the topic record kinds, their statuses, log classes and scopes, so the
 * fold, the writers, the view and the format document cannot drift apart.
 *
 * A topic is a record family with an immutable id (a ULID): every topic
 * record carries that id in the envelope's `topic` field and is written to
 * the `topics` stream. Display values (the title, the folder name of its
 * page) change; the id never does.
 */

/** The stream every topic record is written to. */
export const TOPIC_STREAM = "topics" as const;

export const TOPIC_CREATE_KIND = "topic-create";
export const TOPIC_RENAME_KIND = "topic-rename";
export const TOPIC_STATUS_KIND = "topic-status";
export const TOPIC_GOAL_KIND = "topic-goal";
export const TOPIC_DECISION_KIND = "decision";
export const TOPIC_QUESTION_KIND = "open-question";
export const TOPIC_QUESTION_RESOLVED_KIND = "question-resolved";
export const TOPIC_LOG_KIND = "log-entry";
export const TOPIC_MILESTONE_KIND = "milestone";
export const TOPIC_MILESTONE_DONE_KIND = "milestone-done";
export const TOPIC_ASSIGN_KIND = "assign";
export const TOPIC_UNASSIGN_KIND = "unassign";
export const TOPIC_MERGE_KIND = "merge";
export const TOPIC_SPLIT_KIND = "split";
export const TOPIC_LINK_KIND = "link";
export const TOPIC_UNDO_KIND = "undo";

/** The canonical topic event list of design D8, in its order; FORMAT.md documents each. */
export const TOPIC_RECORD_KINDS = Object.freeze([
  TOPIC_CREATE_KIND,
  TOPIC_RENAME_KIND,
  TOPIC_STATUS_KIND,
  TOPIC_GOAL_KIND,
  TOPIC_DECISION_KIND,
  TOPIC_QUESTION_KIND,
  TOPIC_QUESTION_RESOLVED_KIND,
  TOPIC_LOG_KIND,
  TOPIC_MILESTONE_KIND,
  TOPIC_MILESTONE_DONE_KIND,
  TOPIC_ASSIGN_KIND,
  TOPIC_UNASSIGN_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_SPLIT_KIND,
  TOPIC_LINK_KIND,
  TOPIC_UNDO_KIND,
] as const);
export type TopicRecordKind = (typeof TOPIC_RECORD_KINDS)[number];

/** The four kinds that carry a list item of a topic page. */
export const TOPIC_ITEM_KINDS = Object.freeze([
  TOPIC_DECISION_KIND,
  TOPIC_QUESTION_KIND,
  TOPIC_LOG_KIND,
  TOPIC_MILESTONE_KIND,
] as const);
export type TopicItemKind = (typeof TOPIC_ITEM_KINDS)[number];

/**
 * Topic statuses as records spell them; the page shows each in the view
 * language (`Active`, `Waiting`, `Blocked`, `On hold`, `Done`, `Closed`
 * in English).
 */
export const TOPIC_STATUSES = Object.freeze([
  "active",
  "waiting",
  "blocked",
  "on-hold",
  "done",
  "closed",
] as const);
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

/** The status of a new topic. */
export const TOPIC_DEFAULT_STATUS: TopicStatus = "active";

/**
 * Classes of a `log-entry`. Only the earned ones reach the topic page
 * (spec "Log entries are earned"); `routine` progress stays in the store.
 * `note` is a line the user wrote into the log section of the page.
 */
export const TOPIC_LOG_CLASSES = Object.freeze([
  "correction",
  "decision",
  "blocker",
  "reframing",
  "rejected",
  "note",
  "routine",
] as const);
export type TopicLogClass = (typeof TOPIC_LOG_CLASSES)[number];

/** The log classes the topic page shows. */
export const TOPIC_EARNED_LOG_CLASSES: ReadonlySet<TopicLogClass> = new Set([
  "correction",
  "decision",
  "blocker",
  "reframing",
  "rejected",
  "note",
]);

/** The scope of a topic that belongs to no project. */
export const TOPIC_PERSONAL_SCOPE = "personal";

/** Prefix of a project scope: `project:<project>`. */
export const TOPIC_PROJECT_SCOPE_PREFIX = "project:";

/**
 * The page budget of `topic.md` (spec "Page stays scannable"): at most
 * this many entries of each section stay on the page. The oldest done
 * milestones, decisions and log entries over it move to the companion
 * archive page; open milestones and open questions never move.
 */
export const TOPIC_PAGE_BUDGET = Object.freeze({
  doneMilestones: 10,
  decisions: 25,
  log: 15,
});

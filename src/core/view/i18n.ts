/**
 * Generated prose of the human view in the user's language (spec
 * `human-view` "Language of the view"). Headings, introductions and labels
 * come from here, in the language the shared `view.language` setting
 * names; quoted source text (a rule, a note, a decision) never passes
 * through here and stays in the language it was written in.
 *
 * Languages without a table fall back to English. A tag is matched on its
 * primary subtag, so `pt-BR` would use a `pt` table.
 */

import type { TopicLogClass, TopicStatus } from "../topics/constants.ts";

/** Log classes a topic page shows (every class but `routine`). */
export type EarnedLogClass = Exclude<TopicLogClass, "routine">;

export interface ViewStrings {
  readonly aboutTitle: string;
  readonly aboutIntro: string;
  readonly aboutEmpty: string;
  readonly generalSubject: string;
  readonly decisionsTitle: string;
  readonly decisionsIntro: string;
  readonly decisionsEmpty: string;
  readonly reviewOn: (date: string) => string;
  readonly historyTitle: (year: number, week: number) => string;
  readonly historyIntro: string;
  readonly historyDecision: (text: string) => string;
  readonly historyRule: (text: string) => string;
  readonly historyRetired: (text: string) => string;
  /** Monday first, as ISO weeks count. */
  readonly weekdays: ReadonlyArray<string>;
  readonly topicStatus: Readonly<Record<TopicStatus, string>>;
  /** The status line of a topic page; `resolved` for a done topic. */
  readonly statusLine: (label: string, resolved: string | null) => string;
  /** The label before the status on its line, as {@link statusLine} writes it. */
  readonly statusLabel: string;
  readonly topicNoDescription: string;
  readonly topicGoal: string;
  readonly topicMilestones: string;
  readonly topicDecisions: string;
  readonly topicQuestions: string;
  readonly topicResolvedQuestions: string;
  readonly topicLog: string;
  readonly topicRelated: string;
  readonly milestoneDone: (day: string) => string;
  readonly milestoneLooksDone: string;
  readonly questionLooksAnswered: string;
  readonly questionAnswer: (answer: string) => string;
  readonly goalProposal: (agent: string, goal: string) => string;
  readonly serves: (list: string) => string;
  /** The mark of a decision item that closed an open decision. */
  readonly decisionResolved: string;
  /** The outcome backfilled for a decision item. */
  readonly decisionOutcome: (outcome: string) => string;
  readonly logClass: Readonly<Record<EarnedLogClass, string>>;
  readonly because: (reason: string) => string;
  readonly scopePersonal: string;
  readonly scopeProject: (project: string) => string;
  readonly mergedFrom: (title: string) => string;
  readonly archiveLink: string;
  /** The related line naming how many records a topic holds and the command that lists them. */
  readonly heldRecords: (count: number, command: string) => string;
  /** The related line naming how many held records a page that lists them could not fit. */
  readonly heldMore: (count: number, command: string) => string;
  /** The heading of the held rules a topic page lists. */
  readonly topicRules: string;
  /** The kind a held record's line names. */
  readonly heldKind: Readonly<Record<"rule" | "note", string>>;
  readonly archiveTitle: (title: string) => string;
  readonly archiveIntro: string;
  readonly archiveBack: string;
  readonly reportIntro: (day: string) => string;
  readonly sourceTitle: (source: string) => string;
  readonly sourceIntro: (day: string) => string;
}

const EN: ViewStrings = {
  aboutTitle: "About me",
  aboutIntro:
    "What the brain knows about you: confirmed rules, grouped by subject. Edit a line to " +
    "correct a rule, or delete it to retire the rule.",
  aboutEmpty: "No confirmed rules yet.",
  generalSubject: "General",
  decisionsTitle: "Decisions",
  decisionsIntro: "Decisions recorded by you and your agents, newest first.",
  decisionsEmpty: "No decisions yet.",
  reviewOn: (date) => `review on ${date}`,
  historyTitle: (year, week) => `Week ${week} of ${year}`,
  historyIntro: "What happened this week, day by day.",
  historyDecision: (text) => `Decision: ${text}`,
  historyRule: (text) => `New rule: ${text}`,
  historyRetired: (text) => `You retired a rule: ${text}`,
  weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  topicStatus: {
    active: "Active",
    waiting: "Waiting",
    blocked: "Blocked",
    "on-hold": "On hold",
    done: "Done",
    closed: "Closed",
  },
  statusLine: (label, resolved) =>
    resolved === null ? `Status: ${label}` : `Status: ${label} (resolved ${resolved})`,
  statusLabel: "Status",
  topicNoDescription: "No description yet.",
  topicGoal: "Goal",
  topicMilestones: "Milestones",
  topicDecisions: "Decisions",
  topicQuestions: "Open questions",
  topicResolvedQuestions: "Resolved questions",
  topicLog: "Log",
  topicRelated: "Related",
  milestoneDone: (day) => `done ${day}`,
  milestoneLooksDone: "looks done, confirm",
  questionLooksAnswered: "looks answered, confirm",
  questionAnswer: (answer) => `answer: ${answer}`,
  goalProposal: (agent, goal) => `Goal proposed by ${agent}: ${goal}`,
  serves: (list) => `serves: ${list}`,
  decisionResolved: "resolved open decision",
  decisionOutcome: (outcome) => `outcome: ${outcome}`,
  logClass: {
    correction: "correction",
    decision: "decision",
    blocker: "blocker",
    reframing: "reframing",
    rejected: "rejected approach",
    note: "note",
  },
  because: (reason) => `because ${reason}`,
  scopePersonal: "Personal matter",
  scopeProject: (project) => `Project: ${project}`,
  mergedFrom: (title) => `Merged from: ${title}`,
  archiveLink: "Older entries",
  heldRecords: (count, command) =>
    `Holds ${count} record(s) (notes, signals, decisions): \`${command}\` lists them`,
  heldMore: (count, command) => `${count} more record(s) not shown: \`${command}\` lists them all`,
  topicRules: "Rules and facts",
  heldKind: { rule: "rule", note: "note" },
  archiveTitle: (title) => `${title}: archive`,
  archiveIntro: "Entries that moved off the topic page, newest first.",
  archiveBack: "Back to the topic",
  reportIntro: (day) => `Research report of ${day}.`,
  sourceTitle: (source) => `Source: ${source}`,
  sourceIntro: (day) => `Summary of a source, updated ${day}.`,
};

const RU: ViewStrings = {
  aboutTitle: "Обо мне",
  aboutIntro:
    "Что мозг знает о вас: подтверждённые правила, сгруппированные по темам. Исправьте строку, " +
    "чтобы поправить правило, или удалите её, чтобы снять правило.",
  aboutEmpty: "Подтверждённых правил пока нет.",
  generalSubject: "Общее",
  decisionsTitle: "Решения",
  decisionsIntro: "Решения, принятые вами и вашими агентами, сначала новые.",
  decisionsEmpty: "Решений пока нет.",
  reviewOn: (date) => `пересмотр ${date}`,
  historyTitle: (year, week) => `Неделя ${week}, ${year}`,
  historyIntro: "Что произошло за неделю, по дням.",
  historyDecision: (text) => `Решение: ${text}`,
  historyRule: (text) => `Новое правило: ${text}`,
  historyRetired: (text) => `Вы сняли правило: ${text}`,
  weekdays: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"],
  topicStatus: {
    active: "Активна",
    waiting: "Ожидает",
    blocked: "Заблокирована",
    "on-hold": "Отложена",
    done: "Готова",
    closed: "Закрыта",
  },
  statusLine: (label, resolved) =>
    resolved === null ? `Статус: ${label}` : `Статус: ${label} (решена ${resolved})`,
  statusLabel: "Статус",
  topicNoDescription: "Описания пока нет.",
  topicGoal: "Цель",
  topicMilestones: "Вехи",
  topicDecisions: "Решения",
  topicQuestions: "Открытые вопросы",
  topicResolvedQuestions: "Решённые вопросы",
  topicLog: "Журнал",
  topicRelated: "Связанное",
  milestoneDone: (day) => `готово ${day}`,
  milestoneLooksDone: "похоже, готово, подтвердите",
  questionLooksAnswered: "похоже, есть ответ, подтвердите",
  questionAnswer: (answer) => `ответ: ${answer}`,
  goalProposal: (agent, goal) => `Цель, предложенная ${agent}: ${goal}`,
  serves: (list) => `служит: ${list}`,
  decisionResolved: "решённый открытый вопрос",
  decisionOutcome: (outcome) => `итог: ${outcome}`,
  logClass: {
    correction: "исправление",
    decision: "решение",
    blocker: "блокер",
    reframing: "переосмысление",
    rejected: "отвергнутый подход",
    note: "заметка",
  },
  because: (reason) => `потому что ${reason}`,
  scopePersonal: "Личное дело",
  scopeProject: (project) => `Проект: ${project}`,
  mergedFrom: (title) => `Объединена из: ${title}`,
  archiveLink: "Старые записи",
  heldRecords: (count, command) =>
    `Записей в теме: ${count} (заметки, сигналы, решения): их список выводит \`${command}\``,
  heldMore: (count, command) =>
    `Не показано записей: ${count}; полный список выводит \`${command}\``,
  topicRules: "Правила и факты",
  heldKind: { rule: "правило", note: "заметка" },
  archiveTitle: (title) => `${title}: архив`,
  archiveIntro: "Записи, ушедшие со страницы темы, сначала новые.",
  archiveBack: "Назад к теме",
  reportIntro: (day) => `Исследовательский отчёт от ${day}.`,
  sourceTitle: (source) => `Источник: ${source}`,
  sourceIntro: (day) => `Сводка источника, обновлена ${day}.`,
};

const TABLES: Readonly<Record<string, ViewStrings>> = { en: EN, ru: RU };

/** The primary language subtags the view has strings for, English first. */
export const VIEW_LANGUAGES: ReadonlyArray<string> = Object.freeze(Object.keys(TABLES));

/** The language of the view when `view.language` is not set. */
export const DEFAULT_VIEW_LANGUAGE = "en";

/** Whether `tag` names a language the view has strings for (by its primary subtag). */
export function isViewLanguage(tag: string): boolean {
  return Object.hasOwn(TABLES, tag.split("-")[0]!.toLowerCase());
}

/** The strings of every language the view has, English first. */
export function allViewStrings(): ReadonlyArray<ViewStrings> {
  return Object.values(TABLES);
}

/** The strings for language tag `tag` (`null`: English). */
export function viewStrings(tag: string | null): ViewStrings {
  const primary = (tag ?? "en").split("-")[0]!.toLowerCase();
  return Object.hasOwn(TABLES, primary) ? TABLES[primary]! : EN;
}

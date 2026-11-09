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

/** The strings for language tag `tag` (`null`: English). */
export function viewStrings(tag: string | null): ViewStrings {
  const primary = (tag ?? "en").split("-")[0]!.toLowerCase();
  return Object.hasOwn(TABLES, primary) ? TABLES[primary]! : EN;
}

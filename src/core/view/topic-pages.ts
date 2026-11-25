/**
 * Topic pages of the human view (design D7, D8; spec `topics` "Topic
 * page"; task 3.2): one folder per topic, `topics/<YYYY-MM-DD>-<slug>/`,
 * holding `topic.md` and, when the page budget overflows or questions are
 * resolved, the companion `archive.md`. Pure: the pages are a function of
 * the topic fold (`../topics/fold.ts`) and the view language.
 *
 * `topic.md`, in a fixed section order: the title, the one-line
 * description, the status line, the goal, milestones, decisions, open
 * questions, the log (newest first) and the related section. The goal,
 * milestones, decisions, open questions and log are left out when empty;
 * the title, description, status and related section are always there
 * (related names at least the topic's scope).
 *
 *  - Milestones: open ones in the order they were recorded, then done
 *    ones, newest done first. A completion proposed without standing (a
 *    decision model, an agent with no evidence) shows as "looks done,
 *    confirm" and the milestone stays open.
 *  - Decisions: newest first, each with the milestones it serves. A
 *    decision derived from a held decision event (`held-decisions.ts`,
 *    when the caller passes a fold it augmented) says whether it closed
 *    an open decision and its outcome, and takes only the page slots the
 *    recorded decisions leave.
 *  - Open questions: unresolved questions, then the goal proposals that
 *    lost to the user's goal, attributed to their agent.
 *  - Log: earned entries only (`TOPIC_EARNED_LOG_CLASSES`), newest first.
 *  - Related: the scope, linked topics as relative links, topics merged
 *    into this one, and the archive link.
 *
 * Page budget (`TOPIC_PAGE_BUDGET`): the oldest done milestones, decisions
 * and log entries over their section's budget move to `archive.md`, with
 * the resolved questions. Open milestones and open questions never move.
 *
 * The folder is the UTC day of the topic's creation and a slug of its
 * current title, so a rename moves the page (the renderer retires the old
 * folder). Two topics that take the same folder are told apart by the
 * tail of their id. Every line carries a key `t:<topic id>:...` naming
 * what it shows, so an edit maps back to a topic record (`topic-edits.ts`).
 */

import { heldRecordCounts, heldRecordIds } from "../topics/held-records.ts";
import { isUlid, ulidTime } from "../store/ulid.ts";
import { compareCodeUnits } from "../store/compare.ts";
import {
  TOPIC_EARNED_LOG_CLASSES,
  TOPIC_PAGE_BUDGET,
  TOPIC_PERSONAL_SCOPE,
  TOPIC_PROJECT_SCOPE_PREFIX,
} from "../topics/constants.ts";
import type { TopicFold, TopicItem, TopicState } from "../topics/fold.ts";
import { VIEW_TOPIC_ARCHIVE_PAGE, VIEW_TOPIC_PAGE, VIEW_TOPICS_DIR } from "./constants.ts";
import type { EarnedLogClass, ViewStrings } from "./i18n.ts";
import { ID_LINE_KEY, plainText, type PageLine, type PageModel } from "./pages.ts";
import type { ViewHeldRecord } from "./topic-held.ts";

/** Longest slug of a topic folder, in code points. */
const SLUG_MAX = 48;

/** How many held records a topic page lists; the rest are counted. */
export const TOPIC_HELD_SHOWN = 30;

/** Longest text of one page line, in code points, before it is cut at a word with an ellipsis. */
export const TOPIC_LINE_TEXT_MAX = 400;

/** `text` as one page line: cut at a word boundary with an ellipsis when it is too long. */
export function lineText(text: string, max: number = TOPIC_LINE_TEXT_MAX): string {
  const plain = plainText(text);
  const chars = [...plain];
  if (chars.length <= max) return plain;
  const head = chars.slice(0, max).join("");
  const cut = head.search(/\s\S*$/u);
  return `${(cut > max / 2 ? head.slice(0, cut) : head).replace(/[\s,;:.\-–—]+$/u, "")}…`;
}

const BLANK: PageLine = { key: null, text: "" };

/** The slug of a title: lowercase letters and digits of any script, joined by hyphens. */
export function topicSlug(title: string): string {
  const words = title
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const slug = [...words.join("-")].slice(0, SLUG_MAX).join("").replace(/-+$/, "");
  return slug === "" ? "topic" : slug;
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The day a topic was made: the time in its id, which the writer took
 * from its clock (a pass judged with `--now` mints it from that time), so
 * a topic made by such a pass is filed under the judged day, not the day
 * the pass ran. An id that is not a ULID falls back to the create record.
 */
function createdDay(topic: TopicState): string {
  return dayOf(isUlid(topic.id) ? ulidTime(topic.id) : topic.createdAt);
}

/** What a render may show beyond the view's own rule. */
export interface TopicPageOptions {
  /**
   * Show private topics and items too: for a local caller's read of one
   * topic (the topic tool, `osb://topic/{id}`), never for the view.
   */
  readonly includePrivate?: boolean;
  /**
   * The held notes and signals a shared page may list (`topic-held.ts`), by
   * record id. Given, the page lists them; absent, it names how many
   * records the topic holds and the command that lists them.
   */
  readonly records?: ReadonlyMap<string, ViewHeldRecord>;
}

/** The topics a page is rendered for: existing, not merged away, not private. */
export function renderedTopics(fold: TopicFold, options: TopicPageOptions = {}): TopicState[] {
  return [...fold.topics.values()]
    .filter((t) => t.mergedInto === null && (options.includePrivate === true || !t.private))
    .toSorted((a, b) => a.createdAt - b.createdAt || compareCodeUnits(a.id, b.id));
}

/** The view folder of each rendered topic, relative to the view: `topics/<day>-<slug>`. */
export function topicFolders(fold: TopicFold, options: TopicPageOptions = {}): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const topic of renderedTopics(fold, options)) {
    const base = `${VIEW_TOPICS_DIR}/${createdDay(topic)}-${topicSlug(topic.title)}`;
    // The base, else the base and the tail of the id, else a counter on
    // that: a folder another topic holds (a title that already ends in such
    // a tail) is never shared.
    let folder = taken.has(base) ? `${base}-${topic.id.slice(-6).toLowerCase()}` : base;
    for (let n = 2; taken.has(folder); n++)
      folder = `${base}-${topic.id.slice(-6).toLowerCase()}-${n}`;
    taken.add(folder);
    out.set(topic.id, folder);
  }
  return out;
}

/** The id comment line of a topic page: the store, the page and the topic. */
function topicIdLine(storeId: string, page: string, topic: string): PageLine {
  return {
    key: ID_LINE_KEY,
    text: `<!-- open-second-brain-view store=${storeId} page=${page} topic=${topic} -->`,
  };
}

/** The topic id an id comment line names, or `null`. */
export function topicOfIdLine(line: string): string | null {
  const match = /^<!-- open-second-brain-view .*\btopic=([0-9A-HJKMNP-TV-Z]{26})\b/.exec(line);
  return match === null ? null : match[1]!;
}

interface Sections {
  readonly milestonesOpen: TopicItem[];
  readonly milestonesDone: TopicItem[];
  readonly milestonesArchived: TopicItem[];
  readonly decisions: TopicItem[];
  readonly decisionsArchived: TopicItem[];
  readonly questions: TopicItem[];
  readonly resolved: TopicItem[];
  readonly log: TopicItem[];
  readonly logArchived: TopicItem[];
}

const newestFirst = (a: TopicItem, b: TopicItem): number => b.createdAt - a.createdAt;

function sections(topic: TopicState, includePrivate: boolean): Sections {
  const shown = topic.items.filter((i) => includePrivate || !i.private);
  const milestones = shown.filter((i) => i.kind === "milestone");
  const done = milestones
    .filter((i) => i.done !== undefined)
    .toSorted((a, b) => b.done!.at - a.done!.at);
  const decisions = shown
    .filter((i) => i.kind === "decision" && i.derived === undefined)
    .toReversed()
    .toSorted(newestFirst);
  // Decisions derived from held decision events take only the page slots
  // the recorded decisions leave, so none of those ever moves for one.
  const derived = shown
    .filter((i) => i.kind === "decision" && i.derived !== undefined)
    .toReversed()
    .toSorted(newestFirst);
  const kept = decisions.slice(0, TOPIC_PAGE_BUDGET.decisions);
  const free = TOPIC_PAGE_BUDGET.decisions - kept.length;
  const questions = shown.filter((i) => i.kind === "open-question");
  const log = shown
    .filter((i) => i.kind === "log-entry" && TOPIC_EARNED_LOG_CLASSES.has(i.logClass!))
    .toReversed()
    .toSorted(newestFirst);
  return {
    milestonesOpen: milestones.filter((i) => i.done === undefined),
    milestonesDone: done.slice(0, TOPIC_PAGE_BUDGET.doneMilestones),
    milestonesArchived: done.slice(TOPIC_PAGE_BUDGET.doneMilestones),
    decisions: [...kept, ...derived.slice(0, free)].toSorted(newestFirst),
    decisionsArchived: [
      ...decisions.slice(TOPIC_PAGE_BUDGET.decisions),
      ...derived.slice(free),
    ].toSorted(newestFirst),
    questions: questions.filter((i) => i.resolved === undefined),
    resolved: questions
      .filter((i) => i.resolved !== undefined)
      .toSorted((a, b) => b.resolved!.at - a.resolved!.at),
    log: log.slice(0, TOPIC_PAGE_BUDGET.log),
    logArchived: log.slice(TOPIC_PAGE_BUDGET.log),
  };
}

function hasArchive(s: Sections): boolean {
  return (
    s.milestonesArchived.length +
      s.decisionsArchived.length +
      s.resolved.length +
      s.logArchived.length >
    0
  );
}

interface LineContext {
  readonly includePrivate: boolean;
  readonly topic: TopicState;
  readonly strings: ViewStrings;
  readonly key: (rest: string) => string;
  /** How many records the topic holds (`heldRecordCounts`, built once per render). */
  readonly held: number;
  /** The held records the page may list, when the caller read them. */
  readonly records: ReadonlyMap<string, ViewHeldRecord> | undefined;
}

/** When an item's event happened: the held record it names, else when it was recorded. */
function eventAt(c: LineContext, item: TopicItem): number {
  return c.records?.get(item.id)?.at ?? item.createdAt;
}

/** The held records a page lists, newest first, and how many more it holds. */
interface HeldListing {
  readonly rules: ViewHeldRecord[];
  readonly notes: ViewHeldRecord[];
  readonly more: number;
}

function heldListing(c: LineContext, fold: TopicFold): HeldListing | null {
  if (c.records === undefined) return null;
  const onPage = new Set(c.topic.items.map((i) => i.id));
  const listable = heldRecordIds(fold, c.topic.id)
    .filter((id) => !onPage.has(id))
    .flatMap((id) => {
      const record = c.records!.get(id);
      return record === undefined ? [] : [record];
    })
    .toSorted((a, b) => b.at - a.at || compareCodeUnits(a.id, b.id));
  const readable = listable.filter((r) => !r.hidden);
  const shown = readable.slice(0, TOPIC_HELD_SHOWN);
  return {
    rules: shown.filter((r) => r.kind === "rule"),
    notes: shown.filter((r) => r.kind === "note"),
    more: listable.length - shown.length,
  };
}

function heldLine(c: LineContext, record: ViewHeldRecord): PageLine {
  return {
    key: c.key(`r:${record.id}`),
    text: `- ${dayOf(record.at)}, ${c.strings.heldKind[record.kind]}: ${lineText(record.text)}`,
  };
}

/**
 * The key of an item line: under the topic that owns the item, not the
 * page's topic, since an item id is its owner's own and a merged topic's
 * items show on the page it merged into (an edit lands on the owner).
 */
function itemKey(item: TopicItem, rest: string): string {
  return `t:${item.owner}:${rest}`;
}

function milestoneLine(c: LineContext, item: TopicItem): PageLine {
  const text = lineText(item.text);
  const line =
    item.done !== undefined
      ? `- [x] ${text} (${c.strings.milestoneDone(dayOf(item.done.at))})`
      : item.doneProposed !== undefined
        ? `- [ ] ${text} (${c.strings.milestoneLooksDone})`
        : `- [ ] ${text}`;
  // A done milestone's key names the record that completed it, so
  // unticking the line can undo exactly that record.
  const key = item.done !== undefined ? `mx:${item.done.record}:${item.id}` : `m:${item.id}`;
  return { key: itemKey(item, key), text: line };
}

function decisionLine(c: LineContext, item: TopicItem): PageLine {
  const served = (item.serves ?? []).flatMap((id) => {
    const milestone = c.topic.items.find(
      (i) => i.id === id && i.kind === "milestone" && !i.private,
    );
    return milestone === undefined ? [] : [plainText(milestone.text)];
  });
  const serves = served.length > 0 ? ` (${c.strings.serves(served.join("; "))})` : "";
  const resolved = item.derived?.resolved === true ? ` (${c.strings.decisionResolved})` : "";
  const outcome =
    item.derived?.outcome != null
      ? ` (${c.strings.decisionOutcome(plainText(item.derived.outcome))})`
      : "";
  return {
    key: itemKey(item, `d:${item.id}`),
    text: `- ${lineText(item.text)}${serves}${resolved}${outcome}`,
  };
}

function questionLine(c: LineContext, item: TopicItem): PageLine {
  const text = lineText(item.text);
  if (item.resolved !== undefined) {
    const answer = item.resolved.answer;
    const tail = answer === null ? "" : ` (${c.strings.questionAnswer(plainText(answer))})`;
    return { key: itemKey(item, `q:${item.id}`), text: `- ${text}${tail}` };
  }
  const tail = item.resolveProposed !== undefined ? ` (${c.strings.questionLooksAnswered})` : "";
  return { key: itemKey(item, `q:${item.id}`), text: `- ${text}${tail}` };
}

function logLine(c: LineContext, item: TopicItem): PageLine {
  const cls = item.logClass as EarnedLogClass;
  const reason = item.reason !== undefined ? `, ${c.strings.because(plainText(item.reason))}` : "";
  return {
    key: itemKey(item, `l:${cls}:${item.id}`),
    text: `- ${dayOf(eventAt(c, item))}, ${c.strings.logClass[cls]}: ${lineText(item.text)}${reason}`,
  };
}

function section(
  lines: PageLine[],
  key: string,
  heading: string,
  body: ReadonlyArray<PageLine>,
): void {
  if (body.length === 0) return;
  lines.push(BLANK, { key, text: `## ${heading}` }, BLANK, ...body);
}

function relatedLines(
  c: LineContext,
  fold: TopicFold,
  folders: ReadonlyMap<string, string>,
  archive: boolean,
  listing: HeldListing | null,
): PageLine[] {
  const { topic, strings } = c;
  // A personal topic names no project, so the line is left out.
  const out: PageLine[] =
    topic.scope === TOPIC_PERSONAL_SCOPE
      ? []
      : [
          {
            key: c.key("scope"),
            text: `- ${strings.scopeProject(plainText(topic.scope.slice(TOPIC_PROJECT_SCOPE_PREFIX.length)))}`,
          },
        ];
  const linked = new Set(topic.links.map((id) => fold.canonical(id)).filter((id) => id !== null));
  linked.delete(topic.id);
  for (const id of [...linked].toSorted()) {
    const folder = folders.get(id!);
    const other = fold.topics.get(id!);
    if (folder === undefined || other === undefined) continue;
    out.push({
      key: c.key(`link:${id}`),
      text: `- [${plainText(other.title)}](../${folder.split("/").at(-1)}/${VIEW_TOPIC_PAGE})`,
    });
  }
  for (const merged of [...fold.topics.values()]
    .filter((t) => t.mergedInto === topic.id && (c.includePrivate || !t.private))
    .toSorted((a, b) => compareCodeUnits(a.id, b.id))) {
    out.push({
      key: c.key(`merged:${merged.id}`),
      text: `- ${strings.mergedFrom(plainText(merged.title))}`,
    });
  }
  // The notes and signals the topic holds are not page items (routine
  // unless earned, spec "Log entries are earned", design D10 `event_kind`;
  // its decisions show as decision items when the reader derived them,
  // `held-decisions.ts`); the line says how many records there are and how
  // to list them.
  // A page that lists the records names only those it could not fit.
  const command = `o2b topic show ${topic.id} --held`;
  if (listing !== null) {
    if (listing.more > 0) {
      out.push({ key: c.key("held"), text: `- ${strings.heldMore(listing.more, command)}` });
    }
  } else if (c.held > 0) {
    out.push({ key: c.key("held"), text: `- ${strings.heldRecords(c.held, command)}` });
  }
  if (archive) {
    out.push({
      key: c.key("archive"),
      text: `- [${strings.archiveLink}](${VIEW_TOPIC_ARCHIVE_PAGE})`,
    });
  }
  return out;
}

function topicPage(
  storeId: string,
  fold: TopicFold,
  topic: TopicState,
  folders: ReadonlyMap<string, string>,
  strings: ViewStrings,
  includePrivate: boolean,
  held: ReadonlyMap<string, number>,
  records: ReadonlyMap<string, ViewHeldRecord> | undefined,
): PageModel[] {
  const folder = folders.get(topic.id)!;
  const page = `${folder}/${VIEW_TOPIC_PAGE}`;
  const c: LineContext = {
    includePrivate,
    topic,
    strings,
    key: (rest) => `t:${topic.id}:${rest}`,
    held: held.get(topic.id) ?? 0,
    records,
  };
  const s = sections(topic, includePrivate);
  const listing = heldListing(c, fold);
  const archive = hasArchive(s);
  const lines: PageLine[] = [topicIdLine(storeId, page, topic.id), BLANK];
  lines.push({ key: c.key("title"), text: `# ${plainText(topic.title)}` }, BLANK);
  const description = topic.description === null ? "" : plainText(topic.description);
  const goal = topic.goal === null ? "" : plainText(topic.goal);
  // Without a description the goal says what the topic is about, in its
  // place; with neither, the line is left out.
  const goalAsDescription = description === "" && goal !== "";
  if (description !== "") lines.push({ key: c.key("desc"), text: description }, BLANK);
  else if (goalAsDescription) lines.push({ key: c.key("goal"), text: goal }, BLANK);
  lines.push({
    key: c.key("status"),
    text: strings.statusLine(
      strings.topicStatus[topic.status],
      topic.status === "done" ? topic.resolved : null,
    ),
  });
  section(
    lines,
    c.key("h:goal"),
    strings.topicGoal,
    goal === "" || goalAsDescription ? [] : [{ key: c.key("goal"), text: goal }],
  );
  section(lines, c.key("h:milestones"), strings.topicMilestones, [
    ...s.milestonesOpen.map((i) => milestoneLine(c, i)),
    ...s.milestonesDone.map((i) => milestoneLine(c, i)),
  ]);
  section(
    lines,
    c.key("h:decisions"),
    strings.topicDecisions,
    s.decisions.map((i) => decisionLine(c, i)),
  );
  section(lines, c.key("h:questions"), strings.topicQuestions, [
    ...s.questions.map((i) => questionLine(c, i)),
    ...topic.goalProposals.map((p) => ({
      key: c.key(`gp:${p.record}`),
      text: `- ${strings.goalProposal(plainText(p.agent), plainText(p.goal))}`,
    })),
  ]);
  section(
    lines,
    c.key("h:rules"),
    strings.topicRules,
    (listing?.rules ?? []).map((r) => heldLine(c, r)),
  );
  // The log, newest first by when each entry happened: the earned entries
  // and the held notes.
  const log: Array<{ readonly at: number; readonly line: PageLine }> = [
    ...s.log.map((i) => ({ at: eventAt(c, i), line: logLine(c, i) })),
    ...(listing?.notes ?? []).map((r) => ({ at: r.at, line: heldLine(c, r) })),
  ];
  section(
    lines,
    c.key("h:log"),
    strings.topicLog,
    log.toSorted((a, b) => b.at - a.at).map((e) => e.line),
  );
  section(
    lines,
    c.key("h:related"),
    strings.topicRelated,
    relatedLines(c, fold, folders, archive, listing),
  );
  const pages: PageModel[] = [{ page, lines, topic: topic.id }];
  if (archive) pages.push(archivePage(storeId, folder, c, s));
  return pages;
}

function archivePage(storeId: string, folder: string, c: LineContext, s: Sections): PageModel {
  const page = `${folder}/${VIEW_TOPIC_ARCHIVE_PAGE}`;
  const { strings, topic } = c;
  const lines: PageLine[] = [topicIdLine(storeId, page, topic.id), BLANK];
  lines.push({ key: c.key("a:title"), text: `# ${strings.archiveTitle(plainText(topic.title))}` });
  lines.push(BLANK, { key: c.key("a:intro"), text: strings.archiveIntro });
  lines.push(BLANK, { key: c.key("a:back"), text: `[${strings.archiveBack}](${VIEW_TOPIC_PAGE})` });
  section(
    lines,
    c.key("a:h:milestones"),
    strings.topicMilestones,
    s.milestonesArchived.map((i) => milestoneLine(c, i)),
  );
  section(
    lines,
    c.key("a:h:decisions"),
    strings.topicDecisions,
    s.decisionsArchived.map((i) => decisionLine(c, i)),
  );
  section(
    lines,
    c.key("a:h:resolved"),
    strings.topicResolvedQuestions,
    s.resolved.map((i) => questionLine(c, i)),
  );
  section(
    lines,
    c.key("a:h:log"),
    strings.topicLog,
    s.logArchived.map((i) => logLine(c, i)),
  );
  return { page, lines, topic: topic.id };
}

/** Every topic page and archive the fold renders to. */
export function topicPages(
  storeId: string,
  fold: TopicFold,
  strings: ViewStrings,
  options: TopicPageOptions = {},
): PageModel[] {
  const folders = topicFolders(fold, options);
  const includePrivate = options.includePrivate === true;
  const held = heldRecordCounts(fold);
  return renderedTopics(fold, options).flatMap((topic) =>
    topicPage(storeId, fold, topic, folders, strings, includePrivate, held, options.records),
  );
}

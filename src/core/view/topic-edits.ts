/**
 * Human edits of topic pages as topic records (spec `topics` "Human edits
 * win"; task 3.2). A line of `topic.md` or `archive.md` carries a key
 * `t:<topic id>:<what>` (`topic-pages.ts`); an edit of that line becomes
 * the topic record that says the same thing, with `human` authority, so
 * it beats every agent and decision-model record on that item and moves
 * with the topic through a rename:
 *
 *  - the title line: `topic-rename` of the title; the description line:
 *    `topic-rename` of the description (deleted: cleared);
 *  - the status line: `topic-status`, when the text names a status in any
 *    language the view has (a done date in brackets is kept);
 *  - the goal line: `topic-goal` (deleted: cleared);
 *  - a milestone, decision, open question or log line reworded: the
 *    item's record with the new text (a milestone ticked `[x]` also gets a
 *    `milestone-done`); deleted: the item's tombstone;
 *  - a goal proposal deleted: an `undo` of the agent's goal record;
 *    reworded: the user's own goal;
 *  - a line added under a section heading or item: a new item of that
 *    section (a line added to the log is a `note`), whose id comes from its
 *    topic, section and text, so one line added twice is one item.
 *
 * Generated decorations (the list marker, a checkbox, the done or "looks
 * done" marker, the date and class of a log line, "serves" and answer
 * tails) are stripped in every language before the text is stored. Any
 * other line (headings, the related section, a status that names no
 * status) is not mapped here: `null` sends it to the generic correction
 * of the view (`corrections.ts`).
 */

import { sha256Hex } from "../integrity/digest.ts";
import { TOPIC_STATUSES, type TopicItemKind, type TopicStatus } from "../topics/constants.ts";
import { topicBodyRejection } from "../topics/records.ts";
import type { EditRecord } from "./edit-record.ts";
import { allViewStrings } from "./i18n.ts";

const KEY_RE = /^t:([0-9A-HJKMNP-TV-Z]{26}):(.+)$/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CHECKBOX_RE = /^\[( |x|X)\]\s*/;
const DAY = "\\d{4}-\\d{2}-\\d{2}";

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern from a template: each hole is the source text of its group. */
function template(text: string, holes: ReadonlyArray<string>): string {
  let out = escape(text);
  holes.forEach((hole, i) => {
    out = out.replace(String.fromCharCode(i + 1), hole);
  });
  return out;
}

const STRINGS = allViewStrings();
const alt = (parts: ReadonlyArray<string>): string => parts.join("|");

const MILESTONE_TAIL_RE = new RegExp(
  `\\s*\\((?:${alt(STRINGS.flatMap((s) => [template(s.milestoneDone("\u0001"), [DAY]), escape(s.milestoneLooksDone)]))})\\)\\s*$`,
);
const DECISION_TAIL_RE = new RegExp(
  `\\s*\\((?:${alt(STRINGS.map((s) => template(s.serves("\u0001"), [".*"])))})\\)\\s*$`,
);
const QUESTION_TAIL_RE = new RegExp(
  `\\s*\\((?:${alt(STRINGS.flatMap((s) => [template(s.questionAnswer("\u0001"), [".*"]), escape(s.questionLooksAnswered)]))})\\)\\s*$`,
);
const LOG_HEAD_RE = new RegExp(
  `^${DAY},\\s*(?:${alt(STRINGS.flatMap((s) => Object.values(s.logClass).map(escape)))}):\\s*`,
  "i",
);
const BECAUSE_RE = new RegExp(
  `,\\s*(?:${alt(STRINGS.map((s) => template(s.because("\u0001"), ["(.+)"])))})$`,
);
const GOAL_PROPOSAL_RE = new RegExp(
  `^(?:${alt(STRINGS.map((s) => template(s.goalProposal("\u0001", "\u0002"), [".+?", "(.+)"])))})$`,
);

function human(topic: string, kind: string, body: Record<string, unknown>): EditRecord | null {
  const full = { authority: "human", ...body };
  return topicBodyRejection(kind, topic, full) === null
    ? { stream: "topics", kind, topic, body: full }
    : null;
}

function bare(text: string): string {
  return text.replace(LIST_MARKER_RE, "").trim();
}

/** The status a status line names, in any view language, with its done day. */
function parseStatus(text: string): { status: TopicStatus; resolved?: string } | null {
  for (const s of STRINGS) {
    const match = new RegExp(
      `^${escape(s.statusLabel)}\\s*:\\s*(.+?)\\s*(?:\\((.*)\\))?\\s*$`,
      "i",
    ).exec(text.trim());
    if (match === null) continue;
    const label = match[1]!.toLowerCase();
    for (const other of STRINGS) {
      const status = TOPIC_STATUSES.find((st) => other.topicStatus[st].toLowerCase() === label);
      if (status === undefined) continue;
      const day = new RegExp(DAY).exec(match[2] ?? "")?.[0];
      return status === "done" && day !== undefined ? { status, resolved: day } : { status };
    }
  }
  return null;
}

function milestoneParts(line: string): { checked: boolean; text: string } {
  const rest = bare(line);
  const box = CHECKBOX_RE.exec(rest);
  const text = (box === null ? rest : rest.slice(box[0].length))
    .replace(MILESTONE_TAIL_RE, "")
    .trim();
  return { checked: box !== null && box[1] !== " ", text };
}

function itemText(kind: TopicItemKind, line: string): { text: string; reason?: string } {
  const rest = bare(line);
  switch (kind) {
    case "decision":
      return { text: rest.replace(DECISION_TAIL_RE, "").trim() };
    case "open-question":
      return { text: rest.replace(QUESTION_TAIL_RE, "").trim() };
    case "log-entry": {
      const text = rest.replace(LOG_HEAD_RE, "");
      const because = BECAUSE_RE.exec(text);
      return because === null
        ? { text: text.trim() }
        : {
            text: text.slice(0, because.index).trim(),
            reason: because.slice(1).find(Boolean)!.trim(),
          };
    }
    case "milestone":
      return { text: milestoneParts(line).text };
  }
}

const ITEM_KEYS: Readonly<Record<string, TopicItemKind>> = {
  d: "decision",
  q: "open-question",
  l: "log-entry",
  m: "milestone",
  mx: "milestone",
};

function itemCorrection(
  topic: string,
  kind: TopicItemKind,
  rest: string,
  before: string,
  after: string | null,
): EditRecord[] | null {
  const parts = rest.split(":");
  const item = parts.at(-1)!;
  const logClass = kind === "log-entry" ? parts[0] : undefined;
  // `mx:<done record>:<item>`: a done milestone, and the record that completed it.
  const doneRecord = kind === "milestone" && parts.length === 2 ? parts[0] : undefined;
  if (after === null)
    return [human(topic, kind, { item, removed: true })].filter((r) => r !== null);
  const now = itemText(kind, after);
  const was = itemText(kind, before);
  const out: Array<EditRecord | null> = [];
  if (now.text !== was.text || now.reason !== was.reason) {
    out.push(
      human(topic, kind, {
        item,
        text: now.text,
        ...(logClass !== undefined ? { class: logClass } : {}),
        ...(now.reason !== undefined ? { reason: now.reason } : {}),
      }),
    );
  }
  if (kind === "milestone") {
    const wasDone = milestoneParts(before).checked;
    const isDone = milestoneParts(after).checked;
    if (isDone && !wasDone) out.push(human(topic, "milestone-done", { milestone: item }));
    // Unticked: the user takes the completion back.
    if (wasDone && !isDone && doneRecord !== undefined) {
      out.push(human(topic, "undo", { record: doneRecord }));
    }
  }
  if (out.some((r) => r === null)) return null;
  return out as EditRecord[];
}

function one(record: EditRecord | null): EditRecord[] | null {
  return record === null ? null : [record];
}

/**
 * The topic records for the keyed line `key`, reworded from `before` to
 * `after` or deleted (`after` null); `null` when the key is not a topic
 * line this module maps, or the new text does not make a valid record.
 */
export function topicCorrection(
  key: string,
  before: string,
  after: string | null,
): EditRecord[] | null {
  const match = KEY_RE.exec(key);
  if (match === null) return null;
  const [, topic, what] = match as unknown as [string, string, string];
  const [head, ...tail] = what.split(":");
  const rest = tail.join(":");
  switch (head) {
    case "title": {
      // A deleted title is rendered again; the topic keeps its name.
      if (after === null) return [];
      return one(human(topic, "topic-rename", { title: after.replace(/^#+\s*/, "").trim() }));
    }
    case "desc": {
      if (after === null) return one(human(topic, "topic-rename", { description: null }));
      const text = after.trim();
      if (STRINGS.some((s) => s.topicNoDescription === text)) return [];
      return one(human(topic, "topic-rename", { description: text }));
    }
    case "status": {
      if (after === null) return [];
      const parsed = parseStatus(after);
      return parsed === null ? null : one(human(topic, "topic-status", parsed));
    }
    case "goal":
      return one(human(topic, "topic-goal", { goal: after === null ? null : after.trim() }));
    case "gp": {
      if (after === null) return one(human(topic, "undo", { record: rest }));
      const proposal = GOAL_PROPOSAL_RE.exec(bare(after));
      const goal = proposal === null ? bare(after) : proposal.slice(1).find(Boolean)!.trim();
      return one(human(topic, "topic-goal", { goal }));
    }
    default: {
      const kind = ITEM_KEYS[head!];
      return kind === undefined ? null : itemCorrection(topic, kind, rest, before, after);
    }
  }
}

/** The section an anchor key sits in, as the kind of item a line added there becomes. */
function sectionOf(what: string): TopicItemKind | null {
  const [head, ...tail] = what.split(":");
  const name = head === "a" && tail[0] === "h" ? tail[1] : head === "h" ? tail[0] : null;
  if (name !== null) {
    const bySection: Readonly<Record<string, TopicItemKind>> = {
      milestones: "milestone",
      decisions: "decision",
      questions: "open-question",
      resolved: "open-question",
      log: "log-entry",
    };
    return bySection[name ?? ""] ?? null;
  }
  if (head === "gp") return "open-question";
  return ITEM_KEYS[head!] ?? null;
}

/**
 * The item id of a line the user added: derived from the topic, the
 * section and the text, so the same line added in two copies of a page (a
 * sync tool's conflict copy beside the page) is one item, not two.
 */
function additionId(topic: string, kind: TopicItemKind, text: string): string {
  return `u${sha256Hex(`${topic}\u0000${kind}\u0000${text}`).slice(0, 24)}`;
}

/**
 * The topic records for a line the user added below the keyed line
 * `anchor`; `null` when the anchor is not inside an item section of a
 * topic page.
 */
export function topicAddition(anchor: string | null, line: string): EditRecord[] | null {
  const match = anchor === null ? null : KEY_RE.exec(anchor);
  if (match === null) return null;
  const [, topic, what] = match as unknown as [string, string, string];
  const kind = sectionOf(what);
  if (kind === null) return null;
  if (kind === "milestone") {
    const { checked, text } = milestoneParts(line);
    const item = additionId(topic, kind, text);
    const records = [
      human(topic, kind, { item, text }),
      ...(checked ? [human(topic, "milestone-done", { milestone: item })] : []),
    ];
    return records.some((r) => r === null) ? null : (records as EditRecord[]);
  }
  const { text, reason } = itemText(kind, line);
  const record = human(topic, kind, {
    item: additionId(topic, kind, text),
    text,
    ...(kind === "log-entry" ? { class: "note" } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
  return record === null ? null : [record];
}

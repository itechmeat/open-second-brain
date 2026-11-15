/**
 * Shapes of the topic records (design D8, FORMAT.md "Topics"): what a
 * valid body of each kind holds, checked the same way by the fold (a
 * record that fails is not applied and is reported) and by the writers (a
 * record that fails is never written).
 *
 * Every topic record carries `authority` in its body and the id of its
 * topic in the envelope's `topic` field. A list item (a decision, an open
 * question, a log entry, a milestone) is addressed by its `item` id; a
 * record that creates one may leave `item` out, and its own record id is
 * the item id then. An item record with `removed: true` is the item's
 * tombstone.
 */

import { isAuthority } from "../store/fold.ts";
import { isUlid } from "../store/ulid.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_DECISION_KIND,
  TOPIC_GOAL_KIND,
  TOPIC_ITEM_KINDS,
  TOPIC_LINK_KIND,
  TOPIC_LOG_CLASSES,
  TOPIC_LOG_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_MILESTONE_DONE_KIND,
  TOPIC_PERSONAL_SCOPE,
  TOPIC_PROJECT_SCOPE_PREFIX,
  TOPIC_QUESTION_RESOLVED_KIND,
  TOPIC_RECORD_KINDS,
  TOPIC_RENAME_KIND,
  TOPIC_SPLIT_KIND,
  TOPIC_STATUS_KIND,
  TOPIC_STATUSES,
  TOPIC_UNASSIGN_KIND,
  TOPIC_UNDO_KIND,
  type TopicItemKind,
  type TopicRecordKind,
} from "./constants.ts";

/** Longest title, in characters. */
export const TOPIC_TITLE_MAX = 200;
/** Longest text of any other field, in characters. */
export const TOPIC_TEXT_MAX = 4000;

/** An item id: a ULID, or any short token a writer chose. */
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isTopicRecordKind(kind: string): kind is TopicRecordKind {
  return (TOPIC_RECORD_KINDS as ReadonlyArray<string>).includes(kind);
}

export function isTopicItemKind(kind: string): kind is TopicItemKind {
  return (TOPIC_ITEM_KINDS as ReadonlyArray<string>).includes(kind);
}

export function isItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID_RE.test(value);
}

/** A topic scope: `personal`, or `project:<project>` (one line, at most 200 characters). */
export function isTopicScope(value: unknown): value is string {
  if (value === TOPIC_PERSONAL_SCOPE) return true;
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    value.startsWith(TOPIC_PROJECT_SCOPE_PREFIX) &&
    value.slice(TOPIC_PROJECT_SCOPE_PREFIX.length).trim() !== "" &&
    !/[\r\n]/.test(value)
  );
}

function text(value: unknown, max = TOPIC_TEXT_MAX): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

function textOrNull(value: unknown): boolean {
  return value === null || text(value);
}

/** A one-line text: a title or a description, never a line break that opens a new block. */
function line(value: unknown, max = TOPIC_TEXT_MAX): value is string {
  return text(value, max) && !/[\r\n]/.test(value);
}

function lineOrNull(value: unknown): boolean {
  return value === null || line(value);
}

function idList(value: unknown, valid: (v: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(valid);
}

type Body = Readonly<Record<string, unknown>>;

function itemRejection(kind: TopicItemKind, body: Body): string | null {
  if (body["removed"] === true) return isItemId(body["item"]) ? null : "a removal needs an item id";
  if (body["item"] !== undefined && !isItemId(body["item"])) return "invalid item id";
  if (!text(body["text"])) return "text must be a non-empty string";
  if (kind === TOPIC_LOG_KIND) {
    const cls = body["class"];
    if (typeof cls !== "string" || !(TOPIC_LOG_CLASSES as ReadonlyArray<string>).includes(cls)) {
      return `class must be one of ${TOPIC_LOG_CLASSES.join(", ")}`;
    }
    if (body["reason"] !== undefined && !text(body["reason"])) return "invalid reason";
  }
  if (kind === TOPIC_DECISION_KIND && body["serves"] !== undefined) {
    // An empty list clears the links; a record without `serves` keeps them.
    const serves = body["serves"];
    if (!(Array.isArray(serves) && (serves.length === 0 || idList(serves, isItemId)))) {
      return "serves must list item ids";
    }
  }
  return null;
}

/**
 * Why a topic record of `kind`, for the topic `topic` (the envelope
 * field), with `body` cannot be applied, or `null` when it can.
 */
export function topicBodyRejection(kind: string, topic: string | null, body: Body): string | null {
  if (!isTopicRecordKind(kind)) return `not a topic record kind: ${kind}`;
  if (topic === null || !isUlid(topic)) return "the envelope topic must be a topic id";
  if (!isAuthority(body["authority"])) return "missing or invalid authority";
  if (isTopicItemKind(kind)) return itemRejection(kind, body);
  switch (kind) {
    case TOPIC_CREATE_KIND:
      if (!line(body["title"], TOPIC_TITLE_MAX)) return "title must be a non-empty single line";
      if (!isTopicScope(body["scope"])) return "scope must be personal or project:<project>";
      if (body["description"] !== undefined && !lineOrNull(body["description"])) {
        return "description must be a single line or null";
      }
      if (body["goal"] !== undefined && !textOrNull(body["goal"])) return "invalid goal";
      return null;
    case TOPIC_RENAME_KIND:
      if (body["title"] === undefined && body["description"] === undefined) {
        return "a rename needs a title or a description";
      }
      if (body["title"] !== undefined && !line(body["title"], TOPIC_TITLE_MAX)) {
        return "title must be a non-empty single line";
      }
      if (body["description"] !== undefined && !lineOrNull(body["description"])) {
        return "description must be a single line or null";
      }
      return null;
    case TOPIC_STATUS_KIND:
      if (!(TOPIC_STATUSES as ReadonlyArray<unknown>).includes(body["status"])) {
        return `status must be one of ${TOPIC_STATUSES.join(", ")}`;
      }
      if (
        body["resolved"] !== undefined &&
        !(typeof body["resolved"] === "string" && DAY_RE.test(body["resolved"]))
      ) {
        return "resolved must be a YYYY-MM-DD day";
      }
      return null;
    case TOPIC_GOAL_KIND:
      return textOrNull(body["goal"]) ? null : "goal must be a non-empty string or null";
    case TOPIC_QUESTION_RESOLVED_KIND:
      if (!isItemId(body["question"])) return "question must be an item id";
      return body["answer"] === undefined || text(body["answer"]) ? null : "invalid answer";
    case TOPIC_MILESTONE_DONE_KIND:
      if (!isItemId(body["milestone"])) return "milestone must be an item id";
      return body["evidence"] === undefined || text(body["evidence"]) ? null : "invalid evidence";
    case TOPIC_ASSIGN_KIND:
    case TOPIC_UNASSIGN_KIND:
    case TOPIC_UNDO_KIND:
      return isUlid(body["record"]) ? null : "record must be a record id";
    case TOPIC_MERGE_KIND:
      if (!isUlid(body["into"])) return "into must be a topic id";
      return body["into"] === topic ? "a topic cannot merge into itself" : null;
    case TOPIC_SPLIT_KIND:
      if (!isUlid(body["into"]) || body["into"] === topic) return "into must be another topic id";
      if (body["items"] === undefined && body["records"] === undefined) {
        return "a split needs items or records";
      }
      if (body["items"] !== undefined && !idList(body["items"], isItemId)) return "invalid items";
      if (body["records"] !== undefined && !idList(body["records"], isUlid))
        return "invalid records";
      return null;
    case TOPIC_LINK_KIND:
      if (!isUlid(body["to"]) || body["to"] === topic) return "to must be another topic id";
      return body["removed"] === undefined || body["removed"] === true ? null : "invalid removed";
    default:
      return `not a topic record kind: ${kind}`;
  }
}

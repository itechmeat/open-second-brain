/**
 * Open-decision vault (write-side-trust wave, Lane E, Task 10).
 *
 * A decision can only be RECORDED after it is made (`record.ts` requires
 * `chosen`); this store is the artifact that parks the question before
 * that: one Markdown record per open question at
 * `Brain/decisions/open-<slug>.md`, with the enumerated options an agent
 * or operator is choosing between.
 *
 * The lifecycle follows the trigger store (`triggers/store.ts`), not the
 * pending queue: history is a status change, not a file move. Terminal
 * records (resolved / discarded) stay in place so `list` is a status
 * filter and the resolved pointer survives. There is deliberately NO
 * read-time expiry - a parked judgment question is exactly the thing
 * that must not silently expire.
 *
 * Resolution mints a REAL `type: decision` page through `recordDecision`
 * (so the review obligation, the `decision-record` log event and the B4
 * change trail all happen exactly once, in the one place that owns
 * them), then stamps the open record `resolved` with a
 * `[[decision-<slug>]]` pointer and appends exactly one `open_resolved`
 * receipt to the decision-change trail. The minted page's slug is
 * planned per record (the title slug first, then a title carrying the
 * record's own unique id, numbered on collision): two parked questions
 * under one title must never fight for one page, and a page that already
 * carries this record's `[[open-<slug>]]` provenance is a crashed
 * earlier attempt the next resolve converges against instead of
 * failing. Creating an open decision is
 * exempt from the write gate by design: accountability lanes stay
 * writable when content lanes are gated, the same principle that keeps
 * the audit lane appending under freeze.
 *
 * An unreadable record is confined to itself: every read partitions the
 * directory into the records that parsed and the ones that did not, so
 * one hand-edited file names itself instead of taking the list, the
 * brief and the transitions down with it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { sanitiseTextField } from "../../redactor.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatterText, SLUG_MAX_LEN, slugify } from "../../vault.ts";
import { appendLogEvent } from "../log.ts";
import { BRAIN_DECISIONS_REL } from "../path-constants.ts";
import { decisionsDir, decisionPath } from "../paths.ts";
import { isoDate, isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { recordDecision } from "./record.ts";
import { appendDecisionChangeReceipt, DECISION_CHANGE_REASON } from "./receipts.ts";

// ----- Vocabulary -----------------------------------------------------------

/**
 * Lifecycle states of one open decision. Frozen object + companion list
 * + type guard: the closed-vocabulary trio, census-registered in
 * `tests/core/architecture/verdict-vocabulary-census.test.ts`.
 */
export const OPEN_DECISION_STATUS = Object.freeze({
  open: "open",
  resolved: "resolved",
  discarded: "discarded",
} as const);

export type OpenDecisionStatus = (typeof OPEN_DECISION_STATUS)[keyof typeof OPEN_DECISION_STATUS];

/** The statuses in lifecycle order - the single source every filter reads. */
export const OPEN_DECISION_STATUSES: ReadonlyArray<OpenDecisionStatus> = Object.freeze([
  OPEN_DECISION_STATUS.open,
  OPEN_DECISION_STATUS.resolved,
  OPEN_DECISION_STATUS.discarded,
]);

export function isOpenDecisionStatus(value: unknown): value is OpenDecisionStatus {
  return (
    typeof value === "string" && (OPEN_DECISION_STATUSES as ReadonlyArray<string>).includes(value)
  );
}

// ----- Constants ------------------------------------------------------------

/**
 * How long a held decisions-directory lock may sit before another
 * process treats it as abandoned. Exported so a test can hold the same
 * lock the writers take rather than guessing at its options.
 */
export const OPEN_LOCK_STALE_MS = 10_000;

/** Cap on the short prose frontmatter fields (title mirrors record.ts). */
const TITLE_MAX_LEN = 200;
/** Cap on one enumerated option (single line). */
const OPTION_MAX_LEN = 512;
/** Cap on the question and context body sections. */
const BODY_MAX_LEN = 2000;
/** Cap on the discard reason / resolution rationale. */
const REASON_MAX_LEN = 512;
/** Longest run of an unreadable field value reproduced in an error. */
const FIELD_EXCERPT_MAX = 120;

/**
 * The frontmatter keys of a stored open decision, in one frozen table.
 * The renderer, the parser and the refusal messages all read the names
 * from here, so a key can never be spelled one way on the way out and
 * another way on the way back in.
 */
const OPEN_KEY = Object.freeze({
  id: "open_decision_id",
  status: "status",
  questionHash: "question_hash",
  createdAt: "created_at",
  resolvedAt: "resolved_at",
  discardedAt: "discarded_at",
  title: "title",
  agent: "agent",
  choice: "choice",
  decision: "decision",
  discardReason: "discard_reason",
} as const);

/** Extension of every open-decision record file under `Brain/decisions/`. */
const OPEN_FILE_EXT = ".md";
/** Filename prefix that separates open decisions from `decision-` pages. */
const OPEN_FILE_PREFIX = "open-";

export function openDecisionsRel(id: string): string {
  return `${BRAIN_DECISIONS_REL}/${id}${OPEN_FILE_EXT}`;
}

// ----- Errors ---------------------------------------------------------------

/** Every failure path in this module raises this typed error. */
export class OpenDecisionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenDecisionError";
  }
}

/**
 * A question that already has an OPEN record refuses to park twice. Dedup
 * is on the sha16 of the NORMALIZED question and scoped to open records -
 * the dedup key runs across open records only, so the same wording may be
 * parked again once its twin has settled (resolved or discarded). The
 * refusal names the existing id so the caller can go straight to it.
 */
export class OpenDecisionDuplicateError extends OpenDecisionError {
  /** The id of the record already carrying this question. */
  readonly existingId: string;
  /** The absolute path of the record already carrying this question. */
  readonly existingPath: string;

  constructor(existingId: string, existingPath: string) {
    super(
      `open decision: this question is already parked as ${existingId} ` +
        `(${existingPath}); resolve or discard it first, or word the ` +
        `question differently`,
    );
    this.name = "OpenDecisionDuplicateError";
    this.existingId = existingId;
    this.existingPath = existingPath;
  }
}

// ----- Shapes ---------------------------------------------------------------

export interface OpenDecisionRecord {
  /** Filename basename without `.md`. Equals `open-<slug>`. */
  readonly id: string;
  readonly slug: string;
  readonly status: OpenDecisionStatus;
  /** Short label that drove the slug (frontmatter, JSON-quoted). */
  readonly title: string;
  /** The full question (body `## Question` section). */
  readonly question: string;
  /** The enumerated options (body `## Options` bullets, in file order). */
  readonly options: ReadonlyArray<string>;
  /** Background prose (body `## Context` section); empty when none. */
  readonly context: string;
  /** sha16 of the normalized question - the dedup key. */
  readonly questionHash: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly discardedAt: string | null;
  /** The chosen option, stamped by {@link resolveOpenDecision}. */
  readonly choice: string | null;
  /** `[[decision-<slug>]]` pointer stamped on resolution. */
  readonly decision: string | null;
  /** Why the question was closed without a decision, on discard. */
  readonly discardReason: string | null;
  readonly agent: string;
  readonly path: string;
}

export interface OpenDecisionInput {
  /** Short label that drives the slug. */
  readonly title: string;
  /** The full question; dedup key (normalized). */
  readonly question: string;
  /** The enumerated options; at least one. */
  readonly options: ReadonlyArray<string>;
  /** Optional background prose. */
  readonly context?: string;
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

export interface ListOpenDecisionsOptions {
  /** Filter on status. Unreadable entries are reported either way. */
  readonly status?: OpenDecisionStatus;
  /**
   * The vault-relative paths the caller may read, as the decision pages
   * take them. A record it may not read is answered as an absent one:
   * skipped by the list, refused by the single-id reads with the absent
   * id's error.
   */
  readonly readable?: (relPath: string) => boolean;
}

export interface ListOpenDecisionsResult {
  /** Readable records, oldest first (created_at asc, then id). */
  readonly records: ReadonlyArray<OpenDecisionRecord>;
  /** Records that named themselves and then failed to parse, by path. */
  readonly unreadable: ReadonlyArray<{ path: string; reason: string }>;
}

export interface ResolveOpenDecisionInput {
  /** The chosen option; must be one of the record's enumerated options. */
  readonly choice: string;
  /** Agent/human who resolved the question. */
  readonly actor?: string;
  /** Why this option won; becomes the minted page's assumption. */
  readonly rationale?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

export interface DiscardOpenDecisionInput {
  /** Why the question is being closed without a decision. Required. */
  readonly reason: string;
  readonly actor?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

// ----- Field helpers --------------------------------------------------------

function excerptFieldValue(raw: unknown): string {
  const text = typeof raw === "string" ? raw : String(raw);
  return text.length <= FIELD_EXCERPT_MAX ? text : `${text.slice(0, FIELD_EXCERPT_MAX)}…`;
}

function presentButUnreadable(expectation: string, raw: unknown): string {
  return `is present but ${expectation}: ${excerptFieldValue(raw)}`;
}

/**
 * One frontmatter field of one record cannot be read. Absent and
 * unreadable are different claims; substituting a default for the second
 * would state a value nothing supports. The refusal is scoped to ONE
 * record: the directory reader catches it per file and reports it
 * alongside the records that read cleanly.
 */
class OpenDecisionFieldError extends Error {
  readonly path: string;
  readonly key: string;

  constructor(path: string, key: string, detail: string) {
    super(`open decision ${path}: ${key} ${detail}`);
    this.name = "OpenDecisionFieldError";
    this.path = path;
    this.key = key;
  }
}

function requireTextField(value: unknown, label: string, maxLen: number): string {
  if (typeof value !== "string") {
    throw new OpenDecisionError(`open decision: ${label} is required`);
  }
  const cleaned = sanitiseTextField(value, { maxLen, singleLine: true }).trim();
  if (!cleaned) throw new OpenDecisionError(`open decision: ${label} is required`);
  return cleaned;
}

function optionalTextField(value: unknown, label: string, maxLen: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new OpenDecisionError(`open decision: ${label} must be a string`);
  }
  return sanitiseTextField(value, { maxLen }).trim();
}

/** Normalize a question for dedup: whitespace-collapsed, lowercased. */
export function normalizeOpenQuestion(question: string): string {
  return question.replace(/\s+/g, " ").trim().toLowerCase();
}

/** sha16 of the normalized question - the stable dedup key. */
export function openQuestionHash(question: string): string {
  return createHash("sha256").update(normalizeOpenQuestion(question)).digest("hex").slice(0, 16);
}

// ----- (De)serialization ----------------------------------------------------

function sectionText(body: string, heading: string): string {
  const re = new RegExp(`^## ${heading}$`, "mu");
  const match = re.exec(body);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = /^## /mu.exec(body.slice(start + 1));
  const end = next ? start + 1 + next.index : body.length;
  return body.slice(start, end).trim();
}

/**
 * A line of free-text body prose whose first non-space character is `#`
 * would read back as a section heading: a question carrying its own
 * `## Options` line re-partitions the body on parse, and its bullets
 * become the record's options. The writer indents such a line by one
 * space (breaking the `^## ` anchors the section reader matches); the
 * reader dedents exactly the lines the writer could have indented - a
 * line the writer left alone never has `#` as its first non-space
 * character, because that shape is what the writer escapes - so the
 * round trip is byte-faithful for every line the section reader's own
 * trim leaves alone, an already-indented heading-shaped line included.
 * The exception is the section's opening line: the reader's trim strips
 * a section's leading whitespace - the writer's escape with it - before
 * the dedent runs, so a question OPENING with an indented heading-shaped
 * line reads back dedented. (It re-escapes on the next render, so the
 * shape is stable; the first round trip just is not byte-faithful there.)
 */
function escapeBodyProse(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*#/u.test(line) ? ` ${line}` : line))
    .join("\n");
}

function unescapeBodyProse(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith(" ") && /^\s*#/u.test(line) ? line.slice(1) : line))
    .join("\n");
}

function renderRecord(record: OpenDecisionRecord): string {
  const lines = [
    "---",
    `${OPEN_KEY.id}: ${record.id}`,
    `${OPEN_KEY.status}: ${record.status}`,
    `${OPEN_KEY.questionHash}: ${record.questionHash}`,
    `${OPEN_KEY.createdAt}: ${record.createdAt}`,
    ...(record.resolvedAt !== null ? [`${OPEN_KEY.resolvedAt}: ${record.resolvedAt}`] : []),
    ...(record.discardedAt !== null ? [`${OPEN_KEY.discardedAt}: ${record.discardedAt}`] : []),
    // Free-text values are JSON-quoted so YAML-significant characters can
    // never corrupt the file (triggers/intentions pattern).
    `${OPEN_KEY.title}: ${JSON.stringify(record.title)}`,
    `${OPEN_KEY.agent}: ${JSON.stringify(record.agent)}`,
    ...(record.choice !== null ? [`${OPEN_KEY.choice}: ${JSON.stringify(record.choice)}`] : []),
    ...(record.decision !== null
      ? [`${OPEN_KEY.decision}: ${JSON.stringify(record.decision)}`]
      : []),
    ...(record.discardReason !== null
      ? [`${OPEN_KEY.discardReason}: ${JSON.stringify(record.discardReason)}`]
      : []),
    "---",
    "",
    "## Question",
    "",
    escapeBodyProse(record.question),
    "",
    "## Options",
    "",
  ];
  for (const option of record.options) lines.push(`- ${option}`);
  lines.push("");
  if (record.context.length > 0) {
    lines.push("## Context", "", escapeBodyProse(record.context), "");
  }
  return lines.join("\n");
}

/**
 * Read one file as an open-decision record. `null` means the file is not
 * an open decision at all (no id, so nothing claims it belongs here -
 * `decision-` pages and operator notes share the directory). Every OTHER
 * failure throws {@link OpenDecisionFieldError} naming the field.
 */
function parseOpenRecord(vault: string, fileName: string): OpenDecisionRecord | null {
  const path = join(decisionsDir(vault), fileName);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new OpenDecisionFieldError(
      path,
      OPEN_KEY.id,
      `the file cannot be read: ${(err as Error).message ?? String(err)}`,
    );
  }
  const [meta, body] = parseFrontmatterText(raw);
  const id = meta[OPEN_KEY.id];
  if (id === undefined) return null;
  if (typeof id !== "string" || id === "") {
    throw new OpenDecisionFieldError(path, OPEN_KEY.id, presentButUnreadable("not an id", id));
  }
  if (!id.startsWith(OPEN_FILE_PREFIX)) {
    throw new OpenDecisionFieldError(
      path,
      OPEN_KEY.id,
      presentButUnreadable(`not an ${OPEN_FILE_PREFIX}<slug> id`, id),
    );
  }
  const status = meta[OPEN_KEY.status];
  if (!isOpenDecisionStatus(status)) {
    throw new OpenDecisionFieldError(
      path,
      OPEN_KEY.status,
      presentButUnreadable(`not one of ${OPEN_DECISION_STATUSES.join(", ")}`, status),
    );
  }
  const question = unescapeBodyProse(sectionText(body, "Question"));
  if (!question) {
    throw new OpenDecisionFieldError(
      path,
      "## Question",
      "the question section is missing or empty",
    );
  }
  const options = sectionText(body, "Options")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
  if (options.length === 0) {
    throw new OpenDecisionFieldError(path, "## Options", "the options section carries no options");
  }
  // The dedup hash is derived data: a hand-edit that dropped the key is
  // recomputed from the question body, but a PRESENT value that cannot
  // be read refuses rather than standing in for the operator's bytes.
  const rawHash = meta[OPEN_KEY.questionHash];
  let questionHash: string;
  if (rawHash === undefined) {
    questionHash = openQuestionHash(question);
  } else if (typeof rawHash === "string" && /^[0-9a-f]{16}$/u.test(rawHash)) {
    questionHash = rawHash;
  } else {
    throw new OpenDecisionFieldError(
      path,
      OPEN_KEY.questionHash,
      presentButUnreadable("not a 16-hex-character hash", rawHash),
    );
  }
  const createdAt = meta[OPEN_KEY.createdAt];
  if (typeof createdAt !== "string" || createdAt === "" || Number.isNaN(Date.parse(createdAt))) {
    throw new OpenDecisionFieldError(
      path,
      OPEN_KEY.createdAt,
      createdAt === undefined
        ? "is missing, and a record is ordered and aged by it"
        : presentButUnreadable("not a readable instant", createdAt),
    );
  }
  const textOrNull = (key: string): string | null => {
    const v = meta[key];
    return typeof v === "string" ? v : null;
  };
  // The title is derived data like the dedup hash: a hand-edit that
  // dropped the key falls back to the id, but a PRESENT value that cannot
  // be read refuses rather than standing in for the operator's bytes.
  const titleMeta = meta[OPEN_KEY.title];
  if (titleMeta !== undefined && typeof titleMeta !== "string") {
    throw new OpenDecisionFieldError(
      path,
      OPEN_KEY.title,
      presentButUnreadable("not a string", titleMeta),
    );
  }
  return Object.freeze({
    id,
    slug: id.slice(OPEN_FILE_PREFIX.length),
    status,
    title: typeof titleMeta === "string" ? titleMeta : id,
    question,
    options: Object.freeze(options),
    context: unescapeBodyProse(sectionText(body, "Context")),
    questionHash,
    createdAt,
    resolvedAt: textOrNull(OPEN_KEY.resolvedAt),
    discardedAt: textOrNull(OPEN_KEY.discardedAt),
    choice: textOrNull(OPEN_KEY.choice),
    decision: textOrNull(OPEN_KEY.decision),
    discardReason: textOrNull(OPEN_KEY.discardReason),
    agent: textOrNull(OPEN_KEY.agent) ?? "",
    path,
  });
}

// ----- Reads ----------------------------------------------------------------

/**
 * Read the whole open-decision slice of `Brain/decisions/`, keeping a
 * broken record's blast radius to itself. This is the reader every
 * surface goes through: a refusal from one file is caught here and
 * reported next to the records that read cleanly. The status filter
 * applies to the readable records only - an unreadable record has no
 * status to compare, and dropping it from a filtered view would hide it
 * exactly where a caller is most likely to conclude the queue is empty.
 */
export function listOpenDecisions(
  vault: string,
  opts: ListOpenDecisionsOptions = {},
): ListOpenDecisionsResult {
  const dir = decisionsDir(vault);
  if (!existsSync(dir)) return { records: [], unreadable: [] };
  const records: OpenDecisionRecord[] = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(OPEN_FILE_EXT) || !name.startsWith(OPEN_FILE_PREFIX)) continue;
    const path = join(dir, name);
    if (opts.readable !== undefined && !opts.readable(openDecisionsRel(stripExt(name)))) continue;
    try {
      const record = parseOpenRecord(vault, name);
      if (record === null) continue;
      if (opts.status !== undefined && record.status !== opts.status) continue;
      records.push(record);
    } catch (err) {
      if (!(err instanceof OpenDecisionFieldError)) throw err;
      unreadable.push({ path, reason: err.message });
    }
  }
  records.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { records, unreadable };
}

function stripExt(name: string): string {
  return name.slice(0, -OPEN_FILE_EXT.length);
}

/**
 * One open decision by id, or null. A record the caller cannot read
 * (absent, or excluded by the readable predicate) is answered as absent.
 */
export function showOpenDecision(
  vault: string,
  id: string,
  opts: Pick<ListOpenDecisionsOptions, "readable"> = {},
): OpenDecisionRecord | null {
  const listed = listOpenDecisions(vault, opts);
  return listed.records.find((r) => r.id === id) ?? null;
}

// ----- Directory lock -------------------------------------------------------

/**
 * Run one read-then-write pass under the decisions-directory lock. Every
 * writer here goes through it: the CLI and the MCP server can both reach
 * the store, and without the lock two callers could each observe "no
 * twin" for one question and persist duplicates.
 */
function withOpenDirLock<T>(vault: string, body: () => T): T {
  const dir = decisionsDir(vault);
  mkdirSync(dir, { recursive: true });
  const release = lockfile.lockSync(dir, { stale: OPEN_LOCK_STALE_MS, realpath: false });
  try {
    return body();
  } finally {
    release();
  }
}

// ----- Creation -------------------------------------------------------------

/**
 * Park a question with its enumerated options. Dedup is on the sha16 of
 * the normalized question, scoped to OPEN records: a twin question (same
 * words, different whitespace or casing) with an open record refuses with
 * {@link OpenDecisionDuplicateError} naming the existing id; the same
 * wording parks again once the twin has settled. A DISTINCT question
 * under an occupied slug gets a suffixed filename, never a clobber.
 */
export function openDecision(vault: string, input: OpenDecisionInput): OpenDecisionRecord {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const title = requireTextField(input.title, "title", TITLE_MAX_LEN);
  const question = optionalTextField(input.question, "question", BODY_MAX_LEN);
  if (!question) throw new OpenDecisionError("open decision: question is required");
  if (!Array.isArray(input.options) || input.options.length === 0) {
    throw new OpenDecisionError("open decision: at least one option is required");
  }
  const options = input.options.map((option) =>
    requireTextField(option, "options", OPTION_MAX_LEN),
  );
  const context = optionalTextField(input.context ?? "", "context", BODY_MAX_LEN);
  const now = input.now ?? new Date();
  const questionHash = openQuestionHash(question);

  return withOpenDirLock(vault, () => {
    // Dedup is scoped to open records: a settled (resolved / discarded)
    // twin is history, and the same wording must be parkable again.
    const existing = listOpenDecisions(vault, { status: OPEN_DECISION_STATUS.open }).records.find(
      (r) => r.questionHash === questionHash,
    );
    if (existing !== undefined) {
      throw new OpenDecisionDuplicateError(existing.id, existing.path);
    }

    const explicitAgent = normalizeAgentArgument(input.agent ?? null);
    const agent = explicitAgent ?? resolveAgentName(input.configPath);

    const dir = decisionsDir(vault);
    const slug = slugify(title);
    let id = `${OPEN_FILE_PREFIX}${slug}`;
    let suffix = 2;
    while (existsSync(join(dir, `${id}${OPEN_FILE_EXT}`))) {
      id = `${OPEN_FILE_PREFIX}${slug}-${suffix}`;
      suffix += 1;
    }

    const record: OpenDecisionRecord = Object.freeze({
      id,
      slug: id.slice(OPEN_FILE_PREFIX.length),
      status: OPEN_DECISION_STATUS.open,
      title,
      question,
      options: Object.freeze(options),
      context,
      questionHash,
      createdAt: isoSecond(now),
      resolvedAt: null,
      discardedAt: null,
      choice: null,
      decision: null,
      discardReason: null,
      agent,
      path: join(dir, `${id}${OPEN_FILE_EXT}`),
    });
    atomicWriteFileSync(record.path, renderRecord(record));

    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(now),
        eventType: BRAIN_LOG_EVENT_KIND.decisionOpen,
        agent,
        body: {
          open: `[[${record.id}]]`,
          title,
          options: String(options.length),
          agent,
        },
      });
    } catch {
      // The record file is authoritative; the timeline mirror is best-effort.
    }
    return record;
  });
}

// ----- Transitions ----------------------------------------------------------

/**
 * Refuse an id no readable record carries. When part of the queue is
 * unreadable the refusal says so: "no such record" would otherwise
 * assert the question is not there when in truth the store could not
 * look.
 */
function unknownOpenDecisionError(
  id: string,
  unreadable: ReadonlyArray<{ path: string; reason: string }>,
): OpenDecisionError {
  if (unreadable.length === 0) {
    return new OpenDecisionError(`no open decision: ${id}`);
  }
  return new OpenDecisionError(
    `no open decision: ${id} - and ${unreadable.length} record(s) in the directory could not be ` +
      `read, so the id may belong to one of them: ${unreadable.map((u) => u.reason).join("; ")}`,
  );
}

function requireOpenRecord(vault: string, id: string): OpenDecisionRecord {
  const listed = listOpenDecisions(vault);
  const record = listed.records.find((r) => r.id === id);
  if (record === undefined) throw unknownOpenDecisionError(id, listed.unreadable);
  return record;
}

function actorFor(input: { actor?: string; configPath?: string }, fallback: string): string {
  const explicit = normalizeAgentArgument(input.actor ?? null);
  if (explicit !== null) return explicit;
  const carried = normalizeAgentArgument(fallback);
  return carried ?? resolveAgentName(input.configPath);
}

/**
 * The provenance a minted page always carries: the wikilink naming the
 * open record it came from, in the body, so a resolve that crashed
 * between minting the page and stamping the record can be recognized and
 * converged on the next attempt.
 */
function mintProvenance(record: OpenDecisionRecord): string {
  return `resolved from [[${record.id}]]`;
}

/** The minted page's body: the open record's context plus the provenance. */
function mintNotes(record: OpenDecisionRecord): string {
  return [record.context, mintProvenance(record)].filter((part) => part !== "").join("\n\n");
}

/** The minted page's title exactly as `recordDecision` will sanitise it, so
 * the occupy-check below tests the slug the mint will actually write. */
function sanitiseMintTitle(value: string): string {
  return sanitiseTextField(value, { maxLen: TITLE_MAX_LEN, singleLine: true }).trim();
}

/**
 * The slug budget the mint head keeps to: long enough to carry the
 * question's opening words, short enough that the per-record tail that
 * follows it - the record's own id, and from the second candidate on a
 * counter - fits inside {@link SLUG_MAX_LEN} beside it.
 */
const MINT_HEAD_MAX = 40;

/**
 * The head every derived mint candidate is built on: the longest
 * word-prefix of the title whose slug stays within {@link MINT_HEAD_MAX}.
 * Working word by word keeps the head on a word boundary; a single word
 * longer than the budget yields an empty head, and the derived candidates
 * then carry the id alone.
 */
function mintHead(title: string): string {
  let head = "";
  for (const word of title.split(/\s+/u)) {
    if (word === "") continue;
    const next = head === "" ? word : `${head} ${word}`;
    if (slugify(next).length > MINT_HEAD_MAX) break;
    head = next;
  }
  return head;
}

/**
 * A derived mint title: `<head> (<id>)`, numbered `<head> (<id> N)` from
 * the second candidate on. The id - unique among records - is PRE-SHAVED
 * so the whole tail sits INSIDE the slug cap: `slugify` truncates from the
 * START of the slug, so a tail appended past the cap is silently dropped
 * and every candidate would slugify identically - an occupied slug then
 * wedges the mint walk forever. With the tail budgeted inside the cap the
 * numbered candidates keep their counter on the slug too (the id's slice
 * shrinks as the counter grows), so successive candidates slugify
 * distinctly and the walk terminates by construction.
 */
function derivedMintTitle(sanitisedTitle: string, id: string, suffix: number): string {
  const counter = suffix === 0 ? "" : ` ${suffix}`;
  const counterLen = suffix === 0 ? 0 : 1 + String(suffix).length;
  const head = mintHead(sanitisedTitle);
  const headLen = head === "" ? 0 : slugify(head).length + 1;
  let budget = SLUG_MAX_LEN - headLen - counterLen;
  let effectiveHead = head;
  if (budget < 1) {
    // The head leaves no room for even a one-character id slice: the
    // candidate drops it rather than pushing the tail past the cap.
    effectiveHead = "";
    budget = SLUG_MAX_LEN - counterLen;
  }
  const tailId = id.slice(0, Math.max(1, budget)).replace(/-+$/u, "");
  const tail = `(${tailId}${counter})`;
  return effectiveHead === "" ? tail : `${effectiveHead} ${tail}`;
}

interface ResolveMintTarget {
  /** The title to pass to `recordDecision`; its slug is `slug`. */
  readonly title: string;
  /** The slug the page occupies, or will occupy. */
  readonly slug: string;
  /**
   * True when `slug` is already occupied by a page carrying this
   * record's `[[open-<slug>]]` provenance - a crashed earlier attempt
   * the resolve converges against by stamping, not by minting again.
   */
  readonly ours: boolean;
}

/**
 * Plan the page one resolve mints. The bare title slug first; if that is
 * occupied by a page that does not reference this record, fall through the
 * per-record derived titles (head plus id, numbered on collision) - the
 * same occupy-check `openDecision` runs for the record filename. The
 * derived candidates keep their distinguishing tail INSIDE the slug cap
 * (see {@link derivedMintTitle}), so a title whose slug fills the cap
 * still walks onto fresh slugs instead of spinning on the same one. Never
 * the bare title alone: `recordDecision` refuses an existing slug, so a
 * second "Pick DB" question would otherwise be wedged open forever (and
 * a crash between minting and stamping would wedge the first one too).
 */
function resolveMintTarget(vault: string, record: OpenDecisionRecord): ResolveMintTarget {
  const reference = `[[${record.id}]]`;
  const sanitised = sanitiseMintTitle(record.title);
  let title = sanitised;
  let slug = slugify(title);
  let suffix = 0;
  for (;;) {
    const path = decisionPath(vault, slug);
    if (!existsSync(path)) return { title, slug, ours: false };
    if (readFileSync(path, "utf8").includes(reference)) return { title, slug, ours: true };
    title = sanitiseMintTitle(derivedMintTitle(sanitised, record.id, suffix));
    slug = slugify(title);
    suffix = suffix === 0 ? 2 : suffix + 1;
  }
}

/**
 * Close a parked question by CHOOSING: mint the real `type: decision`
 * page through {@link recordDecision} (review obligation, log event and
 * the B4 change trail included - the one place that owns them), stamp
 * the open record `resolved` with the `[[decision-<slug>]]` pointer, and
 * append exactly one `open_resolved` receipt. The open record stays in
 * place: history is a status filter.
 *
 * Idempotent-safe: when the planned page already exists and carries this
 * record's `[[open-<slug>]]` provenance - a previous attempt that minted
 * the page and crashed before stamping - the resolve converges by
 * stamping against that page instead of failing.
 */
export function resolveOpenDecision(
  vault: string,
  id: string,
  input: ResolveOpenDecisionInput,
): { decision: string } {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const choice = requireTextField(input.choice, "choice", OPTION_MAX_LEN);
  return withOpenDirLock(vault, () => {
    const record = requireOpenRecord(vault, id);
    if (record.status !== OPEN_DECISION_STATUS.open) {
      throw new OpenDecisionError(
        `open decision ${id} is terminal (${record.status}); only an open record can be resolved`,
      );
    }
    if (!record.options.includes(choice)) {
      throw new OpenDecisionError(
        `open decision ${id}: choice ${JSON.stringify(choice)} is not one of the enumerated ` +
          `options (${record.options.map((o) => JSON.stringify(o)).join(", ")})`,
      );
    }
    const actor = actorFor(input, record.agent);
    const now = input.now ?? new Date();
    const rationale = optionalTextField(input.rationale ?? "", "rationale", REASON_MAX_LEN);

    // The minted page is a first-class decision record: `recordDecision`
    // owns the slug, the review obligation, the log event and the
    // decision-record receipt. When the operator gave no rationale the
    // assumption names the provenance (which open record decided this)
    // rather than inventing a belief, and the body always carries the
    // provenance link so a crashed resolve can converge (see
    // {@link resolveMintTarget}).
    const target = resolveMintTarget(vault, record);
    let decisionId: string;
    if (target.ours) {
      // A previous attempt minted this page and crashed before stamping
      // the record: the page is already authoritative, so only the stamp
      // (and its mirrors) remain.
      decisionId = `decision-${target.slug}`;
    } else {
      const minted = recordDecision(vault, {
        title: target.title,
        chosen: choice,
        assumption: rationale || mintProvenance(record),
        reviewDate: isoDate(now),
        notes: mintNotes(record),
        agent: actor,
        now,
        ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
      });
      decisionId = minted.record.id;
    }

    const stamped: OpenDecisionRecord = Object.freeze({
      ...record,
      status: OPEN_DECISION_STATUS.resolved,
      resolvedAt: isoSecond(now),
      choice,
      decision: `[[${decisionId}]]`,
    });
    atomicWriteFileSync(record.path, renderRecord(stamped));

    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(now),
        eventType: BRAIN_LOG_EVENT_KIND.decisionResolved,
        agent: actor,
        body: {
          open: `[[${record.id}]]`,
          decision: `[[${decisionId}]]`,
          choice,
          agent: actor,
        },
      });
    } catch {
      // The record file is authoritative; the timeline mirror is best-effort.
    }

    // Exactly one open_resolved receipt per resolution (the receipts
    // module's idempotency key makes a replay a no-op). Fail-soft like
    // the record.ts trail: the stamped open record and the minted page
    // are authoritative, so an accountability-log hiccup must not fail
    // the transition itself.
    try {
      appendDecisionChangeReceipt(vault, {
        subject: `[[${record.id}]]`,
        before: OPEN_DECISION_STATUS.open,
        after: `${OPEN_DECISION_STATUS.resolved} -> [[${decisionId}]]`,
        evidenceTriggers: [`[[${decisionId}]]`],
        actor,
        ...(rationale ? { rationale } : {}),
        reasonCode: DECISION_CHANGE_REASON.openResolved,
        ts: isoSecond(now),
        ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
      });
    } catch {
      // Best-effort accountability; the stamped record is authoritative.
    }

    return { decision: decisionId };
  });
}

/**
 * Close a parked question WITHOUT deciding: stamp the reason and the
 * instant, keep the record in place. No receipt - the change trail
 * records belief changes, and a discarded question changed none.
 */
export function discardOpenDecision(
  vault: string,
  id: string,
  input: DiscardOpenDecisionInput,
): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const reason = requireTextField(input.reason, "reason", REASON_MAX_LEN);
  withOpenDirLock(vault, () => {
    const record = requireOpenRecord(vault, id);
    if (record.status !== OPEN_DECISION_STATUS.open) {
      throw new OpenDecisionError(
        `open decision ${id} is terminal (${record.status}); only an open record can be discarded`,
      );
    }
    const actor = actorFor(input, record.agent);
    const now = input.now ?? new Date();
    const stamped: OpenDecisionRecord = Object.freeze({
      ...record,
      status: OPEN_DECISION_STATUS.discarded,
      discardedAt: isoSecond(now),
      discardReason: reason,
    });
    atomicWriteFileSync(record.path, renderRecord(stamped));

    try {
      appendLogEvent(vault, {
        timestamp: isoSecond(now),
        eventType: BRAIN_LOG_EVENT_KIND.decisionDiscarded,
        agent: actor,
        body: {
          open: `[[${record.id}]]`,
          reason,
          agent: actor,
        },
      });
    } catch {
      // The record file is authoritative; the timeline mirror is best-effort.
    }
  });
}

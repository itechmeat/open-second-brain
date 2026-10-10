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
 * receipt to the decision-change trail. Creating an open decision is
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
import { parseFrontmatterText, slugify } from "../../vault.ts";
import { appendLogEvent } from "../log.ts";
import { BRAIN_DECISIONS_REL } from "../path-constants.ts";
import { decisionsDir } from "../paths.ts";
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
 * A question that is already parked refuses to park twice. Dedup is on
 * the sha16 of the NORMALIZED question, so rephrased whitespace or
 * casing cannot mint a second record for one question - and the refusal
 * names the existing id so the caller can go straight to it.
 */
export class OpenDecisionDuplicateError extends OpenDecisionError {
  /** The id of the record already carrying this question. */
  readonly existingId: string;
  /** The absolute path of the record already carrying this question. */
  readonly existingPath: string;

  constructor(existingId: string, existingPath: string) {
    super(
      `open decision: this question is already parked as ${existingId} ` +
        `(${existingPath}); resolve or discard an open twin, or word the ` +
        `question differently when the twin has already settled`,
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
    record.question,
    "",
    "## Options",
    "",
  ];
  for (const option of record.options) lines.push(`- ${option}`);
  lines.push("");
  if (record.context.length > 0) {
    lines.push("## Context", "", record.context, "");
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
  const question = sectionText(body, "Question");
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
    context: sectionText(body, "Context"),
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
 * the normalized question: a twin question (same words, different
 * whitespace or casing) refuses with
 * {@link OpenDecisionDuplicateError} naming the existing id. A DISTINCT
 * question under an occupied slug gets a suffixed filename, never a
 * clobber.
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
    const existing = listOpenDecisions(vault).records.find((r) => r.questionHash === questionHash);
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
 * Close a parked question by CHOOSING: mint the real `type: decision`
 * page through {@link recordDecision} (review obligation, log event and
 * the B4 change trail included - the one place that owns them), stamp
 * the open record `resolved` with the `[[decision-<slug>]]` pointer, and
 * append exactly one `open_resolved` receipt. The open record stays in
 * place: history is a status filter.
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
    // rather than inventing a belief.
    const minted = recordDecision(vault, {
      title: record.title,
      chosen: choice,
      assumption: rationale || `resolved from [[${record.id}]]`,
      reviewDate: isoDate(now),
      ...(record.context ? { notes: record.context } : {}),
      agent: actor,
      now,
      ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
    });

    const stamped: OpenDecisionRecord = Object.freeze({
      ...record,
      status: OPEN_DECISION_STATUS.resolved,
      resolvedAt: isoSecond(now),
      choice,
      decision: `[[${minted.record.id}]]`,
    });
    atomicWriteFileSync(record.path, renderRecord(stamped));

    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.decisionResolved,
      agent: actor,
      body: {
        open: `[[${record.id}]]`,
        decision: `[[${minted.record.id}]]`,
        choice,
        agent: actor,
      },
    });

    // Exactly one open_resolved receipt per resolution (the receipts
    // module's idempotency key makes a replay a no-op). Fail-soft like
    // the record.ts trail: the stamped open record and the minted page
    // are authoritative, so an accountability-log hiccup must not fail
    // the transition itself.
    try {
      appendDecisionChangeReceipt(vault, {
        subject: `[[${record.id}]]`,
        before: OPEN_DECISION_STATUS.open,
        after: `${OPEN_DECISION_STATUS.resolved} -> [[${minted.record.id}]]`,
        evidenceTriggers: [`[[${minted.record.id}]]`],
        actor,
        ...(rationale ? { rationale } : {}),
        reasonCode: DECISION_CHANGE_REASON.openResolved,
        ts: isoSecond(now),
        ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
      });
    } catch {
      // Best-effort accountability; the stamped record is authoritative.
    }

    return { decision: minted.record.id };
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

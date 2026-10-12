/**
 * LongMemEval benchmark suite adapter (recall-quality wave, t_607d429d).
 *
 * LongMemEval (Wu et al., 2024) is the long-term-memory benchmark the
 * field reports recall_all@5 on. This module adds it beside LoCoMo as an
 * ADDITIVE named suite: a fail-fast parser over the official dataset
 * shape (a JSON array of question entries, each carrying its haystack
 * sessions), and a converter into the existing {@link BenchFixture} the
 * unchanged `runMemoryBench` consumes.
 *
 * Network-free by design: the loader is pure over its input file. The
 * committed sample fixtures certify CI: `longmemeval-official-sample.json`
 * pins the OFFICIAL dataset shape, `longmemeval-sample.json` the legacy
 * sample shape; the full dataset arrives as an operator-supplied path
 * resolved by the bench verb's literal-then-repo-fixture-dir logic. The
 * official download lives at https://github.com/xiaowu0162/LongMemEval
 * (the dataset ships as JSON: longmemeval_s.json, longmemeval_m.json,
 * longmemeval_oracle.json) - never fetched at run time.
 *
 * Both dataset shapes are accepted, official first: the official files
 * spell the keys `question_id` / `haystack_session_ids` /
 * `haystack_sessions`, mark abstention by a question id ending in
 * `_abs`, and use the six official question types; the legacy sample
 * shape uses `q_id` / `haystack_session_id` / `haystack_session`, an
 * explicit `abstention` question type, and the pre-wave type spellings.
 *
 * Two traps are handled HERE, at conversion, not downstream:
 *
 *  - `expected_text` is NEVER set. `evaluateQuestion` ignores it for
 *    retrieval categories, so a gold answer pinned there would silently
 *    score nothing. The gold answer rides the judge payload instead
 *    (judge.ts), and scoring is expected_paths containment at the
 *    {@link LONGMEMEVAL_RECALL_CUTOFF}.
 *  - Gold session ids join by direct set membership against the entry's
 *    own haystack ids; an unknown id is a named parse error. Ids are
 *    sanitized only when they become note paths.
 *  - Each entry's evidence is namespaced under its own question's
 *    subtree (`sessions/<question_id>/...`): LongMemEval scores every
 *    question against its OWN haystack (~50 sessions), and evidence
 *    pooled across entries would have every query search the union of
 *    all haystacks. Residual, stated honestly: the fixture schema has
 *    no per-question retrieval scope, so the disjoint subtrees keep
 *    the gold paths per-question but cannot stop the ranker from
 *    surfacing another scope's notes inside the cutoff - full
 *    per-question retrieval needs a scope field on the fixture
 *    question plus a rank-time filter in the retrieve phase.
 *
 * Abstention questions are dropped at conversion time with the exclusion
 * count recorded in the suite receipt - the fixture parser rejects
 * unknown categories, so pass-through is not an option, and the report
 * family surfaces the count rather than hiding it.
 */

import { readFileSync } from "node:fs";

import { parseBenchFixture } from "./fixture.ts";
import {
  RETRIEVAL_CATEGORIES,
  type BenchCategory,
  type BenchFixture,
  type BenchFixtureContinuity,
  type BenchFixtureNote,
  type BenchQuestion,
} from "./types.ts";

/** The suite's registered name in the bench verb's suite registry. */
export const LONGMEMEVAL_SUITE_NAME = "longmemeval";

/**
 * Provenance of the answer-judging prompts below, stated honestly: they
 * are SELF-WRITTEN in the spirit of the upstream evaluation - its
 * `evaluate_qa.py` judges a model's response against the reference
 * answer with per-question-type prompts - but they are NOT a
 * transcription of the upstream text, and nothing upstream pins their
 * wording. The dataset itself ships as JSON in the same repository and
 * is downloaded by operators - never at run time.
 */
export const LONGMEMEVAL_PROMPT_PROVENANCE =
  "self-written prompts following the evaluate_qa.py approach in github.com/xiaowu0162/LongMemEval (arXiv:2410.10813); not transcribed from upstream - the dataset ships as longmemeval_s.json / longmemeval_m.json / longmemeval_oracle.json";

/**
 * Answer-judging prompt, system half (self-written; see
 * {@link LONGMEMEVAL_PROMPT_PROVENANCE}). The external judge command
 * composes its model call from this and the per-question template, so
 * the command itself stays a dumb model call and the prompt text has
 * exactly one home in the tree.
 */
export const LONGMEMEVAL_JUDGE_SYSTEM_PROMPT = Object.freeze(
  "You are a meticulous evaluator of long-term conversational memory. " +
    "Judge the provided answer against the reference answer and the gold " +
    "evidence, using only what the evidence supports. Answer with strict " +
    'JSON: {"correct": true} when the answer is supported, {"correct": false} otherwise.',
);

/**
 * Answer-judging prompt, per-question half (self-written; see
 * {@link LONGMEMEVAL_PROMPT_PROVENANCE}). The placeholders are the judge
 * payload's own field names, so a judge command renders the prompt
 * straight from the stdin JSON. Gold evidence is carried as the gold
 * sessions' ids (the payload stays bounded); a judge that wants their
 * conversation text resolves the ids from the dataset it already has.
 */
export const LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE = Object.freeze(
  "Question: {question}\n" +
    "Reference answer: {answer}\n" +
    "Gold evidence sessions: {gold}\n" +
    "Decide whether the answer is supported by the gold evidence.",
);

export interface LongMemEvalTurn {
  readonly role: string;
  readonly content: string;
}

/** One dataset entry, in the official LongMemEval question shape. */
export interface LongMemEvalEntry {
  readonly q_id: string;
  readonly question_type: string;
  readonly question: string;
  readonly answer?: string;
  /**
   * The date the question was asked (official `question_date`). An
   * entry that states none is dated by its last haystack session - the
   * question follows the sessions it was built from.
   */
  readonly question_date: string;
  readonly haystack_session_id: ReadonlyArray<string>;
  readonly haystack_session: ReadonlyArray<ReadonlyArray<LongMemEvalTurn>>;
  readonly haystack_dates: ReadonlyArray<string>;
  readonly answer_session_ids: ReadonlyArray<string>;
}

export interface LongMemEvalDataset {
  readonly name?: string;
  readonly entries: ReadonlyArray<LongMemEvalEntry>;
}

/** What conversion decided, surfaced beside the converted fixture. */
export interface LongMemEvalReceipt {
  /** Abstention questions dropped at conversion time. */
  readonly abstention_excluded: number;
}

export interface LongMemEvalConversion {
  readonly fixture: BenchFixture;
  readonly receipt: LongMemEvalReceipt;
}

class LongMemEvalParseError extends Error {}

/** The explicit legacy-shape question type whose entries measure abstention. */
export const LONGMEMEVAL_ABSTENTION_TYPE = "abstention";

/** Suffix the official dataset puts on abstention question ids. */
const OFFICIAL_ABSTENTION_SUFFIX = "_abs";

/**
 * True when an entry measures abstention and is excluded from scoring.
 * The official dataset marks abstention by a `question_id` ending in
 * `_abs`; the legacy sample shape uses the explicit `abstention`
 * question type. Both paths stay live.
 */
export function isLongMemEvalAbstention(
  entry: Pick<LongMemEvalEntry, "q_id" | "question_type">,
): boolean {
  return (
    entry.question_type === LONGMEMEVAL_ABSTENTION_TYPE ||
    entry.q_id.endsWith(OFFICIAL_ABSTENTION_SUFFIX)
  );
}

/**
 * The recall cutoff the suite scores at: a question passes retrieval
 * when EVERY gold session note ranks inside the top k. Drives both the
 * converted questions' `top_k` and the strict report metric.
 */
export const LONGMEMEVAL_RECALL_CUTOFF = 5;

/**
 * Question types -> OSB's canonical retrieval categories. The official
 * dataset's six types come first (`single-session-*` all read as the
 * single-hop category - each asks about one session, only the turn
 * role or preference focus differs, and scoring is identical
 * expected_paths containment for all of them); the legacy sample
 * shape's spellings follow. Abstention entries map to nothing: they
 * are excluded, never converted.
 */
const QUESTION_TYPE_TO_CATEGORY: Readonly<Record<string, BenchCategory>> = Object.freeze({
  "single-session-user": "single_hop",
  "single-session-assistant": "single_hop",
  "single-session-preference": "single_hop",
  "multi-session": "multi_evidence",
  "temporal-reasoning": "temporal",
  "knowledge-update": "contradiction",
  "single-hop": "single_hop",
  "multi-hop": "multi_evidence",
  "open-domain": "single_hop",
});

/** Every question type the parser accepts, abstention included. */
export const LONGMEMEVAL_QUESTION_TYPES: ReadonlyArray<string> = Object.freeze([
  ...Object.keys(QUESTION_TYPE_TO_CATEGORY),
  LONGMEMEVAL_ABSTENTION_TYPE,
]);

/** Minutes between turns of one session when deriving turn timestamps. */
const TURN_TIMESTAMP_STEP_MS = 60_000;

/**
 * Parse and validate a raw LongMemEval dataset: either the official bare
 * array of question entries or a `{ name, questions }` wrapper naming
 * the dataset. Fail-fast with a named {@link LongMemEvalParseError}.
 *
 * Haystack sessions are merged across entries by id for validation:
 * entries share sessions, and one id must carry the same TURNS
 * everywhere - a content mismatch is a named error rather than a
 * silently doubled note. Dates are assigned per instance upstream, so
 * a date difference between entries is tolerated (first write wins).
 */
export function parseLongMemEvalDataset(raw: unknown): LongMemEvalDataset {
  let entriesRaw: ReadonlyArray<unknown>;
  let name: string | undefined;
  if (Array.isArray(raw)) {
    entriesRaw = raw;
  } else if (
    raw !== null &&
    typeof raw === "object" &&
    Array.isArray((raw as Record<string, unknown>)["questions"])
  ) {
    const wrapper = raw as Record<string, unknown>;
    if (typeof wrapper["name"] === "string" && wrapper["name"].trim() !== "") {
      name = wrapper["name"];
    }
    entriesRaw = wrapper["questions"] as ReadonlyArray<unknown>;
  } else {
    throw new LongMemEvalParseError(
      "LongMemEval dataset must be an array of questions or a { name, questions } object",
    );
  }
  if (entriesRaw.length === 0) {
    throw new LongMemEvalParseError("LongMemEval dataset needs a non-empty questions array");
  }
  const sessions = new Map<
    string,
    { date: string; turns: ReadonlyArray<LongMemEvalTurn>; entry: string }
  >();
  const entries = entriesRaw.map((entry, index) => parseEntry(entry, index, sessions));
  return { ...(name !== undefined ? { name } : {}), entries };
}

/**
 * Read a field under both dataset spellings: the official files spell
 * it `official`, the legacy sample shape `legacy`. Official first; a
 * legacy key is read only when the official one is absent.
 */
function readKey(r: Record<string, unknown>, official: string, legacy: string): unknown {
  const value = r[official];
  return value !== undefined ? value : r[legacy];
}

function parseEntry(
  raw: unknown,
  index: number,
  sessions: Map<string, { date: string; turns: ReadonlyArray<LongMemEvalTurn>; entry: string }>,
): LongMemEvalEntry {
  if (raw === null || typeof raw !== "object") {
    throw new LongMemEvalParseError(`LongMemEval dataset: questions[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const qId = asString(
    readKey(r, "question_id", "q_id"),
    `questions[${index}].question_id (legacy q_id)`,
  );
  const questionType = asString(r["question_type"], `questions[${index}] (${qId}).question_type`);
  if (!(LONGMEMEVAL_QUESTION_TYPES as ReadonlyArray<string>).includes(questionType)) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset: question '${qId}' has an unknown question_type '${questionType}' ` +
        `(expected one of ${LONGMEMEVAL_QUESTION_TYPES.join(", ")})`,
    );
  }
  const abstention = isLongMemEvalAbstention({ q_id: qId, question_type: questionType });
  const question = asString(r["question"], `questions[${index}] (${qId}).question`);
  const answer = answerOf(r["answer"]);

  const sessionIds = stringArray(
    readKey(r, "haystack_session_ids", "haystack_session_id"),
    `questions[${index}] (${qId}).haystack_session_ids (legacy haystack_session_id)`,
    true,
  );
  const sessionsRaw = readKey(r, "haystack_sessions", "haystack_session");
  if (!Array.isArray(sessionsRaw) || sessionsRaw.length !== sessionIds.length) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset: question '${qId}' haystack_sessions (legacy haystack_session) ` +
        `must be an array aligned with haystack_session_ids`,
    );
  }
  const dates = stringArray(
    r["haystack_dates"],
    `questions[${index}] (${qId}).haystack_dates`,
    true,
  );
  if (dates.length !== sessionIds.length) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset: question '${qId}' haystack_dates must be an array aligned with haystack_session_ids`,
    );
  }
  const localIds = new Set<string>();
  sessionIds.forEach((sessionId, j) => {
    localIds.add(sessionId);
    const turns = parseTurns(
      sessionsRaw[j],
      `questions[${index}] (${qId}).haystack_sessions[${j}]`,
    );
    const date = asValidDate(dates[j]!, `questions[${index}] (${qId}).haystack_dates[${j}]`);
    mergeSession(sessions, sessionId, date, turns, qId);
  });

  let gold: ReadonlyArray<string> = [];
  if (!abstention) {
    gold = stringArray(
      r["answer_session_ids"],
      `questions[${index}] (${qId}).answer_session_ids`,
      true,
    );
    if (gold.length === 0) {
      throw new LongMemEvalParseError(
        `LongMemEval dataset: question '${qId}' (${questionType}) needs a non-empty answer_session_ids`,
      );
    }
    for (const id of gold) {
      if (!localIds.has(id)) {
        throw new LongMemEvalParseError(
          `LongMemEval dataset: question '${qId}' references unknown session '${id}'`,
        );
      }
    }
  }
  // The official entries carry question_date; an entry that states none
  // is dated by its last haystack session.
  const questionDateRaw = r["question_date"];
  const questionDate =
    questionDateRaw === undefined
      ? dates[dates.length - 1]!
      : asValidDate(
          asString(questionDateRaw, `questions[${index}] (${qId}).question_date`),
          `questions[${index}] (${qId}).question_date`,
        );
  return {
    q_id: qId,
    question_type: questionType,
    question,
    ...(answer !== undefined ? { answer } : {}),
    question_date: questionDate,
    haystack_session_id: sessionIds,
    haystack_session: sessionIds.map((_, j) =>
      parseTurns(sessionsRaw[j], `haystack_sessions[${j}]`),
    ),
    haystack_dates: dates,
    answer_session_ids: gold,
  };
}

function mergeSession(
  sessions: Map<string, { date: string; turns: ReadonlyArray<LongMemEvalTurn>; entry: string }>,
  sessionId: string,
  date: string,
  turns: ReadonlyArray<LongMemEvalTurn>,
  entryId: string,
): void {
  const existing = sessions.get(sessionId);
  if (existing !== undefined) {
    // Upstream assigns haystack dates PER INSTANCE, so the same session
    // id can legitimately carry a different date in each entry; the
    // first write wins. Only a content mismatch means the dataset is
    // inconsistent - one id whose turns disagree between entries.
    if (JSON.stringify(existing.turns) !== JSON.stringify(turns)) {
      throw new LongMemEvalParseError(
        `LongMemEval dataset: session '${sessionId}' is inconsistent between entries '${existing.entry}' and '${entryId}'`,
      );
    }
    return;
  }
  sessions.set(sessionId, { date, turns, entry: entryId });
}

function parseTurns(raw: unknown, field: string): ReadonlyArray<LongMemEvalTurn> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new LongMemEvalParseError(`LongMemEval dataset: ${field} must be a non-empty turn array`);
  }
  return raw.map((turn, k) => {
    if (turn === null || typeof turn !== "object") {
      throw new LongMemEvalParseError(`LongMemEval dataset: ${field}[${k}] must be an object`);
    }
    const t = turn as Record<string, unknown>;
    return {
      role: asString(t["role"], `${field}[${k}].role`),
      content: asString(t["content"], `${field}[${k}].content`),
    };
  });
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LongMemEvalParseError(`LongMemEval dataset: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse a dataset date into epoch milliseconds, deterministically as
 * UTC. The official dates look like `2023/05/20 (Sat) 02:21`, which
 * JavaScript would read in the host's local zone - so the slash forms
 * are rebuilt as UTC by hand. A naive ISO date-time (no offset) is read
 * as UTC by the same rule, date-only ISO is UTC by spec, and
 * offset-explicit ISO forms parse as stated. Any other shape returns
 * NaN - the caller refuses it by name rather than letting the host
 * zone decide.
 */
function parseDatasetDateMs(value: string): number {
  const trimmed = value.trim();
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+\([^()]*\))?(?:\s+(\d{1,2}):(\d{2}))?$/.exec(
    trimmed,
  );
  if (slash !== null) {
    return Date.UTC(
      Number(slash[1]),
      Number(slash[2]) - 1,
      Number(slash[3]),
      slash[4] !== undefined ? Number(slash[4]) : 0,
      slash[5] !== undefined ? Number(slash[5]) : 0,
    );
  }
  const naiveIso = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    trimmed,
  );
  if (naiveIso !== null) {
    return Date.UTC(
      Number(naiveIso[1]),
      Number(naiveIso[2]) - 1,
      Number(naiveIso[3]),
      Number(naiveIso[4]),
      Number(naiveIso[5]),
      naiveIso[6] !== undefined ? Number(naiveIso[6]) : 0,
      naiveIso[7] !== undefined ? Number(naiveIso[7]) : 0,
    );
  }
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
  ) {
    return Date.parse(trimmed);
  }
  return Number.NaN;
}

function asValidDate(value: string, field: string): string {
  if (Number.isNaN(parseDatasetDateMs(value))) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset: ${field} must be a valid date, got '${value}'`,
    );
  }
  return value;
}

function stringArray(value: unknown, field: string, nonEmpty: boolean): ReadonlyArray<string> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new LongMemEvalParseError(`LongMemEval dataset: ${field} must be an array of strings`);
  }
  if (nonEmpty && value.length === 0) {
    throw new LongMemEvalParseError(`LongMemEval dataset: ${field} must be a non-empty array`);
  }
  return Object.freeze([...value]);
}

/** Sanitize a dataset id into one safe note-path segment. */
function sanitizePathSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * The path scope of one question's evidence: every note, continuity
 * record and expected path of an entry lives under
 * `sessions/<question_id>/`, so one question's haystack never pools
 * with another's. Two distinct question ids that sanitize to the same
 * scope would silently merge haystacks, so that is a named error.
 */
function questionScope(qId: string, claimed: Map<string, string>): string {
  const scope = sanitizePathSegment(qId);
  const owner = claimed.get(scope);
  if (owner !== undefined) {
    throw new LongMemEvalParseError(
      owner === qId
        ? `LongMemEval dataset: question id '${qId}' appears twice`
        : `LongMemEval dataset: question ids '${owner}' and '${qId}' sanitize to the same path scope '${scope}'; their haystacks would merge`,
    );
  }
  claimed.set(scope, qId);
  return scope;
}

/** Vault-relative note path for a session inside its question's scope. */
function sessionNotePath(scope: string, sessionId: string): string {
  return `sessions/${scope}/${sanitizePathSegment(sessionId)}.md`;
}

/**
 * Note body for one scoped session copy. The header names the question
 * scope on purpose: a session shared by several entries materializes
 * once per scope, and bodies that stayed byte-identical would collide
 * in the indexer's content-hash skip - only the first scope's copy
 * would ever index, dangling every other scope's gold path.
 */
function sessionNoteBody(
  scope: string,
  sessionId: string,
  turns: ReadonlyArray<LongMemEvalTurn>,
): string {
  return (
    `# Session ${sessionId} (question ${scope})\n\n` +
    turns.map((t) => `${t.role}: ${t.content}`).join("\n")
  );
}

function turnTimestamp(sessionDate: string, turnIndex: number): string {
  return new Date(
    parseDatasetDateMs(sessionDate) + turnIndex * TURN_TIMESTAMP_STEP_MS,
  ).toISOString();
}

/**
 * The judge reference answer, as the payload may carry it: strings pass
 * through; upstream states some counting answers as numbers, so finite
 * numbers are coerced with String(). Any other non-string type stays
 * refused - an answer that cannot be a string is dropped, never guessed.
 */
function answerOf(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Convert a parsed LongMemEval dataset into an OSB {@link BenchFixture}
 * plus its receipt. Each entry's evidence is namespaced under its own
 * question's subtree - its sessions become evidence notes and
 * session_turn continuity records at `sessions/<question_id>/...` - and
 * every non-abstention question becomes a retrieval question whose
 * expected_paths point at its gold session notes inside that same
 * subtree and whose top_k is the {@link LONGMEMEVAL_RECALL_CUTOFF}.
 * Abstention entries are excluded with the count recorded.
 *
 * Scoping is what keeps the suite's task like-for-like: LongMemEval
 * scores every question against ITS OWN haystack (~50 sessions), so
 * evidence pooled across entries would have every query search the
 * union of all haystacks. A session shared by several entries is
 * materialized once per scope - the trade is cross-entry note dedupe
 * for per-question isolation, which is what the metric scores.
 */
export function longMemEvalToBenchFixture(dataset: LongMemEvalDataset): LongMemEvalConversion {
  let abstentionExcluded = 0;
  const notes: BenchFixtureNote[] = [];
  const continuity: BenchFixtureContinuity[] = [];
  const questions: BenchQuestion[] = [];
  const claimedScopes = new Map<string, string>();
  for (const entry of dataset.entries) {
    if (isLongMemEvalAbstention(entry)) {
      abstentionExcluded += 1;
      continue;
    }
    const scope = questionScope(entry.q_id, claimedScopes);
    const scopedPaths = new Map<string, string>();
    const claimedInScope = new Map<string, string>();
    entry.haystack_session_id.forEach((sessionId, j) => {
      if (scopedPaths.has(sessionId)) return;
      const path = sessionNotePath(scope, sessionId);
      // Distinct session ids can sanitize to one note path (a/b and
      // a-b); within one scope the evidence of both would silently
      // merge into one note, so the collision is a named parse error.
      const collisionOwner = claimedInScope.get(path);
      if (collisionOwner !== undefined) {
        throw new LongMemEvalParseError(
          `LongMemEval dataset: question '${entry.q_id}' has session ids '${collisionOwner}' and '${sessionId}' ` +
            `that sanitize to the same note path '${path}'; the evidence of both would merge`,
        );
      }
      claimedInScope.set(path, sessionId);
      const turns = entry.haystack_session[j]!;
      const date = entry.haystack_dates[j]!;
      notes.push({ path, body: sessionNoteBody(scope, sessionId, turns) });
      turns.forEach((turn, i) => {
        continuity.push({
          kind: "session_turn" as const,
          created_at: turnTimestamp(date, i),
          payload: {
            question_id: entry.q_id,
            session_id: sessionId,
            role: turn.role,
            text: turn.content,
          },
        });
      });
      scopedPaths.set(sessionId, path);
    });
    questions.push({
      id: entry.q_id,
      category: QUESTION_TYPE_TO_CATEGORY[entry.question_type]!,
      query: entry.question,
      top_k: LONGMEMEVAL_RECALL_CUTOFF,
      expected_paths: entry.answer_session_ids.map((id) => {
        const path = scopedPaths.get(id);
        if (path === undefined) {
          // The parser guarantees gold ids join the entry's own
          // haystack; this names the impossible instead of emitting a
          // dangling path.
          throw new LongMemEvalParseError(
            `LongMemEval dataset: question '${entry.q_id}' references unknown session '${id}'`,
          );
        }
        return path;
      }),
      judge_input: Object.freeze({
        question: entry.question,
        ...(entry.answer !== undefined ? { answer: entry.answer } : {}),
        gold: Object.freeze([...entry.answer_session_ids]),
      }),
    });
  }
  if (questions.length === 0) {
    // A dataset of only abstention entries converts to zero questions,
    // which parseBenchFixture refuses generically; name the real cause -
    // the abstention filter, not a missing dataset.
    throw new LongMemEvalParseError(
      `LongMemEval dataset: every one of the ${abstentionExcluded} question(s) is an abstention entry and was excluded from scoring; nothing remains to evaluate`,
    );
  }
  const fixture = parseBenchFixture({
    name: `longmemeval-${dataset.name ?? "suite"}`,
    description:
      "LongMemEval dataset converted to the OSB bench fixture; each question's haystack is scoped under its own subtree and abstention questions are excluded from scoring.",
    notes,
    continuity,
    questions,
  });
  return { fixture, receipt: { abstention_excluded: abstentionExcluded } };
}

/** Load a LongMemEval dataset file and convert it to a suite load. */
export function loadLongMemEvalFixture(path: string): LongMemEvalConversion {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset not readable JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return longMemEvalToBenchFixture(parseLongMemEvalDataset(raw));
}

/** One persisted retrieval result the strict metric reads. */
export interface RecallAllRetrieved {
  readonly id: string;
  /** Result paths in rank order. */
  readonly paths?: ReadonlyArray<string>;
}

export interface RecallAllScore {
  /** Questions scored: the non-abstention, retrieval-category ones. */
  readonly scored: number;
  /** Questions with EVERY gold session note inside the cutoff. */
  readonly passed: number;
}

/**
 * Strict recall_all@{@link LONGMEMEVAL_RECALL_CUTOFF}: the count of
 * scored questions whose EVERY gold session note ranks inside the
 * cutoff, over the PERSISTED retrieval results. This is the aggregate
 * roll-off of the same containment rule `evaluateQuestion` applies per
 * question - not a second scorer - kept as a named metric because the
 * field reports recall_all@5, the number the memory field compares.
 */
export function scoreLongMemEvalRecall(
  questions: ReadonlyArray<BenchQuestion>,
  retrieved: ReadonlyArray<RecallAllRetrieved>,
): RecallAllScore {
  const byId = new Map(retrieved.map((result) => [result.id, result]));
  let scored = 0;
  let passed = 0;
  for (const question of questions) {
    if (!RETRIEVAL_CATEGORIES.has(question.category)) continue;
    scored += 1;
    const top = new Set((byId.get(question.id)?.paths ?? []).slice(0, LONGMEMEVAL_RECALL_CUTOFF));
    if ((question.expected_paths ?? []).every((path) => top.has(path))) passed += 1;
  }
  return { scored, passed };
}

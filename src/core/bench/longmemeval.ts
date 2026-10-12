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
 * committed sample fixture (`tests/fixtures/bench/longmemeval-sample.json`)
 * certifies CI; the full dataset arrives as an operator-supplied path
 * resolved by the bench verb's literal-then-repo-fixture-dir logic. The
 * official download lives at https://github.com/xiaowu0162/LongMemEval
 * (data / longmemeval_s.py / longmemeval_m.py) - never fetched at run
 * time.
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
  type BenchQuestion,
} from "./types.ts";

/** The suite's registered name in the bench verb's suite registry. */
export const LONGMEMEVAL_SUITE_NAME = "longmemeval";

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

/** The question type whose entries measure abstention and are excluded. */
export const LONGMEMEVAL_ABSTENTION_TYPE = "abstention";

/**
 * The recall cutoff the suite scores at: a question passes retrieval
 * when EVERY gold session note ranks inside the top k. Drives both the
 * converted questions' `top_k` and the strict report metric.
 */
export const LONGMEMEVAL_RECALL_CUTOFF = 5;

/**
 * Official question types -> OSB's canonical retrieval categories. The
 * category is a label for the by-category report; scoring is identical
 * expected_paths containment for all of them. `abstention` maps to
 * nothing: those entries are excluded, never converted.
 */
const QUESTION_TYPE_TO_CATEGORY: Readonly<Record<string, BenchCategory>> = Object.freeze({
  "single-hop": "single_hop",
  "multi-hop": "multi_evidence",
  "temporal-reasoning": "temporal",
  "open-domain": "single_hop",
  "knowledge-update": "contradiction",
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
 * Haystack sessions are merged across entries by id: entries share
 * sessions, and the same id must carry the same session everywhere, so a
 * conflicting duplicate is a named error rather than a silently doubled
 * note.
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

function parseEntry(
  raw: unknown,
  index: number,
  sessions: Map<string, { date: string; turns: ReadonlyArray<LongMemEvalTurn>; entry: string }>,
): LongMemEvalEntry {
  if (raw === null || typeof raw !== "object") {
    throw new LongMemEvalParseError(`LongMemEval dataset: questions[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const qId = asString(r["q_id"], `questions[${index}].q_id`);
  const questionType = asString(r["question_type"], `questions[${index}] (${qId}).question_type`);
  if (!(LONGMEMEVAL_QUESTION_TYPES as ReadonlyArray<string>).includes(questionType)) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset: question '${qId}' has an unknown question_type '${questionType}' ` +
        `(expected one of ${LONGMEMEVAL_QUESTION_TYPES.join(", ")})`,
    );
  }
  const question = asString(r["question"], `questions[${index}] (${qId}).question`);

  const sessionIds = stringArray(
    r["haystack_session_id"],
    `questions[${index}] (${qId}).haystack_session_id`,
    true,
  );
  const sessionsRaw = r["haystack_session"];
  if (!Array.isArray(sessionsRaw) || sessionsRaw.length !== sessionIds.length) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset: question '${qId}' haystack_session must be an array aligned with haystack_session_id`,
    );
  }
  const dates = stringArray(
    r["haystack_dates"],
    `questions[${index}] (${qId}).haystack_dates`,
    true,
  );
  if (dates.length !== sessionIds.length) {
    throw new LongMemEvalParseError(
      `LongMemEval dataset: question '${qId}' haystack_dates must be an array aligned with haystack_session_id`,
    );
  }
  const localIds = new Set<string>();
  sessionIds.forEach((sessionId, j) => {
    localIds.add(sessionId);
    const turns = parseTurns(sessionsRaw[j], `questions[${index}] (${qId}).haystack_session[${j}]`);
    const date = asValidDate(dates[j]!, `questions[${index}] (${qId}).haystack_dates[${j}]`);
    mergeSession(sessions, sessionId, date, turns, qId);
  });

  let gold: ReadonlyArray<string> = [];
  if (questionType !== LONGMEMEVAL_ABSTENTION_TYPE) {
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
  return {
    q_id: qId,
    question_type: questionType,
    question,
    ...(typeof r["answer"] === "string" && r["answer"] !== "" ? { answer: r["answer"] } : {}),
    haystack_session_id: sessionIds,
    haystack_session: sessionIds.map((_, j) =>
      parseTurns(sessionsRaw[j], `haystack_session[${j}]`),
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
    if (existing.date !== date || JSON.stringify(existing.turns) !== JSON.stringify(turns)) {
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

function asValidDate(value: string, field: string): string {
  if (Number.isNaN(new Date(value).getTime())) {
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

/** Vault-relative note path for a session; sanitized only here. */
function sessionNotePath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `sessions/${safe}.md`;
}

function sessionNoteBody(sessionId: string, turns: ReadonlyArray<LongMemEvalTurn>): string {
  return `# Session ${sessionId}\n\n` + turns.map((t) => `${t.role}: ${t.content}`).join("\n");
}

function turnTimestamp(sessionDate: string, turnIndex: number): string {
  return new Date(
    new Date(sessionDate).getTime() + turnIndex * TURN_TIMESTAMP_STEP_MS,
  ).toISOString();
}

/**
 * Convert a parsed LongMemEval dataset into an OSB {@link BenchFixture}
 * plus its receipt. Sessions become evidence notes and session_turn
 * continuity records; every non-abstention question becomes a retrieval
 * question whose expected_paths point at its gold session notes and
 * whose top_k is the {@link LONGMEMEVAL_RECALL_CUTOFF}. Abstention
 * entries are excluded with the count recorded.
 */
export function longMemEvalToBenchFixture(dataset: LongMemEvalDataset): LongMemEvalConversion {
  const sessions = new Map<string, { date: string; turns: ReadonlyArray<LongMemEvalTurn> }>();
  for (const entry of dataset.entries) {
    entry.haystack_session_id.forEach((sessionId, j) => {
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          date: entry.haystack_dates[j]!,
          turns: entry.haystack_session[j]!,
        });
      }
    });
  }
  const orderedIds = [...sessions.keys()].toSorted();
  const notes = orderedIds.map((id) => ({
    path: sessionNotePath(id),
    body: sessionNoteBody(id, sessions.get(id)!.turns),
  }));
  const continuity = orderedIds.flatMap((id) => {
    const session = sessions.get(id)!;
    return session.turns.map((turn, i) => ({
      kind: "session_turn" as const,
      created_at: turnTimestamp(session.date, i),
      payload: { session_id: id, role: turn.role, text: turn.content },
    }));
  });
  let abstentionExcluded = 0;
  const questions: BenchQuestion[] = [];
  for (const entry of dataset.entries) {
    if (entry.question_type === LONGMEMEVAL_ABSTENTION_TYPE) {
      abstentionExcluded += 1;
      continue;
    }
    questions.push({
      id: entry.q_id,
      category: QUESTION_TYPE_TO_CATEGORY[entry.question_type]!,
      query: entry.question,
      top_k: LONGMEMEVAL_RECALL_CUTOFF,
      expected_paths: entry.answer_session_ids.map(sessionNotePath),
    });
  }
  const fixture = parseBenchFixture({
    name: `longmemeval-${dataset.name ?? "suite"}`,
    description:
      "LongMemEval dataset converted to the OSB bench fixture; abstention questions are excluded from scoring.",
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

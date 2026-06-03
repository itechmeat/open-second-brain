/**
 * Bench fixture loading, validation, hashing, and materialization
 * (Memory Observability Suite, t_882c396a).
 *
 * Fixtures are repo-local JSON documents. Validation fails fast with
 * named errors (mutation posture); materialization writes ONLY into
 * the caller-supplied disposable directory - note paths are checked
 * against traversal and absolutes at parse time.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { appendContinuityRecord } from "../brain/continuity/store.ts";
import {
  BENCH_CATEGORIES,
  type BenchCategory,
  type BenchFixture,
  type BenchFixtureContinuity,
  type BenchFixtureNote,
  type BenchQuestion,
  RETRIEVAL_CATEGORIES,
} from "./types.ts";

/** Parse and validate a raw fixture document. Throws named errors. */
export function parseBenchFixture(raw: unknown): BenchFixture {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("bench fixture: expected a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const name = nonEmptyString(record["name"]);
  if (name === undefined) throw new Error("bench fixture: missing or empty name");
  const description = nonEmptyString(record["description"]);

  const notesRaw = record["notes"];
  if (!Array.isArray(notesRaw) || notesRaw.length === 0) {
    throw new Error("bench fixture: notes must be a non-empty array");
  }
  const notes = notesRaw.map(parseNote);

  const continuityRaw = record["continuity"];
  const continuity =
    continuityRaw === undefined
      ? []
      : Array.isArray(continuityRaw)
        ? continuityRaw.map(parseContinuity)
        : (() => {
            throw new Error("bench fixture: continuity must be an array");
          })();

  const questionsRaw = record["questions"];
  if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) {
    throw new Error("bench fixture: at least one question is required");
  }
  const questions = questionsRaw.map(parseQuestion);
  const ids = new Set(questions.map((question) => question.id));
  if (ids.size !== questions.length) {
    throw new Error("bench fixture: question ids must be unique");
  }

  return Object.freeze({
    name,
    ...(description !== undefined ? { description } : {}),
    notes: Object.freeze(notes),
    continuity: Object.freeze(continuity),
    questions: Object.freeze(questions),
  });
}

/** Load a fixture from a JSON file. Fail-fast on unreadable or broken input. */
export function loadBenchFixture(path: string): BenchFixture {
  return parseBenchFixture(JSON.parse(readFileSync(path, "utf8")));
}

/** Canonical content hash - stable across key order, sensitive to content. */
export function fixtureHash(fixture: BenchFixture): string {
  return createHash("sha256").update(canonicalJson(fixture)).digest("hex").slice(0, 16);
}

/** Write the fixture's notes and continuity records into a disposable vault. */
export function materializeBenchVault(fixture: BenchFixture, vaultDir: string): void {
  mkdirSync(join(vaultDir, "Brain"), { recursive: true });
  for (const note of fixture.notes) {
    const target = join(vaultDir, note.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, note.body, "utf8");
  }
  for (const record of fixture.continuity) {
    appendContinuityRecord(vaultDir, {
      kind: record.kind,
      createdAt: record.created_at,
      payload: record.payload,
    });
  }
}

function parseNote(raw: unknown, index: number): BenchFixtureNote {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`bench fixture: note ${index} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const path = nonEmptyString(record["path"]);
  const body = typeof record["body"] === "string" ? record["body"] : undefined;
  if (path === undefined || body === undefined) {
    throw new Error(`bench fixture: note ${index} needs path and body`);
  }
  if (isAbsolute(path) || normalize(path).split(/[\\/]/).includes("..")) {
    throw new Error(`bench fixture: note path escapes the vault: ${path}`);
  }
  return Object.freeze({ path, body });
}

function parseContinuity(raw: unknown, index: number): BenchFixtureContinuity {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`bench fixture: continuity ${index} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  if (record["kind"] !== "session_turn") {
    throw new Error(`bench fixture: continuity ${index} kind must be session_turn`);
  }
  const createdAt = nonEmptyString(record["created_at"]);
  const payload = record["payload"];
  if (createdAt === undefined || payload === null || typeof payload !== "object") {
    throw new Error(`bench fixture: continuity ${index} needs created_at and payload`);
  }
  return Object.freeze({
    kind: "session_turn",
    created_at: createdAt,
    payload: Object.freeze({ ...(payload as Record<string, unknown>) }),
  });
}

function parseQuestion(raw: unknown, index: number): BenchQuestion {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`bench fixture: question ${index} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = nonEmptyString(record["id"]);
  if (id === undefined) throw new Error(`bench fixture: question ${index} needs an id`);
  const category = nonEmptyString(record["category"]);
  if (category === undefined || !isBenchCategory(category)) {
    throw new Error(
      `bench fixture: question ${id} has an unknown category (expected one of ${BENCH_CATEGORIES.join(", ")})`,
    );
  }
  const question: BenchQuestion = Object.freeze({
    id,
    category,
    ...(nonEmptyString(record["query"]) !== undefined
      ? { query: nonEmptyString(record["query"]) }
      : {}),
    ...(positiveInt(record["top_k"]) !== undefined ? { top_k: positiveInt(record["top_k"]) } : {}),
    ...(stringArray(record["expected_paths"]) !== undefined
      ? { expected_paths: stringArray(record["expected_paths"]) }
      : {}),
    ...(stringArray(record["not_expected_above"]) !== undefined
      ? { not_expected_above: stringArray(record["not_expected_above"]) }
      : {}),
    ...(nonEmptyString(record["session_id"]) !== undefined
      ? { session_id: nonEmptyString(record["session_id"]) }
      : {}),
    ...(positiveInt(record["expected_turns"]) !== undefined
      ? { expected_turns: positiveInt(record["expected_turns"]) }
      : {}),
    ...(nonEmptyString(record["expected_text"]) !== undefined
      ? { expected_text: nonEmptyString(record["expected_text"]) }
      : {}),
    ...(stringArray(record["expected_ids"]) !== undefined
      ? { expected_ids: stringArray(record["expected_ids"]) }
      : {}),
    ...(positiveInt(record["max_tokens"]) !== undefined
      ? { max_tokens: positiveInt(record["max_tokens"]) }
      : {}),
    ...(positiveInt(record["max_total_chars"]) !== undefined
      ? { max_total_chars: positiveInt(record["max_total_chars"]) }
      : {}),
  });
  validateQuestionShape(question);
  return question;
}

function validateQuestionShape(question: BenchQuestion): void {
  if (RETRIEVAL_CATEGORIES.has(question.category)) {
    if (question.query === undefined || (question.expected_paths ?? []).length === 0) {
      throw new Error(
        `bench fixture: question ${question.id} (${question.category}) needs query and expected_paths`,
      );
    }
  }
  if (question.category === "session_handoff" && question.session_id === undefined) {
    throw new Error(`bench fixture: question ${question.id} needs session_id`);
  }
  if (question.category === "budget" && (question.expected_ids ?? []).length === 0) {
    throw new Error(`bench fixture: question ${question.id} needs expected_ids`);
  }
}

function isBenchCategory(value: string): value is BenchCategory {
  return (BENCH_CATEGORIES as ReadonlyArray<string>).includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string" && item.length > 0)) return undefined;
  return Object.freeze([...value]);
}

/** JSON with recursively sorted object keys - the canonical hash input. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Surfacing-replay fixture loader (t_107a3249, lane C).
 *
 * The replay bench replays a RECORDED prompt sequence through the
 * decision core and judges each surfacing decision. Recorded
 * `gate_telemetry` decisions are never re-executed - that record
 * deliberately stores only a prompt hash, so replay always re-decides
 * from source prompts. This module owns the two ways source prompts
 * enter the suite, both PURE and deterministic:
 *
 *  1. a committed session-shaped JSON fixture (the locomo pattern:
 *     deterministic, network-free, reviewable in the diff), and
 *  2. a vault's own `session_turn` records converted into the same
 *     shape, giving regression proof against real sessions without
 *     committing raw prompts into the repository.
 *
 * Only (1) is wired to the suite's CLI entry this wave:
 * `--suite surfacing-replay` accepts a committed fixture file, and (2)
 * ships as the pure conversion (`sessionTurnsToReplayFixture`) with no
 * flag behind it yet - a recorded-session adapter, not a live vault
 * reader.
 *
 * The expected-outcome vocabulary is CLOSED (`inject` | `abstain`): the
 * scorer denominates false fires and silent misses in exactly that
 * boolean, and an expectation the vocabulary cannot name is a named
 * rejection - never a defaulted expectation, which would silently
 * manufacture the number being measured.
 */

import { readFileSync } from "node:fs";

import type { ContinuityRecord } from "../brain/continuity/types.ts";

/** What memory SHOULD do for one recorded prompt. Closed on purpose. */
export const REPLAY_EXPECTATION = Object.freeze({
  /** Memory should speak up for this prompt. */
  inject: "inject",
  /** Memory should stay quiet - weak match, nothing to add, or a non-prompt. */
  abstain: "abstain",
} as const);

/** Closed union over {@link REPLAY_EXPECTATION}. */
export type ReplayExpectation = (typeof REPLAY_EXPECTATION)[keyof typeof REPLAY_EXPECTATION];

/** Membership list; every surface renders its vocabulary from this array. */
export const REPLAY_EXPECTATIONS: ReadonlyArray<ReplayExpectation> = Object.freeze([
  REPLAY_EXPECTATION.inject,
  REPLAY_EXPECTATION.abstain,
]);

/** Narrow a value read back off disk or across a tool boundary. */
export function isReplayExpectation(value: unknown): value is ReplayExpectation {
  return (
    typeof value === "string" && (REPLAY_EXPECTATIONS as ReadonlyArray<string>).includes(value)
  );
}

/** One recorded prompt, in session order, with its expected outcome. */
export interface ReplayPrompt {
  readonly id: string;
  /** The recorded prompt text, verbatim. */
  readonly text: string;
  /**
   * The immediately preceding prompt's text in the sequence, or null for
   * the first turn - the input duplicate detection reads.
   */
  readonly previousText: string | null;
  /** The expectation, loaded into the boolean the scorer denominates in. */
  readonly expectInject: boolean;
}

/** An ordered replay session: corpus notes plus the prompt sequence. */
export interface ReplayFixture {
  readonly name: string;
  readonly description?: string;
  /**
   * The memory content the prompts are judged against. Empty is valid: a
   * session of purely structural prompts has nothing to say about them.
   */
  readonly notes: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly prompts: ReadonlyArray<ReplayPrompt>;
}

/** Typed rejection for a malformed replay fixture or record conversion. */
export class ReplayFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFixtureError";
  }
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReplayFixtureError(`replay fixture: ${field} must be a non-empty string`);
  }
  return value;
}

function parseTurn(raw: unknown, where: string, previousText: string | null): ReplayPrompt {
  if (raw === null || typeof raw !== "object") {
    throw new ReplayFixtureError(`replay fixture: ${where} must be an object`);
  }
  const t = raw as Record<string, unknown>;
  const id = asString(t["id"], `${where}.id`);
  if (typeof t["text"] !== "string") {
    throw new ReplayFixtureError(`replay fixture: turn '${id}'.text must be a string`);
  }
  if (!isReplayExpectation(t["expect"])) {
    throw new ReplayFixtureError(
      `replay fixture: turn '${id}'.expect must be one of ${REPLAY_EXPECTATIONS.join(", ")}` +
        (t["expect"] === undefined ? "" : `; got '${String(t["expect"])}'`),
    );
  }
  return {
    id,
    text: t["text"],
    previousText,
    expectInject: t["expect"] === REPLAY_EXPECTATION.inject,
  };
}

/**
 * Parse and validate a raw session-shaped replay fixture.
 *
 * The suite-qualified name is applied HERE, at the one entry point raw
 * input flows through, so every downstream consumer (the bench converter,
 * the loader) reports the same `surfacing-replay-` prefixed name without
 * each having to remember the prefix - and without a conversion path ever
 * emitting a bare name that the run store would file under the wrong
 * suite.
 */
export function parseReplayFixture(raw: unknown): ReplayFixture {
  if (raw === null || typeof raw !== "object") {
    throw new ReplayFixtureError("replay fixture must be an object");
  }
  const r = raw as Record<string, unknown>;
  const name = asString(r["name"], "name");
  if (!Array.isArray(r["turns"]) || r["turns"].length === 0) {
    throw new ReplayFixtureError(`replay fixture '${name}' needs a non-empty \`turns\` array`);
  }
  if (r["notes"] !== undefined && !Array.isArray(r["notes"])) {
    throw new ReplayFixtureError(`replay fixture '${name}'.notes must be an array when present`);
  }
  const notes = (r["notes"] ?? []).map((n, i) => {
    if (n === null || typeof n !== "object") {
      throw new ReplayFixtureError(`replay fixture: notes[${i}] must be an object`);
    }
    const nd = n as Record<string, unknown>;
    return {
      path: asString(nd["path"], `notes[${i}].path`),
      body: asString(nd["body"], `notes[${i}].body`),
    };
  });
  const prompts: ReplayPrompt[] = [];
  const seen = new Set<string>();
  for (const [i, rawTurn] of r["turns"].entries()) {
    const previous = prompts.length > 0 ? (prompts[prompts.length - 1]?.text ?? null) : null;
    const turn = parseTurn(rawTurn, `turns[${i}]`, previous);
    if (seen.has(turn.id)) {
      throw new ReplayFixtureError(`replay fixture '${name}': duplicate turn id '${turn.id}'`);
    }
    seen.add(turn.id);
    prompts.push(turn);
  }
  return withSuiteName({
    name,
    ...(typeof r["description"] === "string" ? { description: r["description"] } : {}),
    notes,
    prompts,
  });
}

/** Load a committed replay fixture file, named `surfacing-replay-<name>`. */
export function loadReplayFixture(path: string): ReplayFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ReplayFixtureError(
      `replay fixture not readable JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // `parseReplayFixture` applies the suite-qualified name; loading adds
  // nothing but the file read.
  return parseReplayFixture(raw);
}

/** The suite-qualified fixture name every replay entry point reports. */
function withSuiteName(fixture: ReplayFixture): ReplayFixture {
  return { ...fixture, name: `surfacing-replay-${fixture.name}` };
}

/** Input to the vault-record conversion. */
export interface SessionTurnsToReplayInput {
  readonly name: string;
  /** `session_turn` records, in any order; the conversion orders them. */
  readonly records: ReadonlyArray<ContinuityRecord>;
  /**
   * Expected outcome per turn, keyed by record id. Every replayed turn
   * (every `role === "user"` record) needs one - a turn without a
   * declared expectation is a rejection, because a defaulted expectation
   * would silently manufacture the score. Assistant turns are not
   * replayed and declare none.
   */
  readonly expectations: Readonly<Record<string, unknown>>;
}

/**
 * The role whose turns are prompts. Only `role === "user"` turns are
 * replayed: an assistant turn is not something memory is asked to speak
 * on, and replaying it as a prompt would score a decision nobody makes.
 */
const USER_TURN_ROLE = "user";

/**
 * The conversation instant a turn is ordered by: the turn's
 * `payload.timestamp` when the record carries one, else the record
 * `createdAt` - the same precedence the shipped session-recall reader
 * orders by (`compareRecords`, `src/core/brain/session-recall.ts`).
 * `createdAt` is import time; one import writes a whole session at once,
 * so ordering by it alone can name the wrong turn as "the prompt before".
 */
function turnInstant(record: ContinuityRecord): string {
  return String(record.payload["timestamp"] ?? record.createdAt);
}

/**
 * Convert a vault's `session_turn` records into the committed fixture's
 * shape. Two normalizations make the replay follow the conversation
 * rather than the import:
 *
 *  - ORDER is the conversation's: {@link turnInstant} - the turn's
 *    `payload.timestamp`, falling back to `createdAt` - then record id,
 *    then the caller's array order, all three stable and recomputable.
 *  - ROLE: only {@link USER_TURN_ROLE} turns become prompts, so the
 *    previous-prompt chain (what duplicate detection reads) is a chain
 *    of user prompts.
 *
 * Expectations are required exactly for the turns that are replayed; an
 * assistant turn declares none and silently drops out of the sequence.
 */
export function sessionTurnsToReplayFixture(input: SessionTurnsToReplayInput): ReplayFixture {
  const ordered = input.records
    .map((record, index) => ({ record, index }))
    .toSorted(
      (a, b) =>
        turnInstant(a.record).localeCompare(turnInstant(b.record)) ||
        a.record.id.localeCompare(b.record.id) ||
        a.index - b.index,
    );
  const prompts: ReplayPrompt[] = [];
  for (const { record } of ordered) {
    if (record.kind !== "session_turn") {
      throw new ReplayFixtureError(
        `replay fixture '${input.name}': turn '${record.id}' has kind '${record.kind}', expected session_turn`,
      );
    }
    if (record.payload["role"] !== USER_TURN_ROLE) continue;
    const rawExpectation = input.expectations[record.id];
    if (!isReplayExpectation(rawExpectation)) {
      throw new ReplayFixtureError(
        `replay fixture '${input.name}': turn '${record.id}' needs an expectation from ` +
          `${REPLAY_EXPECTATIONS.join(", ")}` +
          (rawExpectation === undefined ? "" : `; got '${String(rawExpectation)}'`),
      );
    }
    const text = record.payload["text"];
    if (typeof text !== "string") {
      throw new ReplayFixtureError(
        `replay fixture '${input.name}': turn '${record.id}' has no text payload to replay`,
      );
    }
    prompts.push({
      id: record.id,
      text,
      previousText: prompts.length > 0 ? (prompts[prompts.length - 1]?.text ?? null) : null,
      expectInject: rawExpectation === REPLAY_EXPECTATION.inject,
    });
  }
  if (prompts.length === 0) {
    throw new ReplayFixtureError(
      `replay fixture '${input.name}': no user session_turn records to replay`,
    );
  }
  return withSuiteName({
    name: input.name,
    notes: [],
    prompts,
  });
}

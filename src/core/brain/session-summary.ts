/**
 * Structured session summary (Session Knowledge Synthesis, t_325a7e4a).
 *
 * A session-scoped digest over four canonical categories - request,
 * decisions, learnings, next_steps - stored as one append-only
 * continuity record (`kind: "session_summary_digest"`). This is
 * distinct from `session_summary_node` (a hierarchical recall rollup of
 * turns) and from `pre_compact_extract` (per-line labelled extracts):
 * the digest answers "what was the request, what did we decide, what
 * did we learn, what is next" for a whole session as a single unit.
 *
 * Provider-agnostic by construction: the agent supplies the already-
 * extracted categories; this module only validates shape, dedupes by
 * content hash, and appends. The kernel never parses prose into
 * categories with a natural-language word list - that would break the
 * language-agnostic guarantee. Absent agent extraction, no digest is
 * written (no fabricated empty summary).
 */

import { createHash } from "node:crypto";

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord, ContinuitySourceRef } from "./continuity/types.ts";

export class SessionSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSummaryError";
  }
}

export interface SessionSummaryInput {
  readonly sessionId: string;
  /** One-line statement of what the session set out to do. */
  readonly request?: string;
  readonly decisions?: ReadonlyArray<string>;
  readonly learnings?: ReadonlyArray<string>;
  readonly nextSteps?: ReadonlyArray<string>;
  /** Originating runtime (claude, codex, ...); recorded when present. */
  readonly host?: string;
  /** Turn ids the digest was distilled from; recorded as lineage edges. */
  readonly sourceTurnIds?: ReadonlyArray<string>;
  readonly createdAt?: string;
}

export interface SessionSummaryDigest {
  readonly id: string;
  readonly sessionId: string;
  readonly request: string | null;
  readonly decisions: ReadonlyArray<string>;
  readonly learnings: ReadonlyArray<string>;
  readonly nextSteps: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly host?: string;
}

const KIND = "session_summary_digest";

/**
 * Validate the agent-supplied categories, dedupe by content hash, and
 * append one digest record. Throws {@link SessionSummaryError} when
 * every category is empty - an empty digest is never written.
 */
export function appendSessionSummary(
  vault: string,
  input: SessionSummaryInput,
): SessionSummaryDigest {
  const sessionId = input.sessionId.trim();
  if (sessionId.length === 0) {
    throw new SessionSummaryError("session summary requires a non-empty session id");
  }
  const request = normalizeLine(input.request);
  const decisions = normalizeList(input.decisions);
  const learnings = normalizeList(input.learnings);
  const nextSteps = normalizeList(input.nextSteps);

  if (
    request === null &&
    decisions.length === 0 &&
    learnings.length === 0 &&
    nextSteps.length === 0
  ) {
    throw new SessionSummaryError(
      "session summary requires at least one of request, decisions, learnings, or next_steps",
    );
  }

  const host = input.host?.trim();
  const contentHash = hash(JSON.stringify([request ?? "", decisions, learnings, nextSteps]));
  const dedupeKey = [KIND, sessionId, contentHash].join(":");

  const existing = findByDedupeKey(vault, dedupeKey);
  if (existing !== null) return toDigest(existing);

  const createdAt = input.createdAt ?? new Date().toISOString();
  const record = appendContinuityRecord(vault, {
    kind: KIND,
    createdAt,
    sourceRefs: buildSourceRefs(sessionId, input.sourceTurnIds),
    payload: {
      session_id: sessionId,
      ...(request !== null ? { request } : {}),
      decisions,
      learnings,
      next_steps: nextSteps,
      ...(host !== undefined && host.length > 0 ? { host } : {}),
      content_hash: contentHash,
      dedupe_key: dedupeKey,
    },
  });
  return toDigest(record);
}

/** Latest digest for a session, or null when none was ever written. */
export function getSessionSummary(vault: string, sessionId: string): SessionSummaryDigest | null {
  const id = sessionId.trim();
  const records = sessionDigestRecords(vault).filter(
    (record) => String(record.payload["session_id"] ?? "") === id,
  );
  if (records.length === 0) return null;
  return toDigest(records[records.length - 1]!);
}

export interface ListSessionSummariesOptions {
  readonly sessionId?: string;
}

/** All digests, oldest first; optionally scoped to one session. */
export function listSessionSummaries(
  vault: string,
  opts: ListSessionSummariesOptions = {},
): ReadonlyArray<SessionSummaryDigest> {
  const scope = opts.sessionId?.trim();
  return Object.freeze(
    sessionDigestRecords(vault)
      .filter(
        (record) => scope === undefined || String(record.payload["session_id"] ?? "") === scope,
      )
      .map(toDigest),
  );
}

function sessionDigestRecords(vault: string): ReadonlyArray<ContinuityRecord> {
  return listContinuityRecords(vault, { kind: KIND }).toSorted((left, right) =>
    compareByCreatedThenId(left, right),
  );
}

function compareByCreatedThenId(left: ContinuityRecord, right: ContinuityRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildSourceRefs(
  sessionId: string,
  turnIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<ContinuitySourceRef> {
  const refs: ContinuitySourceRef[] = [Object.freeze({ kind: "session", id: sessionId })];
  for (const turnId of turnIds ?? []) {
    const id = turnId.trim();
    if (id.length > 0) refs.push(Object.freeze({ kind: "session_turn", id }));
  }
  return Object.freeze(refs);
}

function toDigest(record: ContinuityRecord): SessionSummaryDigest {
  const payload = record.payload;
  const host = typeof payload["host"] === "string" ? (payload["host"] as string) : undefined;
  return Object.freeze({
    id: record.id,
    sessionId: String(payload["session_id"] ?? ""),
    request: typeof payload["request"] === "string" ? (payload["request"] as string) : null,
    decisions: readList(payload["decisions"]),
    learnings: readList(payload["learnings"]),
    nextSteps: readList(payload["next_steps"]),
    createdAt: record.createdAt,
    ...(host !== undefined ? { host } : {}),
  });
}

function findByDedupeKey(vault: string, dedupeKey: string): ContinuityRecord | null {
  return (
    listContinuityRecords(vault, { kind: KIND }).find(
      (record) => record.payload["dedupe_key"] === dedupeKey,
    ) ?? null
  );
}

function normalizeLine(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeList(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  if (values === undefined) return Object.freeze([]);
  return Object.freeze(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function readList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter((item): item is string => typeof item === "string"));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

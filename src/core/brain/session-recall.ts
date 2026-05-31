import { createHash } from "node:crypto";

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord, ContinuitySourceRef } from "./continuity/types.ts";
import type { SessionTurn } from "./sessions/types.ts";

export interface ImportSessionRecallInput {
  readonly sessionId: string;
  readonly turns: ReadonlyArray<SessionTurn>;
  readonly createdAt?: string;
  readonly summaryGroupSize?: number;
}

export interface ImportSessionRecallResult {
  readonly rawTurns: ReadonlyArray<ContinuityRecord>;
  readonly summaryNodes: ReadonlyArray<ContinuityRecord>;
}

export interface SessionRecallSearchInput {
  readonly query: string;
  readonly sessionId?: string;
  readonly limit?: number;
  readonly snippetChars?: number;
}

export interface SessionRecallHit {
  readonly id: string;
  readonly kind: "session_turn" | "session_summary_node";
  readonly score: number;
  readonly snippet: string;
  readonly turn_id?: string;
  readonly role?: string;
  readonly depth?: number;
  readonly source_record_ids?: ReadonlyArray<string>;
}

export interface SessionRecallSearchResult {
  readonly hits: ReadonlyArray<SessionRecallHit>;
}

export interface DescribeSessionRecallInput {
  readonly sessionId: string;
}

export interface DescribeSessionRecallResult {
  readonly session_id: string;
  readonly raw_turns: number;
  readonly summary_nodes: number;
  readonly depths: Readonly<Record<string, number>>;
}

export interface ExpandSessionRecallInput {
  readonly id: string;
  readonly rawLimit?: number;
  readonly cursor?: string;
}

export interface ExpandedRawTurn {
  readonly id: string;
  readonly turn_id: string;
  readonly role: string;
  readonly timestamp: string;
  readonly text: string;
}

export interface ExpandSessionRecallResult {
  readonly record: ContinuityRecord;
  readonly immediate_sources: ReadonlyArray<ContinuityRecord>;
  readonly raw_content: ReadonlyArray<ExpandedRawTurn>;
  readonly next_cursor: string | null;
}

const DEFAULT_GROUP_SIZE = 8;
const DEFAULT_LIMIT = 10;
const DEFAULT_SNIPPET_CHARS = 160;

export function importSessionRecall(
  vault: string,
  input: ImportSessionRecallInput,
): ImportSessionRecallResult {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rawTurns = input.turns.map((turn) =>
    importRawTurn(vault, input.sessionId, turn, createdAt),
  );
  const summaryNodes = [
    ...importSummaryDepth(
      vault,
      input.sessionId,
      rawTurns,
      1,
      input.summaryGroupSize ?? DEFAULT_GROUP_SIZE,
      createdAt,
    ),
  ];
  summaryNodes.push(
    ...importSummaryDepth(
      vault,
      input.sessionId,
      summaryNodes,
      2,
      input.summaryGroupSize ?? DEFAULT_GROUP_SIZE,
      createdAt,
    ),
  );
  return Object.freeze({
    rawTurns: Object.freeze(rawTurns),
    summaryNodes: Object.freeze(summaryNodes),
  });
}

export function searchSessionRecall(
  vault: string,
  input: SessionRecallSearchInput,
): SessionRecallSearchResult {
  const needle = input.query.trim().toLowerCase();
  if (needle.length === 0) return Object.freeze({ hits: Object.freeze([]) });
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const snippetChars = Math.max(1, input.snippetChars ?? DEFAULT_SNIPPET_CHARS);
  const hits = sessionRecallRecords(vault, input.sessionId)
    .map((record) => hitFor(record, needle, snippetChars))
    .filter((hit): hit is SessionRecallHit => hit !== null)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  return Object.freeze({ hits: Object.freeze(hits) });
}

export function describeSessionRecall(
  vault: string,
  input: DescribeSessionRecallInput,
): DescribeSessionRecallResult {
  const records = sessionRecallRecords(vault, input.sessionId);
  const rawTurns = records.filter((record) => record.kind === "session_turn");
  const summaries = records.filter((record) => record.kind === "session_summary_node");
  const depths: Record<string, number> = {};
  for (const summary of summaries) {
    const depth = String(summary.payload["depth"] ?? "unknown");
    depths[depth] = (depths[depth] ?? 0) + 1;
  }
  return Object.freeze({
    session_id: input.sessionId,
    raw_turns: rawTurns.length,
    summary_nodes: summaries.length,
    depths: Object.freeze(depths),
  });
}

export function expandSessionRecall(
  vault: string,
  input: ExpandSessionRecallInput,
): ExpandSessionRecallResult {
  const records = sessionRecallRecords(vault);
  const byId = new Map(records.map((record) => [record.id, record]));
  const record = byId.get(input.id);
  if (record === undefined) throw new Error(`session recall record not found: ${input.id}`);
  const immediate = sourceRecordIds(record)
    .map((id) => byId.get(id))
    .filter((source): source is ContinuityRecord => source !== undefined);
  const rawRecords = collectRawRecords(record, byId);
  const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
  const limit = Math.max(1, input.rawLimit ?? DEFAULT_LIMIT);
  const page = rawRecords.slice(offset, offset + limit).map(expandedRawTurn);
  const nextOffset = offset + limit;
  return Object.freeze({
    record,
    immediate_sources: Object.freeze(immediate),
    raw_content: Object.freeze(page),
    next_cursor: nextOffset < rawRecords.length ? String(nextOffset) : null,
  });
}

function importRawTurn(
  vault: string,
  sessionId: string,
  turn: SessionTurn,
  createdAt: string,
): ContinuityRecord {
  const text = turn.text ?? "";
  const textHash = hash(text);
  const dedupeKey = ["session_turn", sessionId, turn.turnId, textHash].join(":");
  const existing = findByDedupeKey(vault, dedupeKey);
  if (existing !== null) return existing;
  return appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt,
    sourceRefs: sourceRefs(sessionId, turn.turnId),
    payload: {
      session_id: sessionId,
      turn_id: turn.turnId,
      timestamp: turn.timestamp,
      role: turn.role,
      text,
      text_hash: textHash,
      dedupe_key: dedupeKey,
    },
  });
}

function importSummaryDepth(
  vault: string,
  sessionId: string,
  sources: ReadonlyArray<ContinuityRecord>,
  depth: number,
  groupSize: number,
  createdAt: string,
): ContinuityRecord[] {
  if (sources.length === 0) return [];
  const nodes: ContinuityRecord[] = [];
  const size = Math.max(1, groupSize);
  for (let index = 0; index < sources.length; index += size) {
    const group = sources.slice(index, index + size);
    if (depth > 1 && group.length < 2) continue;
    const sourceIds = group.map((record) => record.id);
    const sourceTurnIds = collectTurnIds(group);
    const summary = summarizeGroup(group);
    const dedupeKey = [
      "session_summary_node",
      sessionId,
      depth,
      hash(sourceIds.join("\n")),
      hash(summary),
    ].join(":");
    const existing = findByDedupeKey(vault, dedupeKey);
    if (existing !== null) {
      nodes.push(existing);
      continue;
    }
    nodes.push(
      appendContinuityRecord(vault, {
        kind: "session_summary_node",
        createdAt,
        sourceRefs: sourceIds.map((id) => Object.freeze({ id, kind: "continuity_record" })),
        payload: {
          session_id: sessionId,
          depth,
          summary,
          source_record_ids: sourceIds,
          source_turn_ids: sourceTurnIds,
          text_hash: hash(summary),
          dedupe_key: dedupeKey,
        },
      }),
    );
  }
  return nodes;
}

function sessionRecallRecords(vault: string, sessionId?: string): ContinuityRecord[] {
  return listContinuityRecords(vault)
    .filter(
      (record) =>
        (record.kind === "session_turn" || record.kind === "session_summary_node") &&
        (sessionId === undefined || record.payload["session_id"] === sessionId),
    )
    .sort((left, right) => compareRecords(left, right));
}

function hitFor(
  record: ContinuityRecord,
  needle: string,
  snippetChars: number,
): SessionRecallHit | null {
  const text = recordText(record);
  const haystack = text.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  const score = (record.kind === "session_turn" ? 2 : 1) + occurrenceCount(haystack, needle);
  const base = {
    id: record.id,
    kind: record.kind as "session_turn" | "session_summary_node",
    score,
    snippet: snippet(text, index, snippetChars),
  };
  if (record.kind === "session_turn") {
    return Object.freeze({
      ...base,
      turn_id: String(record.payload["turn_id"] ?? ""),
      role: String(record.payload["role"] ?? ""),
    });
  }
  return Object.freeze({
    ...base,
    depth: numberValue(record.payload["depth"]) ?? 0,
    source_record_ids: sourceRecordIds(record),
  });
}

function collectRawRecords(
  record: ContinuityRecord,
  byId: ReadonlyMap<string, ContinuityRecord>,
): ContinuityRecord[] {
  if (record.kind === "session_turn") return [record];
  const out: ContinuityRecord[] = [];
  for (const id of sourceRecordIds(record)) {
    const source = byId.get(id);
    if (source === undefined) continue;
    out.push(...collectRawRecords(source, byId));
  }
  return out.sort(compareRecords);
}

function expandedRawTurn(record: ContinuityRecord): ExpandedRawTurn {
  return Object.freeze({
    id: record.id,
    turn_id: String(record.payload["turn_id"] ?? ""),
    role: String(record.payload["role"] ?? ""),
    timestamp: String(record.payload["timestamp"] ?? ""),
    text: String(record.payload["text"] ?? ""),
  });
}

function summarizeGroup(records: ReadonlyArray<ContinuityRecord>): string {
  return records.map(summaryLine).join("\n");
}

function summaryLine(record: ContinuityRecord): string {
  if (record.kind === "session_turn") {
    const turnId = String(record.payload["turn_id"] ?? "");
    const role = String(record.payload["role"] ?? "");
    return `${turnId} ${role}: ${oneLine(String(record.payload["text"] ?? ""), 120)}`;
  }
  const depth = String(record.payload["depth"] ?? "");
  return `summary depth ${depth}: ${oneLine(String(record.payload["summary"] ?? ""), 160)}`;
}

function recordText(record: ContinuityRecord): string {
  return String(record.payload[record.kind === "session_turn" ? "text" : "summary"] ?? "");
}

function sourceRefs(sessionId: string, turnId: string): ReadonlyArray<ContinuitySourceRef> {
  return Object.freeze([
    Object.freeze({ id: sessionId, kind: "session" }),
    Object.freeze({ id: turnId, kind: "session_turn" }),
  ]);
}

function sourceRecordIds(record: ContinuityRecord): string[] {
  const raw = record.payload["source_record_ids"];
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

function collectTurnIds(records: ReadonlyArray<ContinuityRecord>): ReadonlyArray<string> {
  return Object.freeze(
    records.flatMap((record) => {
      if (record.kind === "session_turn")
        return [String(record.payload["turn_id"] ?? "")].filter(Boolean);
      const raw = record.payload["source_turn_ids"];
      return Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === "string")
        : [];
    }),
  );
}

function findByDedupeKey(vault: string, dedupeKey: string): ContinuityRecord | null {
  return (
    listContinuityRecords(vault).find((record) => record.payload["dedupe_key"] === dedupeKey) ??
    null
  );
}

function snippet(text: string, index: number, maxChars: number): string {
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, index - half);
  return text.slice(start, start + maxChars);
}

function oneLine(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function occurrenceCount(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function compareRecords(left: ContinuityRecord, right: ContinuityRecord): number {
  const leftTimestamp = String(left.payload["timestamp"] ?? left.createdAt);
  const rightTimestamp = String(right.payload["timestamp"] ?? right.createdAt);
  return leftTimestamp.localeCompare(rightTimestamp) || left.id.localeCompare(right.id);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

import { createHash } from "node:crypto";

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord, ContinuitySourceRef } from "./continuity/types.ts";
import { readLineageLedger } from "./lineage/ledger.ts";
import type { SessionLineage } from "./lineage/types.ts";
import type { SessionTurn } from "./sessions/types.ts";

export interface ImportSessionRecallInput {
  readonly sessionId: string;
  readonly turns: ReadonlyArray<SessionTurn>;
  readonly createdAt?: string;
  readonly summaryGroupSize?: number;
  /**
   * Lineage of the imported segment (continuity-hygiene-freshness
   * suite). Non-flat lineage is stamped onto every imported record so
   * recall can stitch the conversation across compression boundaries.
   */
  readonly lineage?: SessionLineage;
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

export interface SessionLineageSegment {
  readonly session_id: string;
  readonly parent_session_id: string | null;
}

export interface DescribeSessionRecallResult {
  readonly session_id: string;
  readonly raw_turns: number;
  readonly summary_nodes: number;
  readonly depths: Readonly<Record<string, number>>;
  /**
   * Lineage fields, present only when the session is part of a
   * multi-segment compression chain - flat sessions keep the exact
   * pre-lineage result shape.
   */
  readonly lineage_root?: string;
  readonly segments?: ReadonlyArray<SessionLineageSegment>;
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
  const lineage =
    input.lineage !== undefined && input.lineage.source !== "flat" ? input.lineage : undefined;
  const rawTurns = input.turns.map((turn) =>
    importRawTurn(vault, input.sessionId, turn, createdAt, lineage),
  );
  const summaryNodes = [
    ...importSummaryDepth(
      vault,
      input.sessionId,
      rawTurns,
      1,
      input.summaryGroupSize ?? DEFAULT_GROUP_SIZE,
      createdAt,
      lineage,
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
      lineage,
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
    ...lineageDescription(vault, records, input.sessionId),
  });
}

/**
 * Lineage fields for `describeSessionRecall`: present only when the
 * conversation spans more than one segment. Segments are listed in
 * chronological order of their first record, each with its immediate
 * parent so the continuity edge between adjacent segments is explicit.
 */
function lineageDescription(
  vault: string,
  records: ReadonlyArray<ContinuityRecord>,
  sessionId: string,
): { lineage_root?: string; segments?: ReadonlyArray<SessionLineageSegment> } {
  const links = lineageLinks(vault, records);
  const rootId = transitiveRootOf(sessionId, links);
  const seen = new Set<string>();
  const segments: SessionLineageSegment[] = [];
  for (const record of records) {
    const sid = record.payload["session_id"];
    if (typeof sid !== "string" || seen.has(sid)) continue;
    seen.add(sid);
    segments.push(
      Object.freeze({ session_id: sid, parent_session_id: links.get(sid)?.parentId ?? null }),
    );
  }
  // A root segment can exist without records of its own (the chain was
  // linked before the root transcript was ever imported); it still
  // anchors the conversation, so list it first.
  if (!seen.has(rootId)) {
    segments.unshift(
      Object.freeze({ session_id: rootId, parent_session_id: links.get(rootId)?.parentId ?? null }),
    );
  }
  if (segments.length < 2) return {};
  return { lineage_root: rootId, segments: Object.freeze(segments) };
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

function lineagePayloadFields(lineage: SessionLineage | undefined): Record<string, unknown> {
  if (lineage === undefined) return {};
  return {
    root_session_id: lineage.rootId,
    ...(lineage.parentId !== null ? { parent_session_id: lineage.parentId } : {}),
    compression_depth: lineage.depth,
  };
}

function importRawTurn(
  vault: string,
  sessionId: string,
  turn: SessionTurn,
  createdAt: string,
  lineage: SessionLineage | undefined,
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
      ...lineagePayloadFields(lineage),
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
  lineage: SessionLineage | undefined,
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
          ...lineagePayloadFields(lineage),
        },
      }),
    );
  }
  return nodes;
}

function sessionRecallRecords(vault: string, sessionId?: string): ContinuityRecord[] {
  const records = listContinuityRecords(vault).filter(
    (record) => record.kind === "session_turn" || record.kind === "session_summary_node",
  );
  let scoped = records;
  if (sessionId !== undefined) {
    const scope = lineageScope(vault, records, sessionId);
    scoped = records.filter((record) => scope.has(String(record.payload["session_id"] ?? "")));
  }
  return scoped.sort((left, right) => compareRecords(left, right));
}

interface LineageLink {
  readonly rootId: string;
  readonly parentId: string | null;
}

/**
 * Per-session lineage links visible to recall: stamped record payloads
 * first, then persisted ledger links for captured-but-unimported
 * segments. Flat sessions never appear in the map.
 */
function lineageLinks(
  vault: string,
  records: ReadonlyArray<ContinuityRecord>,
): Map<string, LineageLink> {
  const links = new Map<string, LineageLink>();
  for (const record of records) {
    const sid = record.payload["session_id"];
    const root = record.payload["root_session_id"];
    if (typeof sid !== "string" || typeof root !== "string" || links.has(sid)) continue;
    const parent = record.payload["parent_session_id"];
    links.set(sid, { rootId: root, parentId: typeof parent === "string" ? parent : null });
  }
  try {
    for (const [sid, entry] of readLineageLedger(vault)) {
      if (links.has(sid)) continue;
      if (entry.lineage === undefined || entry.lineage.source === "flat") continue;
      links.set(sid, { rootId: entry.lineage.rootId, parentId: entry.lineage.parentId });
    }
  } catch {
    // Fail-soft: recall works from record payloads alone.
  }
  return links;
}

/**
 * Transitive root of one session id: follow recorded roots and parents
 * until a fixpoint, so a chain whose segments each recorded only their
 * direct predecessor (A -> B -> C with per-segment links) still
 * resolves every segment to the SAME root. Cycle-guarded.
 */
function transitiveRootOf(sessionId: string, links: ReadonlyMap<string, LineageLink>): string {
  let current = sessionId;
  const seen = new Set<string>([current]);
  for (;;) {
    const link = links.get(current);
    const next = link === undefined ? null : link.rootId !== current ? link.rootId : link.parentId;
    if (next === null || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/**
 * Every session id belonging to the same conversation as `sessionId`:
 * the lineage root, all segments resolving to that root (transitively),
 * and the id itself. A flat session resolves to just itself, keeping
 * pre-lineage recall byte-identical.
 */
function lineageScope(
  vault: string,
  records: ReadonlyArray<ContinuityRecord>,
  sessionId: string,
): Set<string> {
  const links = lineageLinks(vault, records);
  const rootId = transitiveRootOf(sessionId, links);
  const scope = new Set<string>([sessionId, rootId]);
  for (const sid of links.keys()) {
    if (transitiveRootOf(sid, links) === rootId) scope.add(sid);
  }
  return scope;
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

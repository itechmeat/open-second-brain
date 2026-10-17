import { createHash } from "node:crypto";

import { charSpanToLineSpan } from "../search/line-numbering.ts";
import { caseInsensitiveIndex, NO_MATCH_OFFSET, snippetAround } from "../search/snippet-window.ts";
import { privateRegionTexts } from "../redactor.ts";
import {
  appendContinuityRecord,
  clipPayloadToBudget,
  listContinuityRecords,
} from "./continuity/store.ts";
import {
  CONTINUITY_AGENT_ID_KEY,
  CONTINUITY_SESSION_ID_KEY,
  type ContinuityPayload,
  type ContinuityRecord,
  type ContinuitySourceRef,
} from "./continuity/types.ts";
import { readLineageLedger } from "./lineage/ledger.ts";
import type { SessionLineage } from "./lineage/types.ts";
import { PayloadRegistry, withPayloadStoreLock } from "./payload-registry.ts";
import { applyCharBudget } from "./recall-budget.ts";
import {
  TOPIC_BUDGET_FLOOR,
  detectThreadFacets,
  resolveTopicBudget,
  type ThreadFacet,
  type ThreadFacetMention,
  type ThreadFacetOrigin,
} from "./thread-topics.ts";
import {
  BRAIN_SESSION_PAYLOAD_DEFAULTS,
  loadBrainConfigDetailed,
  resolveSessionPayloadPolicy,
} from "./policy.ts";
import type { SessionTurn } from "./sessions/types.ts";
import type { ResolvedSessionPayloadPolicy } from "./types.ts";

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
  /**
   * Payload-registry thresholds (t_35440e83). Absent resolves the vault's
   * `sessions:` block, falling back to the defaults when the config
   * cannot be read - an unreadable config must not store blobs inline.
   */
  readonly payloadPolicy?: ResolvedSessionPayloadPolicy;
}

export interface ImportSessionRecallResult {
  readonly rawTurns: ReadonlyArray<ContinuityRecord>;
  readonly summaryNodes: ReadonlyArray<ContinuityRecord>;
}

export interface SessionRecallSearchInput {
  readonly query: string;
  /**
   * Leave out continuity rows flagged `private` (a `<private>` region was
   * stripped from them), and the summary nodes built from them, as if they
   * did not exist. Set for a caller at remote reach; absent keeps every
   * row, the local behaviour.
   */
  readonly withholdPrivate?: boolean;
  readonly sessionId?: string;
  readonly limit?: number;
  readonly snippetChars?: number;
  /**
   * Conversation-chronology time bounds (S1 / t_347e8224). Inclusive
   * unix-ms lower / upper bounds on a record's effective instant (its
   * turn `timestamp`, falling back to `createdAt`). A record whose
   * instant falls outside the range is excluded; a record with no
   * parseable instant is kept only when no bound is set. Absent bounds →
   * byte-identical to the pre-feature unbounded search. Callers parse
   * `since` / `before` strings through `time-range.ts` before calling.
   */
  readonly sinceMs?: number;
  readonly untilMs?: number;
  /**
   * Inline-raw disclosure (C2 / t_ac1d36ea). When true, every returned hit
   * gains an `extracted` discriminator and a `raw` array carrying the
   * original raw captures beside the derived record (a distilled summary
   * node carries the source turns it was distilled from; a raw turn carries
   * itself). Reuses the same collect/expand machinery as
   * {@link expandSessionRecall}. Omitted (the default) leaves hits
   * byte-identical to the pre-feature response.
   */
  readonly includeRaw?: boolean;
  /**
   * Per-raw-record output-budget clip in characters, applied only when
   * `includeRaw` is set. Each inlined raw capture's payload is clipped to
   * this many characters through the shared clip contract
   * ({@link clipPayloadToBudget}), so the protected identity keys
   * (session_id, agent_id) always survive while bulky fields such as the
   * turn text drop first. Omitted returns raw captures unclipped.
   */
  readonly rawBudgetChars?: number;
}

export interface SessionRecallHit {
  readonly id: string;
  readonly kind: "session_turn" | "session_summary_node";
  readonly score: number;
  readonly snippet: string;
  /**
   * 1-based line span of the matched text within the record, computed at
   * read time from the snippet match's char offset. Line-anchors the
   * char-offset snippet so a hit can be cited to exact lines, not just the
   * record as a whole; the stored text is never mutated.
   */
  readonly line_start: number;
  readonly line_end: number;
  readonly turn_id?: string;
  readonly role?: string;
  readonly depth?: number;
  readonly source_record_ids?: ReadonlyArray<string>;
  /**
   * Present only under `includeRaw` (C2): true for a derived/distilled
   * record (a summary node), false for a raw capture (a session turn).
   */
  readonly extracted?: boolean;
  /**
   * Present only under `includeRaw` (C2): the original raw captures
   * inlined beside this record, clip-contract-respecting when a raw
   * budget is set.
   */
  readonly raw?: ReadonlyArray<ExpandedRawTurn>;
}

export interface SessionRecallSearchResult {
  readonly hits: ReadonlyArray<SessionRecallHit>;
}

export interface DescribeSessionRecallInput {
  readonly sessionId: string;
  /**
   * Leave out continuity rows flagged `private` (a `<private>` region was
   * stripped from them), and the summary nodes built from them, as if they
   * did not exist. Set for a caller at remote reach; absent keeps every
   * row, the local behaviour.
   */
  readonly withholdPrivate?: boolean;
  /**
   * Include the coverage topic report (t_2c2a883c): the facets the
   * coverage operation would detect over this session's lineage scope
   * and the adaptive topic budget they clamp to. Omitted keeps the
   * result byte-identical to the pre-topic shape.
   */
  readonly topics?: boolean;
}

export interface SessionLineageSegment {
  readonly session_id: string;
  readonly parent_session_id: string | null;
}

/**
 * The coverage topic budget over one scope: what
 * {@link coverageSessionRecall} would fan out over, without running the
 * selection.
 */
export interface SessionCoverageTopicReport {
  readonly facets_detected: number;
  readonly topics_requested: number;
  readonly topics_realized: number;
  readonly topics: ReadonlyArray<SessionCoverageTopic>;
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
  /**
   * Present only under `topics` (t_2c2a883c): the adaptive topic budget
   * this session's thread clamps to and the facets it detected.
   */
  readonly topic_report?: SessionCoverageTopicReport;
}

export interface ExpandSessionRecallInput {
  readonly id: string;
  /**
   * Leave out continuity rows flagged `private` (a `<private>` region was
   * stripped from them), and the summary nodes built from them, as if they
   * did not exist. Set for a caller at remote reach; absent keeps every
   * row, the local behaviour.
   */
  readonly withholdPrivate?: boolean;
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
/**
 * The bounded default answer size of the search (and the MCP
 * `brain_session_grep` page when `limit` is omitted). Exported so the
 * paging tool keeps ONE spelling of its historical default instead of
 * minting a second 10.
 */
export const DEFAULT_LIMIT = 10;
const DEFAULT_SNIPPET_CHARS = 160;

/**
 * The session id a continuity payload names, or `undefined` when it names
 * no session: the key absent, a non-string value, or the empty string
 * (t_22d58fa7). Absence stays absence - the reader-side reading of the
 * orphan-session precedent, where `session:unknown` is a statement that
 * there was no session rather than a pointer to a missing one. The
 * `String(... ?? "")` coercion this replaces manufactured both a phantom
 * `""` identity for unattributed records and a string match for a
 * non-string one.
 */
export function sessionIdOf(payload: ContinuityPayload): string | undefined {
  const value = payload[CONTINUITY_SESSION_ID_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function importSessionRecall(
  vault: string,
  input: ImportSessionRecallInput,
): ImportSessionRecallResult {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const lineage =
    input.lineage !== undefined && input.lineage.source !== "flat" ? input.lineage : undefined;
  const policy = input.payloadPolicy ?? loadSessionPayloadPolicy(vault);
  const registry = new PayloadRegistry({
    vault,
    maxInlineChars: policy.max_inline_chars,
    maxTextChars: policy.max_text_chars,
  });
  const rawTurns = input.turns.map((turn) =>
    importRawTurn(vault, input.sessionId, turn, createdAt, lineage, registry),
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
  const records = sessionRecallRecords(vault, input.sessionId, input.withholdPrivate);
  const hits = records
    .filter((record) => recordInTimeRange(record, input.sinceMs, input.untilMs))
    .map((record) => hitFor(record, needle, snippetChars))
    .filter((hit): hit is SessionRecallHit => hit !== null)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  if (input.includeRaw !== true) return Object.freeze({ hits: Object.freeze(hits) });
  const byId = new Map(records.map((record) => [record.id, record]));
  const decorated = hits.map((hit) => decorateHitWithRaw(hit, byId, input.rawBudgetChars));
  return Object.freeze({ hits: Object.freeze(decorated) });
}

/**
 * Attach the `extracted` discriminator and inlined `raw` captures to one
 * hit (C2). A distilled summary node carries the raw turns it was distilled
 * from; a raw turn carries itself. The collect/expand machinery is shared
 * with {@link expandSessionRecall} (never duplicated), and each raw payload
 * is clip-contract-respecting when a budget is set.
 */
function decorateHitWithRaw(
  hit: SessionRecallHit,
  byId: ReadonlyMap<string, ContinuityRecord>,
  rawBudgetChars: number | undefined,
): SessionRecallHit {
  const record = byId.get(hit.id);
  if (record === undefined) return hit;
  const raw = collectRawRecords(record, byId).map((source) =>
    expandedRawTurn(clipRawRecord(source, rawBudgetChars)),
  );
  return Object.freeze({
    ...hit,
    extracted: record.kind === "session_summary_node",
    raw: Object.freeze(raw),
  });
}

/**
 * Decorate already-fetched hits (C2) without re-running the search: the
 * record set is read once and each given hit passes through
 * {@link decorateHitWithRaw}. The paging MCP tool slices its page FIRST
 * and decorates only the page's items, so a cursor walk decorates each
 * hit exactly once instead of re-decorating the whole match set on
 * every page.
 */
export function decorateSessionRecallHits(
  vault: string,
  hits: ReadonlyArray<SessionRecallHit>,
  opts: {
    readonly sessionId?: string;
    readonly withholdPrivate?: boolean;
    readonly rawBudgetChars?: number;
  } = {},
): ReadonlyArray<SessionRecallHit> {
  if (hits.length === 0) return Object.freeze([]);
  const byId = new Map(
    sessionRecallRecords(vault, opts.sessionId, opts.withholdPrivate).map(
      (record) => [record.id, record] as const,
    ),
  );
  return Object.freeze(hits.map((hit) => decorateHitWithRaw(hit, byId, opts.rawBudgetChars)));
}

/**
 * A view of one raw record whose payload is clipped to `budgetChars`
 * through the shared clip contract (protected identity keys survive). No
 * budget returns the record unchanged, keeping the unclipped path
 * byte-identical.
 */
function clipRawRecord(
  record: ContinuityRecord,
  budgetChars: number | undefined,
): ContinuityRecord {
  const clipped = clipPayloadToBudget(record.payload, budgetChars);
  if (clipped === record.payload) return record;
  return { ...record, payload: clipped };
}

export function describeSessionRecall(
  vault: string,
  input: DescribeSessionRecallInput,
): DescribeSessionRecallResult {
  const records = sessionRecallRecords(vault, input.sessionId, input.withholdPrivate);
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
    ...(input.topics === true ? { topic_report: coverageTopicReport(vault, records) } : {}),
    ...lineageDescription(vault, records, input.sessionId),
  });
}

/**
 * The adaptive topic budget over one scope's record set, without running
 * the selection: the facets {@link coverageSessionRecall} would detect
 * and what they clamp to between the exported floor and cap.
 */
function coverageTopicReport(
  vault: string,
  records: ReadonlyArray<ContinuityRecord>,
): SessionCoverageTopicReport {
  const facets = detectCoverageFacets(vault, records);
  const { budget, realized } = resolveTopicBudget(facets.length);
  return Object.freeze({
    facets_detected: facets.length,
    topics_requested: budget,
    topics_realized: realized,
    topics: Object.freeze(
      facets
        .slice(0, budget)
        .map((facet) =>
          Object.freeze({ key: facet.key, origin: facet.origin, turn_count: facet.turnIds.length }),
        ),
    ),
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
      Object.freeze({
        session_id: sid,
        parent_session_id: links.get(sid)?.parentId ?? null,
      }),
    );
  }
  // A root segment can exist without records of its own (the chain was
  // linked before the root transcript was ever imported); it still
  // anchors the conversation, so list it first.
  if (!seen.has(rootId)) {
    segments.unshift(
      Object.freeze({
        session_id: rootId,
        parent_session_id: links.get(rootId)?.parentId ?? null,
      }),
    );
  }
  if (segments.length < 2) return {};
  return { lineage_root: rootId, segments: Object.freeze(segments) };
}

/**
 * Every raw turn one imported session holds, in record order.
 *
 * `describeSessionRecall` counts them and `expandSessionRecall` pages
 * them from one node outward; neither hands a caller the turns of a
 * session as a list, which is what a batch lane reading an
 * already-imported transcript needs. An unknown session id returns an
 * empty array - "this session has no imported turns" is a fact about the
 * vault, and the caller decides whether it is a refusal.
 */
export function listSessionRawTurns(
  vault: string,
  sessionId: string,
): ReadonlyArray<ExpandedRawTurn> {
  return buildSessionTurnIndex(vault).turnsFor(sessionId);
}

/** Per-session raw turn lists over one read of the continuity store. */
export interface SessionTurnIndex {
  /** Exactly what {@link listSessionRawTurns} answers for `sessionId`. */
  turnsFor(sessionId: string): ReadonlyArray<ExpandedRawTurn>;
}

/**
 * One pass over the continuity store and one lineage build, then any
 * number of per-session turn lists. A caller that walks many sessions
 * (the mining census, the mining ledger's prune) pays the store read once
 * instead of once per session, which is the difference between linear and
 * quadratic in the number of imported sessions. The lineage scope is the
 * one {@link listSessionRawTurns} applies - that function is this index
 * over a single session - so the census and the plan cannot drift in how
 * they scope a session.
 */
export function buildSessionTurnIndex(vault: string): SessionTurnIndex {
  const records = listContinuityRecords(vault).filter(
    (record) => record.kind === "session_turn" || record.kind === "session_summary_node",
  );
  const links = lineageLinks(vault, records);
  const rootMemo = new Map<string, string>();
  const rootOf = (sid: string): string => {
    let root = rootMemo.get(sid);
    if (root === undefined) {
      root = transitiveRootOf(sid, links);
      rootMemo.set(sid, root);
    }
    return root;
  };
  const segmentsByRoot = new Map<string, string[]>();
  for (const sid of links.keys()) {
    const root = rootOf(sid);
    const segments = segmentsByRoot.get(root);
    if (segments === undefined) segmentsByRoot.set(root, [sid]);
    else segments.push(sid);
  }
  const turnsBySession = new Map<string, ContinuityRecord[]>();
  for (const record of records) {
    if (record.kind !== "session_turn") continue;
    const sid = sessionIdOf(record.payload);
    if (sid === undefined) continue;
    const list = turnsBySession.get(sid);
    if (list === undefined) turnsBySession.set(sid, [record]);
    else list.push(record);
  }
  return {
    turnsFor(sessionId: string): ReadonlyArray<ExpandedRawTurn> {
      const rootId = rootOf(sessionId);
      const scope = new Set<string>([sessionId, rootId, ...(segmentsByRoot.get(rootId) ?? [])]);
      const scoped: ContinuityRecord[] = [];
      for (const sid of scope) scoped.push(...(turnsBySession.get(sid) ?? []));
      return Object.freeze(scoped.sort(compareRecords).map(expandedRawTurn));
    },
  };
}

export function expandSessionRecall(
  vault: string,
  input: ExpandSessionRecallInput,
): ExpandSessionRecallResult {
  const records = sessionRecallRecords(vault, undefined, input.withholdPrivate);
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

// ----- Coverage-first selection (recall-quality wave, Lane B / t_2c2a883c) ---

export interface SessionCoverageInput {
  readonly sessionId?: string;
  /**
   * Seed the coverage call from a mined entity key (t_2c2a883c, design
   * decision 13, read-side only): the key resolves through its existing
   * `session_entity_mention` rows ({@link resolveEntityMentionRows}) to
   * the sessions that name it, the selection runs over their lineage
   * scopes, and the key's own facets lead the fan-out. A key with no
   * rows - or whose establishing turns no imported record carries -
   * raises the typed {@link SessionCoverageEntityUnknownError}, never an
   * empty silent result.
   */
  readonly entityKey?: string;
  /**
   * Leave out continuity rows flagged `private` and the summary nodes
   * built from them, exactly as {@link searchSessionRecall} does.
   */
  readonly withholdPrivate?: boolean;
  /**
   * Total character budget for the selected evidence, measured over the
   * serialized turns the operation emits. The floor-weighted selection
   * must fit or the typed infeasibility error is raised (never a silent
   * drop below the floor).
   */
  readonly charBudget: number;
}

/** One realized fan-out topic, as the diagnostics report it. */
export interface SessionCoverageTopic {
  readonly key: string;
  readonly origin: ThreadFacetOrigin;
  /** In-scope turns establishing this topic. */
  readonly turn_count: number;
}

export interface SessionCoverageDiagnostics {
  /** Distinct facets detected over the scoped record set. */
  readonly facets_detected: number;
  /** Topics the fan-out was budgeted for (the adaptive topic budget). */
  readonly topics_requested: number;
  /** Topics actually fanned out (never silently fewer than requested). */
  readonly topics_realized: number;
  /** The realized topics, in fan-out order. */
  readonly topics: ReadonlyArray<SessionCoverageTopic>;
  /** Characters of serialized evidence the selection kept. */
  readonly chars_used: number;
  /** Turns the character budget dropped, in rank order (never silent). */
  readonly dropped_turn_ids: ReadonlyArray<string>;
}

export interface SessionCoverageResult {
  /** Selected raw turns, re-emitted in `compareRecords` chronological order. */
  readonly turns: ReadonlyArray<ExpandedRawTurn>;
  readonly diagnostics: SessionCoverageDiagnostics;
}

/**
 * Coverage-first selection over a conversation thread
 * (recall-quality wave, Lane B / t_2c2a883c).
 *
 * Retrieve wide, then compress: facets are detected from the thread's
 * own records (depth-1 summary clusters and mined entity keys, through
 * {@link detectThreadFacets}), the pass fans out over the adaptive topic
 * budget ({@link resolveTopicBudget}: clamp of the facet count between
 * the exported floor and cap), and the union of matching turns is ranked
 * by relevance, selected under the caller's character budget through the
 * shared {@link applyCharBudget} primitive (wrapped, never forked), and
 * re-emitted in {@link compareRecords} chronological order. Every drop
 * is named in the diagnostics; nothing degrades silently.
 *
 * An `entityKey` seed (t_2c2a883c design decision 13) resolves read-side
 * through its `session_entity_mention` rows: absent `sessionId`, the
 * scope is the union of the mentioned sessions' lineage scopes, and the
 * key's own facets lead the fan-out so the topic budget cannot cut the
 * facet the call was seeded for. A seed that cannot reach an imported
 * establishing turn raises {@link SessionCoverageEntityUnknownError}.
 */
export function coverageSessionRecall(
  vault: string,
  input: SessionCoverageInput,
): SessionCoverageResult {
  if (
    typeof input.charBudget !== "number" ||
    !Number.isFinite(input.charBudget) ||
    input.charBudget <= 0
  ) {
    throw new Error("session recall coverage: charBudget must be a positive finite number");
  }
  const seed =
    input.entityKey !== undefined ? resolveEntityMentionRows(vault, input.entityKey) : undefined;
  const records =
    seed === undefined
      ? sessionRecallRecords(vault, input.sessionId, input.withholdPrivate)
      : entitySeededRecords(vault, input, seed);
  assertEntitySeedReachesScope(input.entityKey, seed, records, input.withholdPrivate === true);
  const facets = detectCoverageFacets(vault, records);
  const { budget } = resolveTopicBudget(facets.length);
  const topics =
    seed === undefined
      ? facets.slice(0, budget)
      : seededFacetsFirst(facets, input.entityKey!).slice(0, budget);
  const matches = rankTopicMatches(records, topics);
  const serialized = matches.map((match) => JSON.stringify(expandedRawTurn(match.record)));
  const budgeted = applyCharBudget(
    matches.map((match, index) => ({ item: match, text: serialized[index]! })),
    { maxTotalChars: input.charBudget },
  );
  // Floor enforcement verifies what the real selection kept, never what
  // an arithmetic prediction claimed about it.
  assertFloorSelectionRealized(
    topics,
    matches,
    serialized,
    input.charBudget,
    budgeted.kept.map((entry) => entry.item),
  );
  const kept = budgeted.kept
    .map((entry) => entry.item)
    .toSorted((left, right) => compareRecords(left.record, right.record));
  return Object.freeze({
    turns: Object.freeze(kept.map((match) => expandedRawTurn(match.record))),
    diagnostics: Object.freeze({
      facets_detected: facets.length,
      topics_requested: budget,
      topics_realized: topics.length,
      topics: Object.freeze(
        topics.map((facet) =>
          Object.freeze({ key: facet.key, origin: facet.origin, turn_count: facet.turnIds.length }),
        ),
      ),
      chars_used: budgeted.totalChars,
      dropped_turn_ids: Object.freeze(budgeted.dropped.map((match) => turnIdOf(match.record))),
    }),
  });
}

/**
 * One resolved `session_entity_mention` row: the payload spine the
 * ledger writes per (family, key, session), provenance-grade and already
 * on disk - the entity-thread dimension reads it, never re-mines it.
 */
export interface SessionEntityMentionRow {
  readonly family: string;
  readonly key: string;
  readonly session_ref: string;
  readonly turn_id: string;
}

/**
 * Resolve a mined entity key to its `session_entity_mention` rows
 * (t_2c2a883c design decision 13, read-side only): every ledger row
 * whose payload names the key, private rows withheld. A key no row
 * names raises the typed {@link SessionCoverageEntityUnknownError} -
 * resolution never answers an unknown key with an empty silent list.
 */
export function resolveEntityMentionRows(
  vault: string,
  entityKey: string,
): ReadonlyArray<SessionEntityMentionRow> {
  const rows: SessionEntityMentionRow[] = [];
  for (const record of listContinuityRecords(vault, { kind: "session_entity_mention" })) {
    if (record.private) continue;
    const family = record.payload["family"];
    const key = record.payload["key"];
    const sessionRef = record.payload["session_ref"];
    const turnId = record.payload["turn_id"];
    if (
      typeof family !== "string" ||
      typeof key !== "string" ||
      typeof sessionRef !== "string" ||
      typeof turnId !== "string"
    ) {
      continue;
    }
    if (key === entityKey) rows.push({ family, key, session_ref: sessionRef, turn_id: turnId });
  }
  if (rows.length === 0) {
    throw new SessionCoverageEntityUnknownError({
      entityKey,
      reason: "no_mention_rows",
      mentionRows: 0,
    });
  }
  return rows;
}

/**
 * The record set an entity-seeded coverage call selects over: an
 * explicit `sessionId` keeps its own lineage scope (the seed must hold
 * inside it - see {@link assertEntitySeedReachesScope}); otherwise the
 * union of the mentioned sessions' lineage scopes, deduped by record id
 * (lineage links overlap across sessions) and re-sorted into the shared
 * {@link compareRecords} order - concatenating per session would let the
 * mention rows' order decide facet order, and with it which facets
 * survive the topic budget.
 */
function entitySeededRecords(
  vault: string,
  input: SessionCoverageInput,
  rows: ReadonlyArray<SessionEntityMentionRow>,
): ContinuityRecord[] {
  if (input.sessionId !== undefined) {
    return sessionRecallRecords(vault, input.sessionId, input.withholdPrivate);
  }
  const deduped = new Map<string, ContinuityRecord>();
  for (const sessionRef of new Set(rows.map((row) => row.session_ref))) {
    for (const record of sessionRecallRecords(vault, sessionRef, input.withholdPrivate)) {
      if (!deduped.has(record.id)) deduped.set(record.id, record);
    }
  }
  return [...deduped.values()].sort(compareRecords);
}

/**
 * An entity seed must reach imported evidence: at least one establishing
 * turn of the key has to be a raw turn of the scoped record set. A key
 * whose rows all name sessions or turns the recall DAG never imported
 * raises the typed {@link SessionCoverageEntityUnknownError} - never a
 * silently generic result over an empty scope. At remote reach
 * (`withholdPrivate`) the refusal uses the no-rows wording for both
 * reasons: which keys still have mention rows behind the withheld turns
 * is itself withheld.
 */
function assertEntitySeedReachesScope(
  entityKey: string | undefined,
  rows: ReadonlyArray<SessionEntityMentionRow> | undefined,
  records: ReadonlyArray<ContinuityRecord>,
  withholdPrivate: boolean,
): void {
  if (entityKey === undefined || rows === undefined) return;
  const scopedTurns = new Set<string>();
  for (const record of records) {
    if (record.kind !== "session_turn") continue;
    const sessionId = sessionIdOf(record.payload);
    const turnId = turnIdOf(record);
    if (sessionId !== undefined && turnId.length > 0) {
      scopedTurns.add(qualifiedTurnId(sessionId, turnId));
    }
  }
  // The pair, not the bare turn id: in a multi-session scope a row for
  // one session's turn must never be satisfied by another session's
  // same-named turn.
  if (rows.some((row) => scopedTurns.has(qualifiedTurnId(row.session_ref, row.turn_id)))) return;
  throw new SessionCoverageEntityUnknownError({
    entityKey,
    reason: "no_imported_turns",
    mentionRows: rows.length,
    ...(withholdPrivate ? { withholdPrivate: true } : {}),
  });
}

/**
 * Fan-out order for an entity-seeded call: the key's own mined facets
 * lead (stable otherwise), so the adaptive budget's cut can never drop
 * the facet the call was seeded for. The establishing-turn guard above
 * has already proven at least one such facet exists.
 */
function seededFacetsFirst(facets: ReadonlyArray<ThreadFacet>, entityKey: string): ThreadFacet[] {
  const pinned = facets.filter((facet) => facet.origin === "mined" && facet.needle === entityKey);
  if (pinned.length === 0) return [...facets];
  const pinnedKeys = new Set(pinned);
  return [...pinned, ...facets.filter((facet) => !pinnedKeys.has(facet))];
}

/**
 * The floor-violation guard (t_2c2a883c, design decision 10): after the
 * real {@link applyCharBudget} selection, every floor topic must have
 * realized its minimum - ANY of its turns kept. A mined facet's top-ranked
 * turn is usually its largest (the score is 2 + occurrences, so a pasted
 * log outranks its own topic's short mentions), and a budget the greedy
 * pass spends on that log while keeping the topic's smaller evidence is a
 * satisfied floor, not an infeasible one. Only the outcome of the actual
 * selection is authoritative: it spends code points (not UTF-16 units) and
 * skips entries a prefix-sum arithmetic would have charged. A floor topic
 * whose every matching turn was crowded out raises the typed
 * {@link SessionCoverageInfeasibleError} - never a silent zero-evidence
 * topic.
 */
function assertFloorSelectionRealized(
  topics: ReadonlyArray<ThreadFacet>,
  matches: ReadonlyArray<TopicMatch>,
  serialized: ReadonlyArray<string>,
  charBudget: number,
  kept: ReadonlyArray<TopicMatch>,
): void {
  const { requiredTopics, realizedTopics, requiredChars } = floorRequirement(
    topics,
    matches,
    serialized,
    kept,
  );
  if (requiredTopics.length === 0) return;
  if (realizedTopics.length === requiredTopics.length) return;
  throw new SessionCoverageInfeasibleError({
    topicFloor: TOPIC_BUDGET_FLOOR,
    requestedTopics: topics.length,
    keptTopics: realizedTopics.length,
    requiredChars,
    charBudget,
  });
}

interface FloorRequirement {
  /**
   * The floor topics that have at least one matching turn - the only ones
   * that can contribute to the floor.
   */
  readonly requiredTopics: ReadonlyArray<ThreadFacet>;
  /** The required topics the real selection kept at least one turn of. */
  readonly realizedTopics: ReadonlyArray<ThreadFacet>;
  /**
   * Code points of the cheapest matching turn per required topic, each
   * distinct turn charged once - the honest retry bound: the smallest
   * per-topic evidence the floor asks the selection to hold, in the unit
   * {@link applyCharBudget} spends. The rank-prefix sum this replaces
   * compounded every rank up to the deepest floor turn and could name a
   * bound many times larger than what the floor actually needs.
   */
  readonly requiredChars: number;
}

/** The priced requirement behind the floor guard's retry bound. */
function floorRequirement(
  topics: ReadonlyArray<ThreadFacet>,
  matches: ReadonlyArray<TopicMatch>,
  serialized: ReadonlyArray<string>,
  kept: ReadonlyArray<TopicMatch>,
): FloorRequirement {
  const floorTopics = topics.slice(0, Math.min(topics.length, TOPIC_BUDGET_FLOOR));
  const floorKeys = new Set(floorTopics.map((topic) => topic.key));
  // Per required topic: whether any of its turns was kept, and its
  // cheapest matching turn (rank order breaks length ties).
  const keptIds = new Set(kept.map((match) => match.record.id));
  const realized = new Set<string>();
  const cheapest = new Map<string, { turnId: string; chars: number }>();
  matches.forEach((match, index) => {
    const keptThis = keptIds.has(match.record.id);
    const chars = [...serialized[index]!].length;
    for (const key of match.topics) {
      if (!floorKeys.has(key)) continue;
      if (keptThis) realized.add(key);
      const incumbent = cheapest.get(key);
      if (incumbent === undefined || chars < incumbent.chars) {
        cheapest.set(key, { turnId: match.record.id, chars });
      }
    }
  });
  const requiredTopics = floorTopics.filter((topic) => cheapest.has(topic.key));
  const realizedTopics = requiredTopics.filter((topic) => realized.has(topic.key));
  // The cheapest turn per required topic, each distinct turn charged once:
  // topics can share their cheapest turn, and charging it twice would
  // overstate the floor's own requirement.
  const priced = new Set<string>();
  let requiredChars = 0;
  for (const topic of requiredTopics) {
    const entry = cheapest.get(topic.key)!;
    if (priced.has(entry.turnId)) continue;
    priced.add(entry.turnId);
    requiredChars += entry.chars;
  }
  return { requiredTopics, realizedTopics, requiredChars };
}

/**
 * The typed error family of the coverage operation (t_2c2a883c): every
 * refusal the selection can produce - a budget below the floor-weighted
 * selection, an entity seed with no reachable evidence - is a named
 * subclass of this one, so callers (and the MCP INVALID_PARAMS mapping)
 * can catch the family without catching unrelated failures.
 */
export class SessionCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCoverageError";
  }
}

/**
 * The floor of the adaptive topic budget cannot be honored within the
 * caller's character budget (t_2c2a883c). Carries the recomputable
 * diagnostics so the caller can retry with a larger budget: which floor
 * was violated, the topics requested and representable, and the
 * characters the floor-weighted selection needs. Over MCP this maps to
 * INVALID_PARAMS.
 */
export class SessionCoverageInfeasibleError extends SessionCoverageError {
  readonly topicFloor: number;
  readonly requestedTopics: number;
  readonly keptTopics: number;
  readonly requiredChars: number;
  readonly charBudget: number;

  constructor(details: {
    topicFloor: number;
    requestedTopics: number;
    keptTopics: number;
    requiredChars: number;
    charBudget: number;
  }) {
    super(
      `session recall coverage: character budget ${details.charBudget} cannot hold the ` +
        `floor-weighted selection of floor ${details.topicFloor} - requested topics ` +
        `${details.requestedTopics}, kept topics ${details.keptTopics}, required chars ` +
        `${details.requiredChars}; retry with a larger charBudget`,
    );
    this.name = "SessionCoverageInfeasibleError";
    this.topicFloor = details.topicFloor;
    this.requestedTopics = details.requestedTopics;
    this.keptTopics = details.keptTopics;
    this.requiredChars = details.requiredChars;
    this.charBudget = details.charBudget;
  }
}

/** Why an entity key could not seed a coverage call. */
export type SessionCoverageEntitySeedFailure = "no_mention_rows" | "no_imported_turns";

/**
 * An entity key cannot seed a coverage call with evidence (t_2c2a883c
 * design decision 13): no `session_entity_mention` row names the key, or
 * every row that does names a session or turn the recall DAG never
 * imported. Carries the key, the failure reason and the resolved row
 * count so the caller can retry with a key the ledger actually holds -
 * never an empty silent result. Same typed family as the infeasibility
 * error; over MCP both map to INVALID_PARAMS.
 *
 * With `withholdPrivate` (remote reach) both reasons answer with the
 * no-rows MESSAGE: whether mention rows still exist for a key whose
 * turns are withheld is itself withheld, and two distinguishable
 * refusals would leak exactly that. The typed `reason` stays truthful
 * for local diagnostics.
 */
export class SessionCoverageEntityUnknownError extends SessionCoverageError {
  readonly entityKey: string;
  readonly reason: SessionCoverageEntitySeedFailure;
  readonly mentionRows: number;

  constructor(details: {
    entityKey: string;
    reason: SessionCoverageEntitySeedFailure;
    mentionRows: number;
    withholdPrivate?: boolean;
  }) {
    super(
      details.withholdPrivate === true || details.reason === "no_mention_rows"
        ? `session recall coverage: no session_entity_mention row names the entity key ${details.entityKey}`
        : `session recall coverage: no imported turn establishes the entity key ` +
            `${details.entityKey} (${details.mentionRows} mention row(s) name it, none joins ` +
            `the recall DAG scope)`,
    );
    this.name = "SessionCoverageEntityUnknownError";
    this.entityKey = details.entityKey;
    this.reason = details.reason;
    this.mentionRows = details.mentionRows;
  }
}

/** The `turn_id` payload key of a raw-turn record ("" when absent). */
function turnIdOf(record: ContinuityRecord): string {
  return String(record.payload["turn_id"] ?? "");
}

/**
 * Session-qualified turn identity: `SessionTurn.turnId` can repeat across
 * sessions, and a multi-session scope (entity seeding) mixes lineages, so
 * a bare `turn_id` is not a turn identity wherever the coverage path
 * matches mentions, cluster source lists and turn records against each
 * other. The public output keeps the bare turn ids; this qualifies only
 * that internal plumbing.
 */
function qualifiedTurnId(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

/**
 * The scoped record set's coverage facets: depth-1 summary clusters (the
 * thread's own topic skeleton - a depth-1 node's source turn list
 * partitions the segment's turns) plus the mined entity keys whose
 * mention rows name a session of the scope. Detection itself is the pure
 * {@link detectThreadFacets}; this is the record-set projection into its
 * input. A cluster with no in-scope turns, and a mention naming a
 * session outside the scope or a turn the recall DAG never imported,
 * cannot contribute coverage and is not detected as a facet - nothing
 * selectable is dropped silently, and the ledger rows remain for every
 * other reader. Turn identity is session-qualified
 * ({@link qualifiedTurnId}), so {@link detectThreadFacets} orders and
 * counts turns per session even when the transcripts reuse turn ids.
 */
function detectCoverageFacets(
  vault: string,
  records: ReadonlyArray<ContinuityRecord>,
): ReadonlyArray<ThreadFacet> {
  const turns: string[] = [];
  const clusters: Array<{ id: string; turnIds: ReadonlyArray<string> }> = [];
  for (const record of records) {
    if (record.kind === "session_turn") {
      const sessionId = sessionIdOf(record.payload);
      const turnId = turnIdOf(record);
      if (sessionId !== undefined && turnId.length > 0) {
        turns.push(qualifiedTurnId(sessionId, turnId));
      }
      continue;
    }
    if (record.kind !== "session_summary_node") continue;
    if (numberValue(record.payload["depth"]) !== 1) continue;
    const sessionId = sessionIdOf(record.payload);
    if (sessionId === undefined) continue;
    clusters.push({
      id: record.id,
      turnIds: collectTurnIds([record]).map((turnId) => qualifiedTurnId(sessionId, turnId)),
    });
  }
  return detectThreadFacets({ turns, mentions: scopedMentions(vault, records), clusters });
}

/**
 * The vault's mined-mention rows that name a session of the scope: the
 * payload spine ({@link ThreadFacetMention}) of every
 * `session_entity_mention` record whose `session_ref` joins the scope.
 * The ledger keys provenance by the same portable session identity the
 * recall DAG uses, so the join is direct.
 */
function scopedMentions(
  vault: string,
  records: ReadonlyArray<ContinuityRecord>,
): ReadonlyArray<ThreadFacetMention> {
  const scope = new Set<string>();
  for (const record of records) {
    const sid = sessionIdOf(record.payload);
    if (sid !== undefined) scope.add(sid);
  }
  const mentions: ThreadFacetMention[] = [];
  for (const record of listContinuityRecords(vault, { kind: "session_entity_mention" })) {
    // The same private-row rule the entity-seed reader applies: a
    // `<private>` mention never seeds a facet, so its key string cannot
    // surface through the diagnostics or the topic report.
    if (record.private) continue;
    const family = record.payload["family"];
    const key = record.payload["key"];
    const sessionRef = record.payload["session_ref"];
    const turnId = record.payload["turn_id"];
    if (
      typeof family !== "string" ||
      typeof key !== "string" ||
      typeof sessionRef !== "string" ||
      typeof turnId !== "string"
    ) {
      continue;
    }
    if (scope.has(sessionRef)) {
      mentions.push({ family, key, turnId: qualifiedTurnId(sessionRef, turnId) });
    }
  }
  return mentions;
}

/** One turn's accumulation of topic matches: score and the topics that hit it. */
interface TopicMatch {
  readonly record: ContinuityRecord;
  readonly topics: Set<string>;
  score: number;
}

/**
 * The wide pass: per topic, gather the in-scope turns it touches. Mined
 * facets match turn text through {@link hitFor} (the same keyword
 * machinery grep uses, so the two cannot drift); membership facets reach
 * their turns directly. A turn touched by several topics accumulates
 * their scores, which is what ranks multi-topic turns first.
 */
function rankTopicMatches(
  records: ReadonlyArray<ContinuityRecord>,
  topics: ReadonlyArray<ThreadFacet>,
): TopicMatch[] {
  const turnRecords = records.filter((record) => record.kind === "session_turn");
  // Membership facets name their turns by the same session-qualified
  // identity detectCoverageFacets built, so a cluster of one session can
  // never resolve to another session's same-named turn in a multi-session
  // scope.
  const byTurnId = new Map<string, ContinuityRecord>();
  for (const record of turnRecords) {
    const sessionId = sessionIdOf(record.payload);
    const turnId = turnIdOf(record);
    if (sessionId === undefined || turnId.length === 0) continue;
    const key = qualifiedTurnId(sessionId, turnId);
    if (!byTurnId.has(key)) byTurnId.set(key, record);
  }
  const matches = new Map<string, TopicMatch>();
  const add = (record: ContinuityRecord, score: number, topicKey: string): void => {
    const existing = matches.get(record.id);
    if (existing === undefined) {
      matches.set(record.id, { record, topics: new Set([topicKey]), score });
      return;
    }
    existing.topics.add(topicKey);
    existing.score += score;
  };
  for (const facet of topics) {
    if (facet.origin === "mined" && facet.needle !== null) {
      const needle = facet.needle.toLowerCase();
      for (const record of turnRecords) {
        const hit = hitFor(record, needle, 1);
        if (hit !== null) add(record, hit.score, facet.key);
      }
      continue;
    }
    for (const turnId of facet.turnIds) {
      const record = byTurnId.get(turnId);
      if (record !== undefined) add(record, 1, facet.key);
    }
  }
  return [...matches.values()].toSorted(
    (left, right) => right.score - left.score || compareRecords(left.record, right.record),
  );
}

/**
 * The vault's payload thresholds, or the defaults when `_brain.yaml`
 * cannot be read. Falling back rather than throwing keeps a broken config
 * from failing an import, and falling back to the DEFAULTS rather than to
 * "no bound" keeps it from storing blobs inline either.
 */
function loadSessionPayloadPolicy(vault: string): ResolvedSessionPayloadPolicy {
  try {
    return resolveSessionPayloadPolicy(loadBrainConfigDetailed(vault).config);
  } catch {
    return BRAIN_SESSION_PAYLOAD_DEFAULTS;
  }
}

function importRawTurn(
  vault: string,
  sessionId: string,
  turn: SessionTurn,
  createdAt: string,
  lineage: SessionLineage | undefined,
  registry: PayloadRegistry,
): ContinuityRecord {
  const original = turn.text ?? "";
  // Keyed on the ORIGINAL text, so a re-import of the same transcript
  // dedupes against rows written before the registry existed as well as
  // after it, and a threshold change never duplicates a turn.
  const textHash = hash(original);
  const dedupeKey = ["session_turn", sessionId, turn.turnId, textHash].join(":");
  const existing = findByDedupeKey(vault, dedupeKey);
  if (existing !== null) return existing;
  // Externalize BEFORE the row is written: the ledger, recall search and
  // every summary node built from this row only ever see placeholders.
  // Both halves run under the payload store lock, so a gc cannot remove a
  // payload between its write and the row that names it.
  const row = { sessionId, turn, createdAt, lineage, original, textHash, dedupeKey };
  if (!registry.mayExternalize(original)) return appendTurnRow(vault, registry, row);
  return withPayloadStoreLock(vault, () => appendTurnRow(vault, registry, row));
}

interface TurnRowInput {
  readonly sessionId: string;
  readonly turn: SessionTurn;
  readonly createdAt: string;
  readonly lineage: SessionLineage | undefined;
  readonly original: string;
  readonly textHash: string;
  readonly dedupeKey: string;
}

function appendTurnRow(
  vault: string,
  registry: PayloadRegistry,
  input: TurnRowInput,
): ContinuityRecord {
  const { sessionId, turn, createdAt, lineage, original, textHash, dedupeKey } = input;
  const externalized = registry.externalizeOversized(original);
  const text = externalized.text;
  return appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt,
    sourceRefs: sourceRefs(sessionId, turn.turnId),
    // The registry strips `<private>` regions before it writes anything,
    // which leaves the store nothing to detect; the verdict is carried.
    // It is the redactor's own region detection, so a region the registry
    // stripped (an unclosed tag included) is the region that flags the row.
    ...(externalized.payloads.length > 0 && privateRegionTexts(original).length > 0
      ? { private: true }
      : {}),
    payload: {
      session_id: sessionId,
      turn_id: turn.turnId,
      timestamp: turn.timestamp,
      role: turn.role,
      text,
      text_hash: textHash,
      ...(externalized.payloads.length > 0
        ? { payload_refs: externalized.payloads.map((payload) => payload.ref) }
        : {}),
      dedupe_key: dedupeKey,
      ...lineagePayloadFields(lineage),
      ...delegationPayloadFields(turn),
    },
  });
}

/**
 * The delegation boundary, as additive payload fields.
 *
 * A sub-agent's transcript reuses its parent's session id, so without
 * these two keys a recalled turn cannot say which agent produced it -
 * which is what `docs/observability.md` recorded as the missing
 * parent/child thread. `agent_id` is the key the envelope already
 * protects from an output-budget clip, so a clipped delegated turn stays
 * attributable. Absent on a flat turn, so an ordinary session's records
 * are byte-identical to what they were.
 */
function delegationPayloadFields(turn: SessionTurn): Record<string, unknown> {
  return {
    ...(turn.agentId !== undefined ? { [CONTINUITY_AGENT_ID_KEY]: turn.agentId } : {}),
    ...(turn.sidechain === true ? { sidechain: true } : {}),
  };
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

function sessionRecallRecords(
  vault: string,
  sessionId?: string,
  withholdPrivate?: boolean,
): ContinuityRecord[] {
  const all = listContinuityRecords(vault).filter(
    (record) => record.kind === "session_turn" || record.kind === "session_summary_node",
  );
  const records = withholdPrivate === true ? withoutPrivateRecords(all) : all;
  let scoped = records;
  if (sessionId !== undefined) {
    const scope = lineageScope(vault, records, sessionId);
    // A record naming no session is excluded from a scoped read: the scope
    // set only ever holds real ids (the lineage ledger omits blank
    // declarations), so matching against a coerced "" or a stringified
    // non-string could only ever exclude by accident or match by invention.
    // Unscoped reads still return the record.
    scoped = records.filter((record) => {
      const sid = sessionIdOf(record.payload);
      return sid !== undefined && scope.has(sid);
    });
  }
  return scoped.sort((left, right) => compareRecords(left, right));
}

/**
 * `records` without the rows flagged `private` and without every summary
 * node built, at any depth, from one of them: a summary copies the text of
 * the turns it summarizes, so keeping it would show what the row hides.
 */
function withoutPrivateRecords(records: ReadonlyArray<ContinuityRecord>): ContinuityRecord[] {
  const withheld = new Set(records.filter((record) => record.private).map((record) => record.id));
  let grew = withheld.size > 0;
  while (grew) {
    grew = false;
    for (const record of records) {
      if (withheld.has(record.id) || record.kind !== "session_summary_node") continue;
      if (sourceRecordIds(record).some((id) => withheld.has(id))) {
        withheld.add(record.id);
        grew = true;
      }
    }
  }
  return records.filter((record) => !withheld.has(record.id));
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
    links.set(sid, {
      rootId: root,
      parentId: typeof parent === "string" ? parent : null,
    });
  }
  try {
    for (const [sid, entry] of readLineageLedger(vault)) {
      if (links.has(sid)) continue;
      if (entry.lineage === undefined || entry.lineage.source === "flat") continue;
      links.set(sid, {
        rootId: entry.lineage.rootId,
        parentId: entry.lineage.parentId,
      });
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
  const index = caseInsensitiveIndex(text, needle);
  if (index === NO_MATCH_OFFSET) return null;
  const score = (record.kind === "session_turn" ? 2 : 1) + occurrenceCount(haystack, needle);
  const span = charSpanToLineSpan(text, index, needle.length);
  const base = {
    id: record.id,
    kind: record.kind as "session_turn" | "session_summary_node",
    score,
    snippet: snippetAround(text, index, snippetChars),
    line_start: span.lineStart,
    line_end: span.lineEnd,
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

/**
 * Whether a record's effective instant falls within the inclusive
 * `[sinceMs, untilMs]` bounds (conversation chronology, S1). The instant
 * is the turn `timestamp`, falling back to the record `createdAt` (the
 * same precedence `compareRecords` uses). A record with no parseable
 * instant is kept only when no bound is set - a bounded query is a
 * deliberate time filter, so an undatable record cannot silently pass it.
 */
function recordInTimeRange(
  record: ContinuityRecord,
  sinceMs: number | undefined,
  untilMs: number | undefined,
): boolean {
  if (sinceMs === undefined && untilMs === undefined) return true;
  const raw = String(record.payload["timestamp"] ?? record.createdAt);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  if (sinceMs !== undefined && ms < sinceMs) return false;
  if (untilMs !== undefined && ms > untilMs) return false;
  return true;
}

/**
 * Code-unit string order: the same order on every host, where
 * `localeCompare` varies with the host locale and would make record and
 * facet order - and with it what survives a budget cut - depend on where
 * the process runs.
 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRecords(left: ContinuityRecord, right: ContinuityRecord): number {
  const leftTimestamp = String(left.payload["timestamp"] ?? left.createdAt);
  const rightTimestamp = String(right.payload["timestamp"] ?? right.createdAt);
  return compareCodeUnits(leftTimestamp, rightTimestamp) || compareCodeUnits(left.id, right.id);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

#!/usr/bin/env -S bun
/**
 * UserPromptSubmit hook: neighbour updates (task 4.3, design D5, D10
 * `neighbour_relevant`). On by default when a brain store is in use;
 * `neighbour_updates_enabled: "false"` turns it off. Before each turn it
 * reads the records appended to the store's `topics` shards since this
 * session's last prompt, straight from the shards past the session's
 * cursor (`src/core/agent-context/topic-tail.ts`: no lock, no index
 * catch-up, no other stream), drops this session's own, keeps those on
 * topics this session works on or in its project scope, gates them
 * deterministically (topic this session works on and kind `decision`),
 * refines the gate with the `neighbour_relevant` use, and injects at
 * most five fenced lines, under one heading per topic naming how to open
 * it, their texts cut to share 800 characters.
 *
 * Own records are never returned: a record stamped with this session
 * (`src/core/agent-context/session-identity.ts`), or an unstamped one of
 * this device and resolved agent name, as `log-catchup` resolves "me"; a
 * model-derived item counts as its source's. Another session of the same
 * agent name, on this device or another, is a neighbour. The first prompt
 * of a session and the first after the state expired (a day without a
 * prompt) place the cursor at the end of every shard and inject nothing;
 * later turns read what was appended, the newest 2000 candidates of it,
 * and say in one line how many older ones were not read and which call
 * lists them. The session's topics are those the earlier turns stored,
 * those of this device and agent's topics records (read once from this
 * device's shards when the session starts) and of its newest own records
 * the index holds (read-only, never caught up here). Candidates are
 * filtered by the session's topics and project before the candidate cap,
 * and what the cap removes is counted in the cut line. A candidate the
 * model did not judge under `enforce` keeps the deterministic gate. The
 * block is written and the cursor moved past it in one synchronous step
 * after the decision wait, so a turn the ceiling cuts shows nothing and
 * moves nothing: its updates come on the next turn. Fail-open: any error
 * or timeout exits 0 with no output and leaves the cursor unchanged.
 */

import { existsSync, writeSync } from "node:fs";
import { basename } from "node:path";

import { readDeviceId, resolveAgentName } from "../src/core/config.ts";
import { resolveDecisionModelConfig } from "../src/core/decision-model/config.ts";
import { discoverConfig } from "../src/core/config.ts";
import { runNeighbourRelevant } from "../src/core/agent-context/neighbour-relevant.ts";
import {
  capNeighbourCandidates,
  deterministicNeighbourGate,
  NEIGHBOUR_KINDS,
  renderNeighbourBlock,
  selectNeighbourCandidates,
  type NeighbourCandidate,
  type NeighbourRecordRow,
} from "../src/core/agent-context/neighbours.ts";
import { budgetCutLine } from "../src/core/agent-context/budget-line.ts";
import { resolveNeighbourUpdatesEnabled } from "../src/core/agent-context/config.ts";
import { isOwnRecord, sessionStamp } from "../src/core/agent-context/session-identity.ts";
import {
  readTopicTail,
  type TopicCursor,
  type TopicTailRecord,
} from "../src/core/agent-context/topic-tail.ts";
import { STORE_INDEX_GENERATION_KEY } from "../src/core/search/brain-store/constants.ts";
import { getRecord, headSeq, ownRecordsTail } from "../src/core/search/store/brain-records.ts";
import { getState } from "../src/core/search/store/state.ts";
import { recordAuthority } from "../src/core/store/fold.ts";
import { readStreamRecords } from "../src/core/store/read/stream-read.ts";
import { resolveSearchConfig } from "../src/core/search/index.ts";
import { scopedRuleKey } from "../src/core/brain/scoped-rules.ts";
import { fenceUntrustedContent } from "../src/core/brain/untrusted-source.ts";
import { inspectStore } from "../src/core/store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../src/core/store/store-paths.ts";
import { Database } from "bun:sqlite";
import { probeIndexedStore, storeIndexPath } from "../src/core/search/brain-store/location.ts";
import { readTopicsOf } from "../src/core/topics/read.ts";
import { armProcessCeiling, decisionWaitMs, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { readHookStamp, updateHookState } from "./lib/session-state.ts";
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { resolveHookTarget } from "./lib/hook-vault.ts";

/** The whole lane's budget: the decision request gets the rest of it. */
export const LANE_BUDGET_MS = 1500;

/**
 * How long the lane may still wait on the decision model, `elapsedMs`
 * after the hook started under a ceiling of `ceilingMs`: the rest of the
 * lane's budget, and never past half the ceiling, so a hung provider gives
 * way to the deterministic gate while there is still time to emit.
 */
export function neighbourDecisionWaitMs(ceilingMs: number, elapsedMs: number): number {
  return Math.min(Math.max(0, LANE_BUDGET_MS - elapsedMs), decisionWaitMs(ceilingMs, elapsedMs));
}

async function main(): Promise<void> {
  const ceilingMs = resolveHookCeilingMs();
  const disarm = armProcessCeiling({ ceilingMs });
  const startedAt = Date.now();
  try {
    if (!resolveNeighbourUpdatesEnabled()) return;
    const target = resolveHookTarget();
    if (target === null) return;

    let payload;
    try {
      payload = asHookPayload(await readHookInput());
    } catch {
      return;
    }
    const sessionId =
      typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : null;
    if (sessionId === null) return;
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

    const config = resolveSearchConfig({ vault: target.hasVault ? target.vault : null });
    const device = readDeviceId();
    if (device === null || device === "") return;
    const agent = resolveAgentName();

    if (config.brainStore === null || config.brainStore === undefined) return;
    const stored = readHookStamp(target.vault, sessionId, NEIGHBOUR_CURSOR_KEY);
    const storedData = stored?.data as { cursor?: unknown; watermark?: unknown } | undefined;
    const storedCursor = isTopicCursor(storedData?.cursor) ? storedData.cursor : undefined;
    const since = typeof storedData?.watermark === "string" ? storedData.watermark : undefined;
    // The same rule the writer stamps by: the launcher's name for the
    // session when set, else the payload's id (`session-identity.ts`).
    const session = sessionStamp({ env: process.env, hostSessionId: sessionId });
    if (session === null) return;
    const self = { device, agent, session };
    const storeRootPath = resolveConfiguredStoreRoot().root;
    const inspection = inspectStore(storeRootPath);
    if (inspection === null) return;
    // The topics shards past this session's cursor, read straight from the
    // store: no lock, no catch-up, no other stream (`topic-tail.ts`).
    // The index, read only and before the shards: its head is stored as the
    // watermark the cut line's `brain_changes` call names, and reading it
    // first keeps every record at or under that head inside what the
    // shard read below sees (a record written in between is past both,
    // or past the head only), so the pointer never skips a record the
    // cursor passed. It also gives this device and agent's newest own
    // records, which seed the session's topics. A busy, missing or stale
    // index costs neither the turn nor its updates.
    const indexed = readIndexView(config, self, OWN_RECORDS_MAX);
    const tail = readTopicTail(inspection.root, [...inspection.partitions], storedCursor);
    const watermark = indexed?.watermark ?? since;
    // The topics this session works on (design D20 item 17): those the
    // earlier turns stored, those of this device and agent's newest own
    // records the index holds, so an old own record still counts, and
    // those of the own records just read.
    const sessionTopics = new Set<string>([
      ...readSessionTopics(target.vault, sessionId),
      ...(indexed?.own ?? []).flatMap((r) => (r.topic === null ? [] : [r.topic])),
      ...tail.records.flatMap(({ record }) =>
        record.device === device && record.agent === agent && record.topic !== null
          ? [record.topic]
          : [],
      ),
    ]);
    if (tail.reseed) {
      // First prompt of the session, or a state that expired: start at the
      // end of every shard, inject nothing. The topics this device and
      // agent recorded on before join the session's, read once from this
      // device's own topics shards, since the index may not hold them yet.
      for (const topic of ownTopicsOf(inspection, device, agent)) sessionTopics.add(topic);
      // A session open across the update from the index reader still holds
      // that reader's watermark: what arrived since its last turn is not
      // read here, so one line names the call that lists it, once.
      const legacy = legacyWatermark(target.vault, sessionId);
      if (legacy !== undefined) {
        emit(
          "_Neighbour updates now read the store directly. What other sessions recorded " +
            `since this session's last turn was not read: \`brain_changes\` since ${legacy} ` +
            "lists it among every record written since then._",
        );
      }
      storeCursor(target.vault, sessionId, tail.cursor, watermark, [...sessionTopics]);
      return;
    }
    // The candidate kinds, the newest NEIGHBOUR_PROBE_ROWS of them.
    const kinds = tail.records.filter(({ record }) =>
      (NEIGHBOUR_KINDS as ReadonlyArray<string>).includes(record.kind),
    );
    const kept = kinds.slice(0, NEIGHBOUR_PROBE_ROWS);
    const skipped = kinds.length - kept.length;
    const rows = kept.map((r, i) => rowOf(r, kept.length - i));
    // Candidate rows the read's limit left out: said in one line, with the
    // call that lists them. The count is of every topic and project (the
    // limit applies before the session's filter), and `brain_changes`
    // lists them among every other record since the last turn's index head.
    const skippedLine =
      skipped > 0
        ? `_${skipped} older topic ${skipped === 1 ? "record" : "records"}, ` +
          `on any topic or project, arrived since the last turn and ` +
          `${skipped === 1 ? "was" : "were"} not read. ` +
          (since !== undefined
            ? `\`brain_changes\` since ${since} lists them among every record written since then._`
            : "`brain_topic` action `list` names the topics they belong to._")
        : "";

    const workspaceDir =
      typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : null;
    const projectScope = workspaceDir === null ? null : scopedRuleKey(basename(workspaceDir));

    // Keep the groups whose topic is this session's or whose scope is the
    // session's project, before any cap; the candidates carry topic ids.
    const scoped = rows.filter((row) => {
      if (row.topic !== null && sessionTopics.has(row.topic)) return true;
      if (projectScope === null || row.scope === null) return false;
      // Both sides through one normalisation: the topic scopes are slug
      // keys, the session's project a scoped-rule key (design D20).
      const left = scopedRuleKey(row.scope.replace(/^project:/, ""));
      return left !== null && left === projectScope;
    });
    if (scoped.length === 0) {
      emit(skippedLine);
      storeCursor(target.vault, sessionId, tail.cursor, watermark, [...sessionTopics]);
      return;
    }

    // The fold gives titles and record texts; read it only now.
    const topics = readTopicsOf(inspection);
    if (topics.unreadable.length > 0) return;
    // A model-derived item is its source's text: never returned to the
    // agent that wrote the source (spec: own records are never returned).
    const neighbours = selectNeighbourCandidates(scoped, self, topics.recordSessions);
    const sourceIds = neighbours
      .map((row) => topics.recordSources.get(row.id))
      .filter((id): id is string => id !== undefined);
    const sources = new Map((indexRows(config, sourceIds) ?? []).map((r) => [r.id, r]));
    const filtered = neighbours
      .filter((row) => {
        const sourceId = topics.recordSources.get(row.id);
        if (sourceId === undefined) return true;
        // The source's writer: from the topics records read (the source of
        // a derived item is often one), else from the index. When neither
        // knows it (a record the index has not ingested yet), whose it is
        // cannot be told, and the item is left out rather than risk
        // showing a session its own text.
        const source = topics.recordWriters.get(sourceId) ?? sources.get(sourceId);
        if (source === undefined) return false;
        return !isOwnRecord(source, topics.recordSessions.get(sourceId), self);
      })
      .map((row) => candidateOf(row, topics))
      .filter((c): c is NeighbourCandidate => c !== null);
    const { kept: candidates, capped } = capNeighbourCandidates(filtered);
    if (candidates.length === 0) {
      emit(skippedLine);
      storeCursor(target.vault, sessionId, tail.cursor, watermark, [...sessionTopics]);
      return;
    }

    // Own records the fold assigns (not only the envelope's topic) join
    // the session's topics too.
    const ownIds = [
      ...(indexed?.own ?? []).map((r) => r.id),
      ...tail.records
        .filter(({ record }) => record.device === device && record.agent === agent)
        .map(({ record }) => record.id),
    ];
    for (const id of ownIds) {
      const assigned = topics.fold.assignments.get(id);
      if (assigned !== undefined && assigned !== null) sessionTopics.add(assigned);
    }

    const remaining = neighbourDecisionWaitMs(ceilingMs, Date.now() - startedAt);
    const decision = await runNeighbourRelevant({
      config: resolveDecisionModelConfig({
        config: discoverConfig().data,
        vault: target.hasVault ? target.vault : null,
      }),
      candidates,
      prompt,
      remainingMs: remaining,
    });
    // A candidate the model judged under enforce passes on its answer;
    // one it did not judge (withheld as private, cut to fit the state
    // budget, an invalid answer) keeps the deterministic gate.
    const gate = (candidate: NeighbourCandidate): boolean =>
      decision.applied && decision.judged.has(candidate.record)
        ? decision.relevant.has(candidate.record)
        : deterministicNeighbourGate(candidate, sessionTopics);

    const block = renderNeighbourBlock(
      candidates,
      gate,
      (dropped) =>
        budgetCutLine({
          dropped,
          what: "neighbour updates",
          whatOne: "neighbour update",
          command:
            since !== undefined
              ? `Fetch them with \`brain_changes\` since ${since}`
              : "Open their topics with `brain_topic` action `show`",
        }),
      capped,
    );
    // The block and the cursor that moves past it, in one synchronous step:
    // the process ceiling fires only between tasks, so a turn either shows
    // the whole block and moves its cursor or does neither (a turn cut
    // before this point shows its updates on the next one).
    emit([block.body, skippedLine].filter((part) => part !== "").join("\n"));
    storeCursor(target.vault, sessionId, tail.cursor, watermark, [...sessionTopics]);
  } catch {
    // Fail-open: exit 0 with no output; the cursor is unchanged.
  } finally {
    disarm();
  }
}

/**
 * Write `body` fenced as the hook's context; nothing for an empty body.
 * Synchronous, so the process ceiling cannot end the process with half of
 * it written.
 */
function emit(body: string): void {
  if (body === "") return;
  const bytes = Buffer.from(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: fenceUntrustedContent(body, "neighbour-updates"),
      },
    }),
  );
  let written = 0;
  while (written < bytes.length) written += writeSync(1, bytes, written);
}

function storeCursor(
  vault: string,
  sessionId: string,
  cursor: TopicCursor,
  watermark: string | undefined,
  topics: string[],
): void {
  // The stamps are session-scoped and device-local. A session resumed
  // after a day without a prompt finds them expired and starts again at
  // the end of every shard: what its neighbours wrote in that day is not
  // replayed.
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  updateHookState(vault, sessionId, (state) => {
    // The index reader's stamp is spent once the cursor exists.
    delete state[LEGACY_WATERMARK_KEY];
    state[NEIGHBOUR_CURSOR_KEY] = {
      expiresAt,
      data: { cursor, ...(watermark !== undefined ? { watermark } : {}) },
    };
    state["neighbour_topics"] = { expiresAt, data: { topics } };
    return { state, result: null };
  });
}

/** The topics of every topics record this device and agent wrote, from this device's shards. */
function ownTopicsOf(
  inspection: NonNullable<ReturnType<typeof inspectStore>>,
  device: string,
  agent: string,
): string[] {
  const out = new Set<string>();
  for (const partition of inspection.partitions) {
    try {
      const read = readStreamRecords(inspection.root, partition, { stream: "topics" }, { device });
      for (const record of read.records) {
        if (record.agent === agent && record.topic !== null) out.add(record.topic);
      }
    } catch {
      // An unreadable shard seeds nothing; the session's own next record does.
    }
  }
  return [...out];
}

/** The hook-state key the index reader (before the cursor) kept its watermark under. */
const LEGACY_WATERMARK_KEY = "neighbour_watermark";

/** The index reader's watermark this session still holds, or undefined. */
function legacyWatermark(vault: string, sessionId: string): string | undefined {
  const data = readHookStamp(vault, sessionId, LEGACY_WATERMARK_KEY)?.data as
    | { watermark?: unknown }
    | undefined;
  return typeof data?.watermark === "string" ? data.watermark : undefined;
}

/** The hook-state key of the session's topics cursor. */
const NEIGHBOUR_CURSOR_KEY = "neighbour_cursor";

function isTopicCursor(value: unknown): value is TopicCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as { id?: unknown }).id === "string" &&
      Number.isSafeInteger((e as { offset?: unknown }).offset) &&
      (e as { offset: number }).offset >= 0 &&
      ((e as { hlc?: unknown }).hlc === undefined ||
        typeof (e as { hlc?: unknown }).hlc === "string"),
  );
}

/** A record read from a shard as the row the lane filters (`seq`: newest highest). */
function rowOf({ record, partition }: TopicTailRecord, seq: number): NeighbourRecordRow {
  return {
    id: record.id,
    seq,
    stream: "topics",
    kind: record.kind,
    topic: record.topic,
    scope: record.scope,
    device: record.device,
    agent: record.agent,
    partition,
    authority: recordAuthority(record),
  };
}

/**
 * The index, opened read-only without a catch-up: its head as a watermark
 * (`<generation>.<seq>`) and this device and agent's newest `ownLimit`
 * records. Null when there is no index or it cannot be read now.
 */
function readIndexView(
  config: ReturnType<typeof resolveSearchConfig>,
  self: { readonly device: string; readonly agent: string },
  ownLimit: number,
): { readonly watermark: string | undefined; readonly own: NeighbourRecordRow[] } | null {
  try {
    const storePath = probeIndexedStore(resolveConfiguredStoreRoot().root);
    if (storePath === null) return null;
    const dbPath = storeIndexPath(storePath, config.vault ?? null);
    if (!existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    try {
      const generation = getState(db, STORE_INDEX_GENERATION_KEY);
      const head = headSeq(db);
      const own = ownRecordsTail(db, self, head, ownLimit);
      return { watermark: generation === null ? undefined : `${generation}.${head}`, own };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Most candidate rows one turn reads (stream `topics`, the neighbour
 * kinds, this session's own included); older ones are counted and named.
 */
const NEIGHBOUR_PROBE_ROWS = 2000;

/** Most own records the session's topics are seeded from. */
const OWN_RECORDS_MAX = 500;

/** The index record rows of `ids`, in the order given; missing ids are skipped. */
function indexRows(
  config: ReturnType<typeof resolveSearchConfig>,
  ids: ReadonlyArray<string>,
): NeighbourRecordRow[] | null {
  if (ids.length === 0) return [];
  try {
    const storeRootPath = resolveConfiguredStoreRoot().root;
    const storePath = probeIndexedStore(storeRootPath);
    if (storePath === null) return null;
    const dbPath = storeIndexPath(storePath, config.vault ?? null);
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows: NeighbourRecordRow[] = [];
      for (const id of ids) {
        const row = getRecord(db, id);
        if (row !== null) rows.push(row);
      }
      return rows;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The session's topics the earlier turns stored. */
function readSessionTopics(vault: string, sessionId: string): string[] {
  const stored = readHookStamp(vault, sessionId, "neighbour_topics");
  const topics = (stored?.data as { topics?: unknown } | undefined)?.topics;
  return Array.isArray(topics) ? topics.filter((t): t is string => typeof t === "string") : [];
}

/**
 * The candidate's fold text, topic title and privacy, or null without the
 * topic or for a routine log entry (never a candidate).
 */
function candidateOf(
  row: NeighbourRecordRow,
  topics: ReturnType<typeof readTopicsOf>,
): NeighbourCandidate | null {
  if (row.topic === null) return null;
  const topic = topics.fold.topics.get(row.topic);
  if (topic === undefined) return null;
  const item = topic.items.find((i) => i.author.record === row.id);
  if (row.kind === "log-entry" && item?.logClass === "routine") return null;
  return {
    record: row.id,
    kind: row.kind,
    topic: row.topic,
    topicTitle: topic.title,
    text: item?.text ?? null,
    seq: row.seq,
    device: row.device,
    agent: row.agent,
    private: row.partition === "private" || topic.private || item?.private === true,
    titlePrivate: topic.private || topic.privateFields.title,
    ...(row.authority === "model" ? { modelDerived: true } : {}),
    ...(row.kind === "log-entry" && item?.logClass !== undefined
      ? { logClass: item.logClass }
      : {}),
  };
}

if (import.meta.main) {
  await main();
}

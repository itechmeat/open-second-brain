#!/usr/bin/env -S bun
/**
 * UserPromptSubmit hook: neighbour updates (task 4.3, design D5, D10
 * `neighbour_relevant`). On by default when a brain store is in use;
 * `neighbour_updates_enabled: "false"` turns it off. Before each turn it
 * asks the index for the candidate records other devices wrote since this
 * session's last prompt (`probeNeighbours`: stream `topics`, the
 * neighbour kinds, never this device and agent), keeps those on topics
 * this session works on or in its project scope, gates them
 * deterministically (topic this session works on and kind `decision`),
 * refines the gate with the `neighbour_relevant` use, and injects at
 * most five fenced lines naming the record and how to open it.
 *
 * Own records are never returned (same device and same resolved agent
 * name, as `log-catchup` resolves "me"; a model-derived item counts as
 * its source's). The first prompt of a session, the first after an index
 * rebuild and the first after the state expired (a day without a prompt)
 * store the head watermark and inject nothing; later turns read every
 * candidate up to the head, the newest 2000 of them, and say in one line
 * how many older ones were not read and which call lists them. The session's
 * topics are those of its own newest records, asked from the index each
 * turn. Candidates are filtered by the session's topics and project
 * before the candidate cap, and what the cap removes is counted in the
 * cut line. A candidate the model did not judge under `enforce` keeps the
 * deterministic gate. The new watermark is
 * stored after stdout, whether or not anything was injected. Fail-open:
 * any error or timeout exits 0 with no output and leaves the watermark
 * unchanged.
 */

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
import { probeNeighbours } from "../src/core/search/brain-store/neighbour-probe.ts";
import { getRecord } from "../src/core/search/store/brain-records.ts";
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
const LANE_BUDGET_MS = 1500;

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

    const stored = readHookStamp(target.vault, sessionId, "neighbour_watermark");
    const storedData = stored?.data as { watermark?: unknown } | undefined;
    const storedWatermark = storedData === undefined ? undefined : storedData.watermark;
    const since = typeof storedWatermark === "string" ? storedWatermark : undefined;
    const self = { device, agent };
    const probe = await probeNeighbours(config, {
      since,
      self,
      stream: "topics",
      kinds: NEIGHBOUR_KINDS,
      limit: NEIGHBOUR_PROBE_ROWS,
      ownLimit: OWN_RECORDS_MAX,
    });
    if (probe === null) return;
    const { watermark } = probe;
    // The topics this session works on (design D20 item 17): those the
    // earlier turns stored and those of this device and agent's newest own
    // records, asked from the index, so an old own record still counts.
    const sessionTopics = new Set<string>([
      ...readSessionTopics(target.vault, sessionId),
      ...probe.own.flatMap((r) => (r.topic === null ? [] : [r.topic])),
    ]);
    if (probe.reseed) {
      // First prompt of the session, a state that expired, or an index
      // rebuilt since the last one: start at the head, inject nothing.
      storeWatermark(target.vault, sessionId, watermark, [...sessionTopics]);
      return;
    }
    const candidates0 = selectNeighbourCandidates(probe.candidates, self);
    // Candidate rows the probe's limit left out: said in one line, with
    // the call that lists them. The count is of every topic and project
    // (the limit applies before the session's filter), and `brain_changes`
    // lists them among every other record since the old watermark.
    const skippedLine =
      probe.skipped > 0 && since !== undefined
        ? `_${probe.skipped} older topic ${probe.skipped === 1 ? "record" : "records"} from ` +
          `other devices, on any topic or project, arrived since the last turn and ` +
          `${probe.skipped === 1 ? "was" : "were"} not read. \`brain_changes\` since ${since} ` +
          `lists them among every record written since then._`
        : "";

    const workspaceDir =
      typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : null;
    const projectScope = workspaceDir === null ? null : scopedRuleKey(basename(workspaceDir));

    // Keep the groups whose topic is this session's or whose scope is the
    // session's project, before any cap; the candidates carry topic ids.
    const scoped = candidates0.filter((row) => {
      if (row.topic !== null && sessionTopics.has(row.topic)) return true;
      if (projectScope === null || row.scope === null) return false;
      // Both sides through one normalisation: the topic scopes are slug
      // keys, the session's project a scoped-rule key (design D20).
      const left = scopedRuleKey(row.scope.replace(/^project:/, ""));
      return left !== null && left === projectScope;
    });
    if (scoped.length === 0) {
      emit(skippedLine);
      storeWatermark(target.vault, sessionId, watermark, [...sessionTopics]);
      return;
    }

    // The fold gives titles and record texts; read it only now.
    const storeRootPath = resolveConfiguredStoreRoot().root;
    const storePath = probeIndexedStore(storeRootPath);
    if (storePath === null) return;
    const inspection = inspectStore(storePath.root);
    if (inspection === null) return;
    const topics = readTopicsOf(inspection);
    if (topics.unreadable.length > 0) return;
    // A model-derived item is its source's text: never returned to the
    // agent that wrote the source (spec: own records are never returned).
    const sourceIds = scoped
      .map((row) => topics.recordSources.get(row.id))
      .filter((id): id is string => id !== undefined);
    const sources = new Map((indexRows(config, sourceIds) ?? []).map((r) => [r.id, r]));
    const filtered = scoped
      .filter((row) => {
        const sourceId = topics.recordSources.get(row.id);
        const source = sourceId === undefined ? undefined : sources.get(sourceId);
        return !(
          source !== undefined &&
          source.device === self.device &&
          source.agent === self.agent
        );
      })
      .map((row) => candidateOf(row, topics))
      .filter((c): c is NeighbourCandidate => c !== null);
    const { kept: candidates, capped } = capNeighbourCandidates(filtered);
    if (candidates.length === 0) {
      emit(skippedLine);
      storeWatermark(target.vault, sessionId, watermark, [...sessionTopics]);
      return;
    }

    // Own records the fold assigns (not only the envelope's topic) join
    // the session's topics too.
    for (const row of probe.own) {
      if (row.device !== self.device || row.agent !== self.agent) continue;
      const assigned = topics.fold.assignments.get(row.id);
      if (assigned !== undefined && assigned !== null) sessionTopics.add(assigned);
    }

    // Inside the process ceiling too: a hung provider gives way to the
    // deterministic gate while there is still time to emit.
    const elapsed = Date.now() - startedAt;
    const remaining = Math.min(
      Math.max(0, LANE_BUDGET_MS - elapsed),
      decisionWaitMs(ceilingMs, elapsed),
    );
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
          command: `Fetch them with \`brain_changes\` since ${since}`,
        }),
      capped,
    );
    emit([block.body, skippedLine].filter((part) => part !== "").join("\n"));
    storeWatermark(target.vault, sessionId, watermark, [...sessionTopics]);
  } catch {
    // Fail-open: exit 0 with no output; the watermark is unchanged.
  } finally {
    disarm();
  }
}

/** Write `body` fenced as the hook's context; nothing for an empty body. */
function emit(body: string): void {
  if (body === "") return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: fenceUntrustedContent(body, "neighbour-updates"),
      },
    }),
  );
}

function storeWatermark(
  vault: string,
  sessionId: string,
  watermark: string,
  topics: string[],
): void {
  // The stamps are session-scoped and device-local. A session resumed
  // after a day without a prompt finds them expired and re-seeds at the
  // head: what its neighbours wrote in that day is not replayed.
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  updateHookState(vault, sessionId, (state) => {
    state["neighbour_watermark"] = { expiresAt, data: { watermark } };
    state["neighbour_topics"] = { expiresAt, data: { topics } };
    return { state, result: null };
  });
}

/**
 * Most candidate rows one turn reads (stream `topics`, the neighbour
 * kinds, never this device and agent); older ones are counted and named.
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

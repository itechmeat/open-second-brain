/**
 * `human_readable` of the dream-time decide pass (design D10): asks
 * whether each `note` log event of `shared` from the last eight ISO
 * weeks belongs in the person's weekly history. One file per use
 * family; the shared context lives in `decide-shared.ts`, the writes
 * happen under the planning lock (`verdict-writes.ts`), and the history
 * renderer reads the stored `history-verdict` records (`pages.ts`).
 */

import type { DecisionNoulQuestion } from "../decision-model/contract.ts";
import { mayStartRequest } from "../decision-model/request-floor.ts";
import {
  HUMAN_READABLE_QUESTIONS,
  TOPIC_DECISION_LIMITS,
} from "../decision-model/questions-topics.ts";
import { mayShareRecord } from "../decision-model/egress-guard.ts";
import { runDecision } from "../decision-model/run.ts";
import { appliedThreshold } from "../decision-model/use-thresholds.ts";
import { buildCandidateState } from "../decision-model/state.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import { LOG_EVENT_KIND } from "../store/constants.ts";
import { parseHlc } from "../store/hlc.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import type { StoreRecord } from "../store/envelope.ts";
import {
  DECIDE_LOOKBACK_MS,
  newestPresentFirst,
  requestOptions,
  WITHHELD_ID,
  type PassContext,
  requestTimeoutMs,
} from "./decide-shared.ts";
import { verdictBody } from "./verdicts.ts";
import { judgedHistoryNotes } from "./verdict-writes.ts";

/** How far back the pass asks: eight ISO weeks. */
export const HISTORY_LOOKBACK_MS = DECIDE_LOOKBACK_MS;

/**
 * The `note` log events of `shared` the pass asks about, newest first,
 * a note dated after `nowMs` after every present one. A note carrying a
 * `<private>` region is left out.
 */
export function historyNoteCandidates(
  shared: ReadonlyArray<StoreRecord>,
  nowMs: number,
): Array<{ id: string; text: string; at: number }> {
  const notes: Array<{ id: string; text: string; at: number }> = [];
  // A note with any stored `history-verdict` (kept or hidden) is settled.
  const judged = judgedHistoryNotes(shared);
  for (const record of shared) {
    if (record.kind !== LOG_EVENT_KIND) continue;
    if (record.body["event_type"] !== "note") continue;
    if (judged.has(record.id)) continue;
    const payload = record.body["body"];
    const text =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["text"]
        : undefined;
    if (typeof text !== "string" || text === "") continue;
    // A note that carries a `<private>` region counts as private, and its
    // verdict could only be shared (the pages read `shared`): not asked.
    if (valueCarriesPrivateRegion(record.body)) continue;
    // The record's own timestamp decides (as the pages read it); the
    // HLC's physical part is only the fallback - a synced record's HLC
    // can be newer than the moment it speaks of.
    const stamp = record.body["timestamp"];
    const at =
      typeof stamp === "string" && Number.isFinite(Date.parse(stamp))
        ? Date.parse(stamp)
        : (parseHlc(record.hlc)?.physical ?? 0);
    if (nowMs - at > HISTORY_LOOKBACK_MS) continue;
    notes.push({ id: record.id, text, at });
  }
  // Newest first: a new note is never queued behind older ones. A note
  // dated after the run (a device with a fast clock) comes after every
  // present one, as the record uses order theirs.
  return newestPresentFirst(notes, nowMs);
}

/**
 * `human_readable` (design D10): `noul` per note, id `history_<k>`,
 * batched one request per `recordsPerRequest` notes, the state
 * `{ records: { R0..: text } }`. p(yes) below `hide_below` becomes a
 * hidden verdict; the `history-verdict` record is written under the
 * planning lock and `historyPages` leaves that note out. Decisions and
 * confirmed rules are never asked about and never hidden. Everything
 * else - off, shadow, timeout, below threshold - keeps today's page.
 */
async function decideHistory(ctx: PassContext, shared: ReadonlyArray<StoreRecord>): Promise<void> {
  const use = "human_readable" as const;
  const notes = historyNoteCandidates(shared, ctx.at()).slice(
    0,
    TOPIC_DECISION_LIMITS.historyNotesPerPass,
  );
  for (let i = 0; i < notes.length; i += TOPIC_DECISION_LIMITS.recordsPerRequest) {
    if (!mayStartRequest(ctx.clock(), ctx.until, ctx.cfg.timeoutMs)) return;
    // Sequential by design: the budget is checked before every request.
    // oxlint-disable-next-line no-await-in-loop
    await runHistoryRequest(ctx, use, notes.slice(i, i + TOPIC_DECISION_LIMITS.recordsPerRequest));
  }
}

async function runHistoryRequest(
  ctx: PassContext,
  use: "human_readable",
  notes: ReadonlyArray<{ id: string; text: string; at: number }>,
): Promise<void> {
  const built = buildCandidateState({
    candidates: notes.map((note) => ({
      text: note.text,
      visibility: mayShareRecord(ctx.cfg, use, false) ? [] : [REMOTE_DENY_VISIBILITY_TOKEN],
      privateRegions: [],
    })),
    prefix: HUMAN_READABLE_QUESTIONS.notePrefix,
    clipChars: TOPIC_DECISION_LIMITS.recordClipChars,
    maxStateTokens: ctx.cfg.maxStateTokens,
    frame: (texts) => ({ records: texts }),
  });
  if (built.kind !== "ok") return;
  const context = { map: new Map<number, (typeof notes)[number]>() };
  built.included.forEach((candidateIndex, k) => context.map.set(k, notes[candidateIndex]!));
  const questions: Record<string, DecisionNoulQuestion> = {};
  for (const [k] of context.map) {
    questions[HUMAN_READABLE_QUESTIONS.historyId(k)] = HUMAN_READABLE_QUESTIONS.history(k);
  }
  const result = await runDecision<{ map: Map<number, (typeof notes)[number]> }>(
    use,
    () => ({
      kind: "ok",
      state: built.state,
      candidateCount: built.included.length,
      context,
    }),
    () => questions,
    {
      config: ctx.cfg,
      timeoutMs: requestTimeoutMs(ctx),
      ...requestOptions(ctx, (response, builtContext, answeredBy) => {
        const details: Record<string, unknown> = {
          record_ids: notes.map((note) =>
            mayShareRecord(ctx.cfg, use, false) ? note.id : WITHHELD_ID,
          ),
        };
        if (response === null || builtContext === null) return details;
        const probabilities: Array<number | null> = [];
        const hidden: string[] = [];
        const hideBelow = appliedThreshold(ctx.cfg, use, answeredBy.model, "hide_below");
        for (const [k, note] of (builtContext as { map: Map<number, (typeof notes)[number]> })
          .map) {
          const p = response.answers[HUMAN_READABLE_QUESTIONS.historyId(k)] as
            | { value: unknown; valid?: boolean }
            | undefined;
          const value =
            p !== undefined && p.valid === true && typeof p.value === "number" ? p.value : null;
          probabilities.push(value);
          if (value !== null && value < hideBelow) hidden.push(note.id);
        }
        details["probabilities"] = probabilities;
        details["hidden"] = hidden;
        return details;
      }),
    },
  );
  if (result.status !== "ok" || result.mode !== "enforce") return;
  const hideBelow = appliedThreshold(ctx.cfg, use, result.answeredBy.model, "hide_below");
  for (const [k, note] of context.map) {
    const a = result.response.answers[HUMAN_READABLE_QUESTIONS.historyId(k)];
    const p = a !== undefined && a.valid === true && typeof a.value === "number" ? a.value : null;
    if (p === null) continue;
    const verdict = verdictBody(use, result.response, result.answeredBy.provider, p);
    if (p < hideBelow) ctx.out.hidden.set(note.id, verdict);
    else ctx.out.kept.set(note.id, verdict);
  }
}

export { decideHistory };

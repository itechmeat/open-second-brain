/**
 * The distilled and undistilled census over imported sessions
 * (session-mining-economy, t_0358af42).
 *
 * The import ledger (`sessions/discover.ts`) knows what was imported; the
 * mining ledger (`session-mining-ledger.ts`) knows what was mined and with
 * what yield. This module joins the two and classifies every imported
 * session, so "how much of my imported backlog was never distilled" is one
 * read, not a re-scan of every transcript on the machine:
 *
 *   - `distilled` - mined with accepted yield (written or staged > 0) on
 *     the session's CURRENT turn material;
 *   - `known-nothing-new` - mined barren on the current material (the
 *     tombstone: every item deduped or durability-rejected). This is a
 *     different state from backlog - the session is known, it just had
 *     nothing new to say;
 *   - `undistilled` - never mined, or mined on material that has since
 *     changed (a re-import changed the turns, which changes the mined
 *     content hash and re-opens the session with no clearing step);
 *   - `refused` - sessions the plan would refuse (capture boundary, zero
 *     imported turns, zero user turns). They can never be distilled, so
 *     they are excluded from the backlog: counting them would nag forever
 *     about unparsable material.
 *
 * ## The join is the portable identity, and the reads are vault-side
 *
 * The import ledger's keys are absolute machine paths; the mining ledger is
 * keyed by the portable `sessionRefIdentity` basename, which is what the
 * mining lane and every written signal's `session_ref` already carry. The
 * census joins on that basename, so a session whose log moved to another
 * absolute path (a rotated store, another machine's layout) still joins.
 * No source log is opened or re-hashed here: the mined-material hash runs
 * over the continuity turns the mining lane itself reads, which is what
 * makes the census answerable inside a SessionStart hook's budget. The
 * census reads only - neither ledger is rewritten, and a report that
 * quietly rewrote the state it reports on would not be a report.
 */

import { basename } from "node:path";

import { selectMinedTurns } from "../extract-signals.ts";
import { buildCaptureBoundary, type CaptureBoundary } from "../capture-boundary.ts";
import {
  minedTurnsHash,
  readSessionMiningLedger,
  type MinedTurnMaterial,
  type SessionMiningEntry,
} from "../session-mining-ledger.ts";
import type { Safeguard } from "../safeguard.ts";
import { listSessionRawTurns } from "../session-recall.ts";
import { readSessionLedger } from "./discover.ts";
import type { SessionRuntimeId } from "../../runtime/host-facts.ts";

/** Where an imported session stands with respect to distillation. */
export type SessionDistillationState = "distilled" | "known-nothing-new" | "undistilled";

/** One runtime's backlog: how much of what it imported is still undistilled. */
export interface RuntimeMiningCensus {
  readonly runtime: SessionRuntimeId;
  /** Every session the import ledger records under this runtime. */
  readonly imported: number;
  readonly distilled: number;
  readonly knownNothingNew: number;
  readonly undistilled: number;
  /**
   * Sessions the mining plan would refuse (boundary, zero imported turns,
   * zero user turns). Excluded from the backlog by construction;
   * `imported = distilled + knownNothingNew + undistilled + refused`.
   */
  readonly refused: number;
  /** The undistilled sessions' portable ids, sorted. */
  readonly undistilledSessionIds: ReadonlyArray<string>;
}

/** The vault-wide distilled and undistilled census. */
export interface SessionMiningCensus {
  readonly imported: number;
  readonly distilled: number;
  readonly knownNothingNew: number;
  readonly undistilled: number;
  readonly refused: number;
  /** One row per runtime the import ledger records, sorted by runtime id. */
  readonly byRuntime: ReadonlyArray<RuntimeMiningCensus>;
}

export interface BuildMiningCensusOptions {
  /**
   * Cooperative deadline, checked once per imported session. The census is
   * vault-side and never hashes a source log, but a vault with tens of
   * thousands of imported sessions still spends one turn listing per
   * session; a caller with a host deadline (the SessionStart hook) passes
   * its ceiling here so the read stops in time.
   */
  readonly safeguard?: Safeguard;
}

/**
 * Build the census. A corrupt or unknown-schema IMPORT ledger or MINING
 * record refuses by name (each read's own contract): a census that could
 * not verify one of its two sources must not report a clean backlog as if
 * the state were empty.
 */
export function buildMiningCensus(
  vault: string,
  opts: BuildMiningCensusOptions = {},
): SessionMiningCensus {
  const importedEntries = readSessionLedger(vault).entries;
  const miningEntries = readSessionMiningLedger(vault).entries;
  const boundary = buildCaptureBoundary(vault);

  // One identity can sit under several absolute paths (the same basename
  // imported from two machines' layouts); its state is a fact about the
  // identity, so it is classified once and applied to every path entry.
  const stateByIdentity = new Map<string, SessionDistillationState | "refused">();
  const stateOf = (identity: string): SessionDistillationState | "refused" => {
    const cached = stateByIdentity.get(identity);
    if (cached !== undefined) return cached;
    const state = classifySession(vault, boundary, miningEntries, identity);
    stateByIdentity.set(identity, state);
    return state;
  };

  interface Row {
    imported: number;
    refused: number;
    states: Record<SessionDistillationState, number>;
    ids: Set<string>;
  }
  const rows = new Map<SessionRuntimeId, Row>();
  const rowOf = (runtime: SessionRuntimeId): Row => {
    const existing = rows.get(runtime);
    if (existing !== undefined) return existing;
    const fresh: Row = {
      imported: 0,
      refused: 0,
      states: { distilled: 0, "known-nothing-new": 0, undistilled: 0 },
      ids: new Set(),
    };
    rows.set(runtime, fresh);
    return fresh;
  };

  for (const [path, entry] of Object.entries(importedEntries)) {
    opts.safeguard?.checkpoint();
    // The join identity is the portable sessionRefIdentity basename - what
    // the mining lane keys its tombstone and every signal's session_ref on
    // when the import pinned no explicit id. The import ledger's entry
    // does not carry the RESOLVED identity (an explicit --recall-session-id
    // import files its turns, tombstone and session_ref under the recall
    // id, not the basename), so such an import's mining state is invisible
    // to this join until the resolved id is recorded in the import ledger
    // itself; classifying the basename as refused here stays factually
    // right - the plan really would refuse it.
    const identity = basename(path);
    const state = stateOf(identity);
    const row = rowOf(entry.runtime);
    row.imported += 1;
    if (state === "refused") {
      row.refused += 1;
      continue;
    }
    row.states[state] += 1;
    if (state === "undistilled") row.ids.add(identity);
  }

  const byRuntime: RuntimeMiningCensus[] = [...rows.keys()].toSorted().map((runtime) => {
    const row = rows.get(runtime)!;
    return {
      runtime,
      imported: row.imported,
      distilled: row.states.distilled,
      knownNothingNew: row.states["known-nothing-new"],
      undistilled: row.states.undistilled,
      refused: row.refused,
      undistilledSessionIds: [...row.ids].toSorted(),
    };
  });
  const total = (pick: (row: RuntimeMiningCensus) => number): number =>
    byRuntime.reduce((sum, row) => sum + pick(row), 0);

  return {
    imported: total((row) => row.imported),
    distilled: total((row) => row.distilled),
    knownNothingNew: total((row) => row.knownNothingNew),
    undistilled: total((row) => row.undistilled),
    refused: total((row) => row.refused),
    byRuntime,
  };
}

/**
 * The mined turn material the plan would embed for one session, or `null`
 * when the session is one the plan refuses (boundary, zero imported turns,
 * zero user turns). The selection is the plan's own shared
 * {@link selectMinedTurns} - user role, unsuppressed text, trimmed and
 * non-empty, the turn's stored timestamp verbatim - so this census hashes
 * exactly what the plan would mine and cannot drift from it. `boundary` is
 * injectable so a caller walking many sessions builds it once.
 */
export function minedTurnMaterial(
  vault: string,
  sessionId: string,
  boundary: CaptureBoundary = buildCaptureBoundary(vault),
): ReadonlyArray<MinedTurnMaterial> | null {
  if (boundary.sessionDecision(sessionId) !== "capture") return null;
  const turns = listSessionRawTurns(vault, sessionId);
  if (turns.length === 0) return null;
  const mined = selectMinedTurns(boundary, turns);
  return mined.length === 0 ? null : mined;
}

/**
 * Classify one session identity: the plan's own refusal order (boundary
 * decision, zero imported turns, zero user turns), then the mining join.
 */
function classifySession(
  vault: string,
  boundary: ReturnType<typeof buildCaptureBoundary>,
  miningEntries: Readonly<Record<string, SessionMiningEntry>>,
  identity: string,
): SessionDistillationState | "refused" {
  const material = minedTurnMaterial(vault, identity, boundary);
  if (material === null) return "refused";
  const entry = miningEntries[identity];
  if (entry === undefined || entry.minedContentHash !== minedTurnsHash(material)) {
    return "undistilled";
  }
  return entry.outcome.written + entry.outcome.staged > 0 ? "distilled" : "known-nothing-new";
}

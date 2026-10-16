/**
 * The shared per-session mining record (session-mining-economy,
 * t_93617709).
 *
 * `planExtractSignals` is a pure read with no cross-run memory, so a
 * session that was mined once is rebuilt and re-offered to the calling
 * agent's model on every re-scan - repeated model spend, whether the mine
 * would yield anything or not. This ledger is the memory: every commit that
 * answers a plan records its outcome breakdown for the session, and the
 * plan gate consults the record before any decision-model work. A zero-
 * yield record (nothing written, nothing staged) is a tombstone that
 * suppresses the session by name; a yield record is the distilled state the
 * mining census reports, and suppresses nothing.
 *
 * ## The entry is keyed on content the mining lane actually holds
 *
 * The session import ledger (`sessions/discover.ts`) hashes the BYTES of a
 * source log and keys the hash on the log's absolute machine path. The
 * mining lane holds neither: `session_turn` continuity records carry no
 * source path and no hash, and the lane's session id is the portable
 * `sessionRefIdentity` basename, not a path. So the tombstone hashes the
 * mined turn material itself - exactly the (turn id, text, timestamp)
 * triples the plan embeds - under the portable id. The invalidation
 * semantics fall out for free: a re-import that changes a session's turns
 * changes the hash and re-opens the session with no clearing step, and a
 * session whose turns vanish leaves nothing for the gate to honor.
 *
 * ## The house ledger discipline, mirrored
 *
 * The shape is the import ledger's: schema-versioned, read fail-closed on
 * corrupt JSON or an unknown schema version (a silent reset would unsuppress
 * every barren session at once and send them all back to the model), written
 * under the same file lock with the vault-identity assertion, serialized
 * with sorted keys so a no-op rerun is byte-identical, and pruned of dead
 * entries at write time only, because a read that rewrote the state it read
 * would not be a read. The pruning here drops sessions with no imported
 * turns rather than files that no longer exist - the mining lane's
 * equivalent of a vanished path.
 *
 * The ledger is deterministic local state: no model, no network, no config
 * knob. Like the import ledger it is always on, because the spend it
 * prevents is the point of the feature.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { listContinuityRecords } from "./continuity/store.ts";
import { hashBytes } from "./ingest/content-manifest.ts";
import { DERIVED_STORE_DIR } from "./path-constants.ts";
import { listSessionRawTurns, sessionIdOf } from "./session-recall.ts";
import { acquireLockSyncWithRetry, ingestLockRemedy } from "./sync-lockfile.ts";
import { isoSecond } from "./time.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** Only ledger schema this build understands. Anything else is refused. */
export const SESSION_MINING_LEDGER_SCHEMA_VERSION = 1 as const;

/** Basename of the mining ledger inside the derived store. */
const SESSION_MINING_LEDGER_FILE = "session-mining-ledger.json";

/** Absolute path of the session mining ledger for a vault. */
export function sessionMiningLedgerPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, SESSION_MINING_LEDGER_FILE);
}

/** How the mined session ended, in the commit result's own vocabulary. */
export interface SessionMiningOutcome {
  /** Signals written straight to the inbox. */
  readonly written: number;
  /** Of those, the ones staged into `Brain/pending/` for approval. */
  readonly staged: number;
  /** Items refused because their dedup hash was already in the vault. */
  readonly deduped: number;
  /** Items the durability gate refused. */
  readonly durabilityRejected: number;
}

/**
 * The turn material the plan embeds, as far as the hash is concerned:
 * the turn's id, its trimmed text and its stored timestamp verbatim.
 * Structurally the plan's `MinedTurn`, kept separate so this module does
 * not import the mining lane that records into it.
 */
export interface MinedTurnMaterial {
  readonly turnId: string;
  readonly text: string;
  readonly timestamp: string;
}

/** What was recorded about one mined session. */
export interface SessionMiningEntry {
  /**
   * The portable session id. Carried inside the entry as well as under its
   * key so a record is self-describing: a census or an operator reading the
   * file needs no key context to attribute it, and an entry misfiled under
   * another session's key is unreadable rather than misattributed.
   */
  readonly sessionId: string;
  /** {@link minedTurnsHash} of the turn material the mine covered. */
  readonly minedContentHash: string;
  /**
   * The outcome breakdown the last commit over this material recorded.
   * Zero written and zero staged makes the entry a tombstone (the plan
   * gate's evidence); a yield makes it the distilled state the census
   * reports - the same field, read through two contracts.
   */
  readonly outcome: SessionMiningOutcome;
  /** When the commit recorded it, to the second. */
  readonly recordedAt: string;
}

/** Portable session id → what was recorded about mining it. */
export interface SessionMiningLedger {
  readonly schema_version: typeof SESSION_MINING_LEDGER_SCHEMA_VERSION;
  readonly entries: Readonly<Record<string, SessionMiningEntry>>;
}

/**
 * Read the ledger. A missing file is an empty ledger - no session is
 * tombstoned, which is the correct answer for a vault that has mined
 * nothing. A CORRUPT or unknown-schema file is a hard error: a silent reset
 * would unsuppress every barren session at once and re-offer all of them to
 * the model on the next scan. The entries container is held to the same
 * contract: a container that is absent, null, an array or a primitive is
 * file-level corruption and refuses by name, while damage to a SINGLE entry
 * drops that entry only.
 */
export function readSessionMiningLedger(vault: string): SessionMiningLedger {
  const path = sessionMiningLedgerPath(vault);
  if (!existsSync(path)) {
    return { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`session mining ledger is corrupted JSON: ${path}`, { cause: e });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`session mining ledger is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== SESSION_MINING_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `session mining ledger schema_version ${String(obj["schema_version"])} not supported ` +
        `(expected ${SESSION_MINING_LEDGER_SCHEMA_VERSION}): ${path}`,
    );
  }
  const entries: Record<string, SessionMiningEntry> = {};
  const raw = obj["entries"];
  // Container shape is file-level corruption, the same class as a corrupt
  // body or an unknown schema: a string, array, null or absent container
  // read as an empty ledger would silently unsuppress every barren session
  // at once, which is the outcome the hard errors exist to prevent. This is
  // different from per-ENTRY damage, which is dropped rather than guessed
  // at, because a dropped entry can only re-open one session for mining.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`session mining ledger entries is not an object: ${path}`);
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = readEntry(key, value);
    if (entry !== null) entries[key] = entry;
  }
  return { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries };
}

/**
 * One entry, or `null` when it is not one this build can read. An
 * unreadable entry is dropped rather than guessed at: treated as absent it
 * can only re-open a session for mining (the safe direction), while
 * suppressing a session on a half-readable record would hide material
 * behind corrupted state. An entry filed under a DIFFERENT session's key is
 * unreadable too - attributing it to the key it sits under would suppress
 * one session on another session's evidence.
 */
function readEntry(key: string, value: unknown): SessionMiningEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sessionId = row["sessionId"];
  const hash = row["minedContentHash"];
  const recordedAt = row["recordedAt"];
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId !== key) return null;
  if (typeof hash !== "string" || hash.length === 0) return null;
  const outcome = readOutcome(row["outcome"]);
  if (outcome === null) return null;
  return {
    sessionId,
    minedContentHash: hash,
    outcome,
    recordedAt: typeof recordedAt === "string" ? recordedAt : "",
  };
}

function readOutcome(value: unknown): SessionMiningOutcome | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const written = row["written"];
  const staged = row["staged"];
  const deduped = row["deduped"];
  const durabilityRejected = row["durabilityRejected"];
  if (
    typeof written !== "number" ||
    typeof staged !== "number" ||
    typeof deduped !== "number" ||
    typeof durabilityRejected !== "number"
  ) {
    return null;
  }
  return { written, staged, deduped, durabilityRejected };
}

/** Canonical ledger bytes: keys sorted, so a no-op rerun is byte-identical. */
function serializeLedger(entries: Record<string, SessionMiningEntry>): string {
  const sorted: Record<string, SessionMiningEntry> = {};
  for (const key of Object.keys(entries).toSorted()) sorted[key] = entries[key]!;
  return (
    JSON.stringify(
      { schema_version: SESSION_MINING_LEDGER_SCHEMA_VERSION, entries: sorted },
      null,
      2,
    ) + "\n"
  );
}

/** One commit's mining outcome to record. */
export interface SessionMiningRecord {
  readonly sessionId: string;
  /** {@link minedTurnsHash} of the turn material the commit covered. */
  readonly minedContentHash: string;
  readonly outcome: SessionMiningOutcome;
}

/**
 * Record one session's mining outcome, keyed on its portable id. Returns
 * `true` when the ledger was rewritten, `false` on a byte-identical no-op.
 *
 * The read, the merge and the write are one critical section under the same
 * lock every other Brain read-modify-write takes: two mining commits for
 * different sessions can be running in two processes at once, and two
 * snapshots written back in sequence would each lose the other's entry.
 *
 * Every OTHER entry whose session no longer has turns is dropped in the
 * same pass, and so is the recorded one should its own session have none.
 * A session the plan refuses (zero imported turns) has nothing for the gate
 * to suppress, so its entry has no left reason to exist - and dropping only
 * never-mined-again sessions would have meant one pass that hears a
 * session's turn count and still leaves a dead key behind. The pruning
 * happens here and not in the read on purpose: the read stays a read. The
 * cost is one continuity-store pass per record building the set of sessions
 * that hold turns directly, plus a full turn listing only for an entry
 * whose session holds none of them - the rare root-ref-mined-over-segments
 * case, where the turns are reachable only through the lineage scope the
 * plan itself reads.
 */
export function recordSessionMiningOutcome(
  vault: string,
  record: SessionMiningRecord,
  now: Date = new Date(),
): boolean {
  assertVaultIdentityForWrite(vault);
  const path = sessionMiningLedgerPath(vault);
  const handle = acquireLockSyncWithRetry(path, undefined, { remedy: ingestLockRemedy });
  try {
    const entries: Record<string, SessionMiningEntry> = {
      ...readSessionMiningLedger(vault).entries,
    };
    entries[record.sessionId] = {
      sessionId: record.sessionId,
      minedContentHash: record.minedContentHash,
      outcome: { ...record.outcome },
      recordedAt: isoSecond(now),
    };
    // One store pass for the whole prune, mirroring the import ledger's
    // one-existsSync-per-entry idiom: a full turn listing per entry here
    // would be a whole-store read plus a lineage build per entry, growing
    // with the ledger's history instead of with this record.
    const sessionsWithTurns = new Set<string>();
    for (const turnRecord of listContinuityRecords(vault)) {
      if (turnRecord.kind !== "session_turn") continue;
      const sid = sessionIdOf(turnRecord.payload);
      if (sid !== undefined) sessionsWithTurns.add(sid);
    }
    for (const key of Object.keys(entries)) {
      if (sessionsWithTurns.has(key)) continue;
      // A session holding no direct turn record may still have turns,
      // reachable through the lineage scope (a root ref mined over
      // segment-recorded turns); the exact read decides those, and only
      // those.
      if (listSessionRawTurns(vault, key).length === 0) delete entries[key];
    }
    const next = serializeLedger(entries);
    if (existsSync(path) && readFileSync(path, "utf8") === next) return false;
    atomicWriteFileSync(path, next);
    return true;
  } finally {
    handle.release();
  }
}

/**
 * The mined-content hash: a SHA-256 over the turn material in list order,
 * each turn as its (turn id, text, timestamp) triple. JSON is the canonical
 * encoding, so the field boundaries are unambiguous no matter what the turn
 * text contains. A turn that changes in any field, or a list that changes
 * order, changes the hash - which is exactly the invalidation the gate
 * wants: the hash covers what the plan would embed, so a matching hash
 * means the recorded outcome was earned by the turns the caller is about to
 * be offered again.
 */
export function minedTurnsHash(turns: ReadonlyArray<MinedTurnMaterial>): string {
  const canonical = turns.map((turn) => ({
    turnId: turn.turnId,
    text: turn.text,
    timestamp: turn.timestamp,
  }));
  return hashBytes(new TextEncoder().encode(JSON.stringify(canonical)));
}

/**
 * The plan gate's answer: the recorded TOMBSTONE whose hash still matches
 * `turns`, or `null`. `null` means no entry (never mined), a changed turn
 * list (re-mined material, re-opened), a session id that has no record - or
 * an entry whose recorded outcome carried a yield: a yielding commit writes
 * the distilled state the census reports, not a suppression, so the session
 * stays minable and only the zero-yield record suppresses. A hit means the
 * session's CURRENT material was mined to nothing accepted; the caller
 * suppresses with {@link SessionMiningEntry.outcome} as evidence.
 *
 * A corrupt or unknown-schema ledger throws, by the read's contract: a gate
 * that could not verify the ledger must not wave the session through as if
 * the ledger were empty.
 */
export function readMiningTombstone(
  vault: string,
  sessionId: string,
  turns: ReadonlyArray<MinedTurnMaterial>,
): SessionMiningEntry | null {
  const hash = minedTurnsHash(turns);
  const entry = readSessionMiningLedger(vault).entries[sessionId.trim()];
  if (entry === undefined || entry.minedContentHash !== hash) return null;
  if (entry.outcome.written + entry.outcome.staged > 0) return null;
  return entry;
}

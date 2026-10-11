/**
 * The hallways pass (recall-quality wave, Lane B / t_13a82a31).
 *
 * Sessions are the hallways: entities that keep turning up in the same
 * transcripts are related even when no vault page links them. This pass
 * reads ONLY the mined-mention ledger (`session_entity_mention` records)
 * - never a vault page, and never the vault-derived co-occurrence graph,
 * whose walk skips `Brain/` entirely and whose reach differs from the
 * doc-graph passes by design. The two graphs share no artifact and never
 * merge; this module is the session-derived one.
 *
 * The math is co-occurrence's, with sessions in the document role:
 * document frequency becomes distinct-session frequency, and a pair's
 * score is the same rounded PMI, `log2((co * N) / (dfA * dfB))` - so two
 * keys that keep sharing transcripts outscore pairs that met by chance,
 * with no natural-language word list anywhere.
 *
 * Output follows the house derived-artifact convention, through the S2
 * helper: schema-versioned (`o2b.hallways.v1`), dataset-hashed over the
 * folded mention set, written atomically behind the vault-identity
 * guard, and FAIL-SOFT on read - a missing, torn, stale or foreign-schema
 * artifact reads as null and the caller re-derives. Beside it lives a
 * REVIEWABLE proposals file with persisted dismissals (the bridges
 * pattern); nothing here promotes anything - promotion is a separate,
 * explicit step through the entity registry.
 *
 * What the dataset hash describes, exactly. The derivation's `keys` list
 * EXCLUDES dismissed ids, so the dismissal set is one of the inputs the
 * artifact is a function of - and the hash is taken over both: the folded
 * (family, key, session) incidence AND the dismissed key ids. Hashing the
 * ledger alone would let two derivations with different key lists carry
 * the same `dataset_hash`, and the hash would no longer describe the bytes
 * it stamps. Dismissal silences proposals either way; here it is also
 * named in the fingerprint of what this artifact was derived from.
 *
 * A dismissal removes the key AND every pair it took part in. The pairs
 * are the promote verb's roadmap - each surviving pair whose other half
 * is already an entity gains a `related` edge - so a pair with a
 * dismissed side must never be offered, or promote would relate a
 * partner the operator silenced. The proposals table filters the same
 * rows again (an overlay the caller may pass separately), but the
 * derivation itself offers none.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import {
  deriveDatasetHash,
  readDerivedArtifact,
  writeDerivedArtifact,
  type DerivedArtifact,
} from "../derived-artifact.ts";
import { formatFrontmatter } from "../../vault.ts";
import { isoSecond } from "../time.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { OPERATION, type Safeguard } from "../safeguard.ts";
import { progressCounter, withProgress, type ProgressSink } from "../progress.ts";
import { acquireLockSyncWithRetry } from "../sync-lockfile.ts";
import { listContinuityRecords } from "../continuity/store.ts";
import { SESSION_ENTITY_MENTION_KIND } from "./session-mining.ts";

export const HALLWAYS_SCHEMA_VERSION = "o2b.hallways.v1";

/** Relative paths, all posix-joined (the vault-portability rule): a
 * posix literal, not node:path join, whose Windows separators would leak
 * into the artifact hash and every string comparison against the rel. */
export const HALLWAYS_ARTIFACT_REL = "Brain/link-graph/hallways.json";
export const HALLWAYS_PROPOSALS_REL = "Brain/proposals/hallways.md";
export const HALLWAYS_DISMISSED_REL = "Brain/proposals/hallways-dismissed.json";

/**
 * The promotion floor a key must clear before it is OFFERED: distinct
 * sessions that mention it. Sensible default, precision-biased - one
 * shared transcript is a coincidence, three are a habit. The CLI owns
 * the operator-facing override; this constant is the shared floor.
 */
export const DEFAULT_PROMOTION_MIN_SESSIONS = 3;

const DEFAULT_MIN_CO_SESSIONS = 2;
const DEFAULT_MIN_SCORE = 0;
const DEFAULT_LIMIT = 100;

/**
 * Cooperative-deadline yield interval INSIDE one session's pairwise
 * fold. The fold is O(k^2) in a session's distinct keys, so the stage
 * boundary between sessions can be arbitrarily far away: a single
 * hostile session must not own the thread between checkpoints. Every
 * this many entities the fold offers a checkpoint, keeping
 * `hallways mine` interruptible over a large session.
 */
export const PAIRWISE_CHECKPOINT_EVERY = 256;

/** One mined key's incidence over the ledger. */
export interface HallwaysKeyStat {
  readonly family: string;
  readonly key: string;
  /** Distinct sessions that mention the key. */
  readonly sessionCount: number;
}

/** One suggested association between two mined keys. */
export interface HallwaysPair {
  /** Lexicographically smaller family-scoped key id (see {@link hallwaysKeyId}). */
  readonly left: string;
  /** Lexicographically larger family-scoped key id. */
  readonly right: string;
  /** Number of distinct sessions that mention both keys. */
  readonly coSessionCount: number;
  /** PMI-style association score (higher = more surprising co-mention). */
  readonly score: number;
}

export interface HallwaysResult {
  readonly schema: string;
  /**
   * Hash of the inputs the derivation is a function of: the folded mention
   * set AND the dismissal overlay (see the module header - the `keys` list
   * excludes dismissed ids, so both belong in the fingerprint).
   */
  readonly datasetHash: string;
  /** Distinct sessions that contributed at least one mention. */
  readonly sessionCount: number;
  /** Ledger rows read, before the private/dedupe fold (never silent). */
  readonly mentionRows: number;
  /** Ledger rows skipped as malformed or flagged private. */
  readonly skippedRows: number;
  readonly keys: ReadonlyArray<HallwaysKeyStat>;
  readonly pairs: ReadonlyArray<HallwaysPair>;
}

export interface HallwaysOptions {
  /** Minimum distinct sessions co-mentioning a pair. Default 2. */
  readonly minCoSessions?: number;
  /** Minimum score to keep a pair. Default 0. */
  readonly minScore?: number;
  /** Maximum pairs returned, after ranking. Default 100. */
  readonly limit?: number;
  /** Key ids (see {@link hallwaysKeyId}) silenced for proposals. */
  readonly dismissed?: ReadonlySet<string>;
  /** Cooperative deadline (t_06784b8d): checked at each stage boundary. */
  readonly safeguard?: Safeguard;
  /** Live progress observer; absence means nobody asked. */
  readonly onProgress?: ProgressSink;
}

/** The family-scoped id one mined key carries through the pass. */
export function hallwaysKeyId(family: string, key: string): string {
  return `${family}:${key}`;
}

/** The family and key an id carries, or null when it names no family. */
export function splitHallwaysKeyId(id: string): { family: string; key: string } | null {
  const sep = id.indexOf(":");
  if (sep <= 0) return null;
  const family = id.slice(0, sep);
  const key = id.slice(sep + 1);
  if (family.length === 0 || key.length === 0) return null;
  return { family, key };
}

// Canonical key ids are lowercase-family plus case-sensitive key text, so
// the pair separator must be a character that can never appear in either.
// The unit separator (U+001F) never occurs in a mined key, so it
// round-trips unambiguously - the same convention the co-occurrence pass
// uses for note-title keys.
const PAIR_SEPARATOR = String.fromCharCode(0x1f);

/** Canonical unordered pair key over two key ids. */
export function hallwaysPairKey(a: string, b: string): string {
  return a < b ? `${a}${PAIR_SEPARATOR}${b}` : `${b}${PAIR_SEPARATOR}${a}`;
}

/** Split a pair key back into its two key ids. */
export function splitHallwaysPairKey(pairKey: string): readonly [string, string] {
  const idx = pairKey.indexOf(PAIR_SEPARATOR);
  return [pairKey.slice(0, idx), pairKey.slice(idx + PAIR_SEPARATOR.length)];
}

interface FoldedMentions {
  readonly incidence: Map<string, Set<string>>;
  readonly mentionRows: number;
  readonly skippedRows: number;
}

/**
 * Fold the ledger to (key id -> distinct sessions). Duplicate rows fold
 * at (family, key, sessionRef); rows flagged `private` are skipped - the
 * import loop withholds private turns whole, and a hand-planted private
 * row must not surface through a read side either.
 */
function foldMentions(vault: string): FoldedMentions {
  const records = listContinuityRecords(vault, { kind: SESSION_ENTITY_MENTION_KIND });
  const incidence = new Map<string, Set<string>>();
  let skippedRows = 0;
  for (const record of records) {
    if (record.private) {
      skippedRows++;
      continue;
    }
    const family = record.payload["family"];
    const key = record.payload["key"];
    const sessionRef = record.payload["session_ref"];
    if (typeof family !== "string" || typeof key !== "string" || typeof sessionRef !== "string") {
      skippedRows++;
      continue;
    }
    const id = hallwaysKeyId(family, key);
    let sessions = incidence.get(id);
    if (sessions === undefined) {
      sessions = new Set<string>();
      incidence.set(id, sessions);
    }
    sessions.add(sessionRef);
  }
  return { incidence, mentionRows: records.length, skippedRows };
}

/**
 * Compute the hallways derivation over the mined-mention ledger.
 * Deterministic for a fixed ledger: identical incidence yields identical
 * keys, pairs and order.
 */
export function computeHallways(vault: string, opts: HallwaysOptions = {}): HallwaysResult {
  const minCoSessions = Math.max(1, Math.floor(opts.minCoSessions ?? DEFAULT_MIN_CO_SESSIONS));
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const dismissed = opts.dismissed ?? new Set<string>();
  const progress = progressCounter(OPERATION.sessions, opts.onProgress);
  return withProgress(progress, () =>
    computeHallwaysRun(
      vault,
      {
        minCoSessions,
        minScore,
        limit,
        dismissed,
        ...(opts.safeguard === undefined ? {} : { safeguard: opts.safeguard }),
      },
      progress,
    ),
  );
}

function computeHallwaysRun(
  vault: string,
  opts: {
    readonly minCoSessions: number;
    readonly minScore: number;
    readonly limit: number;
    readonly dismissed: ReadonlySet<string>;
    readonly safeguard?: Safeguard;
  },
  progress: ReturnType<typeof progressCounter>,
): HallwaysResult {
  const folded = foldMentions(vault);
  // Cooperative deadline (t_06784b8d): checked at each stage boundary,
  // exactly like the bridges pass - the read-only fold aborts between
  // sessions, never mid-write.
  opts.safeguard?.checkpoint();
  progress.start("mentions", folded.mentionRows);
  for (let i = 0; i < folded.mentionRows; i++) progress.advance("mentions");

  // Stable per-session key sets, for the pairwise pass.
  const sessionKeys = new Map<string, Set<string>>();
  for (const [id, sessions] of folded.incidence) {
    for (const session of sessions) {
      let keys = sessionKeys.get(session);
      if (keys === undefined) {
        keys = new Set<string>();
        sessionKeys.set(session, keys);
      }
      keys.add(id);
    }
  }

  const documentFrequency = new Map<string, number>();
  for (const [id, sessions] of folded.incidence) {
    documentFrequency.set(id, sessions.size);
  }
  const coCount = new Map<string, number>();
  progress.start("sessions", sessionKeys.size);
  for (const keys of sessionKeys.values()) {
    // Cooperative deadline: abort between sessions (read-only fold) -
    // and, every PAIRWISE_CHECKPOINT_EVERY entities, inside one: a
    // single large session is itself O(k^2) work.
    opts.safeguard?.checkpoint();
    const unique = [...keys].toSorted();
    for (let i = 0; i < unique.length; i++) {
      if (i > 0 && i % PAIRWISE_CHECKPOINT_EVERY === 0) opts.safeguard?.checkpoint();
      for (let j = i + 1; j < unique.length; j++) {
        const pairId = hallwaysPairKey(unique[i]!, unique[j]!);
        coCount.set(pairId, (coCount.get(pairId) ?? 0) + 1);
      }
    }
    progress.advance("sessions");
  }

  const sessionCount = sessionKeys.size;
  const pairs: HallwaysPair[] = [];
  for (const [pairId, co] of coCount) {
    if (co < opts.minCoSessions) continue;
    const [left, right] = splitHallwaysPairKey(pairId);
    // No fallback: a pair id is built only from keys the fold saw, so both
    // document frequencies are always present.
    const dfLeft = documentFrequency.get(left)!;
    const dfRight = documentFrequency.get(right)!;
    const score = round6(Math.log2((co * sessionCount) / (dfLeft * dfRight)));
    if (score < opts.minScore) continue;
    // A pair with a dismissed side is never offered: these pairs are
    // promote's roadmap, and a dismissed partner must not gain an edge.
    if (opts.dismissed.has(left) || opts.dismissed.has(right)) continue;
    pairs.push({ left, right, coSessionCount: co, score });
  }
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      (a.left < b.left ? -1 : a.left > b.left ? 1 : 0) ||
      (a.right < b.right ? -1 : a.right > b.right ? 1 : 0),
  );

  // The hashed input set is everything the artifact below is a function
  // of: the folded (family, key, session) incidence lines AND the
  // dismissed key ids, each under its own separator prefix so the two
  // input spaces can never collide. A dismissal changes `keys`, so it
  // must change the fingerprint too.
  const datasetHash = deriveDatasetHash([
    ...[...folded.incidence].flatMap(([id, sessions]) =>
      [...sessions].map((session) => `${id}${PAIR_SEPARATOR}${session}`),
    ),
    ...[...opts.dismissed].map((id) => `dismissed${PAIR_SEPARATOR}${id}`),
  ]);

  return Object.freeze({
    schema: HALLWAYS_SCHEMA_VERSION,
    datasetHash,
    sessionCount,
    mentionRows: folded.mentionRows,
    skippedRows: folded.skippedRows,
    keys: Object.freeze(
      [...folded.incidence.entries()]
        .map(([id, sessions]) => {
          const { family, key } = splitHallwaysKeyId(id)!;
          return Object.freeze({
            family,
            key,
            sessionCount: sessions.size,
          });
        })
        .filter((stat) => !opts.dismissed.has(hallwaysKeyId(stat.family, stat.key)))
        .toSorted((a, b) =>
          a.family !== b.family ? (a.family < b.family ? -1 : 1) : a.key < b.key ? -1 : 1,
        ),
    ),
    pairs: Object.freeze(pairs.slice(0, opts.limit)),
  });
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ----- Artifact ---------------------------------------------------------------

/** The artifact payload on disk: the derivation plus the envelope fields. */
interface HallwaysArtifactPayload extends DerivedArtifact {
  readonly session_count: number;
  readonly mention_rows: number;
  readonly skipped_rows: number;
  readonly keys: ReadonlyArray<HallwaysKeyStat>;
  readonly pairs: ReadonlyArray<HallwaysPair>;
}

/**
 * Persist the derivation to `Brain/link-graph/hallways.json` through the
 * shared derived-artifact rails: atomic write, vault-identity guard.
 * Returns the absolute path written.
 */
export function writeHallwaysArtifact(
  vault: string,
  result: HallwaysResult,
  opts: { readonly generatedAt: string },
): string {
  const payload: HallwaysArtifactPayload = {
    schema: result.schema,
    generated_at: opts.generatedAt,
    dataset_hash: result.datasetHash,
    session_count: result.sessionCount,
    mention_rows: result.mentionRows,
    skipped_rows: result.skippedRows,
    keys: result.keys,
    pairs: result.pairs,
  };
  writeDerivedArtifact(vault, HALLWAYS_ARTIFACT_REL, payload);
  return join(vault, HALLWAYS_ARTIFACT_REL);
}

/**
 * Read a persisted derivation, re-validated against the schema version
 * and the CURRENT dataset hash the caller derives from the ledger.
 * Fail-soft: missing file, torn JSON, schema mismatch, hash expiry or a
 * malformed payload all read as null.
 */
export function readHallwaysArtifact(vault: string, datasetHash: string): HallwaysResult | null {
  const parsed = readDerivedArtifact<HallwaysArtifactPayload>(
    vault,
    HALLWAYS_ARTIFACT_REL,
    HALLWAYS_SCHEMA_VERSION,
    datasetHash,
  );
  if (parsed === null) return null;
  if (typeof parsed.session_count !== "number") return null;
  if (!Array.isArray(parsed.keys) || !Array.isArray(parsed.pairs)) return null;
  const keys: HallwaysKeyStat[] = [];
  for (const raw of parsed.keys) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof (raw as HallwaysKeyStat).family !== "string" ||
      typeof (raw as HallwaysKeyStat).key !== "string" ||
      typeof (raw as HallwaysKeyStat).sessionCount !== "number"
    ) {
      return null;
    }
    keys.push(raw as HallwaysKeyStat);
  }
  const pairs: HallwaysPair[] = [];
  for (const raw of parsed.pairs) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof (raw as HallwaysPair).left !== "string" ||
      typeof (raw as HallwaysPair).right !== "string" ||
      typeof (raw as HallwaysPair).coSessionCount !== "number" ||
      typeof (raw as HallwaysPair).score !== "number"
    ) {
      return null;
    }
    pairs.push(raw as HallwaysPair);
  }
  return Object.freeze({
    schema: HALLWAYS_SCHEMA_VERSION,
    datasetHash: parsed.dataset_hash,
    sessionCount: parsed.session_count,
    mentionRows: typeof parsed.mention_rows === "number" ? parsed.mention_rows : 0,
    skippedRows: typeof parsed.skipped_rows === "number" ? parsed.skipped_rows : 0,
    keys: Object.freeze(keys),
    pairs: Object.freeze(pairs),
  });
}

// ----- Proposals and dismissals (the bridges pattern) ---------------------------

/**
 * One Markdown table cell. A mined key can legitimately carry a `|` (a
 * URL query value, a path segment); rendered raw inside a table row it
 * spawns a phantom cell and corrupts every row after it, so pipes are
 * escaped as `\|` on render. The escape touches nothing else - the cell
 * text stays copy-pasteable modulo the one escaped character.
 */
function proposalsCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/**
 * Regenerate the reviewable proposals artifact. Derived file: the whole
 * document is replaced on every run. Promotion candidates are the
 * surviving keys at or above `minSessions`; pairs are the ranked
 * associations - the derivation already drops pairs with a dismissed
 * side, and this filter keeps the file honest even when the caller's
 * overlay is fresher than the one the derivation saw.
 */
export function writeHallwaysProposals(
  vault: string,
  result: HallwaysResult,
  opts: {
    readonly now: Date;
    readonly minSessions?: number;
    readonly dismissed?: ReadonlySet<string>;
  },
): string {
  assertVaultIdentityForWrite(vault);
  const minSessions = Math.max(1, Math.floor(opts.minSessions ?? DEFAULT_PROMOTION_MIN_SESSIONS));
  const dismissed = opts.dismissed ?? new Set<string>();
  const candidates = result.keys.filter((k) => k.sessionCount >= minSessions);
  const visiblePairs = result.pairs.filter(
    (p) => !dismissed.has(p.left) && !dismissed.has(p.right),
  );
  const path = join(vault, HALLWAYS_PROPOSALS_REL);
  const lines: string[] = [
    "# Hallway proposals",
    "",
    "Auto-generated from the mined-session ledger. Do not edit - regenerated",
    `on every run. Promote a key with \`o2b brain hallways promote <family> <key>\``,
    "once it clears the session threshold; silence one with",
    "`o2b brain hallways dismiss <family> <key>`.",
    "",
  ];
  if (result.keys.length === 0) {
    lines.push("No mined keys in the ledger yet: mining runs on every writable import.");
  } else if (candidates.length === 0) {
    lines.push(
      `No promotion candidates: no key is mentioned in >= ${minSessions} distinct sessions yet.`,
    );
  } else {
    lines.push(`## Promotion candidates (>= ${minSessions} sessions)`, "");
    lines.push("| family | key | sessions |");
    lines.push("| --- | --- | --- |");
    for (const k of candidates) {
      lines.push(`| ${proposalsCell(k.family)} | ${proposalsCell(k.key)} | ${k.sessionCount} |`);
    }
  }
  if (visiblePairs.length > 0) {
    lines.push("", "## Associated pairs (PMI over sessions)", "");
    lines.push("| left | right | co-sessions | score |");
    lines.push("| --- | --- | --- | --- |");
    for (const p of visiblePairs) {
      lines.push(
        `| ${proposalsCell(p.left)} | ${proposalsCell(p.right)} | ${p.coSessionCount} | ${p.score.toFixed(3)} |`,
      );
    }
  }
  const content = formatFrontmatter(
    {
      kind: "brain-hallway-proposals",
      generated_at: isoSecond(opts.now),
      proposals: candidates.length,
      keys: result.keys.length,
      pairs: visiblePairs.length,
    },
    lines.join("\n"),
  );
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, content);
  return path;
}

/** Persisted dismissals, as family-scoped key ids. Fail-soft read. */
export function readDismissedHallwayKeys(vault: string): Set<string> {
  const path = join(vault, HALLWAYS_DISMISSED_REL);
  if (!existsSync(path)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const keys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return new Set();
    return new Set(keys.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Persist one dismissal; returns true when it was new.
 *
 * The whole read-modify-write runs under the brain's lockfile: two
 * concurrent dismissals (CLI beside MCP server, or two agents) would
 * otherwise both read the same set, each write back what it first read,
 * and one dismissal would be silently lost. Contention waits its bounded
 * turn; an expired wait is a loud refusal, never an unlocked write.
 */
export function dismissHallwayKey(vault: string, family: string, key: string): boolean {
  assertVaultIdentityForWrite(vault);
  const id = hallwaysKeyId(family, key);
  const path = join(vault, HALLWAYS_DISMISSED_REL);
  const lock = acquireLockSyncWithRetry(path);
  try {
    const dismissed = readDismissedHallwayKeys(vault);
    if (dismissed.has(id)) return false;
    dismissed.add(id);
    // Through the shared atomic writer, not a raw writeFileSync: an
    // interrupted swap leaves the old dismissal set or the new one, and
    // the file stays out of the direct-fs write-site census population.
    atomicWriteFileSync(path, `${JSON.stringify({ keys: [...dismissed].toSorted() }, null, 2)}\n`);
    return true;
  } finally {
    lock.release();
  }
}

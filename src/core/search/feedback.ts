/**
 * Retrieval feedback loop (recall-trust-suite, Feature B).
 *
 * Explicit recall feedback is the operator (or a downstream agent)
 * saying "this result helped" / "this result was noise". Each event is
 * one small JSON file under `Brain/search/feedback/` — the same
 * conflict-free one-file-per-signal pattern `Brain/inbox/` uses, so
 * multi-device vaults never produce sync conflicts on a shared
 * append-only file.
 *
 * Learned weights are a PURE FOLD over the event set: deterministic,
 * order-insensitive, bounded to [LEARNED_WEIGHT_MIN, LEARNED_WEIGHT_MAX],
 * and replayable from the events at any time. The derived file
 * (`Brain/search/learned-weights.json`) is a cache of that fold —
 * deleting it (reset) loses nothing. Operator configuration stays the
 * base policy: the multipliers compose with the configured weights and
 * cannot drift outside the documented bounds.
 *
 * Privacy: events carry an FNV-1a hash of the query, never the raw
 * query text.
 *
 * A store-only machine (design D14 item 1) appends each event as a
 * `search-feedback` ledger row instead of a file, and keeps the learned
 * weights cache in device-local state ({@link learnedWeightsFile}).
 */

import { legacyVaultOf } from "../brain/no-vault.ts";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson } from "../integrity/digest.ts";
import { machineStatePath } from "../state/machine-state.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import { ledgerRowRecord } from "../store/dual-write-records.ts";
import { readLedgerRows } from "../store/read/ledger-rows.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";
import { STORE_PARTITIONS } from "../store/constants.ts";
import { listShards } from "../store/shard-list.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { partitionDir, resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { storeWrite } from "../store/store-write.ts";

import type { BrainSearchResult, ResolvedSearchConfig, WeightProfile } from "./types.ts";
import type { TransportReach } from "../graph/transport-reach.ts";
import { semanticLaneMissing, type RetrievalDegradationCode } from "./retrieval-trail.ts";

/** Lower bound for one learned per-layer multiplier. */
export const LEARNED_WEIGHT_MIN = 0.8;
/** Upper bound for one learned per-layer multiplier. */
export const LEARNED_WEIGHT_MAX = 1.2;
/** Step scale for the fold: full agreement moves a layer by ±this much. */
export const LEARNED_WEIGHT_STEP = 0.5;

/** Per-layer scoring contributions captured at retrieval time. */
export interface LayerContributions {
  readonly keyword: number;
  readonly semantic: number;
  readonly entity: number;
  readonly recency: number;
}

export interface RecallFeedbackEvent {
  /** Unix-ms timestamp the feedback was given. */
  readonly ts: number;
  /** FNV-1a hash of the normalised query — never the raw query text. */
  readonly queryHash: string;
  /** Vault-relative path of the result being judged. */
  readonly resultPath: string;
  readonly verdict: "up" | "down";
  readonly contributions: LayerContributions;
}

export interface LearnedWeights extends WeightProfile {
  /** Number of events the fold consumed. */
  readonly events: number;
  /** ISO timestamp of the most recent event in the fold. */
  readonly updatedAt: string | null;
}

export const NEUTRAL_LEARNED_WEIGHTS: LearnedWeights = Object.freeze({
  keywordMul: 1,
  semanticMul: 1,
  entityMul: 1,
  recencyMul: 1,
  events: 0,
  updatedAt: null,
});

export function feedbackDir(vault: string | null): string {
  return join(legacyVaultOf(vault, "feedbackDir"), "Brain", "search", "feedback");
}

export function learnedWeightsPath(vault: string): string {
  return join(vault, ...LEARNED_WEIGHTS_SEGMENTS);
}

/**
 * Where this machine keeps the learned weights: {@link learnedWeightsPath}
 * on an unswitched machine. The weights are a cache folded from the
 * feedback events (design D14 item 11) that the migration drops, so a
 * store-only machine keeps it in its device-local machine state
 * (`machineStatePath`), at the same vault-relative path.
 */
export function learnedWeightsFile(vault: string | null): string {
  return machineStatePath(vault, ...LEARNED_WEIGHTS_SEGMENTS);
}

/** Vault-relative segments of the folded learned weights. */
const LEARNED_WEIGHTS_SEGMENTS = ["Brain", "search", "learned-weights.json"] as const;

/** The store ledger of feedback events (FORMAT.md, the migration's ledgers). */
export const SEARCH_FEEDBACK_LEDGER = "search-feedback";

/**
 * The store row of one feedback event: `private` when it names a private
 * page or one that cannot be judged, else `private` when this machine
 * holds it (the judged path says what the user looked for).
 */
function feedbackRowRecord(vault: string | null, event: RecallFeedbackEvent): DualWriteRecord {
  return ledgerRowRecord(
    SEARCH_FEEDBACK_LEDGER,
    event,
    rowNamesPrivatePage(vault, event) ? "private" : "private-when-held",
  );
}

/** Deterministic FNV-1a 32-bit hash, hex-encoded (same family as query-plan). */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Read the per-layer contributions off a search result. Keyword,
 * semantic, and recency are first-class fields; the entity layer is read
 * from the structured `breakdown` the ranker emits. A result without a
 * breakdown (a synthetic traversal expansion or relation-polarity
 * pull-in) genuinely has no entity contribution, so 0 is correct - not a
 * lossy fallback.
 */
export function contributionsFromResult(result: BrainSearchResult): LayerContributions {
  return Object.freeze({
    keyword: result.keywordScore,
    semantic: result.semanticScore,
    entity: result.breakdown?.entity ?? 0,
    recency: result.recencyBoost,
  });
}

/**
 * Record one feedback event as its own file and refresh the derived
 * learned-weights file. The filename derives from the timestamp plus a
 * content hash, so recording the identical event twice is idempotent.
 */
export function recordRecallFeedback(vault: string | null, event: RecallFeedbackEvent): string {
  // One `search-feedback` ledger row on a store-only machine (design D14
  // item 1); an unswitched machine keeps its event file, with no dual write
  // (format version 1 has none for this ledger; the migration imports the
  // files).
  let file: string;
  if (isStoreOnly({ vault })) {
    file = storeWrite(() => feedbackRowRecord(vault, event), { vault })[0]?.path ?? "";
  } else {
    const dir = feedbackDir(vault);
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(event, null, 2) + "\n";
    file = join(dir, `${event.ts}-${fnv1aHex(body)}.json`);
    writeFileSync(file, body);
  }
  writeLearnedWeights(vault, computeLearnedWeights(loadFeedbackEvents(vault)));
  return file;
}

export function loadFeedbackEvents(vault: string | null): RecallFeedbackEvent[] {
  // The `search-feedback` ledger rows on a store-only machine. A file name
  // made the same event recorded twice one file; in the store an identical
  // row is counted once for the same reason.
  return dedupeIdentical(
    readLedgerRows<unknown>(SEARCH_FEEDBACK_LEDGER, loadLegacyFeedbackEvents, { vault }).filter(
      isFeedbackEvent,
    ),
  ).toSorted((a, b) => a.ts - b.ts || a.resultPath.localeCompare(b.resultPath));
}

/** Rows with identical content, kept once (first occurrence). */
export function dedupeIdentical<T>(rows: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = canonicalJson(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether a parsed file or a store row is a well-formed feedback event. */
function isFeedbackEvent(parsed: unknown): parsed is RecallFeedbackEvent {
  if (parsed === null || typeof parsed !== "object") return false;
  const e = parsed as Partial<RecallFeedbackEvent>;
  const c = e.contributions;
  // Every layer must be a finite number: a malformed contributions
  // object would otherwise feed NaN into the fold's totals.
  const contributionsValid =
    c !== undefined &&
    c !== null &&
    [c.keyword, c.semantic, c.entity, c.recency].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    );
  return (
    typeof e.ts === "number" &&
    (e.verdict === "up" || e.verdict === "down") &&
    typeof e.resultPath === "string" &&
    contributionsValid
  );
}

function loadLegacyFeedbackEvents(vault: string): RecallFeedbackEvent[] {
  const dir = feedbackDir(vault);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: RecallFeedbackEvent[] = [];
  for (const f of files.toSorted()) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (isFeedbackEvent(parsed)) out.push(parsed);
    } catch {
      // One malformed file never breaks the fold.
    }
  }
  out.sort((a, b) => a.ts - b.ts || a.resultPath.localeCompare(b.resultPath));
  return out;
}

/**
 * The deterministic fold. Per layer: each event contributes its
 * contribution share (this layer's value over the event's total) signed
 * by the verdict; the layer's multiplier is
 * `1 + STEP * netSignal / totalEvents`, clamped to the documented
 * bounds. Order-insensitive by construction (a sum), and a layer that
 * never contributed stays exactly 1.
 */
export function computeLearnedWeights(events: ReadonlyArray<RecallFeedbackEvent>): LearnedWeights {
  if (events.length === 0) return NEUTRAL_LEARNED_WEIGHTS;
  const net = { keyword: 0, semantic: 0, entity: 0, recency: 0 };
  let counted = 0;
  let latestTs = 0;
  for (const e of events) {
    const c = e.contributions;
    const total = c.keyword + c.semantic + c.entity + c.recency;
    if (total <= 0) continue; // zero-contribution events carry no layer signal
    counted++;
    const sign = e.verdict === "up" ? 1 : -1;
    net.keyword += (sign * c.keyword) / total;
    net.semantic += (sign * c.semantic) / total;
    net.entity += (sign * c.entity) / total;
    net.recency += (sign * c.recency) / total;
    if (e.ts > latestTs) latestTs = e.ts;
  }
  if (counted === 0) {
    return Object.freeze({ ...NEUTRAL_LEARNED_WEIGHTS, events: events.length });
  }
  const mul = (n: number): number => {
    const raw = 1 + (LEARNED_WEIGHT_STEP * n) / counted;
    return round6(Math.min(LEARNED_WEIGHT_MAX, Math.max(LEARNED_WEIGHT_MIN, raw)));
  };
  return Object.freeze({
    keywordMul: mul(net.keyword),
    semanticMul: mul(net.semantic),
    entityMul: mul(net.entity),
    recencyMul: mul(net.recency),
    events: events.length,
    updatedAt: latestTs > 0 ? new Date(latestTs).toISOString() : null,
  });
}

export function writeLearnedWeights(vault: string | null, weights: LearnedWeights): void {
  const path = learnedWeightsFile(vault);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(weights, null, 2) + "\n");
}

/**
 * On a store-only machine the weights file is a device-local cache of the
 * `search-feedback` rows, which sync between devices: it is folded again
 * when it is missing (right after the migration, which drops it) or when
 * the ledger holds another number of events than it folded (rows another
 * device recorded). Best effort: a failure leaves the cache as it is.
 */
function refreshStoreWeights(vault: string | null): void {
  if (!isStoreOnly({ vault })) return;
  try {
    const path = learnedWeightsFile(vault);
    // The ledger and the cache as they stand: unchanged since this process
    // last refreshed them, nothing is read again (a query asks twice).
    const stamp = refreshStamp(path);
    if (stamp !== null && REFRESHED.get(path) === stamp) return;
    const events = loadFeedbackEvents(vault);
    let cached: number | null = null;
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LearnedWeights>;
        cached = typeof parsed.events === "number" ? parsed.events : null;
      } catch {
        // A cache cut short or damaged: folded again from the ledger.
        cached = null;
      }
    } else if (events.length === 0) {
      return;
    }
    if (cached !== events.length) writeLearnedWeights(vault, computeLearnedWeights(events));
    const after = refreshStamp(path);
    if (after !== null) REFRESHED.set(path, after);
  } catch {
    // The cache stays as it is.
  }
}

/** Per weights file: the stamp of the ledger and the cache it was last refreshed at. */
const REFRESHED = new Map<string, string>();

/**
 * The size and modification time of every `search-feedback` ledger shard
 * of the configured store and of the cache file: a row recorded here or
 * synced in from another device changes it. Null when it cannot be told
 * (the store cannot be listed), and the refresh then reads the ledger.
 */
function refreshStamp(cachePath: string): string | null {
  try {
    const root = resolveConfiguredStoreRoot().root;
    const parts: string[] = [];
    for (const partition of STORE_PARTITIONS) {
      const shards = listShards(partitionDir(root, partition), {
        stream: "ledgers",
        ledger: SEARCH_FEEDBACK_LEDGER,
      });
      for (const shard of shards) {
        const stat = statSync(shard.path);
        parts.push(`${shard.path}:${stat.size}:${stat.mtimeMs}`);
      }
    }
    const cache = existsSync(cachePath) ? statSync(cachePath) : null;
    parts.push(cache === null ? "no-cache" : `cache:${cache.size}:${cache.mtimeMs}`);
    return parts.toSorted().join("|");
  } catch {
    return null;
  }
}

export function readLearnedWeights(vault: string | null): LearnedWeights | null {
  refreshStoreWeights(vault);
  try {
    const parsed = JSON.parse(readFileSync(learnedWeightsFile(vault), "utf8")) as LearnedWeights;
    // All four multipliers must be finite numbers inside the bounds the
    // fold itself clamps to — a partially-corrupt file must not feed NaN
    // into the weight composition, and a hand-edited one must not inject a
    // value `computeLearnedWeights` could never have produced. Zero deletes
    // a lane and a negative value inverts its rank order under rank fusion,
    // so the bound is the guard, not merely finiteness.
    const muls = [parsed.keywordMul, parsed.semanticMul, parsed.entityMul, parsed.recencyMul];
    const inBounds = (m: unknown): boolean =>
      typeof m === "number" &&
      Number.isFinite(m) &&
      m >= LEARNED_WEIGHT_MIN &&
      m <= LEARNED_WEIGHT_MAX;
    if (!muls.every(inBounds)) return null;
    if (typeof parsed.events !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete the derived weights file. The events stay — the fold can replay.
 * On a store-only machine, where a missing cache is folded again on read,
 * the reset leaves neutral weights over the events seen so far instead:
 * the next feedback, here or synced in, folds them all again, as an
 * unswitched machine does.
 */
export function resetLearnedWeights(vault: string | null): void {
  if (isStoreOnly({ vault })) {
    writeLearnedWeights(vault, {
      ...NEUTRAL_LEARNED_WEIGHTS,
      events: loadFeedbackEvents(vault).length,
    });
    return;
  }
  rmSync(learnedWeightsFile(vault), { force: true });
}

/**
 * Stable fingerprint of the learned-weights state for the query-cache
 * key: "off" when no derived file exists, else a hash of its content.
 */
export function learnedWeightsFingerprint(vault: string | null): string {
  refreshStoreWeights(vault);
  const path = learnedWeightsFile(vault);
  if (!existsSync(path)) return "off";
  try {
    return fnv1aHex(readFileSync(path, "utf8"));
  } catch {
    return "off";
  }
}

/** True when every multiplier is exactly neutral (1.0). */
export function isNeutralLearnedWeights(w: WeightProfile): boolean {
  return w.keywordMul === 1 && w.semanticMul === 1 && w.entityMul === 1 && w.recencyMul === 1;
}

/**
 * Compose the intent profile with the learned multipliers. Both factors
 * are bounded ([0.7, 1.4] and [0.8, 1.2]), so the product is naturally
 * bounded in [0.56, 1.68]; no extra clamp is needed and the composition
 * stays transparent (each factor is visible in diagnostics).
 */
export function composeWeightProfiles(
  intent: WeightProfile | undefined,
  learned: WeightProfile,
): WeightProfile {
  const base = intent ?? { keywordMul: 1, semanticMul: 1, entityMul: 1, recencyMul: 1 };
  return Object.freeze({
    keywordMul: round6(base.keywordMul * learned.keywordMul),
    semanticMul: round6(base.semanticMul * learned.semanticMul),
    entityMul: round6(base.entityMul * learned.entityMul),
    recencyMul: round6(base.recencyMul * learned.recencyMul),
  });
}

/** Human/agent-readable summary of the non-neutral learned multipliers. */
export function learnedWeightsReason(w: WeightProfile): string {
  const parts: string[] = [];
  if (w.keywordMul !== 1) parts.push(`kw=${w.keywordMul.toFixed(3)}`);
  if (w.semanticMul !== 1) parts.push(`sem=${w.semanticMul.toFixed(3)}`);
  if (w.entityMul !== 1) parts.push(`ent=${w.entityMul.toFixed(3)}`);
  if (w.recencyMul !== 1) parts.push(`rec=${w.recencyMul.toFixed(3)}`);
  return `learned_weights: ${parts.join(" ")}`;
}

/**
 * How deep the judged query is re-run before the verdict is scored.
 * Hoisted so the depth is named where it is decided rather than inline.
 */
const FEEDBACK_RERUN_LIMIT = 50;

export interface CaptureRecallFeedbackInput {
  readonly query: string;
  readonly resultPath: string;
  readonly verdict: "up" | "down";
  /** Injected clock for deterministic tests. Defaults to Date.now(). */
  readonly nowMs?: number;
  /**
   * How far this caller reached, minted by the transport
   * (`src/core/graph/transport-reach.ts`).
   *
   * Load-bearing rather than decorative: {@link
   * CaptureRecallFeedbackOutcome.resultFound} reports whether the judged
   * path came back, so a re-run that saw a reserved page would answer
   * "yes, it exists" to a caller the page is reserved against. Omitted
   * resolves to the narrowest.
   */
  readonly transportReach?: TransportReach;
}

export interface CaptureRecallFeedbackOutcome {
  readonly file: string;
  readonly event: RecallFeedbackEvent;
  readonly learned: LearnedWeights;
  /** False when the judged path was not in the re-ran result set. */
  readonly resultFound: boolean;
  /**
   * Why the re-run narrowed, as the trail's codes; empty when nothing did.
   * The re-run is gated like any search (a remote caller's unpriced query
   * embed is refused), so the contributions it recorded describe the
   * ranking this caller's own search produces, and this says when that
   * ranking was keyword-only.
   */
  readonly degraded: ReadonlyArray<RetrievalDegradationCode>;
}

/**
 * Shared CLI/MCP capture path: re-run the query, read the judged
 * result's per-layer contributions at retrieval time, and record the
 * event. When the path is no longer in the result set the event is
 * still recorded — with zero contributions, which the fold skips for
 * layer signal but keeps in the audit trail. `search.ts` is imported
 * lazily because it imports this module for ranking integration (the
 * same lazy-import seam search.ts itself uses for the indexer).
 */
export async function captureRecallFeedback(
  config: ResolvedSearchConfig,
  input: CaptureRecallFeedbackInput,
): Promise<CaptureRecallFeedbackOutcome> {
  const { search } = await import("./search.ts");
  const outcome = await search(config, {
    query: input.query,
    limit: FEEDBACK_RERUN_LIMIT,
    ...(input.transportReach !== undefined ? { transportReach: input.transportReach } : {}),
  });
  const hit = outcome.results.find((r) => r.path === input.resultPath);
  const degraded = Object.freeze((outcome.retrievalTrail?.degraded ?? []).map((d) => d.code));
  // A re-run the semantic lane never reached (the spend gate, or any other
  // stop under hybrid recall) scored the hit on a keyword-only pool, so its
  // layer shares describe the degradation, not the result. The event keeps
  // its audit row with zero contributions, which the fold skips, so the
  // vault-wide weights never drift toward keyword while the gate holds.
  const laneMissing = semanticLaneMissing(degraded);
  const contributions: LayerContributions =
    hit && !laneMissing
      ? contributionsFromResult(hit)
      : Object.freeze({ keyword: 0, semantic: 0, entity: 0, recency: 0 });
  const normalized = input.query.trim().replace(/\s+/gu, " ").toLowerCase();
  const event: RecallFeedbackEvent = Object.freeze({
    ts: input.nowMs ?? Date.now(),
    queryHash: fnv1aHex(normalized),
    resultPath: input.resultPath,
    verdict: input.verdict,
    contributions,
  });
  const file = recordRecallFeedback(config.vault, event);
  const learned = readLearnedWeights(config.vault) ?? NEUTRAL_LEARNED_WEIGHTS;
  return Object.freeze({ file, event, learned, resultFound: hit !== undefined, degraded });
}

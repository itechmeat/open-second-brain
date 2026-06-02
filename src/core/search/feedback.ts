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
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { BrainSearchResult, ResolvedSearchConfig, WeightProfile } from "./types.ts";

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

export function feedbackDir(vault: string): string {
  return join(vault, "Brain", "search", "feedback");
}

export function learnedWeightsPath(vault: string): string {
  return join(vault, "Brain", "search", "learned-weights.json");
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
 * semantic, and recency are first-class fields; the entity layer only
 * surfaces through its `entity_match:` reason, so it is parsed back out.
 */
export function contributionsFromResult(result: BrainSearchResult): LayerContributions {
  let entity = 0;
  for (const reason of result.reasons) {
    if (reason.startsWith("entity_match: ")) {
      const parsed = Number(reason.slice("entity_match: ".length));
      if (Number.isFinite(parsed)) entity = parsed;
      break;
    }
  }
  return Object.freeze({
    keyword: result.keywordScore,
    semantic: result.semanticScore,
    entity,
    recency: result.recencyBoost,
  });
}

/**
 * Record one feedback event as its own file and refresh the derived
 * learned-weights file. The filename derives from the timestamp plus a
 * content hash, so recording the identical event twice is idempotent.
 */
export function recordRecallFeedback(vault: string, event: RecallFeedbackEvent): string {
  const dir = feedbackDir(vault);
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(event, null, 2) + "\n";
  const file = join(dir, `${event.ts}-${fnv1aHex(body)}.json`);
  writeFileSync(file, body);
  writeLearnedWeights(vault, computeLearnedWeights(loadFeedbackEvents(vault)));
  return file;
}

/** Load all feedback events, sorted by timestamp then path (stable). */
export function loadFeedbackEvents(vault: string): RecallFeedbackEvent[] {
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
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as RecallFeedbackEvent;
      if (
        typeof parsed.ts === "number" &&
        (parsed.verdict === "up" || parsed.verdict === "down") &&
        typeof parsed.resultPath === "string" &&
        parsed.contributions !== undefined
      ) {
        out.push(parsed);
      }
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

export function writeLearnedWeights(vault: string, weights: LearnedWeights): void {
  mkdirSync(join(vault, "Brain", "search"), { recursive: true });
  writeFileSync(learnedWeightsPath(vault), JSON.stringify(weights, null, 2) + "\n");
}

export function readLearnedWeights(vault: string): LearnedWeights | null {
  try {
    const parsed = JSON.parse(readFileSync(learnedWeightsPath(vault), "utf8")) as LearnedWeights;
    // All four multipliers must be finite numbers — a partially-corrupt
    // file must not feed NaN into the weight composition.
    const muls = [parsed.keywordMul, parsed.semanticMul, parsed.entityMul, parsed.recencyMul];
    if (!muls.every((m) => typeof m === "number" && Number.isFinite(m))) return null;
    if (typeof parsed.events !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Delete the derived weights file. The events stay — the fold can replay. */
export function resetLearnedWeights(vault: string): void {
  rmSync(learnedWeightsPath(vault), { force: true });
}

/**
 * Stable fingerprint of the learned-weights state for the query-cache
 * key: "off" when no derived file exists, else a hash of its content.
 */
export function learnedWeightsFingerprint(vault: string): string {
  const path = learnedWeightsPath(vault);
  if (!existsSync(path)) return "off";
  try {
    return fnv1aHex(readFileSync(path, "utf8"));
  } catch {
    return "off";
  }
}

/** True when at least one multiplier deviates from neutral. */
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

export interface CaptureRecallFeedbackInput {
  readonly query: string;
  readonly resultPath: string;
  readonly verdict: "up" | "down";
  /** Injected clock for deterministic tests. Defaults to Date.now(). */
  readonly nowMs?: number;
}

export interface CaptureRecallFeedbackOutcome {
  readonly file: string;
  readonly event: RecallFeedbackEvent;
  readonly learned: LearnedWeights;
  /** False when the judged path was not in the re-ran result set. */
  readonly resultFound: boolean;
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
  const outcome = await search(config, { query: input.query, limit: 50 });
  const hit = outcome.results.find((r) => r.path === input.resultPath);
  const contributions: LayerContributions = hit
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
  return Object.freeze({ file, event, learned, resultFound: hit !== undefined });
}

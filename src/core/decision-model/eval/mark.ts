/**
 * The machine-side tuning mark (cycle 20261020, card t_4e1681b3).
 *
 * One small file per (threshold profile, use) under the platform state
 * root - outside every vault - recording that the preregistered eval
 * met its bar for that pair. The config resolver consults it ONLY when
 * the source table in `questions.ts` says the use is untuned, so a
 * hand-registered tune always wins and the hot-path cost is one TTL
 * cached file read per pair per minute (the `SPEND_CACHE_TTL_MS`
 * precedent).
 *
 * The mark is the GATE INPUT; the vault's `decision_model_eval_grade`
 * records are the review evidence a reviewer audits it against. The
 * runner (`eval/grade.ts`) is the only writer: a `promote` verdict
 * writes the mark, and a completed non-promote measurement retracts a
 * matching one - a use that missed its bar must not keep an earlier
 * mark armed. Acceptance is fail-closed: the mark is honored only
 * when its spec hash, fixture hash and pinned threshold values all match
 * the installed spec - a spec edited after the mark was written, a
 * fixture that moved, or thresholds that drifted each put the use back
 * in shadow. No mark file is exactly today's behavior.
 *
 * The mark is also bound to the endpoint that earned it. It records the
 * decision provider id, the pinned model id and a hash of the base URL
 * of the config whose measurement promoted, and the gate reader
 * (`machineTunedMarkReader`) refuses a mark whose recorded endpoint
 * differs from the config being resolved - a promote measured on one
 * model never arms enforce for another, at another URL, or under
 * another provider. Marks written before the binding existed carry no
 * endpoint fields and parse as no mark: fail closed, shadow.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync, unlinkWithRetry } from "../../fs-atomic.ts";
import { sha256Hex } from "../../integrity/digest.ts";
import {
  decisionModelStateDir,
  processDirsEnv,
  type PlatformDirsEnv,
} from "../../platform-dirs.ts";
import type { DecisionModelUse } from "../contract.ts";
import { decisionEvalSpecFor, decisionEvalSpecHash, type DecisionEvalSpec } from "../eval-spec.ts";

/** The only verdict a mark may carry, by construction of the writer. */
const PROMOTE = "promote";

/** sha-256 hex digest length, for the recorded base-URL hash. */
const HASH_HEX_RE = /^[0-9a-f]{64}$/;

export interface DecisionTuningMark {
  readonly profile: string;
  readonly use: DecisionModelUse;
  readonly spec_hash: string;
  readonly fixture_hash: string;
  /** The pinned threshold values the use was measured against. */
  readonly thresholds: Readonly<Record<string, number>>;
  readonly metric: string;
  readonly counted_n: number;
  readonly counted_error: number | null;
  readonly baseline_error: number | null;
  readonly verdict: typeof PROMOTE;
  readonly created_at: string;
  /** The decision provider id whose measurement earned the mark. */
  readonly provider: string;
  /** The pinned model id that was measured. */
  readonly model: string;
  /**
   * sha-256 of the measured base URL - a hash, never the URL itself.
   * Marks written before these three fields existed are refused at
   * parse time: an endpoint no one can prove is a mark no one arms.
   */
  readonly base_url_hash: string;
}

/**
 * The decision endpoint a mark is checked against: the resolved
 * config's provider id, pinned model id and base URL. A `null` field
 * never matches a recorded one.
 */
export interface DecisionMarkEndpoint {
  readonly provider: string | null;
  readonly model: string | null;
  readonly baseUrl: string | null;
}

/** The base-URL binding recorded in a mark: a digest, never the URL. */
export function decisionModelBaseUrlHash(baseUrl: string | null | undefined): string {
  return sha256Hex(baseUrl ?? "");
}

/** The mark file for one (profile, use) pair. */
export function decisionModelTuningMarkPath(
  source: PlatformDirsEnv,
  profile: string,
  use: DecisionModelUse,
): string {
  return join(decisionModelStateDir(source), "tuning-marks", profile, `${use}.json`);
}

/** Write one mark atomically; the next read sees it immediately. */
export function writeTuningMark(path: string, mark: DecisionTuningMark): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(mark, null, 2)}\n`);
  MARK_CACHE.delete(path);
}

/**
 * Delete the tuning mark for (profile, use) - but only one whose spec
 * hash matches `specHash`, i.e. a mark this exact spec earned; a
 * measurement under another spec does not speak for it. Reports whether
 * a matching mark was deleted: false when there is no state root, no
 * profile (no pair to retract), no mark, or a foreign-spec mark. The
 * deletion is immediately visible to the next read, cached or not.
 */
export function retractTuningMark(
  source: PlatformDirsEnv | null | undefined,
  profile: string | null,
  use: DecisionModelUse,
  specHash: string,
  nowMs: number = Date.now(),
): boolean {
  if (source === null || source === undefined || profile === null) return false;
  const path = decisionModelTuningMarkPath(source, profile, use);
  const mark = readTuningMark(path, nowMs);
  if (mark === null || mark.spec_hash !== specHash) return false;
  unlinkWithRetry(path);
  MARK_CACHE.delete(path);
  return true;
}

/** Parse one mark document. Anything malformed parses as no mark (fail closed). */
function parseTuningMark(text: string): DecisionTuningMark | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m["profile"] !== "string" ||
    typeof m["use"] !== "string" ||
    typeof m["spec_hash"] !== "string" ||
    typeof m["fixture_hash"] !== "string" ||
    typeof m["metric"] !== "string" ||
    typeof m["created_at"] !== "string" ||
    m["verdict"] !== PROMOTE ||
    typeof m["counted_n"] !== "number" ||
    // The endpoint binding: a mark that cannot name the provider, the
    // pinned model and the base-URL hash it was measured on is refused
    // here, so pre-binding marks fail closed to shadow.
    typeof m["provider"] !== "string" ||
    m["provider"].trim() === "" ||
    typeof m["model"] !== "string" ||
    m["model"].trim() === "" ||
    typeof m["base_url_hash"] !== "string" ||
    !HASH_HEX_RE.test(m["base_url_hash"]) ||
    m["thresholds"] === null ||
    typeof m["thresholds"] !== "object" ||
    Array.isArray(m["thresholds"]) ||
    !Object.values(m["thresholds"]).every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return null;
  }
  for (const key of ["counted_error", "baseline_error"] as const) {
    const v = m[key];
    if (v !== null && typeof v !== "number") return null;
  }
  return {
    profile: m["profile"],
    use: m["use"] as DecisionModelUse,
    spec_hash: m["spec_hash"],
    fixture_hash: m["fixture_hash"],
    thresholds: m["thresholds"] as Readonly<Record<string, number>>,
    metric: m["metric"],
    counted_n: m["counted_n"],
    counted_error: m["counted_error"] as number | null,
    baseline_error: m["baseline_error"] as number | null,
    verdict: PROMOTE,
    created_at: m["created_at"],
    provider: m["provider"],
    model: m["model"],
    base_url_hash: m["base_url_hash"],
  };
}

/**
 * Read one mark file through the TTL cache. Anything unreadable or
 * malformed reads as no mark (fail closed) - and that absence is cached
 * too, so a missing file costs one stat-and-read per {@link
 * TUNING_MARK_CACHE_TTL_MS}, not one per request. {@link writeTuningMark}
 * drops the cache entry it wrote so the next read sees it immediately.
 */
export function readTuningMark(
  path: string,
  nowMs: number = Date.now(),
): DecisionTuningMark | null {
  const hit = MARK_CACHE.get(path);
  if (hit !== undefined && nowMs - hit.loadedAtMs < TUNING_MARK_CACHE_TTL_MS) return hit.mark;
  let mark: DecisionTuningMark | null = null;
  try {
    mark = parseTuningMark(readFileSync(path, "utf8"));
  } catch {
    mark = null;
  }
  MARK_CACHE.set(path, { mark, loadedAtMs: nowMs });
  return mark;
}

/**
 * How long a loaded mark is trusted before its file is read again. A
 * deleted mark takes effect within this window - failing closed shortly
 * after deletion, never failing open.
 */
export const TUNING_MARK_CACHE_TTL_MS = 60_000;

const MARK_CACHE = new Map<string, { mark: DecisionTuningMark | null; loadedAtMs: number }>();

/** Tests only: forget every loaded mark. */
export function resetTuningMarkCache(): void {
  MARK_CACHE.clear();
}

/**
 * The validated mark for (profile, use), or null. Every axis must match
 * the installed spec - spec hash, fixture hash, pinned threshold values,
 * the pair itself - and the verdict must be promote; when an `endpoint`
 * is supplied, its provider, model and base-URL hash must match the ones
 * recorded in the mark too. Anything else is no mark, and the use stays
 * in shadow.
 */
export function validatedTuningMark(
  profile: string | null,
  use: DecisionModelUse,
  source: PlatformDirsEnv = processDirsEnv(),
  spec: DecisionEvalSpec | null = decisionEvalSpecFor(use),
  nowMs: number = Date.now(),
  endpoint?: DecisionMarkEndpoint,
): DecisionTuningMark | null {
  if (profile === null || spec === null) return null;
  const mark = readTuningMark(decisionModelTuningMarkPath(source, profile, use), nowMs);
  if (mark === null) return null;
  if (mark.profile !== profile || mark.use !== use) return null;
  if (mark.spec_hash !== decisionEvalSpecHash(spec)) return null;
  if (mark.fixture_hash !== spec.fixture_hash) return null;
  if (JSON.stringify(mark.thresholds) !== JSON.stringify(spec.thresholds)) return null;
  if (mark.verdict !== PROMOTE) return null;
  if (
    endpoint !== undefined &&
    (mark.provider !== endpoint.provider ||
      mark.model !== endpoint.model ||
      mark.base_url_hash !== decisionModelBaseUrlHash(endpoint.baseUrl))
  ) {
    return null;
  }
  return mark;
}

/**
 * The reader shape `resolveDecisionModelConfig` threads to
 * `thresholdsTunedFor`: true only when a mark that matches the installed
 * spec AND the `endpoint` being resolved exists for the pair. Consulted
 * only when the source table says untuned, so a hand-registered tune
 * never pays the read. The endpoint binding is what keeps a promote
 * earned by one provider/model/base URL from arming enforce for
 * another.
 */
export function machineTunedMarkReader(
  endpoint: DecisionMarkEndpoint,
  source: PlatformDirsEnv = processDirsEnv(),
): (profile: string | null, use: DecisionModelUse) => boolean {
  return (profile, use) =>
    validatedTuningMark(profile, use, source, undefined, undefined, endpoint) !== null;
}

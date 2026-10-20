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
 * runner (`eval/grade.ts`) is the only writer, and it writes only on a
 * `promote` verdict. Acceptance is fail-closed: the mark is honored only
 * when its spec hash, fixture hash and pinned threshold values all match
 * the installed spec - a spec edited after the mark was written, a
 * fixture that moved, or thresholds that drifted each put the use back
 * in shadow. No mark file is exactly today's behavior.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import {
  decisionModelStateDir,
  processDirsEnv,
  type PlatformDirsEnv,
} from "../../platform-dirs.ts";
import type { DecisionModelUse } from "../contract.ts";
import { decisionEvalSpecFor, decisionEvalSpecHash, type DecisionEvalSpec } from "../eval-spec.ts";

/** The only verdict a mark may carry, by construction of the writer. */
const PROMOTE = "promote";

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
 * the pair itself - and the verdict must be promote; anything else is no
 * mark, and the use stays in shadow.
 */
export function validatedTuningMark(
  profile: string | null,
  use: DecisionModelUse,
  source: PlatformDirsEnv = processDirsEnv(),
  spec: DecisionEvalSpec | null = decisionEvalSpecFor(use),
  nowMs: number = Date.now(),
): DecisionTuningMark | null {
  if (profile === null || spec === null) return null;
  const mark = readTuningMark(decisionModelTuningMarkPath(source, profile, use), nowMs);
  if (mark === null) return null;
  if (mark.profile !== profile || mark.use !== use) return null;
  if (mark.spec_hash !== decisionEvalSpecHash(spec)) return null;
  if (mark.fixture_hash !== spec.fixture_hash) return null;
  if (JSON.stringify(mark.thresholds) !== JSON.stringify(spec.thresholds)) return null;
  if (mark.verdict !== PROMOTE) return null;
  return mark;
}

/**
 * The reader shape `resolveDecisionModelConfig` threads to
 * `thresholdsTunedFor`: true only when a mark that matches the installed
 * spec exists for the pair. Consulted only when the source table says
 * untuned, so a hand-registered tune never pays the read.
 */
export function machineTunedMarkReader(
  source: PlatformDirsEnv = processDirsEnv(),
): (profile: string | null, use: DecisionModelUse) => boolean {
  return (profile, use) => validatedTuningMark(profile, use, source) !== null;
}

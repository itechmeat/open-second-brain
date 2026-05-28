import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs, vaultRelative } from "./paths.ts";
import { parseRetired } from "./preference.ts";
import { parseSignal } from "./signal.ts";
import type { BrainRetired, BrainSignal } from "./types.ts";

export type RetentionAction = "keep" | "improve" | "park" | "prune";
export type RetentionArtifactType = "retired_preference" | "processed_signal";

export interface RetentionRecommendation {
  readonly id: string;
  readonly artifact_type: RetentionArtifactType;
  readonly action: RetentionAction;
  readonly reason: string;
  readonly path: string;
}

export interface RetentionSummary {
  readonly keep: number;
  readonly improve: number;
  readonly park: number;
  readonly prune: number;
}

export interface RetentionReviewReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly summary: RetentionSummary;
  readonly recommendations: ReadonlyArray<RetentionRecommendation>;
}

export interface BuildRetentionReviewOptions {
  readonly now?: Date;
}

const OLD_PROCESSED_SIGNAL_DAYS = 30;
const PARK_RETIRED_AFTER_DAYS = 90;

export function buildRetentionReview(
  vault: string,
  options: BuildRetentionReviewOptions = {},
): RetentionReviewReport {
  const now = options.now ?? new Date();
  const recommendations = [
    ...collectRetiredPreferences(vault, now),
    ...collectProcessedSignals(vault, now),
  ].toSorted((left, right) => left.id.localeCompare(right.id));

  return Object.freeze({
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    summary: Object.freeze(summarize(recommendations)),
    recommendations: Object.freeze(recommendations),
  });
}

function collectRetiredPreferences(
  vault: string,
  now: Date,
): RetentionRecommendation[] {
  const retiredDir = brainDirs(vault).retired;
  if (!existsSync(retiredDir)) return [];
  const recommendations: RetentionRecommendation[] = [];
  for (const name of readdirSync(retiredDir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = join(retiredDir, name);
    try {
      const retired = parseRetired(path);
      recommendations.push(recommendRetired(vault, path, retired, now));
    } catch {
      continue;
    }
  }
  return recommendations;
}

function collectProcessedSignals(
  vault: string,
  now: Date,
): RetentionRecommendation[] {
  const processedDir = brainDirs(vault).processed;
  if (!existsSync(processedDir)) return [];
  const recommendations: RetentionRecommendation[] = [];
  for (const name of readdirSync(processedDir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = join(processedDir, name);
    try {
      const signal = parseSignal(path);
      recommendations.push(recommendProcessedSignal(vault, path, signal, now));
    } catch {
      continue;
    }
  }
  return recommendations;
}

function recommendRetired(
  vault: string,
  path: string,
  retired: BrainRetired,
  now: Date,
): RetentionRecommendation {
  const applied = retired.applied_count ?? 0;
  const violated = retired.violated_count ?? 0;
  const ageDays = daysSince(retired.retired_at, now);
  let action: RetentionAction;
  let reason: string;

  if (violated > applied && violated > 0) {
    action = "improve";
    reason =
      "retired rule has more violations than applications; review wording before reuse";
  } else if (applied > 0 || retired.last_evidence_at !== null) {
    action = "keep";
    reason = "retired rule has an evidence trail worth preserving for audit";
  } else if (ageDays >= PARK_RETIRED_AFTER_DAYS) {
    action = "park";
    reason =
      "old retired rule has no evidence trail; preserve inactive unless needed";
  } else {
    action = "improve";
    reason =
      "recent retired rule has no evidence trail; review whether it needs clarification";
  }

  return Object.freeze({
    id: retired.id,
    artifact_type: "retired_preference" as const,
    action,
    reason,
    path: vaultRelative(vault, path),
  });
}

function recommendProcessedSignal(
  vault: string,
  path: string,
  signal: BrainSignal,
  now: Date,
): RetentionRecommendation {
  const ageDays = daysSince(signal.created_at, now);
  const hasSource = (signal.source?.length ?? 0) > 0;
  let action: RetentionAction;
  let reason: string;

  if (!hasSource && ageDays >= OLD_PROCESSED_SIGNAL_DAYS) {
    action = "prune";
    reason =
      "old processed one-off signal has no source pointers; safe candidate for manual pruning";
  } else if (hasSource) {
    action = "keep";
    reason =
      "processed signal carries source pointers that preserve audit context";
  } else {
    action = "park";
    reason =
      "processed signal is recent; leave it inactive until the next retention pass";
  }

  return Object.freeze({
    id: signal.id,
    artifact_type: "processed_signal" as const,
    action,
    reason,
    path: vaultRelative(vault, path),
  });
}

function summarize(
  recommendations: ReadonlyArray<RetentionRecommendation>,
): RetentionSummary {
  const summary = { keep: 0, improve: 0, park: 0, prune: 0 };
  for (const recommendation of recommendations) {
    summary[recommendation.action] += 1;
  }
  return summary;
}

function daysSince(iso: string, now: Date): number {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(
    0,
    Math.floor((now.getTime() - timestamp) / (24 * 60 * 60 * 1000)),
  );
}

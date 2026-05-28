import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs, vaultRelative } from "./paths.ts";
import { loadBrainConfig } from "./policy.ts";
import { parseRetired } from "./preference.ts";
import { parseSignal } from "./signal.ts";
import { BRAIN_SIGNAL_SIGN, type BrainSignal, type BrainSignalSign } from "./types.ts";

export type BrainIntentDecision =
  | "ready_for_main_review"
  | "needs_more_evidence"
  | "blocked_conflicted"
  | "suppressed_by_rejected_retired";

export type BrainIntentRiskBand = "low" | "medium" | "high";

export interface BrainIntentReviewEntry {
  readonly topic: string;
  readonly decision: BrainIntentDecision;
  readonly signal_count: number;
  readonly risk_band: BrainIntentRiskBand;
  readonly risk_score: number;
  readonly reasons: ReadonlyArray<string>;
}

export interface BrainIntentReviewReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly reviews: ReadonlyArray<BrainIntentReviewEntry>;
}

export interface BuildIntentReviewOptions {
  readonly now?: Date;
}

interface SignalRecord {
  readonly path: string;
  readonly signal: BrainSignal;
}

interface RejectedRetiredSuppressor {
  readonly topic: string;
  readonly scope?: string;
}

export function buildIntentReview(
  vault: string,
  options: BuildIntentReviewOptions = {},
): BrainIntentReviewReport {
  const now = options.now ?? new Date();
  const config = loadBrainConfig(vault);
  const records = collectActiveSignals(vault).filter((record) =>
    isWithinWindow(record.signal.created_at, config.dream.contradiction_window_days, now),
  );
  const byTopic = new Map<string, SignalRecord[]>();
  for (const record of records) {
    const topicRecords = byTopic.get(record.signal.topic);
    if (topicRecords === undefined) {
      byTopic.set(record.signal.topic, [record]);
    } else {
      topicRecords.push(record);
    }
  }
  const rejectedRetiredByTopic = collectRejectedRetiredSuppressors(vault);

  const reviews = [...byTopic.entries()]
    .toSorted(([leftTopic], [rightTopic]) => leftTopic.localeCompare(rightTopic))
    .map(([topic, topicRecords]) =>
      reviewTopic(
        topic,
        topicRecords,
        config.dream.candidate_threshold,
        rejectedRetiredByTopic.get(topic) ?? [],
      ),
    );

  return Object.freeze({
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    reviews: Object.freeze(reviews),
  });
}

function collectActiveSignals(vault: string): SignalRecord[] {
  const inbox = brainDirs(vault).inbox;
  if (!existsSync(inbox)) return [];
  const records: SignalRecord[] = [];
  for (const name of readdirSync(inbox).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const path = join(inbox, name);
    try {
      records.push({
        path: vaultRelative(vault, path),
        signal: parseSignal(path),
      });
    } catch {
      continue;
    }
  }
  return records;
}

function collectRejectedRetiredSuppressors(
  vault: string,
): Map<string, RejectedRetiredSuppressor[]> {
  const retiredDir = brainDirs(vault).retired;
  const byTopic = new Map<string, RejectedRetiredSuppressor[]>();
  if (!existsSync(retiredDir)) return byTopic;
  for (const name of readdirSync(retiredDir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    try {
      const retired = parseRetired(join(retiredDir, name));
      if (!retired.user_rejected_reason?.trim()) continue;
      const suppressor: RejectedRetiredSuppressor = {
        topic: retired.topic,
        ...(retired.scope ? { scope: retired.scope } : {}),
      };
      const existing = byTopic.get(retired.topic);
      if (existing === undefined) {
        byTopic.set(retired.topic, [suppressor]);
      } else {
        existing.push(suppressor);
      }
    } catch {
      continue;
    }
  }
  return byTopic;
}

function reviewTopic(
  topic: string,
  records: ReadonlyArray<SignalRecord>,
  candidateThreshold: number,
  rejectedRetiredSuppressors: ReadonlyArray<RejectedRetiredSuppressor>,
): BrainIntentReviewEntry {
  const candidateRecords = records.filter(
    (record) => !isSuppressedByRejectedRetired(record, rejectedRetiredSuppressors),
  );
  const suppressedCount = records.length - candidateRecords.length;
  const positiveCount = countSign(candidateRecords, BRAIN_SIGNAL_SIGN.positive);
  const negativeCount = countSign(candidateRecords, BRAIN_SIGNAL_SIGN.negative);
  const minorityCount = Math.min(positiveCount, negativeCount);
  const dominantCount = Math.max(positiveCount, negativeCount);
  const effectiveSignalCount = dominantCount - minorityCount;
  const signalCount = records.length;

  let decision: BrainIntentDecision;
  const reasons: string[] = [];
  if (suppressedCount > 0 && candidateRecords.length === 0) {
    decision = "suppressed_by_rejected_retired";
    reasons.push("signals match a user-rejected retired preference");
  } else if (positiveCount > 0 && negativeCount > 0 && effectiveSignalCount < candidateThreshold) {
    decision = "blocked_conflicted";
    reasons.push("opposing signals cancel below the promotion threshold");
  } else if (effectiveSignalCount >= candidateThreshold) {
    decision = "ready_for_main_review";
    reasons.push("dominant signal count meets the promotion threshold");
  } else {
    decision = "needs_more_evidence";
    reasons.push("dominant signal count is below the promotion threshold");
  }
  if (suppressedCount > 0 && candidateRecords.length > 0) {
    reasons.push("some signals match a user-rejected retired preference");
  }

  const riskScore = scoreRisk(decision, minorityCount, signalCount, candidateThreshold);
  return Object.freeze({
    topic,
    decision,
    signal_count: signalCount,
    risk_band: riskBand(riskScore),
    risk_score: riskScore,
    reasons: Object.freeze(reasons),
  });
}

function isSuppressedByRejectedRetired(
  record: SignalRecord,
  suppressors: ReadonlyArray<RejectedRetiredSuppressor>,
): boolean {
  return suppressors.some((suppressor) => {
    if (!suppressor.scope) return true;
    return record.signal.scope === suppressor.scope;
  });
}

function countSign(records: ReadonlyArray<SignalRecord>, sign: BrainSignalSign): number {
  return records.filter((record) => record.signal.signal === sign).length;
}

function scoreRisk(
  decision: BrainIntentDecision,
  minorityCount: number,
  signalCount: number,
  candidateThreshold: number,
): number {
  if (decision === "suppressed_by_rejected_retired") return 6;
  if (decision === "blocked_conflicted") return 8;
  if (decision === "needs_more_evidence") return 5;
  if (minorityCount > 0) return 4;
  if (signalCount === candidateThreshold) return 2;
  return 1;
}

function riskBand(score: number): BrainIntentRiskBand {
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function isWithinWindow(createdAt: string, windowDays: number, now: Date): boolean {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  const nowMs = now.getTime();
  const minTime = nowMs - windowDays * 24 * 60 * 60 * 1000;
  return createdMs >= minTime && createdMs <= nowMs;
}

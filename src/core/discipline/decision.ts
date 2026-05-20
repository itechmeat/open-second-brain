import type { BrainEventCounts } from "./log-counts.ts";
import type { GitActivity } from "./activity-git.ts";
import type { VaultDelta } from "./vault-delta.ts";
import type { TranscriptActivity } from "./transcripts/types.ts";

export interface RepoActivityRow {
  readonly path: string;
  readonly git: GitActivity;
}
export interface NonRepoActivityRow {
  readonly path: string;
  readonly modifiedFiles: number;
}

export interface ActivitySummary {
  readonly repo: ReadonlyArray<RepoActivityRow>;
  readonly nonRepo: ReadonlyArray<NonRepoActivityRow>;
  readonly vaultDelta: VaultDelta;
  /**
   * Per-runtime session-transcript activity (v0.10.11). Optional so
   * the type is back-compat with callers / tests that have not been
   * migrated yet. When present and non-empty it adds a
   * `transcript-confirmed` sub-reason to an `alert` row.
   */
  readonly transcripts?: TranscriptActivity;
}

/**
 * Did at least one per-runtime transcript surface activity in the
 * report window? Used by the renderer to add a `transcript-confirmed`
 * hint to an `alert` row.
 */
export function transcriptConfirmed(activity: ActivitySummary): boolean {
  return (activity.transcripts?.totalFiles ?? 0) > 0;
}

export type DisciplineStatus = "ok" | "info" | "alert";

export function decideStatus(
  events: BrainEventCounts,
  activity: ActivitySummary,
): DisciplineStatus {
  // Taste events only: feedback + apply_evidence. The `other` bucket
  // (snapshot / dream-pass / import-claude-memory / migrate-frontmatter)
  // would otherwise mask a real "agent shipped artifacts but recorded
  // zero taste signals" day — exactly the regression §D exists to catch.
  let tasteEvents = 0;
  for (const c of Object.values(events.byAgent)) {
    tasteEvents += c.feedback + c.apply_evidence;
  }
  for (const u of events.unknownAgents) {
    tasteEvents += u.counts.feedback + u.counts.apply_evidence;
  }
  if (tasteEvents > 0) return "ok";
  const repoCommits = activity.repo.reduce((a, r) => a + r.git.commits, 0);
  const mtimeFiles = activity.nonRepo.reduce((a, r) => a + r.modifiedFiles, 0);
  const vaultActive = activity.vaultDelta.total > 0;
  const activitySignal = repoCommits > 0 || mtimeFiles >= 3 || vaultActive;
  return activitySignal ? "alert" : "info";
}

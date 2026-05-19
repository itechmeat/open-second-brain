import type { BrainEventCounts } from "./log-counts.ts";
import type { GitActivity } from "./activity-git.ts";
import type { MtimeActivity } from "./activity-mtime.ts";
import type { VaultDelta } from "./vault-delta.ts";

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

import { escapeMarkdownV2 as e } from "./telegram.ts";
import type { BrainEventCounts } from "./log-counts.ts";
import { transcriptConfirmed, type ActivitySummary, type DisciplineStatus } from "./decision.ts";

export interface RenderInput {
  readonly localDate: string;
  readonly timezone: string;
  readonly status: DisciplineStatus;
  readonly events: BrainEventCounts;
  readonly activity: ActivitySummary;
}

export function renderReport(r: RenderInput): string {
  const lines: string[] = [];
  lines.push(`🧠 OSB discipline — ${e(r.localDate)} \\(${e(r.timezone)}\\)`);
  lines.push("");
  lines.push(`Status: ${e(r.status)}`);
  lines.push("");

  lines.push("Brain events:");
  const knownEntries = Object.entries(r.events.byAgent);
  if (knownEntries.length === 0) {
    lines.push("\\- \\(no known agents configured\\)");
  } else {
    for (const [agent, c] of knownEntries) {
      lines.push(
        `\\- ${e(agent)}: ${c.feedback} feedback, ${c.apply_evidence} apply\\-evidence, ${c.note} note, ${c.other} other \\(total ${c.total}\\)`,
      );
    }
  }
  for (const u of r.events.unknownAgents) {
    lines.push(
      `\\- ${e(u.agent)} \\(unknown\\): ${u.counts.feedback} feedback, ${u.counts.apply_evidence} apply\\-evidence, ${u.counts.note} note, ${u.counts.other} other \\(total ${u.counts.total}\\)`,
    );
  }
  lines.push("");

  lines.push("Activity:");
  for (const row of r.activity.repo) {
    lines.push(
      `\\- ${e(row.path)} — ${row.git.commits} commits, ${row.git.filesChanged} files, \\+${row.git.insertions}/\\-${row.git.deletions}`,
    );
  }
  for (const row of r.activity.nonRepo) {
    lines.push(`\\- ${e(row.path)} — ${row.modifiedFiles} modified files`);
  }
  const vd = r.activity.vaultDelta;
  lines.push(
    `\\- vault — ${vd.newSignals} new signals, ${vd.newPreferences} new preferences, ${vd.newRetired} new retired`,
  );
  const complexity = r.activity.complexity;
  if (complexity !== undefined) {
    lines.push(
      `\\- complexity — score ${complexity.score}, thinking ${complexity.thinking_activity}, ratio ${formatRatio(complexity.ratio)}`,
    );
  }
  const transcripts = r.activity.transcripts;
  if (transcripts && transcripts.byRuntime.length > 0) {
    const parts = transcripts.byRuntime
      .filter((b) => b.fileCount > 0 || b.detail)
      .map((b) => {
        const base = `${e(b.runtime)}: ${b.fileCount}`;
        if (b.detail) {
          return `${base} \\(${b.detail.sessionCount} sessions, ${b.detail.messageCount} messages\\)`;
        }
        return base;
      });
    if (parts.length > 0) {
      lines.push(`\\- transcripts — ${parts.join(", ")}`);
    }
  }

  if (r.status === "alert") {
    lines.push("");
    // Unescaped wrapper underscores so Telegram MarkdownV2 reads the line
    // as italic; the period in the middle stays escaped because it is a
    // reserved character. With both underscores escaped (as before) the
    // styling intent silently failed and rendered literal "_" instead.
    lines.push(
      "_Activity present; zero brain events recorded\\. Stop guardrail likely bypassed or hook regressed\\._",
    );
    if (transcriptConfirmed(r.activity)) {
      lines.push(
        "_Sub\\-reason: transcript\\-confirmed — runtime session files dated to this window\\._",
      );
    }
    if (complexity?.warning === true) {
      lines.push(
        "_Sub\\-reason: productivity\\-trap — vault structure grew faster than recorded thinking\\._",
      );
    }
  }
  return lines.join("\n");
}

function formatRatio(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

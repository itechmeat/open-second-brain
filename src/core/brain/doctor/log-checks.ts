/**
 * The event log: its shard structure and the artifact references its
 * apply-evidence events carry.
 *
 * One reason to change: the log format. A malformed header is a defect
 * in the file itself; a malformed or unresolvable artifact reference is
 * a defect in what an event points at.
 */

import type { DegradationNotice } from "../../integrity/degradation.ts";
import { listVaultBasenames } from "../../vault.ts";
import { listLogMarkdownFiles } from "../log-jsonl.ts";
import { parseLogDayFile } from "../log.ts";
import { brainDirs } from "../paths.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { parseArtifactRef } from "../wikilink.ts";
import type { DoctorCheck } from "./check.ts";
import type { DoctorUncertainEntry } from "./report.ts";
import { forwardSweepNotices, reportSweptFailure, SWEEP_ORIGIN } from "./unreadable-path.ts";

/** Subsystem name the shard discovery reports an unreadable path under. */
const LOG_SHARD_SITE = "brain.doctor.logShard";

/**
 * 7. Log header parsing — surface warnings from every markdown shard.
 */
export const logShardCheck: DoctorCheck = {
  failSoft: false,
  run({ vault }, { issues, uncertain }) {
    // Per-device shards (Memory Integrity Suite): lint every markdown
    // log file - legacy `<date>.md` and sharded `<date>.<deviceId>.md` -
    // so warnings keep their exact file paths and line numbers.
    //
    // The discovery itself is behind a shared helper: a `Brain/log` that
    // is a regular file arrives as a throw, and this check does not fail
    // soft, so it took the whole pass down with it. The read is now
    // classified like every other; a parse failure below still throws,
    // because a log the doctor mis-parses leaves the report wrong rather
    // than incomplete.
    for (const { date, path } of listShards(vault, uncertain)) {
      const { warnings } = parseLogDayFile(vault, date, path);
      for (const w of warnings) {
        issues.push({
          severity: "warning",
          code: "log-malformed",
          path: w.path,
          message: `line ${w.lineNumber}: ${w.message}`,
        });
      }
    }
  },
};

/** The markdown log shards, or none plus the reason there are none to lint. */
function listShards(
  vault: string,
  uncertain: DoctorUncertainEntry[],
): ReadonlyArray<{ date: string; path: string }> {
  try {
    return listLogMarkdownFiles(vault);
  } catch (err) {
    reportSweptFailure(
      brainDirs(vault).log,
      "log shard discovery failed",
      err,
      {
        site: LOG_SHARD_SITE,
        consequence:
          "no log shard under it was linted, so a malformed header in this vault's history is " +
          "missing from this report",
        uncertain,
      },
      SWEEP_ORIGIN.root,
    );
    return [];
  }
}

/**
 * `malformed-evidence-range`: walks every `apply-evidence` event,
 * runs the artifact wikilink through {@link parseArtifactRef}, and
 * flags any malformed range suffix (`:abc-def`, `:120-100`, etc.).
 * The event itself remains valid — only the range is malformed.
 */
export const evidenceRangeCheck: DoctorCheck = {
  failSoft: true,
  run({ logs }, { issues }) {
    for (const { entries } of logs) {
      for (const e of entries) {
        if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
        const artifact = e.body["artifact"];
        if (typeof artifact !== "string") continue;
        const parsed = parseArtifactRef(artifact);
        if (parsed.malformedRange) {
          issues.push({
            severity: "warning",
            code: "malformed-evidence-range",
            message:
              `apply-evidence at ${e.timestamp} references artifact ${parsed.raw}` +
              ` with malformed range '${parsed.rangeText}'.` +
              " Use `[[file:N-N]]` (inclusive, 1-based) or `[[file:N]]`.",
          });
        }
      }
    }
  },
};

/** Subsystem name the basename sweep reports an unreadable path under. */
const ORPHAN_EVIDENCE_SITE = "brain.doctor.orphanEvidence";

/**
 * `orphan-evidence`: walks every `apply-evidence` event and verifies
 * the artifact wikilink resolves to some file in the vault. Obsidian
 * wikilinks resolve by basename; we use the cheap basename-only
 * walker from `vault.ts` (no frontmatter parse).
 *
 * This is the only doctor lint that walks the entire vault (not just
 * `Brain/`). It's an on-demand check; doctor isn't called per-turn.
 *
 * The walker is fail-soft over a directory it cannot list, so an
 * unreadable subtree silently shrank the universe every reference here
 * is resolved against - and a reference into that subtree then reads as
 * orphaned. Those directories now arrive on the walker's notice sink and
 * are reported as uncertainty; the findings below are unchanged.
 */
export const orphanEvidenceCheck: DoctorCheck = {
  failSoft: true,
  run({ vault, logs }, { issues, uncertain }) {
    const notices: DegradationNotice[] = [];
    const basenames: ReadonlySet<string> = listVaultBasenames(vault, {
      notices,
      site: ORPHAN_EVIDENCE_SITE,
    });
    forwardSweepNotices(notices, {
      site: ORPHAN_EVIDENCE_SITE,
      consequence:
        "its pages are absent from the basename universe this lint resolves artifact " +
        "references against, so a reference that resolves under it reads as orphaned here",
      uncertain,
    });
    for (const { entries } of logs) {
      for (const e of entries) {
        if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
        const artifact = e.body["artifact"];
        if (typeof artifact !== "string") continue;
        const target = parseArtifactRef(artifact).target;
        if (!target) continue;
        if (basenames.has(target)) continue;
        issues.push({
          severity: "warning",
          code: "orphan-evidence",
          message:
            `apply-evidence at ${e.timestamp} references artifact [[${target}]]` +
            " but no file with that basename exists in the vault.",
        });
      }
    }
  },
};

/**
 * The event log: its shard structure and the artifact references its
 * apply-evidence events carry.
 *
 * One reason to change: the log format. A malformed header is a defect
 * in the file itself; a malformed or unresolvable artifact reference is
 * a defect in what an event points at.
 */

import { listVaultBasenames } from "../../vault.ts";
import { listLogMarkdownFiles } from "../log-jsonl.ts";
import { parseLogDayFile } from "../log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { parseArtifactRef } from "../wikilink.ts";
import type { DoctorCheck } from "./check.ts";

/**
 * 7. Log header parsing — surface warnings from every markdown shard.
 */
export const logShardCheck: DoctorCheck = {
  failSoft: false,
  run({ vault }, { issues }) {
    // Per-device shards (Memory Integrity Suite): lint every markdown
    // log file - legacy `<date>.md` and sharded `<date>.<deviceId>.md` -
    // so warnings keep their exact file paths and line numbers.
    for (const { date, path } of listLogMarkdownFiles(vault)) {
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

/**
 * `orphan-evidence`: walks every `apply-evidence` event and verifies
 * the artifact wikilink resolves to some file in the vault. Obsidian
 * wikilinks resolve by basename; we use the cheap basename-only
 * walker from `vault.ts` (no frontmatter parse).
 *
 * This is the only doctor lint that walks the entire vault (not just
 * `Brain/`). It's an on-demand check; doctor isn't called per-turn.
 */
export const orphanEvidenceCheck: DoctorCheck = {
  failSoft: true,
  run({ vault, logs }, { issues }) {
    let basenames: ReadonlySet<string>;
    try {
      basenames = listVaultBasenames(vault);
    } catch {
      return;
    }
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

/**
 * The state of the store as a set of files, independent of what any
 * record says.
 *
 * A symlink that leaves the vault, a sync-conflict copy no writer made,
 * a workrun that never reached a terminal phase, an identity field
 * hand-edited into the index: none of these is a schema violation, and
 * all of them are conditions only a walk of the tree can see.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { realpathInsideVault, vaultRelative } from "../../path-safety.ts";
import { scanDanglingWorkruns } from "../dream-workrun.ts";
import { readTierDriftCount } from "../frontmatter-tiers.ts";
import { listLogSyncConflicts } from "../log-jsonl.ts";
import { brainDirs } from "../paths.ts";
import type { DoctorCheck } from "./check.ts";
import { readSweptDir } from "./unreadable-path.ts";

/**
 * Tier guard (write-time-integrity-governance): staged identity
 * hand-edits the index post-pass detected. Fail-soft index read - a
 * missing index or pre-v6 schema simply skips the check.
 */
export const tierDriftCheck: DoctorCheck = {
  failSoft: false,
  run({ dbPath }, { issues }) {
    if (dbPath === undefined) return;
    const driftCount = readTierDriftCount(dbPath);
    if (driftCount > 0) {
      issues.push({
        severity: "warning",
        code: "tier-drift",
        message:
          `${driftCount} identity-field hand-edit(s) staged - ` +
          "review with: o2b brain tiers check",
      });
    }
  },
};

/**
 * `dangling-workrun` (v0.12.0, Brain Integrity Suite): surfaces every
 * dream-pass workrun JSONL whose last event is neither `finalized`
 * nor `interrupted`. A non-empty result means at least one previous
 * dream invocation died before it could declare a terminal phase,
 * usually because the host process was killed mid-run. The next
 * dream pass starts fresh - this check is purely observational so
 * the operator notices the failed run.
 */
export const danglingWorkrunCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues }) {
    for (const path of scanDanglingWorkruns(vault)) {
      issues.push({
        severity: "warning",
        code: "dangling-workrun",
        path,
        message:
          `dream-pass workrun did not reach a terminal phase: ${path}. ` +
          "A previous dream run was likely killed mid-execution; " +
          "subsequent dream invocations will continue normally.",
      });
    }
  },
};

/**
 * Memory Integrity Suite: leftover Syncthing conflict copies under
 * Brain/log/. The per-device shard layout prevents new ones; old
 * copies need a manual union+dedup merge into the day's log.
 */
export const syncConflictLogCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues }) {
    for (const path of listLogSyncConflicts(vault)) {
      issues.push({
        severity: "warning",
        code: "sync-conflict-log",
        path,
        message:
          `Syncthing sync-conflict copy under Brain/log/: ${path}. ` +
          "Merge its rows into the day's log (union + dedup by ts and content), then delete it.",
      });
    }
  },
};

/** Subsystem name the symlink walk reports an unreadable path under. */
const SYMLINK_ESCAPE_SITE = "brain.doctor.symlinkEscape";

/**
 * Store hardening (D2): a symlink inside Brain/ whose realpath resolves
 * OUTSIDE the vault root is an exfiltration/clobber hazard. Lint only -
 * never auto-fixed, because removing an operator-created link is a
 * judgment call.
 *
 * Reuses {@link realpathInsideVault} (the same two-step check
 * `ensureInsideVault` performs) so a symlink pointing at an in-vault
 * target never flags. Directory symlinks are reported but NOT descended
 * into - following them would leave the vault.
 *
 * A subtree the walk cannot list is reported as uncertainty rather than
 * skipped in silence: "no escaping symlink found" and "no symlink
 * examined" are the same empty result, and only one of them means the
 * store is safe to read.
 */
export const symlinkEscapeCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues, uncertain }) {
    const root = brainDirs(vault).brain;
    if (!existsSync(root)) return;
    const swept = {
      site: SYMLINK_ESCAPE_SITE,
      consequence:
        "no symlink under it was examined, so this subtree is not certified free of links " +
        "resolving outside the vault root",
      uncertain,
    };
    const visit = (dir: string): void => {
      const entries = readSweptDir(dir, swept);
      if (entries === null) return;
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          if (!realpathInsideVault(full, vault)) {
            issues.push({
              severity: "error",
              code: "symlink-escape",
              path: vaultRelative(full, vault),
              message:
                `symlink '${vaultRelative(full, vault)}' resolves outside the vault root. ` +
                "A reader following it leaves the vault; remove or repoint the link.",
            });
          }
          continue; // never descend through a symlink
        }
        if (entry.isDirectory()) visit(full);
      }
    };
    visit(root);
  },
};

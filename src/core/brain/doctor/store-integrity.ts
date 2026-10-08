/**
 * The state of the store as a set of files, independent of what any
 * record says.
 *
 * A symlink that leaves the vault, a sync-conflict copy no writer made,
 * a workrun that never reached a terminal phase, an identity field
 * hand-edited into the index: none of these is a schema violation, and
 * all of them are conditions only a walk of the tree can see.
 */

import { dirname, join } from "node:path";

import { ensureInsideVault, realpathInsideVault, vaultRelative } from "../../path-safety.ts";
import { readFreshenState } from "../../search/freshen.ts";
import { BRAIN_LOG_AUDIT_DIRS } from "../audit-dirs.ts";
import { continuityLogDir } from "../continuity/store.ts";
import { scanDanglingWorkruns } from "../dream-workrun.ts";
import { readTierDriftCount } from "../frontmatter-tiers.ts";
import { gitStoreRootDir } from "../git/store.ts";
import { idempotencyLogDir } from "../idempotency-ledger.ts";
import { JSONL_LEDGER_EXT, listSyncConflictFiles } from "../ledger-shards.ts";
import { brainStateDirPath } from "../lineage/ledger.ts";
import { metricsDir } from "../metrics.ts";
import { BRAIN_SKILL_PROPOSALS_REL } from "../path-constants.ts";
import { brainDirs, hookAuditDir, prefAuditDir } from "../paths.ts";
import { schemaMutationAuditDir } from "../schema-integrity.ts";
import { watchdogFallbackAuditDir } from "../watchdog.ts";
import type { DoctorCheck } from "./check.ts";
import type { DoctorUncertainEntry } from "./report.ts";
import {
  readSweptDir,
  reportSweptFailure,
  SWEEP_ORIGIN,
  type SweepOrigin,
} from "./unreadable-path.ts";

/**
 * Tier guard (write-time-integrity-governance): staged identity
 * hand-edits the index post-pass detected. Fail-soft index read - a
 * missing index or pre-v6 schema simply skips the check. Counted over
 * the pages the caller may read, like every check handed `readable`.
 */
export const tierDriftCheck: DoctorCheck = {
  failSoft: false,
  run({ dbPath, readable }, { issues }) {
    if (dbPath === undefined) return;
    const driftCount = readTierDriftCount(dbPath, readable);
    if (driftCount > 0) {
      issues.push({
        severity: "warning",
        code: TIER_DRIFT_CODE,
        message: tierDriftMessage(driftCount),
      });
    }
  },
};

/**
 * Freshen on read (index-freshness): background index runs started by
 * stale reads that keep failing. Three in a row is a broken index, not a
 * hiccup - every search meanwhile answers from an ageing index.
 */
export const freshenFailureCheck: DoctorCheck = {
  failSoft: false,
  run({ dbPath }, { issues }) {
    if (dbPath === undefined) return;
    const state = readFreshenState(dirname(dbPath));
    if (state.lastOutcome !== "failed" || state.failures < FRESHEN_FAILURE_WARN_AT) return;
    issues.push({
      severity: "warning",
      code: FRESHEN_FAILING_CODE,
      message:
        `background index refresh failed ${state.failures} times in a row ` +
        `(last: ${state.lastError ?? "unknown error"}); the index is not being kept current`,
    });
  },
};

/** Failures in a row from which {@link freshenFailureCheck} warns. */
export const FRESHEN_FAILURE_WARN_AT = 3;

/** The code of the {@link freshenFailureCheck} warning. */
export const FRESHEN_FAILING_CODE = "freshen-failing";

/** The code of the {@link tierDriftCheck} warning. */
export const TIER_DRIFT_CODE = "tier-drift";

/** The {@link tierDriftCheck} warning text for `count` staged drift rows. */
function tierDriftMessage(count: number): string {
  return `${count} identity-field hand-edit(s) staged - review with: o2b brain tiers check`;
}

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
 * Every append-only ledger directory in the vault, each named by the
 * module that owns it rather than by a path spelled a second time here.
 *
 * All of them shard per device (who-wrote-what, Task B; t_774dea61),
 * which is what makes one finding cover all of them: the shard layout
 * prevents NEW conflicts everywhere, so a `*.sync-conflict-*` copy under
 * any of these means the same thing - a file that exists and that no
 * reader merges.
 */
interface LedgerSweep {
  readonly resolve: (vault: string, uncertain: DoctorUncertainEntry[]) => string[];
  /**
   * The directory also holds files that are not ledger shards (notes,
   * atomically replaced JSON state). There only a copy carrying the JSON
   * Lines ledger extension is a split-off shard; any other copy is a
   * conflict of a whole file and is reported with its own remedy.
   */
  readonly mixed: boolean;
}

const LEDGER_DIRS: ReadonlyArray<LedgerSweep> = Object.freeze([
  { resolve: (vault: string) => [brainDirs(vault).log], mixed: false },
  {
    resolve: (vault: string) =>
      BRAIN_LOG_AUDIT_DIRS.map((name) => join(brainDirs(vault).log, name)),
    mixed: false,
  },
  { resolve: (vault: string) => [schemaMutationAuditDir(vault)], mixed: false },
  { resolve: (vault: string) => [watchdogFallbackAuditDir(vault)], mixed: false },
  { resolve: (vault: string) => [hookAuditDir(vault)], mixed: false },
  { resolve: (vault: string) => [continuityLogDir(vault)], mixed: false },
  { resolve: (vault: string) => [idempotencyLogDir(vault)], mixed: false },
  { resolve: prefAuditSweepDirs, mixed: false },
  { resolve: (vault: string) => [metricsDir(vault)], mixed: false },
  { resolve: (vault: string) => [brainStateDirPath(vault)], mixed: false },
  // The verifier-rejection ledger sits at the proposals root, next to the
  // proposal files. Named through the path constant rather than
  // `verifierRejectionLedgerPath`: `skill-proposals.ts` reaches the doctor,
  // so importing it here closes an import cycle.
  {
    resolve: (vault: string) => [ensureInsideVault(join(vault, BRAIN_SKILL_PROPOSALS_REL), vault)],
    mixed: true,
  },
  // Preference edit-history shards sit next to the preference notes.
  { resolve: (vault: string) => [brainDirs(vault).preferences], mixed: true },
  // Each repository's commits shards sit next to its state.json.
  { resolve: gitStoreSweepDirs, mixed: true },
]);

/** What to do with a conflict copy of a ledger shard. */
const LEDGER_COPY_REMEDY =
  "Merge its rows into the shard it was split from (union + dedup by timestamp and " +
  "content), then delete it.";

/** What to do with a conflict copy of a whole file that is not a ledger shard. */
const FILE_COPY_REMEDY =
  "It is not a ledger shard: compare it with the file it was copied from, keep the right " +
  "version by hand, then delete the copy.";

/**
 * The preference audit keeps one DIRECTORY per preference
 * (`pref-audit/<pref-id>/`), so its shards - and therefore any conflict
 * copy of one - live a level below the others. Sweeping only the parent
 * would report a clean ledger while a copy nobody merges sat inside it.
 */
function prefAuditSweepDirs(vault: string, uncertain: DoctorUncertainEntry[]): string[] {
  const parent = prefAuditDir(vault);
  return [parent, ...subdirectories(parent, uncertain, "per-preference")];
}

/**
 * The git store keeps one directory per repository
 * (`Brain/projects/git/<repo>/`), each holding its own `commits` shards,
 * so the repositories are discovered from the tree on every pass. The
 * root itself holds no ledger. Its path comes from the store's own
 * root builder rather than being spelled a second time here.
 */
function gitStoreSweepDirs(vault: string, uncertain: DoctorUncertainEntry[]): string[] {
  return subdirectories(gitStoreRootDir(vault), uncertain, "per-repository");
}

/**
 * The immediate subdirectories of `parent`. A parent that cannot be
 * listed is reported by name through the shared swept-path reporter
 * rather than read as "no subdirectories": the whole point of this check
 * is to keep "nothing found" and "nothing looked at" apart. An absent
 * parent is simply empty.
 */
function subdirectories(parent: string, uncertain: DoctorUncertainEntry[], kind: string): string[] {
  const entries = readSweptDir(
    parent,
    {
      site: SYNC_CONFLICT_SITE,
      consequence:
        `its ${kind} subdirectories were not listed for Syncthing conflict copies, so a ` +
        "leftover copy waiting to be merged is missing from this report",
      uncertain,
    },
    SWEEP_ORIGIN.root,
  );
  if (entries === null) return [];
  return entries.filter((e) => e.isDirectory()).map((e) => join(parent, e.name));
}

/**
 * Memory Integrity Suite: leftover Syncthing conflict copies under any
 * append-only ledger directory. The per-device shard layout prevents new
 * ones; old copies need a manual union+dedup merge into the shard they
 * were split from.
 *
 * One exit, one meaning - "a sync conflict copy exists that no reader
 * merges" - so the code stays `sync-conflict-log` and the DETAIL names
 * the directory the copy was found in.
 */
export const syncConflictLogCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues, uncertain }) {
    for (const sweep of LEDGER_DIRS) {
      let ledgerDirs: string[];
      try {
        ledgerDirs = sweep.resolve(vault, uncertain);
      } catch {
        // A directory whose own resolver refuses (a vault path that
        // escapes its root) is not a directory this sweep can visit;
        // the resolver's caller is where that refusal belongs.
        continue;
      }
      for (const ledgerDir of ledgerDirs) {
        for (const path of listSyncConflicts(ledgerDir, uncertain)) {
          const ledgerCopy = !sweep.mixed || path.endsWith(`.${JSONL_LEDGER_EXT}`);
          issues.push({
            severity: "warning",
            code: "sync-conflict-log",
            path,
            message:
              `Syncthing sync-conflict copy under ${vaultRelative(ledgerDir, vault)}/: ${path}. ` +
              (ledgerCopy ? LEDGER_COPY_REMEDY : FILE_COPY_REMEDY),
          });
        }
      }
    }
  },
};

/** Subsystem name the sync-conflict listing reports an unreadable path under. */
const SYNC_CONFLICT_SITE = "brain.doctor.syncConflictLog";

/**
 * The conflict copies under one ledger directory, or none plus a named
 * reason.
 *
 * The listing is behind a shared helper, so the failure arrives here as
 * a throw. Swallowed by the pass's fail-soft arm it produced no finding
 * at all, which reads as "no conflict copies" - the answer this check
 * exists to distinguish from "the directory was not read". Reported per
 * directory, so one unreadable ledger does not silence the others.
 */
function listSyncConflicts(dir: string, uncertain: DoctorUncertainEntry[]): string[] {
  try {
    return listSyncConflictFiles(dir);
  } catch (err) {
    reportSweptFailure(
      dir,
      "sync-conflict listing failed",
      err,
      {
        site: SYNC_CONFLICT_SITE,
        consequence:
          "it was not listed for Syncthing conflict copies, so a leftover copy waiting to be " +
          "merged is missing from this report",
        uncertain,
      },
      SWEEP_ORIGIN.root,
    );
    return [];
  }
}

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
    const swept = {
      site: SYMLINK_ESCAPE_SITE,
      consequence:
        "no symlink under it was examined, so this subtree is not certified free of links " +
        "resolving outside the vault root",
      uncertain,
    };
    const visit = (dir: string, origin: SweepOrigin): void => {
      const entries = readSweptDir(dir, swept, origin);
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
        if (entry.isDirectory()) visit(full, SWEEP_ORIGIN.discovered);
      }
    };
    visit(root, SWEEP_ORIGIN.root);
  },
};

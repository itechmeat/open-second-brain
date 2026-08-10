import {
  BrainSnapshotListingError,
  listSnapshots,
  extractSnapshotToTemp,
  restoreSnapshot,
  type ExtractSnapshotResult,
  type SnapshotInfo,
} from "../../../core/brain/snapshot.ts";
import {
  BRAIN_MANIFEST_SIDECAR_SINCE_VERSION,
  buildManifest,
  diffManifests,
  manifestDiffHasDrift,
  readManifestSidecar,
  renderManifestDriftJson,
  renderManifestDriftMarkdown,
  type BrainManifestDerivedStore,
} from "../../../core/brain/manifest.ts";
import { diffBrainTrees } from "../../../core/brain/snapshot-diff.ts";
import { renderDiffJson, renderDiffMarkdown } from "../../../core/brain/snapshot-diff-render.ts";
import { brainDirs } from "../../../core/brain/paths.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import {
  brainVerbContext,
  diffSummary,
  fail,
  ok,
  okJson,
  parse,
  readSingleLine,
} from "../helpers.ts";
import {
  renderDerivedStoreCoverage,
  renderDerivedStoreRestore,
  renderSnapshotListingFailure,
  renderSnapshotReason,
} from "../snapshot-render.ts";

export async function cmdBrainRollback(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    list: { type: "boolean" },
    yes: { type: "boolean" },
    "dry-run": { type: "boolean" },
    "force-rollback": { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const forceRollback = Boolean(flags["force-rollback"]);

  // The usage check precedes the listing so a missing argument is still a
  // usage error rather than a filesystem report, and the listing is then
  // read ONCE for both surfaces below.
  if (!flags["list"] && positional.length < 1)
    return fail("brain rollback requires a <run_id> argument (or --list to enumerate snapshots)");

  let snaps: SnapshotInfo[];
  try {
    snaps = listSnapshots(vault);
  } catch (exc) {
    // A directory nobody could read must never be rendered as a vault
    // with no recovery points: that is the answer an operator would act
    // on by taking a fresh snapshot over a history that is still there.
    if (exc instanceof BrainSnapshotListingError) return fail(renderSnapshotListingFailure(exc));
    throw exc;
  }

  if (flags["list"]) {
    if (flags["json"]) {
      process.stdout.write(JSON.stringify(snaps, null, 2) + "\n");
      return 0;
    }
    if (snaps.length === 0) {
      ok("no snapshots available");
      return 0;
    }
    ok("run_id\tcreated_at\treason\tsize_bytes\tderived_store");
    for (const s of snaps) {
      ok(
        `${s.run_id}\t${s.created_at}\t${renderSnapshotReason(s.reason)}\t${s.size_bytes}\t` +
          renderDerivedStoreCoverage(s.derived_store, { withArchiveSize: true }),
      );
    }
    return 0;
  }

  const runId = positional[0]!;
  const target = snaps.find((s) => s.run_id === runId);
  if (target === undefined) {
    process.stderr.write(
      `snapshot not found: ${runId}; run \`o2b brain rollback --list\` to enumerate.\n`,
    );
    return 2;
  }

  const driftDiff = flags["dry-run"]
    ? null
    : (() => {
        const stored = readManifestSidecar(vault, runId);
        if (stored === null) {
          process.stderr.write(
            `warning: no manifest sidecar for snapshot '${runId}'; drift detection ` +
              `skipped (snapshot predates ${BRAIN_MANIFEST_SIDECAR_SINCE_VERSION}).\n`,
          );
          return null;
        }
        const live = buildManifest(brainDirs(vault).brain);
        return diffManifests(stored, live);
      })();
  const drift = driftDiff !== null && manifestDiffHasDrift(driftDiff);
  if (drift && !forceRollback) {
    if (flags["json"]) {
      process.stdout.write(
        JSON.stringify(renderManifestDriftJson(driftDiff!, runId), null, 2) + "\n",
      );
      return 2;
    }
    process.stderr.write(renderManifestDriftMarkdown(driftDiff!, runId) + "\n");
    return 2;
  }

  if (flags["dry-run"]) {
    if (flags["yes"]) return fail("rollback: --dry-run and --yes are mutually exclusive");
    let ext: ExtractSnapshotResult;
    try {
      ext = extractSnapshotToTemp(vault, runId);
    } catch (exc) {
      return fail(`rollback dry-run failed: ${(exc as Error).message ?? exc}`);
    }
    try {
      const liveBrain = brainDirs(vault).brain;
      const diff = diffBrainTrees(liveBrain, ext.brainRoot);
      const out = flags["json"]
        ? JSON.stringify(renderDiffJson(diff), null, 2) + "\n"
        : renderDiffMarkdown(diff, { aLabel: "live", bLabel: runId });
      process.stdout.write(out + (out.endsWith("\n") ? "" : "\n"));
      return 0;
    } finally {
      ext.cleanup();
    }
  }

  if (!flags["yes"]) {
    if (flags["json"] || !process.stdin.isTTY)
      return fail("rollback requires --yes in non-interactive mode (--json or non-TTY stdin)");
    const summary = diffSummary(vault);
    // The reason is in the prompt because it is the one fact that tells an
    // operator WHICH point they are about to restore. Two archives minted
    // seconds apart differ only in why they were taken, and a run id is a
    // timestamp, not an explanation.
    process.stderr.write(
      `About to restore snapshot '${runId}' over Brain/.\n` +
        `Snapshot reason: ${renderSnapshotReason(target.reason)}.\n` +
        `Current state: ${summary.preferences} preferences, ${summary.retired} retired, ${summary.signals} signals.\n` +
        `This will OVERWRITE the live Brain/ tree (.snapshots/ is preserved).\nProceed? [y/N] `,
    );
    const ans = await readSingleLine();
    if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
      ok("rollback cancelled");
      return 0;
    }
  }

  let result;
  try {
    result = restoreSnapshot(vault, runId);
  } catch (exc) {
    return fail(`rollback failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    const body: Record<string, string> = {
      run_id: runId,
      restored_files: String(result.restored_files),
    };
    if (drift && forceRollback) body["drift_overridden"] = "true";
    appendLogEvent(vault, {
      timestamp: isoSecond(new Date()),
      eventType: BRAIN_LOG_EVENT_KIND.rollback,
      body,
    });
  } catch (err) {
    process.stderr.write(`warning: append rollback log failed: ${(err as Error).message}\n`);
  }

  if (flags["json"]) {
    okJson({
      run_id: runId,
      // Null when the snapshot predates the reason or its sidecar is
      // unreadable: UNKNOWN provenance stays null rather than borrowing a
      // label from the run id.
      reason: target.reason,
      restored_files: result.restored_files,
      derived_store: result.derived_store,
    });
  } else {
    ok(
      `restored: ${runId} (${result.restored_files} files, reason ${renderSnapshotReason(target.reason)})`,
    );
    // Always printed, in all three shapes. A restore that silently says
    // nothing about the derived store is exactly the silence this
    // feature exists to remove: the operator cannot tell a store that
    // was put back from one that was never in the archive.
    ok(`derived store: ${renderDerivedStoreRestore(result.derived_store)}`);
  }
  return 0;
}

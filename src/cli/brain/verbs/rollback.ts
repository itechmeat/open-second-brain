import {
  listSnapshots,
  extractSnapshotToTemp,
  restoreSnapshot,
  type ExtractSnapshotResult,
  type RestoreDerivedStoreResult,
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

  if (flags["list"]) {
    const snaps = listSnapshots(vault);
    if (flags["json"]) {
      process.stdout.write(JSON.stringify(snaps, null, 2) + "\n");
      return 0;
    }
    if (snaps.length === 0) {
      ok("no snapshots available");
      return 0;
    }
    ok("run_id\tcreated_at\tsize_bytes\tderived_store");
    for (const s of snaps) {
      ok(
        `${s.run_id}\t${s.created_at}\t${s.size_bytes}\t` +
          renderDerivedStoreCoverage(s.derived_store),
      );
    }
    return 0;
  }

  if (positional.length < 1)
    return fail("brain rollback requires a <run_id> argument (or --list to enumerate snapshots)");
  const runId = positional[0]!;

  const allSnaps = listSnapshots(vault);
  if (!allSnaps.some((s) => s.run_id === runId)) {
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
    process.stderr.write(
      `About to restore snapshot '${runId}' over Brain/.\n` +
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
      restored_files: result.restored_files,
      derived_store: result.derived_store,
    });
  } else {
    ok(`restored: ${runId} (${result.restored_files} files)`);
    // Always printed, in all three shapes. A restore that silently says
    // nothing about the derived store is exactly the silence this
    // feature exists to remove: the operator cannot tell a store that
    // was put back from one that was never in the archive.
    ok(`derived store: ${renderDerivedStoreRestore(result.derived_store)}`);
  }
  return 0;
}

/** One-column coverage answer for `--list`. */
function renderDerivedStoreCoverage(record: BrainManifestDerivedStore | null): string {
  // A snapshot with no record predates the feature. `unknown`, never
  // `excluded`: nothing checked, so nothing may be claimed.
  if (record === null) return "unknown";
  if (record.included) return `included (${record.archive_size ?? 0} bytes)`;
  return `excluded (${record.exclusion_reason ?? "unspecified"})`;
}

/** One-line outcome for a completed restore. */
function renderDerivedStoreRestore(outcome: RestoreDerivedStoreResult): string {
  if (outcome.replaced) return `replaced ${outcome.path ?? ""}`.trimEnd();
  if (!outcome.coverage_known) {
    return `unknown (snapshot predates derived-store coverage); live store left untouched`;
  }
  return `not restored (${outcome.exclusion_reason ?? "unspecified"}); live store left untouched`;
}

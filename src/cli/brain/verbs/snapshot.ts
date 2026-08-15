import {
  BrainSnapshotListingError,
  listSnapshots,
  extractSnapshotToTemp,
  type ExtractSnapshotResult,
  type SnapshotInfo,
  type SnapshotListing,
} from "../../../core/brain/snapshot.ts";
import { diffBrainTrees } from "../../../core/brain/snapshot-diff.ts";
import { renderDiffJson, renderDiffMarkdown } from "../../../core/brain/snapshot-diff-render.ts";
import { brainDirs } from "../../../core/brain/paths.ts";
import {
  BRAIN_SNAPSHOT_REASONS,
  isBrainSnapshotReason,
  type BrainSnapshotReason,
} from "../../../core/brain/types.ts";
import { brainVerbContext, fail, ok, parse, usageError } from "../helpers.ts";
import {
  renderDerivedStoreCoverage,
  renderSnapshotListingFailure,
  renderSnapshotListingSkips,
  SNAPSHOT_UNKNOWN_LABEL,
} from "../snapshot-render.ts";

/** Verbs this dispatcher routes, named once for the help and the error. */
const SNAPSHOT_VERBS = Object.freeze({ log: "log", diff: "diff" } as const);

/** Rendered for an unstamped or unreadable sidecar. Never a guessed reason. */
const UNKNOWN_REASON_LABEL = SNAPSHOT_UNKNOWN_LABEL;

/** Column order of the `log` text table, and its header line. */
const LOG_COLUMNS: ReadonlyArray<string> = Object.freeze([
  "run_id",
  "created_at",
  "reason",
  "size_bytes",
  "manifest",
  "derived_store",
]);

/**
 * `o2b brain snapshot log` — the missing third surface over the snapshot
 * family.
 *
 * `snapshot diff` and `rollback` already gave the family a diff and a
 * revert; the LIST was the gap, so the only way to ask which recovery
 * point covers a given boundary was to read filenames out of
 * `.snapshots/`. With this, log / diff / revert is complete.
 *
 * Newest-first, because that is the order an operator looking for "the
 * point just before the thing I regret" reads in. The ordering comes from
 * {@link listSnapshots} (by archive mtime) rather than from the run id: a
 * hand-named recovery point carries no timestamp to sort on.
 */
export async function cmdBrainSnapshotLog(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    reason: { type: "string" },
    limit: { type: "string" },
  });

  // Both flag checks run BEFORE the vault is resolved, and both are usage
  // errors (exit 2), matching how `brain event-trace` rejects a bad
  // --kind. An unregistered reason must never degrade into an empty
  // listing: that would report "your vault has no such snapshots" when
  // the truth is "that is not a reason".
  const reasonRaw = trimOrUndefined(flags["reason"]);
  if (reasonRaw !== undefined && !isBrainSnapshotReason(reasonRaw)) {
    return usageError(
      `brain snapshot log: unknown snapshot reason '${reasonRaw}'; ` +
        `supported: ${BRAIN_SNAPSHOT_REASONS.join(", ")}`,
    );
  }
  const reason: BrainSnapshotReason | undefined = reasonRaw;

  const limitRaw = trimOrUndefined(flags["limit"]);
  if (limitRaw !== undefined && (!/^[0-9]+$/.test(limitRaw) || Number.parseInt(limitRaw, 10) < 1)) {
    return usageError("brain snapshot log: --limit must be a positive integer");
  }
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;

  const { vault } = brainVerbContext(flags);

  // A snapshots directory that exists and cannot be enumerated is a
  // failure of the listing, not a listing of nothing - so it is reported
  // before either output shape, and neither the empty-history line below
  // nor an empty `--json` array can stand in for it.
  let listing: SnapshotListing;
  try {
    listing = listSnapshots(vault);
  } catch (exc) {
    if (exc instanceof BrainSnapshotListingError) return fail(renderSnapshotListingFailure(exc));
    throw exc;
  }
  const all = listing.snapshots;
  // Same rule one level down: an archive that is on disk and could not be
  // described is missing from every count below, so the incompleteness is
  // said out loud rather than left to be inferred from a shorter table.
  if (listing.skipped.length > 0) {
    process.stderr.write(renderSnapshotListingSkips(listing.skipped) + "\n");
  }

  // The reason filter compares against what the SIDECAR recorded, so a
  // snapshot whose reason is unknown is never swept into a named bucket by
  // its run-id prefix.
  const matching = all.filter((s) => reason === undefined || s.reason === reason);
  const snaps = limit === undefined ? matching : matching.slice(0, limit);

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        { total: snaps.length, snapshots: snaps.map(renderLogJson), skipped: listing.skipped },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (snaps.length === 0) {
    // Zero, not an error: the directory was read (an unreadable one was
    // reported above) and the answer is none. The filter is echoed so an
    // operator who mistyped a valid reason can see which one was applied.
    // "None" is qualified when archives were skipped, because "no
    // snapshots available" over a directory holding archives nobody could
    // describe is the sentence this listing must never print.
    const none =
      listing.skipped.length > 0
        ? "no snapshots could be listed (see the warning above; the directory is not empty)"
        : "no snapshots available";
    ok(reason === undefined ? none : `no snapshots with reason '${reason}'`);
    return 0;
  }
  ok(LOG_COLUMNS.join("\t"));
  for (const s of snaps) {
    ok(
      [
        s.run_id,
        s.created_at,
        s.reason ?? UNKNOWN_REASON_LABEL,
        String(s.size_bytes),
        s.manifest_path === null ? "absent" : "present",
        renderDerivedStore(s),
      ].join("\t"),
    );
  }
  return 0;
}

/** Structured row for `--json`, one per listed recovery point. */
function renderLogJson(s: SnapshotInfo): Record<string, unknown> {
  return {
    run_id: s.run_id,
    created_at: s.created_at,
    // `null` is UNKNOWN provenance and stays null in the payload: a
    // consumer must be able to tell an unstamped snapshot from a stamped
    // one, which a substituted label would hide.
    reason: s.reason,
    size_bytes: s.size_bytes,
    path: s.path,
    manifest: s.manifest_path !== null,
    manifest_path: s.manifest_path,
    derived_store: s.derived_store,
    store_archive_path: s.store_archive_path,
  };
}

/**
 * One-column derived-store answer. The size is omitted here because this
 * surface already has its own size column; the rollback listing appends
 * it, and both draw the words from one renderer so they cannot drift.
 */
function renderDerivedStore(s: SnapshotInfo): string {
  return renderDerivedStoreCoverage(s.derived_store);
}

function trimOrUndefined(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function cmdBrainSnapshotDiff(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  if (positional.length < 1 || positional.length > 2) {
    return fail(
      "brain snapshot diff requires <run_id_a> [<run_id_b>] (with one arg, the live tree is compared as B)",
    );
  }
  const [a, b] = positional;
  // Same reason as the log verb: "snapshot not found" over a directory
  // nobody could read names the wrong cause. And an archive that could not
  // be described is exactly the archive an operator is most likely to be
  // asking about here, so it is named before the not-found line below.
  let listing: SnapshotListing;
  try {
    listing = listSnapshots(vault);
  } catch (exc) {
    if (exc instanceof BrainSnapshotListingError) return fail(renderSnapshotListingFailure(exc));
    throw exc;
  }
  const snaps = listing.snapshots;
  if (listing.skipped.length > 0) {
    process.stderr.write(renderSnapshotListingSkips(listing.skipped) + "\n");
  }
  if (!snaps.some((s) => s.run_id === a)) {
    process.stderr.write(
      `snapshot not found: ${a}; run \`o2b brain snapshot log\` to enumerate.\n`,
    );
    return 2;
  }
  if (b !== undefined && !snaps.some((s) => s.run_id === b)) {
    process.stderr.write(
      `snapshot not found: ${b}; run \`o2b brain snapshot log\` to enumerate.\n`,
    );
    return 2;
  }

  let extA: ExtractSnapshotResult | null = null;
  let extB: ExtractSnapshotResult | null = null;
  try {
    extA = extractSnapshotToTemp(vault, a!);
    const bRoot =
      b !== undefined ? (extB = extractSnapshotToTemp(vault, b)).brainRoot : brainDirs(vault).brain;
    const diff = diffBrainTrees(extA.brainRoot, bRoot);
    const out = flags["json"]
      ? JSON.stringify(renderDiffJson(diff), null, 2) + "\n"
      : renderDiffMarkdown(diff, { aLabel: a!, bLabel: b ?? "live" });
    process.stdout.write(out + (out.endsWith("\n") ? "" : "\n"));
    return 0;
  } catch (exc) {
    return fail(`snapshot diff failed: ${(exc as Error).message ?? exc}`);
  } finally {
    extA?.cleanup();
    extB?.cleanup();
  }
}

export async function handleBrainSnapshotSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(
      "usage: o2b brain snapshot <verb> [args...]\n" +
        "Verbs:\n" +
        "  log [--reason <r>] [--limit <n>]  Newest-first listing of every recovery\n" +
        "                                  point: run id, created_at, reason, size,\n" +
        "                                  manifest presence, derived-store coverage.\n" +
        "  diff <run_id_a> [<run_id_b>]   Read-only diff between two snapshots,\n" +
        "                                  or between a snapshot and live Brain/.\n",
    );
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0]!;
  const rest = argv.slice(1);
  switch (sub) {
    case SNAPSHOT_VERBS.log:
      return await cmdBrainSnapshotLog([...rest]);
    case SNAPSHOT_VERBS.diff:
      return await cmdBrainSnapshotDiff([...rest]);
    default:
      process.stderr.write(
        `unknown brain snapshot verb: ${sub}; supported: ` +
          `${Object.values(SNAPSHOT_VERBS).join(", ")}\n`,
      );
      return 2;
  }
}

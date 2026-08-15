/**
 * How long since anything left a recovery point - and what that cannot
 * tell you (t_1037d94e).
 *
 * ## Why this reports liveness ONLY
 *
 * The check a durability question asks for is "is the job registered, and
 * did it run". The first half has no referent in this product. Nothing
 * here registers a scheduled job: every scheduled-job surface in the tree
 * is a recipe RENDERER that prints text for the operator's own scheduler
 * and writes nothing (`src/cli/cron-recipe.ts`, `search-cron-template.ts`,
 * `partner-codegraph-cron.ts` all say so at their own site). There is no
 * record whose presence could be looked up, and the host's crontab is out
 * of reach of a tool that never installed anything into it.
 *
 * So PRESENCE is unobservable, and a check reporting "durability job
 * missing" would be inventing the fact it claims to have measured. What
 * IS observable is the age of the artifact a durability pass leaves
 * behind. That is what this reports, and {@link SCHEDULE_UNOBSERVABLE_CLAUSE}
 * is carried in every message so a reader is never left assuming the
 * other half was checked.
 *
 * ## Why the recovery point, and not some other artifact
 *
 * `Brain/.snapshots/<run_id>.tar.zst` is the one artifact whose whole
 * purpose is surviving a mistake. It is written before every
 * state-changing pass - dream, upgrade, the Claude-memory import - so its
 * age is the age of the last point the vault can be rolled back to. The
 * search index is a poor substitute: it is derived and rebuildable, so a
 * stale index costs a rebuild rather than a memory.
 *
 * ## The four states, and why an empty history is not one of them
 *
 * {@link listSnapshots} draws the distinctions this check needs, and they
 * are reused rather than re-implemented:
 *
 *   - an ABSENT directory is an empty history: no archives and nothing
 *     skipped. No state-changing pass has ever run, so there is no
 *     schedule to have missed and no artifact to be stale. Reporting here
 *     would be reporting an expectation nobody set.
 *   - a POPULATED directory gives a newest mtime, which is measurable.
 *   - a directory that IS there and cannot be enumerated throws, and that
 *     is neither answer - it reaches the uncertain stream naming why.
 *   - an ARCHIVE that is named in the directory and could not be described
 *     - a `stat` that failed, a run id this build will not accept - is
 *     reported to the same stream, whether or not other archives survived.
 *     When none did, the vault has a history nobody could read and that is
 *     emphatically not "no pass has ever run"; when some did, the measured
 *     age is the newest READABLE one's and the entry nobody could stat may
 *     be newer, so the number is an upper bound and the reader is told the
 *     listing was partial.
 *
 * ## Not the durability gate
 *
 * `src/core/brain/gates/durability.ts` is unrelated despite the name: it
 * classifies extracted-fact TEXT as worth keeping versus transient noise,
 * has no I/O and no notion of storage at all. Two meanings of "durable"
 * sharing one module would be a namespace, not an abstraction, so this
 * check lives beside its siblings in `doctor/` instead.
 *
 * The clock is {@link DoctorCheckContext.now}, never a global read, so
 * every age below is pinnable from a test.
 */

import { msToWholeDays } from "../time.ts";
import {
  describeSnapshotEntrySkip,
  listSnapshots,
  type SnapshotEntrySkip,
  type SnapshotInfo,
} from "../snapshot.ts";
import { snapshotsDir } from "../paths.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { pushUncertain } from "./uncertain-stream.ts";

/** The newest recovery point is older than the window. */
export const RECOVERY_POINT_STALE_CODE = "recovery-point-stale";

/**
 * The recovery-point history is there and some or all of it could not be
 * read - the directory refused enumeration, or an archive inside it could
 * not be described. One code for both because the consequence is one
 * thing: the age reported here is not the age of the newest recovery
 * point, and the message says which of the two happened.
 */
export const RECOVERY_POINT_UNMEASURED_CODE = "recovery-point-unmeasured";

/**
 * How old the newest recovery point may be before it is reported.
 *
 * Wide enough that a vault used occasionally is not nagged - a snapshot is
 * a side effect of a state-changing pass, not a nightly chore - and narrow
 * enough that a vault whose passes silently stopped is reported while the
 * change that stopped them is still findable. It matches the recall
 * channel's coverage window for the same reason: a month is the coarsest
 * period over which "nothing happened" is still a fact about this vault
 * rather than about the calendar.
 */
export const RECOVERY_POINT_LIVENESS_WINDOW_DAYS = 30;

/**
 * The half of the durability question this check did NOT answer, carried
 * verbatim in every finding it produces.
 *
 * Exported so the tests assert the disclaimer is present without pinning
 * the prose around it, and so the two findings cannot drift into two
 * differently-worded admissions of the same gap.
 */
export const SCHEDULE_UNOBSERVABLE_CLAUSE =
  "whether a schedule exists was NOT checked: nothing in this tool registers a scheduled job - " +
  "every cron surface renders a recipe for your own scheduler and writes nothing - so a schedule " +
  "that stopped and a schedule that was never installed leave identical evidence";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The newest recovery point's age in whole days, or why there is none. */
type RecoveryPointAge =
  /** At least one archive; `days` is the newest one's age. */
  | { readonly kind: "measured"; readonly days: number; readonly runId: string }
  /** No archive has ever been written; nothing to be stale. */
  | { readonly kind: "empty" }
  /** The history is there and could not be read. */
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * How many skipped entries are named before the message stops listing
 * them. Three, because the sentence has to stay readable next to the
 * clause it shares a line with, and the count that precedes them is the
 * fact a reader acts on - the names are there so the first one can be
 * looked at without another command.
 */
const MAX_NAMED_SKIPS = 3;

/** `<name> (<reason>: <detail>)` for the first few, then a count. */
function describeSkips(skipped: ReadonlyArray<SnapshotEntrySkip>): string {
  const named = skipped.slice(0, MAX_NAMED_SKIPS).map(describeSnapshotEntrySkip).join(", ");
  const rest = skipped.length - Math.min(skipped.length, MAX_NAMED_SKIPS);
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

function newestRecoveryPoint(infos: ReadonlyArray<SnapshotInfo>, now: Date): RecoveryPointAge {
  if (infos.length === 0) return { kind: "empty" };
  let newest = infos[0]!;
  let newestMs = Date.parse(newest.created_at);
  for (const info of infos.slice(1)) {
    const ms = Date.parse(info.created_at);
    if (Number.isFinite(ms) && (!Number.isFinite(newestMs) || ms > newestMs)) {
      newest = info;
      newestMs = ms;
    }
  }
  if (!Number.isFinite(newestMs)) {
    return {
      kind: "unreadable",
      reason: `no recovery point carried a parseable timestamp (newest was ${newest.run_id})`,
    };
  }
  return {
    kind: "measured",
    days: msToWholeDays(now.getTime() - newestMs),
    runId: newest.run_id,
  };
}

/** One uncertain entry, worded once, for every way this check came up short. */
function unmeasured(ctx: DoctorCheckContext, out: DoctorFindings, what: string): void {
  pushUncertain(out.uncertain, {
    code: RECOVERY_POINT_UNMEASURED_CODE,
    path: snapshotsDir(ctx.vault),
    message: `${what}. Note that ${SCHEDULE_UNOBSERVABLE_CLAUSE}`,
  });
}

export const recoveryPointLivenessCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    let listing;
    try {
      listing = listSnapshots(ctx.vault);
    } catch (err) {
      unmeasured(
        ctx,
        out,
        `the recovery-point history exists and could not be read (${describe(err)}), so the age ` +
          "of the newest one is unknown",
      );
      return;
    }

    const age = newestRecoveryPoint(listing.snapshots, ctx.now);
    if (listing.skipped.length > 0) {
      // Reported whether or not any archive survived, because the two
      // shapes are wrong in different directions: with none left there is
      // a history nobody could read, and with some left the age below is
      // only the newest READABLE one's.
      unmeasured(
        ctx,
        out,
        age.kind === "measured"
          ? `${listing.skipped.length} archive(s) in the recovery-point history could not be ` +
              `read - ${describeSkips(listing.skipped)} - so the age reported below is that of ` +
              "the newest READABLE recovery point and an entry skipped here may be newer"
          : `the recovery-point history is populated and no archive in it could be read - ` +
              `${describeSkips(listing.skipped)} - so whether a recovery point exists at all is ` +
              "unknown. This is NOT a vault that has never taken one",
      );
    }
    if (age.kind === "empty") return;
    if (age.kind === "unreadable") {
      unmeasured(
        ctx,
        out,
        `the recovery-point history exists and could not be read (${age.reason}), so the age ` +
          "of the newest one is unknown",
      );
      return;
    }
    if (age.days <= RECOVERY_POINT_LIVENESS_WINDOW_DAYS) return;
    out.issues.push({
      severity: "warning",
      code: RECOVERY_POINT_STALE_CODE,
      path: snapshotsDir(ctx.vault),
      target: age.runId,
      message:
        `the newest recovery point (${age.runId}) is ${age.days} days old, past the ` +
        `${RECOVERY_POINT_LIVENESS_WINDOW_DAYS}-day window. A snapshot is written before every ` +
        "state-changing pass, so this measures how long since one ran - and " +
        SCHEDULE_UNOBSERVABLE_CLAUSE,
    } satisfies DoctorIssue);
  },
};

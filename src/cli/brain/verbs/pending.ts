/**
 * `o2b brain pending <list|apply|reject>` - the write-approval queue surface
 * (A3, t_e540b093; multi-lane since write-side trust Task 9). Thin CLI
 * wrapper over `src/core/brain/pending/pending-lanes.ts`.
 *
 * When a review lane's gate is on, writes stage into `Brain/pending/` -
 * signals flat in `Brain/pending/`, note creates under `notes/`, ingest
 * summary pages under `ingest/`. `list` shows every lane sorted (filter
 * with `--lane`), `apply <id>` moves an entry into its decoded publish
 * target unchanged (`--dry-run` reports the move and writes nothing),
 * and `reject <id> --reason <text>` renders it into `Brain/retired/`
 * (`--dry-run` previews that too). A missing id is a typed error
 * surfaced as exit 2 (not a silent no-op).
 */

import {
  applyPendingLane,
  listPendingLane,
  PendingSignalNotFoundError,
  rejectPendingLane,
} from "../../../core/brain/pending/pending-lanes.ts";
import { REVIEW_LANES, isReviewLane } from "../../../core/brain/write-gate.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  usageError,
} from "../helpers.ts";

/** The `--lane` values, in registry order plus the all-lane wildcard. */
const LANE_FLAGS = [...REVIEW_LANES, "all"] as const;

type LaneFlag = (typeof LANE_FLAGS)[number];

function coerceLaneFlag(raw: string | null): LaneFlag | null {
  if (raw === null) return null;
  if (raw === "all") return "all";
  return isReviewLane(raw) ? raw : null;
}

export async function cmdBrainPending(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "list":
      return pendingList(rest);
    case "apply":
      return pendingApply(rest);
    case "reject":
      return pendingReject(rest);
    default:
      return usageError(
        "brain pending requires a subcommand: list | apply <id> | reject <id> --reason <text>",
      );
  }
}

function pendingList(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    lane: { type: "string" },
    json: { type: "boolean" },
  });
  const lane = coerceLaneFlag(typeof flags["lane"] === "string" ? flags["lane"] : null);
  if (flags["lane"] !== undefined && lane === null) {
    return usageError(`brain pending list --lane must be one of ${LANE_FLAGS.join(", ")}`);
  }
  const { vault } = brainVerbContext(flags);
  try {
    const listing = listPendingLane(vault, lane ?? "all");
    if (flags["json"]) {
      okJson({
        pending: listing.entries.map((e) => ({
          id: e.id,
          lane: e.lane,
          ...(e.signal !== undefined
            ? {
                topic: e.signal.topic,
                principle: e.signal.principle,
                created_at: e.signal.created_at,
              }
            : {}),
          publish_target: e.publishTarget,
          path: e.path,
        })),
        unreadable: listing.unreadable,
        total: listing.entries.length,
      });
    } else if (listing.entries.length === 0 && listing.unreadable.length === 0) {
      ok(
        lane === null || lane === "all"
          ? "no entries in any review lane"
          : `no entries in the ${lane} review lane`,
      );
    } else {
      for (const e of listing.entries) {
        const what =
          e.signal?.topic ??
          (e.publishTarget !== undefined ? `publish target: ${e.publishTarget}` : "");
        ok(`${e.id}  [${e.lane}]  ${what}`);
      }
      for (const u of listing.unreadable) {
        ok(`${u.path}  [unreadable]  ${u.reason}`);
      }
    }
    return 0;
  } catch (exc) {
    const message = `brain pending list failed: ${(exc as Error).message}`;
    if (flags["json"]) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

function pendingApply(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return usageError("brain pending apply requires an <id> argument");
  const { vault } = brainVerbContext(flags);
  const dryRun = flags["dry-run"] === true;
  try {
    const res = applyPendingLane(vault, positional[0]!, { dryRun });
    // `status` is the one field that distinguishes the preview from the
    // move, so a caller reading JSON cannot mistake one for the other.
    if (flags["json"]) {
      okJson({ id: res.id, path: res.path, status: dryRun ? "would-apply" : "applied" });
    } else {
      ok(`${dryRun ? "would apply" : "applied"}: ${res.id} -> ${res.path}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof PendingSignalNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    const message = `brain pending apply failed: ${(exc as Error).message}`;
    if (flags["json"]) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

function pendingReject(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    reason: { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return usageError("brain pending reject requires an <id> argument");
  const reason = normalizeFlagString(flags["reason"]);
  if (reason === null) return usageError("brain pending reject requires --reason <text>");
  const { vault } = brainVerbContext(flags);
  const dryRun = flags["dry-run"] === true;
  try {
    const res = rejectPendingLane(vault, positional[0]!, reason, { dryRun, now: new Date() });
    if (flags["json"]) {
      okJson({
        id: res.id,
        path: res.path,
        status: dryRun ? "would-reject" : "rejected",
        reason,
      });
    } else {
      ok(`${dryRun ? "would reject" : "rejected"}: ${res.id} -> ${res.path}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof PendingSignalNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    const message = `brain pending reject failed: ${(exc as Error).message}`;
    if (flags["json"]) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

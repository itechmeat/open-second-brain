/**
 * `o2b brain maintenance <run|status>` (t_166d1226): the quiet-window
 * lane for heavy passes. `run` gates on the local-time window
 * (--window H-H, unset = always open), recent interactive query-rate,
 * and the expiring SQLite lease, then executes dream, reindex,
 * bridges, and clusters stale-first; --force bypasses the soft gates
 * and every streak refusal but never the lease, while --retry <task>
 * (repeatable) bypasses the streak refusal for that task alone and
 * leaves every gate in force.
 * `status` renders the lease holder and recent journal. Designed as
 * the cron entry point: a dead dashboard hour surfaces as
 * skipped:window in the journal instead of a contended vault.
 *
 * Exit codes: see {@link MAINTENANCE_EXIT}.
 */

import { dream } from "../../../core/brain/dream.ts";
import {
  discoverBridges,
  readDismissedBridges,
  writeBridgeProposals,
} from "../../../core/brain/link-graph/bridge-discovery.ts";
import {
  detectCommunities,
  materializeClusterNotes,
} from "../../../core/brain/link-graph/communities.ts";
import { appendMetric } from "../../../core/brain/metrics.ts";
import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
  type Operation,
} from "../../../core/brain/safeguard.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { Store } from "../../../core/search/store.ts";
import { currentLease, MAINTENANCE_LEASE_NAME } from "../../../core/brain/maintenance/lease.ts";
import {
  MAINTENANCE_BUSY_MINUTES,
  MAINTENANCE_BUSY_THRESHOLD,
  runMaintenance,
  type DailyWindow,
  type MaintenanceTask,
} from "../../../core/brain/maintenance/lane.ts";
import { listJournal } from "../../../core/brain/maintenance/journal.ts";
import { resolveAgentName } from "../../../core/config.ts";
import { indexVault, resolveSearchConfig } from "../../../core/search/index.ts";
import { onInterrupt } from "../../interrupt.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain maintenance run [--force] [--retry <task>] [--window H-H] [--tz ZONE] " +
  "[--busy-minutes N] [--busy-threshold N] [--progress] | status [--limit N]  " +
  "[--vault <path>] [--json]";

/**
 * What this verb's exit code says, and why a refusal has its own number.
 *
 * 0 covers a gate skip as well as a clean pass: a quiet hour, a busy
 * vault and a loaded host are self-resolving conditions and cron must
 * not alarm on them. 1 means a task was ATTEMPTED and failed.
 *
 * A streak refusal is neither. Nothing ran, so 1 would report a failure
 * this run did not have - the same collapse the lane's own row avoids by
 * carrying no `ok` - and every failure behind the refusal was already
 * reported as a 1 on the run that produced it. But 0 would tell a
 * nightly cron that a lane which has stopped doing a heavy pass is
 * healthy, and it is not: a refusal stands until an operator clears it,
 * which is exactly the condition an exit code exists to surface.
 *
 * So it gets its own number, on the precedent this repository already
 * set for "the run did not attempt" - `DOCTOR_EXIT.probeIncomplete` and
 * `SEARCH_CHECK_EXIT.probeIncomplete`. It is not 6, because 6 means "the
 * probe could not find out" on both of those surfaces and this run found
 * out precisely: it names the task and the streak.
 *
 * Precedence follows `exitCodeForCheck`: a proved failure keeps the
 * generic code even when another task was also refused, so the specific
 * number never masks the more basic finding.
 */
export const MAINTENANCE_EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  refused: 7,
} as const);

export type MaintenanceExit = (typeof MAINTENANCE_EXIT)[keyof typeof MAINTENANCE_EXIT];

/** The four long operations the lane dispatches, in its own order. */
type LaneOperation = Extract<Operation, "dream" | "reindex" | "bridges" | "clusters">;

export async function cmdBrainMaintenance(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    force: { type: "boolean" },
    retry: { type: "string-array" },
    window: { type: "string" },
    tz: { type: "string" },
    "busy-minutes": { type: "string" },
    "busy-threshold": { type: "string" },
    limit: { type: "string" },
    agent: { type: "string" },
    progress: { type: "boolean" },
    json: { type: "boolean" },
  });
  const op = positional[0];
  const asJson = flags["json"] === true;
  if (op !== "run" && op !== "status") {
    process.stderr.write(`${USAGE}\n`);
    return MAINTENANCE_EXIT.usage;
  }

  const { config, vault } = brainVerbContext(flags);
  const now = new Date();

  try {
    if (op === "status") {
      const limitRaw = flags["limit"] as string | undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : 10;
      if (!Number.isInteger(limit) || limit < 1) {
        process.stderr.write("brain maintenance status: --limit must be a positive integer\n");
        return MAINTENANCE_EXIT.usage;
      }
      const lease = currentLease(vault, { name: MAINTENANCE_LEASE_NAME, now });
      const journal = listJournal(vault, limit);
      if (asJson) okJson({ lease, journal });
      else {
        ok(lease === null ? "lease: free" : `lease: ${lease.holder} until ${lease.expiresAt}`);
        ok(`journal (${journal.length} recent):`);
        for (const e of journal) {
          // A refusal row names its task but records no outcome, because
          // the task never ran; rendering it as FAILED would report an
          // attempt that did not happen.
          const outcome = e.ok === undefined ? "" : ` ${e.ok ? "ok" : "FAILED"}`;
          ok(`  ${e.ts}  ${e.verdict}${e.task ? `  ${e.task}${outcome}` : ""}`);
        }
      }
      return MAINTENANCE_EXIT.ok;
    }

    let window: DailyWindow | undefined;
    const windowRaw = flags["window"] as string | undefined;
    if (windowRaw !== undefined) {
      const match = /^(\d{1,2})-(\d{1,2})$/.exec(windowRaw.trim());
      const startHour = match ? Number(match[1]) : Number.NaN;
      const endHour = match ? Number(match[2]) : Number.NaN;
      if (!match || startHour > 23 || endHour > 23) {
        process.stderr.write(
          `brain maintenance run: --window must be H-H with hours 0..23, got: ${windowRaw}\n`,
        );
        return MAINTENANCE_EXIT.usage;
      }
      window = { startHour, endHour, tz: (flags["tz"] as string | undefined) ?? "UTC" };
    }
    const busyMinutes = numberFlag(flags["busy-minutes"], MAINTENANCE_BUSY_MINUTES);
    const busyThreshold = numberFlag(flags["busy-threshold"], MAINTENANCE_BUSY_THRESHOLD);
    if (busyMinutes === null || busyThreshold === null) {
      process.stderr.write(
        "brain maintenance run: --busy-minutes/--busy-threshold must be positive integers\n",
      );
      return MAINTENANCE_EXIT.usage;
    }

    const holder =
      ((flags["agent"] as string | undefined)?.trim() || resolveAgentName(config)) +
      `@${process.pid}`;
    // Progress is opt-in, on the same terms as every other long verb: a
    // sink attached by default would change the stderr of every cron
    // invocation that has ever run this lane.
    //
    // The lane is a DISPATCHER over four long operations, not a fifth
    // one, so it forwards the caller's sink to each task instead of
    // counting tasks itself. A lane-owned counter would emit "1 of 4"
    // and then say nothing for the length of a full reindex, which is
    // the silence this release exists to remove - and it would ALSO
    // double-count, because each of the four already reports its own
    // stages. Forwarding needs no change to `MaintenanceTask`: the tasks
    // are built here, so the sink reaches them by closure, and every
    // record names the operation that emitted it, which is exactly what
    // tells a reader which task the lane is currently inside. The MCP
    // lane took the same decision for the same reason; a second shape
    // here would make the two surfaces disagree about one mechanism.
    const observation =
      flags["progress"] === true
        ? attachProgress({ command: "brain", argv: ["maintenance"], jsonRequested: asJson })
        : null;
    reportProgressRefusal(observation);
    const laneProgress = observation?.sink !== undefined ? { onProgress: observation.sink } : {};
    // Everything that can throw before the lane starts happens BEFORE the
    // handle exists. `release` MUST run for every handle - it removes
    // process-global listeners and settles a signal nobody acted on - and
    // a throw between `onInterrupt()` and the `try` would skip it. This
    // was the one verb of the six that had the ordering wrong.
    const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
    // Ctrl-C reaches the lane between tasks: `runMaintenance` awaits each
    // one, so a signal delivered during a task is dispatched before the
    // next task's first checkpoint. The lane records the abort as that
    // task's failure and releases the lease in its own `finally`, so the
    // vault is never left leased by a stopped run.
    const interrupt = onInterrupt(OPERATION.maintenance);
    // One fresh deadline per lane task: each long pass gets its own
    // budget (per-op key -> global -> default), created lazily so the
    // clock starts when the task starts, not when the lane is gated.
    const laneSafeguard = (operation: LaneOperation) =>
      createSafeguard({
        operation,
        timeoutMs: resolveSafeguardTimeoutMs(operation, config ?? undefined),
        signal: interrupt.signal,
      });
    let result: Awaited<ReturnType<typeof runMaintenance>>;
    try {
      // Built once and read twice - the lane runs these, and `--retry` is
      // checked against their names. A second hard-coded list of the same
      // four names is a list that can disagree with this one.
      //
      // Inside the `try`, because the check below can return: a return
      // between `onInterrupt()` and the `try` would skip `release`.
      const laneTasks: ReadonlyArray<MaintenanceTask> = [
        {
          name: "dream",
          run: async () => {
            dream(vault, { now, safeguard: laneSafeguard(OPERATION.dream), ...laneProgress });
          },
        },
        {
          name: "reindex",
          run: async () => {
            await indexVault(searchConfig, {
              safeguard: laneSafeguard(OPERATION.reindex),
              signal: interrupt.signal,
              ...laneProgress,
            });
          },
        },
        // Link-recall-intelligence passes ride the same lease, after
        // reindex so they see fresh edges. Both are fail-soft inside:
        // a vault without embeddings simply proposes nothing.
        {
          name: "bridges",
          run: async () => {
            const store = await Store.open(searchConfig, { mode: "read" });
            try {
              const report = discoverBridges(store, {
                dismissed: readDismissedBridges(vault),
                safeguard: laneSafeguard(OPERATION.bridges),
                ...laneProgress,
              });
              writeBridgeProposals(vault, report, { now });
              try {
                appendMetric(vault, {
                  surface: "bridge_discovery",
                  runAt: isoSecond(now),
                  payload: {
                    proposals: report.proposals.length,
                    scanned_candidates: report.scannedCandidates,
                    vec_available: report.vecAvailable,
                    lane: true,
                  },
                });
              } catch {
                // Metrics are observability, not correctness.
              }
            } finally {
              await store.close();
            }
          },
        },
        {
          name: "clusters",
          run: async () => {
            const store = await Store.open(searchConfig, { mode: "read" });
            try {
              const communities = detectCommunities(store, {
                safeguard: laneSafeguard(OPERATION.clusters),
                ...laneProgress,
              });
              const materialized = materializeClusterNotes(vault, communities, { store, now });
              try {
                appendMetric(vault, {
                  surface: "communities",
                  runAt: isoSecond(now),
                  payload: {
                    communities: communities.length,
                    sizes: communities.map((c) => c.size),
                    written: materialized.written.length,
                    removed: materialized.removed.length,
                    lane: true,
                  },
                });
              } catch {
                // Metrics are observability, not correctness.
              }
            } finally {
              await store.close();
            }
          },
        },
      ];
      const retryTasks = stringArrayFlag(flags["retry"]);
      const unknownRetries = retryTasks.filter(
        (name) => !laneTasks.some((task) => task.name === name),
      );
      if (unknownRetries.length > 0) {
        // Named, not ignored: a typo that silently retried nothing would
        // leave the operator reading a refusal they thought they had just
        // asked past.
        process.stderr.write(
          `brain maintenance run: --retry names no lane task: ${unknownRetries.join(", ")} ` +
            `(tasks: ${laneTasks.map((task) => task.name).join(", ")})\n`,
        );
        return MAINTENANCE_EXIT.usage;
      }
      result = await runMaintenance(vault, {
        now,
        holder,
        force: flags["force"] === true,
        ...(window !== undefined ? { window } : {}),
        busy: { minutes: busyMinutes, threshold: busyThreshold },
        ...(retryTasks.length > 0 ? { retryTasks } : {}),
        tasks: laneTasks,
      });

      if (asJson) okJson({ verdict: result.verdict, tasks: result.tasks });
      else {
        ok(`maintenance: ${result.verdict}`);
        for (const t of result.tasks) {
          // A refused task never ran, so it is neither `ok` nor FAILED and
          // has no duration to report - printing `in 0ms` would describe an
          // attempt that did not happen. The lane's row omits `ok` for the
          // same reason; this line agrees with it.
          if (t.refused === true) ok(`  ${t.name}: REFUSED (${t.error})`);
          else ok(`  ${t.name}: ${t.ok ? "ok" : `FAILED (${t.error})`} in ${t.duration_ms}ms`);
        }
      }
      // A stopped lane is reported as stopped, not as four failures. The
      // lane catches each task's abort and journals it, so without this the
      // run would exit 1 - a code that says "these passes are broken" about
      // passes the operator simply cancelled. The report above is written
      // first either way: the journal is what makes the stop auditable.
      //
      // Decided INSIDE the try, before `release`: the acknowledgement and
      // the exit code are the same decision, and a `release` that ran
      // first would re-raise the signal this arm is in the middle of
      // reporting.
      if (interrupt.received() !== null) {
        interrupt.acknowledge();
        return interrupt.exitCode();
      }
      // An attempted failure outranks a refusal: see {@link MAINTENANCE_EXIT}.
      if (result.tasks.some((t) => !t.ok && t.refused !== true)) return MAINTENANCE_EXIT.failed;
      return result.tasks.some((t) => t.refused === true)
        ? MAINTENANCE_EXIT.refused
        : MAINTENANCE_EXIT.ok;
    } finally {
      interrupt.release();
    }
  } catch (exc) {
    const message = `maintenance ${op} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return MAINTENANCE_EXIT.failed;
    }
    return fail(message);
  }
}

/** A repeatable flag's values; a flag never passed is an empty list. */
function stringArrayFlag(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

function numberFlag(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

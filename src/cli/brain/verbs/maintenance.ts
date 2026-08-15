/**
 * `o2b brain maintenance <run|status>` (t_166d1226): the quiet-window
 * lane for heavy passes. `run` gates on the local-time window
 * (--window H-H, unset = always open), recent interactive query-rate,
 * and the expiring SQLite lease, then executes dream, reindex,
 * bridges, and clusters stale-first; --force bypasses the soft gates
 * but never the lease.
 * `status` renders the lease holder and recent journal. Designed as
 * the cron entry point: a dead dashboard hour surfaces as
 * skipped:window in the journal instead of a contended vault.
 *
 * Exit codes: 0 on success (including a gate skip - cron must not
 * alarm on a quiet hour), 1 on an operational failure, 2 on usage
 * errors.
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
} from "../../../core/brain/maintenance/lane.ts";
import { listJournal } from "../../../core/brain/maintenance/journal.ts";
import { resolveAgentName } from "../../../core/config.ts";
import { indexVault, resolveSearchConfig } from "../../../core/search/index.ts";
import { onInterrupt } from "../../interrupt.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain maintenance run [--force] [--window H-H] [--tz ZONE] " +
  "[--busy-minutes N] [--busy-threshold N] [--progress] | status [--limit N]  " +
  "[--vault <path>] [--json]";

/** The four long operations the lane dispatches, in its own order. */
type LaneOperation = Extract<Operation, "dream" | "reindex" | "bridges" | "clusters">;

export async function cmdBrainMaintenance(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    force: { type: "boolean" },
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
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);
  const now = new Date();

  try {
    if (op === "status") {
      const limitRaw = flags["limit"] as string | undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : 10;
      if (!Number.isInteger(limit) || limit < 1) {
        process.stderr.write("brain maintenance status: --limit must be a positive integer\n");
        return 2;
      }
      const lease = currentLease(vault, { name: MAINTENANCE_LEASE_NAME, now });
      const journal = listJournal(vault, limit);
      if (asJson) okJson({ lease, journal });
      else {
        ok(lease === null ? "lease: free" : `lease: ${lease.holder} until ${lease.expiresAt}`);
        ok(`journal (${journal.length} recent):`);
        for (const e of journal) {
          ok(`  ${e.ts}  ${e.verdict}${e.task ? `  ${e.task} ${e.ok ? "ok" : "FAILED"}` : ""}`);
        }
      }
      return 0;
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
        return 2;
      }
      window = { startHour, endHour, tz: (flags["tz"] as string | undefined) ?? "UTC" };
    }
    const busyMinutes = numberFlag(flags["busy-minutes"], MAINTENANCE_BUSY_MINUTES);
    const busyThreshold = numberFlag(flags["busy-threshold"], MAINTENANCE_BUSY_THRESHOLD);
    if (busyMinutes === null || busyThreshold === null) {
      process.stderr.write(
        "brain maintenance run: --busy-minutes/--busy-threshold must be positive integers\n",
      );
      return 2;
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
    // Ctrl-C reaches whichever task is running: the lane records the
    // abort as that task's failure and releases the lease in its own
    // `finally`, so the vault is never left leased by a stopped run.
    const interrupt = onInterrupt();
    // One fresh deadline per lane task: each long pass gets its own
    // budget (per-op key -> global -> default), created lazily so the
    // clock starts when the task starts, not when the lane is gated.
    const laneSafeguard = (operation: LaneOperation) =>
      createSafeguard({
        operation,
        timeoutMs: resolveSafeguardTimeoutMs(operation, config ?? undefined),
        signal: interrupt.signal,
      });
    const searchConfig = resolveSearchConfig({ vault, configPath: config ?? undefined });
    let result: Awaited<ReturnType<typeof runMaintenance>>;
    try {
      result = await runMaintenance(vault, {
        now,
        holder,
        force: flags["force"] === true,
        ...(window !== undefined ? { window } : {}),
        busy: { minutes: busyMinutes, threshold: busyThreshold },
        tasks: [
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
        ],
      });
    } finally {
      interrupt.release();
    }

    if (asJson) okJson({ verdict: result.verdict, tasks: result.tasks });
    else {
      ok(`maintenance: ${result.verdict}`);
      for (const t of result.tasks) {
        ok(`  ${t.name}: ${t.ok ? "ok" : `FAILED (${t.error})`} in ${t.duration_ms}ms`);
      }
    }
    // A stopped lane is reported as stopped, not as four failures. The
    // lane catches each task's abort and journals it, so without this the
    // run would exit 1 - a code that says "these passes are broken" about
    // passes the operator simply cancelled. The report above is written
    // first either way: the journal is what makes the stop auditable.
    if (interrupt.received() !== null) return interrupt.exitCode();
    return result.tasks.some((t) => !t.ok) ? 1 : 0;
  } catch (exc) {
    const message = `maintenance ${op} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

function numberFlag(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

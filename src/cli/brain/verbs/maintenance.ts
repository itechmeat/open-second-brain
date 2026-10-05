/**
 * `o2b brain maintenance <run|status>` (t_166d1226): the quiet-window
 * lane for heavy passes. `run` gates on the local-time window
 * (--window H-H, unset = always open), recent interactive query-rate,
 * and the expiring SQLite lease, then executes dream, reindex,
 * bridges, and clusters stale-first; --force bypasses the soft gates
 * and every streak refusal but never the lease, while --retry <task>
 * (repeatable) bypasses the streak refusal for that task alone and
 * leaves every gate in force. The reindex pass stays keyword-only
 * unless `maintenance_embeddings` opts the lane into the embedding phase
 * and the resolved config can reach a provider: then the pass announces
 * its predicted spend before it runs, receipts what the phase actually
 * priced after it, and --force-cost bypasses a positive embedding cost
 * gate for this run alone - recorded on the receipt when it did.
 * `status` renders the lease holder and recent journal. Designed as
 * the cron entry point: a dead dashboard hour surfaces as
 * skipped:window in the journal instead of a contended vault.
 * `run --cron-template [--interval N] [--format cron|systemd]` prints
 * the recipe that schedules this very verb and returns before the
 * lease, the gates, the journal and the metrics: it installs nothing.
 *
 * Exit codes: see {@link MAINTENANCE_EXIT}.
 */

import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
} from "../../../core/brain/safeguard.ts";
import { currentLease, MAINTENANCE_LEASE_NAME } from "../../../core/brain/maintenance/lease.ts";
import {
  MAINTENANCE_BUSY_MINUTES,
  MAINTENANCE_BUSY_MINUTES_MAX,
  MAINTENANCE_BUSY_THRESHOLD,
  MAINTENANCE_BUSY_THRESHOLD_MAX,
  runMaintenance,
  type DailyWindow,
  type LaneTask,
  type LaneTaskId,
  type MaintenanceTaskResult,
} from "../../../core/brain/maintenance/lane.ts";
import {
  listJournal,
  MAINTENANCE_JOURNAL_CAP,
  recordedPriceSource,
  type MaintenanceSpendReceipt,
} from "../../../core/brain/maintenance/journal.ts";
import {
  customTasksOffNotice,
  resolveCustomTasks,
} from "../../../core/brain/maintenance/custom-tasks.ts";
import { isCustomLaneTask } from "../../../core/brain/maintenance/custom-task-id.ts";
import { buildLaneTasks } from "../../../core/brain/maintenance/lane-tasks.ts";
import { resolveAgentName } from "../../../core/config.ts";
import { CronTemplateError, parseRecipeFormat } from "../../cron-recipe.ts";
import {
  DEFAULT_MAINTENANCE_INTERVAL,
  MAX_WINDOW_HOUR,
  parseWindowBounds,
  renderMaintenanceCronTemplate,
} from "../../maintenance-cron.ts";
import {
  formatEstimatedUsd,
  PRICE_UNKNOWN_LABEL,
  USD_DECIMALS,
} from "../../../core/search/embedding-spend.ts";
import type { EmbeddingSpendPreview } from "../../../core/search/indexer.ts";
import { resolveSearchConfig } from "../../../core/search/index.ts";
import { onInterrupt } from "../../interrupt.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import { MAINTENANCE_USAGE, brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

/**
 * What this verb's exit code says, and why a refusal has its own number.
 *
 * 0 covers a gate skip as well as a clean pass: a quiet hour, a busy
 * vault and a loaded host are self-resolving conditions and cron must
 * not alarm on them. 1 means a task was ATTEMPTED and failed for a
 * reason the error names.
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
 * A safeguard timeout is the 6 case, by the docblock's own reasoning: the
 * task was killed mid-run at a checkpoint, so its outcome is unmeasured -
 * precisely "could not find out", the same condition those two surfaces
 * spend 6 on. Collapsing it into 1 told a nightly cron that a pass is
 * broken when the only proved fact is that the pass did not finish; the
 * timeout already names itself (and its budget) in the row's error.
 * A `custom:<name>` task is the exception: its timeout is the command
 * hanging, which the failure streak already counts as a failure, so it
 * exits 1 and the exit code reads the row the way the journal does.
 *
 * Precedence follows `exitCodeForCheck` and `doctorExitCode`: a proved
 * failure keeps the generic code even when another task timed out or was
 * refused, and an attempted-but-unmeasured pass outranks a refusal
 * (something ran, where a refusal records that nothing did) - so the
 * specific number never masks the more basic finding.
 */
export const MAINTENANCE_EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  probeIncomplete: 6,
  refused: 7,
} as const);

export type MaintenanceExit = (typeof MAINTENANCE_EXIT)[keyof typeof MAINTENANCE_EXIT];

/** Flags that shape a lane run and have no place in the printed recipe. */
const RUN_ONLY_FLAGS = [
  "force",
  "retry",
  "force-cost",
  "busy-minutes",
  "busy-threshold",
  "agent",
  "progress",
  "json",
] as const;

/** A built-in task's safeguard timeout: the one row whose outcome is unmeasured. */
function builtInTimeout(t: MaintenanceTaskResult): boolean {
  return t.timed_out === true && !isCustomLaneTask(t.name);
}

/**
 * The run's exit code from the lane's task rows, keyed ONLY on rows the
 * lane itself distinguished: `timed_out` (safeguard deadline, outcome
 * unmeasured), `refused` (streak refusal, nothing ran) and the plain
 * failed attempt. A timed-out row carries `ok: false` like any failure,
 * so the timeout check must come off `timed_out` - reading `ok` here
 * would make the exit 6 impossible to reach.
 */
export function maintenanceExitCode(tasks: ReadonlyArray<MaintenanceTaskResult>): MaintenanceExit {
  if (tasks.some((t) => !t.ok && t.refused !== true && !builtInTimeout(t))) {
    return MAINTENANCE_EXIT.failed;
  }
  if (tasks.some(builtInTimeout)) return MAINTENANCE_EXIT.probeIncomplete;
  return tasks.some((t) => t.refused === true) ? MAINTENANCE_EXIT.refused : MAINTENANCE_EXIT.ok;
}

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
    "force-cost": { type: "boolean" },
    "cron-template": { type: "boolean" },
    interval: { type: "string" },
    format: { type: "string" },
  });
  const op = positional[0];
  const asJson = flags["json"] === true;
  if (op !== "run" && op !== "status") {
    process.stderr.write(`${MAINTENANCE_USAGE}\n`);
    return MAINTENANCE_EXIT.usage;
  }

  const cronTemplate = flags["cron-template"] === true;
  const intervalRaw = flags["interval"] as string | undefined;
  const formatRaw = flags["format"] as string | undefined;
  // Named, not ignored: a recipe flag on a verb that is not printing a
  // recipe would otherwise be accepted and do nothing, and `status
  // --cron-template` would render the journal to someone who asked for a
  // schedule.
  if (cronTemplate && op === "status") {
    process.stderr.write(
      "brain maintenance status: --cron-template applies to run only " +
        "(o2b brain maintenance run --cron-template)\n",
    );
    return MAINTENANCE_EXIT.usage;
  }
  if (!cronTemplate && (intervalRaw !== undefined || formatRaw !== undefined)) {
    process.stderr.write(
      `brain maintenance ${op}: --interval and --format apply only with --cron-template\n`,
    );
    return MAINTENANCE_EXIT.usage;
  }
  // The reverse rule: the recipe has no place for a lane-run flag, so
  // printing it with one would schedule something other than was asked.
  const runOnly = cronTemplate
    ? RUN_ONLY_FLAGS.filter((name) => {
        const value = flags[name];
        return (
          value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)
        );
      })
    : [];
  if (runOnly.length > 0) {
    process.stderr.write(
      "brain maintenance run: --cron-template prints the recipe only and does not take " +
        runOnly.map((name) => `--${name}`).join(", ") +
        " (a lane-run flag)\n",
    );
    return MAINTENANCE_EXIT.usage;
  }

  const { config, vault } = brainVerbContext(flags);
  const now = new Date();

  try {
    if (op === "status") {
      // Bounded on the journal's own ring size, which is also the bound
      // `brain_maintenance` enforces. Unbounded here, `--limit 100000`
      // was accepted on this surface and refused on the other for the
      // same lane; and the ring cannot hold more than its cap anyway, so
      // a larger number was never a request the journal could answer.
      const limitRaw = flags["limit"] as string | undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAINTENANCE_JOURNAL_CAP) {
        process.stderr.write(
          `brain maintenance status: --limit must be an integer between 1 and ${MAINTENANCE_JOURNAL_CAP}\n`,
        );
        return MAINTENANCE_EXIT.usage;
      }
      const lease = currentLease(vault, { name: MAINTENANCE_LEASE_NAME, now });
      const journal = listJournal(vault, limit);
      // Declared and switched off is said once, here, rather than left to
      // look like a lane that forgot the operator's tasks.
      const customOff = customTasksOffNotice(resolveCustomTasks(config ?? undefined));
      if (asJson) okJson({ lease, journal, ...(customOff !== null ? { notice: customOff } : {}) });
      else {
        if (customOff !== null) ok(customOff);
        ok(lease === null ? "lease: free" : `lease: ${lease.holder} until ${lease.expiresAt}`);
        ok(`journal (${journal.length} recent):`);
        for (const e of journal) {
          // A refusal row names its task but records no outcome, because
          // the task never ran; rendering it as FAILED would report an
          // attempt that did not happen.
          const outcome = e.ok === undefined ? "" : ` ${e.ok ? "ok" : "FAILED"}`;
          ok(
            `  ${e.ts}  ${e.verdict}${e.task ? `  ${e.task}${outcome}` : ""}${journalReceiptSuffix(e.receipt)}`,
          );
        }
      }
      return MAINTENANCE_EXIT.ok;
    }

    let window: DailyWindow | undefined;
    const windowRaw = flags["window"] as string | undefined;
    if (windowRaw !== undefined) {
      // The recipe renderer's own parser, so the lane and the recipe it
      // prints cannot disagree on what a window is.
      const bounds = parseWindowBounds(windowRaw.trim());
      if (bounds === null) {
        process.stderr.write(
          `brain maintenance run: --window must be H-H with hours 0..${MAX_WINDOW_HOUR}, got: ${windowRaw}\n`,
        );
        return MAINTENANCE_EXIT.usage;
      }
      window = { ...bounds, tz: (flags["tz"] as string | undefined) ?? "UTC" };
    }
    if (cronTemplate) {
      // Before the busy flags, the lease and every gate: printing the
      // recipe is not a lane pass, so it must leave no lease, no journal
      // row and no metric behind. The window was validated above so a
      // recipe never embeds a window the lane would refuse at 3 a.m.
      return printMaintenanceRecipe(vault, intervalRaw, formatRaw, windowRaw, flags["tz"]);
    }
    // Same ceilings the MCP tool's schema declares and its handler
    // enforces, read from the same constants beside the defaults: one
    // lane must not accept through one door what it refuses at the other.
    const busyMinutes = numberFlag(
      flags["busy-minutes"],
      MAINTENANCE_BUSY_MINUTES,
      MAINTENANCE_BUSY_MINUTES_MAX,
    );
    const busyThreshold = numberFlag(
      flags["busy-threshold"],
      MAINTENANCE_BUSY_THRESHOLD,
      MAINTENANCE_BUSY_THRESHOLD_MAX,
    );
    if (busyMinutes === null || busyThreshold === null) {
      process.stderr.write(
        `brain maintenance run: --busy-minutes must be an integer between 1 and ` +
          `${MAINTENANCE_BUSY_MINUTES_MAX} and --busy-threshold between 1 and ` +
          `${MAINTENANCE_BUSY_THRESHOLD_MAX}\n`,
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
    // stages. Forwarding needs no change to `MaintenanceTask`: the shared
    // builder hands the sink to each built-in task by closure, and every
    // record names the operation that emitted it, which is exactly what
    // tells a reader which task the lane is currently inside. The MCP
    // lane passes its sink to the same builder; a second shape would
    // make the two surfaces disagree about one mechanism.
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
    // A lane task IS one of the guarded operations - `LANE_TASK` reads its
    // values out of `OPERATION` - so the task name is the budget key, and
    // the union this used to retype locally is gone from both surfaces.
    const laneSafeguard = (operation: LaneTask) =>
      createSafeguard({
        operation,
        timeoutMs: resolveSafeguardTimeoutMs(operation, config ?? undefined),
        signal: interrupt.signal,
      });
    let result: Awaited<ReturnType<typeof runMaintenance>>;
    try {
      // Built once and read twice - the lane runs these, and `--retry` is
      // checked against their names. The task bodies live in one shared
      // builder that the MCP tool calls too: the two surfaces carried
      // inline copies of the four built-ins and the copies drifted, so
      // neither surface spells a task any more. `taskNames` is the
      // vocabulary THIS install registered - the built-ins plus any
      // declared custom tasks - which is what `--retry` validates against.
      //
      // Inside the `try`, because the check below can return: a return
      // between `onInterrupt()` and the `try` would skip `release`.
      //
      // Spend is opt-in (`maintenance_embeddings`): the builder decides
      // whether the reindex pass may embed, announces the predicted spend
      // inside the task and receipts what the phase priced. `--force-cost`
      // bypasses a positive gate for this run and is recorded on the
      // receipt when it did override one.
      const lane = buildLaneTasks({
        vault,
        ...(config ? { configPath: config } : {}),
        searchConfig,
        now,
        forceCost: flags["force-cost"] === true,
        safeguardFor: laneSafeguard,
        signal: interrupt.signal,
        ...laneProgress,
        ...(asJson
          ? {}
          : {
              onBanner: (preview: EmbeddingSpendPreview) =>
                ok(formatSpendBanner(preview, searchConfig.semantic.costGateUsd)),
            }),
      });
      // Named, never dropped: a refused declaration journals nothing, and
      // the valid tasks still run.
      for (const reason of lane.custom.errors) {
        process.stderr.write(`custom task refused: ${reason}\n`);
      }
      const registered = new Set<string>(lane.taskNames);
      // Deduplicated, as the MCP tool does: naming a task twice retries it once.
      const requested = [...new Set(stringArrayFlag(flags["retry"]))];
      const unknownRetries = requested.filter((name) => !registered.has(name));
      if (unknownRetries.length > 0) {
        // Named, not ignored: a typo that silently retried nothing would
        // leave the operator reading a refusal they thought they had just
        // asked past.
        process.stderr.write(
          `brain maintenance run: --retry names no lane task: ${unknownRetries.join(", ")} ` +
            `(tasks: ${lane.taskNames.join(", ")})\n`,
        );
        return MAINTENANCE_EXIT.usage;
      }
      const retryTasks = requested as LaneTaskId[];
      result = await runMaintenance(vault, {
        now,
        holder,
        force: flags["force"] === true,
        ...(window !== undefined ? { window } : {}),
        busy: { minutes: busyMinutes, threshold: busyThreshold },
        ...(retryTasks.length > 0 ? { retryTasks } : {}),
        tasks: lane.tasks,
      });

      // The run-level spend block: the banner this run announced and the
      // receipt its reindex pass returned, both absent when nothing spent.
      const spend = lane.reindex.spendBlock(result.tasks);
      if (asJson) {
        okJson({
          verdict: result.verdict,
          tasks: result.tasks,
          ...(spend !== undefined ? { spend } : {}),
        });
      } else {
        ok(`maintenance: ${result.verdict}`);
        for (const t of result.tasks) ok(`  ${renderTaskLine(t)}`);
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
      // An attempted failure outranks a refusal, and a pass the safeguard
      // killed mid-run is reported as unmeasured, not broken: the table and
      // its reasoning live on {@link MAINTENANCE_EXIT}.
      return maintenanceExitCode(result.tasks);
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

/**
 * Print the lane's cron or systemd recipe for `vault`. A bad interval or
 * format is the lane's usage code 2, not the 1 the two older recipe
 * surfaces return: in this verb's vocabulary 1 means "attempted and
 * failed" (see {@link MAINTENANCE_EXIT}).
 */
function printMaintenanceRecipe(
  vault: string,
  intervalRaw: string | undefined,
  formatRaw: string | undefined,
  windowRaw: string | undefined,
  tzRaw: unknown,
): MaintenanceExit {
  try {
    const body = renderMaintenanceCronTemplate(intervalRaw ?? DEFAULT_MAINTENANCE_INTERVAL, {
      vault,
      format: parseRecipeFormat(formatRaw),
      ...(windowRaw !== undefined ? { window: windowRaw.trim() } : {}),
      ...(typeof tzRaw === "string" ? { tz: tzRaw } : {}),
    });
    process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
    return MAINTENANCE_EXIT.ok;
  } catch (err) {
    if (err instanceof CronTemplateError) {
      process.stderr.write(`brain maintenance run: ${err.message}\n`);
      return MAINTENANCE_EXIT.usage;
    }
    throw err;
  }
}

/**
 * One task row of the human run report. A refusal is rendered as neither
 * `ok` nor FAILED and carries no duration - the task never ran, and
 * printing `in 0ms` would describe an attempt that did not happen (the
 * lane's row omits `ok` for the same reason; this line agrees with it).
 * A safeguard timeout is rendered TIMED OUT rather than FAILED for the
 * same reason the exit code says 6 and not 1: the pass was killed at a
 * checkpoint, and the row's error - not this renderer - is what names
 * the safeguard and the budget it spent. A receipt rides the line as a
 * parenthetical, because the row that did the spending is the row an
 * operator reads first.
 */
export function renderTaskLine(t: MaintenanceTaskResult): string {
  if (t.refused === true) return `${t.name}: REFUSED (${t.error})`;
  const outcome =
    t.timed_out === true ? `TIMED OUT (${t.error})` : t.ok ? "ok" : `FAILED (${t.error})`;
  const line = `${t.name}: ${outcome} in ${t.duration_ms}ms`;
  if (t.receipt === undefined) return line;
  return `${line} (${receiptFields(t.receipt)})`;
}

/** A spend receipt's tokens, estimate and model, as the task line prints them. */
function receiptFields(receipt: MaintenanceSpendReceipt): string {
  // The journal read casts its rows unvalidated, so a row from another
  // build or a hand edit may carry no estimate or a non-number one; that
  // reads as an unknown price instead of breaking the whole listing.
  const estimate =
    typeof receipt.estimatedUsd === "number" && Number.isFinite(receipt.estimatedUsd)
      ? `estimatedUsd=${receipt.estimatedUsd.toFixed(USD_DECIMALS)}`
      : PRICE_UNKNOWN_LABEL;
  return `tokens=${receipt.tokens}, ${estimate}, model=${receipt.model ?? "unknown"}`;
}

/**
 * A journaled receipt for the status listing: the task line's fields plus
 * the recorded price source, so a row written before sources existed
 * reads as unrecorded instead of as a known price.
 */
function journalReceiptSuffix(receipt: MaintenanceSpendReceipt | undefined): string {
  if (receipt === undefined) return "";
  return `  (${receiptFields(receipt)}, price_source=${recordedPriceSource(receipt)})`;
}

/**
 * The pre-spend banner for an embedding pass about to run. The estimate
 * is INFORMATION, not only a refusal message: a zero gate (the default)
 * never blocks, and the operator still sees what the pass is predicted
 * to spend at the resolved model. Money formatting follows the cost
 * gate's own refusal message - four fixed decimals - so the banner and
 * the refusal that can follow it print one spelling.
 */
export function formatSpendBanner(preview: EmbeddingSpendPreview, gateUsd: number): string {
  const gate = gateUsd > 0 ? formatEstimatedUsd(gateUsd) : "off";
  const estimate =
    preview.estimatedUsd === null
      ? PRICE_UNKNOWN_LABEL
      : `estimated ${formatEstimatedUsd(preview.estimatedUsd)}`;
  return (
    `embedding spend: model ${preview.model ?? "unknown"}, ${preview.pendingChunks} chunks pending, ` +
    `${estimate} (gate: ${gate})`
  );
}

/** A repeatable flag's values; a flag never passed is an empty list. */
function stringArrayFlag(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

/** An integer flag inside `1..max`, its default, or null when refused. */
function numberFlag(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= max ? value : null;
}

/**
 * Administration: label vocabulary, frontmatter tier guard, secret custody, and the quiet-window maintenance lane.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { resolveAgentName } from "../../core/config.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import { toolSafeguard } from "./shared.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import { cursorOffsetArg, CURSOR_SCHEMA } from "./pagination.ts";
import { currentLease } from "../../core/brain/maintenance/lease.ts";
import {
  journalEntryWithoutCapacityReading,
  listJournal,
  MAINTENANCE_JOURNAL_CAP,
} from "../../core/brain/maintenance/journal.ts";
import {
  CUSTOM_TASK_MAX,
  customTasksOffNotice,
  resolveCustomTasks,
} from "../../core/brain/maintenance/custom-tasks.ts";
import { buildLaneTasks } from "../../core/brain/maintenance/lane-tasks.ts";
import {
  LANE_TASKS,
  MAINTENANCE_BUSY_MINUTES,
  MAINTENANCE_BUSY_MINUTES_MAX,
  MAINTENANCE_BUSY_THRESHOLD,
  MAINTENANCE_BUSY_THRESHOLD_MAX,
  runMaintenance,
  type DailyWindow,
  type LaneTask,
  type LaneTaskId,
} from "../../core/brain/maintenance/lane.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { coerceInt, coerceStrList, unknownOperationError } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { contextReach } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { toolBrainLabels, toolBrainSecrets, toolBrainTiers } from "./admin-policy-tools.ts";

// ----- brain_maintenance (t_166d1226) ------------------------------------------

/**
 * Advertised bound for `retry_tasks`: the widest list any install can
 * need, the built-ins plus the custom-task cap. The handler refuses
 * against the tasks THIS install registered, which can be fewer; naming
 * more tasks than the lane has is a mistake, not a request.
 *
 * The `maxItems` this feeds into the schema is ADVERTISEMENT, not
 * enforcement - nothing in the request path validates a JSON Schema.
 * `src/mcp/argument-guard.ts` checks argument NAMES and `coerceStrList`
 * enforces no length of its own, so a 1000-entry array reached the lane
 * with the schema saying it could not. The handler checks the length
 * itself for that reason; the schema keeps the number so a client that
 * does validate refuses before spending a round trip.
 */
const MAX_RETRY_TASKS = LANE_TASKS.length + CUSTOM_TASK_MAX;

/**
 * An optional boolean argument, read through one rule. `true` passes as
 * itself, and so does the string `"true"` - clients commonly round-trip
 * booleans as strings, and a literal `=== true` read turned that spelling
 * into a preview that still reported `verdict: ok`, the caller never the
 * wiser. `false` and `"false"` answer `false`; absence and `null` answer
 * `undefined` (the caller's default applies). Every OTHER value - `"yes"`,
 * `1`, a nested object - is an INVALID_PARAMS refusal naming the argument,
 * the same shape `coerceBoolOptional` throws for a non-boolean: refused,
 * never silently demoted to the argument's default.
 */
function coerceOptionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a boolean`);
}

/** The refusal of a lane run below local reach; it names nothing in the vault. */
export const MAINTENANCE_RUN_LOCAL_ONLY = "brain_maintenance: run executes at local reach only";

/** Quiet-window, lease-guarded heavy maintenance lane. */
async function toolBrainMaintenance(
  ctx: ServerContext,
  args: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "status") {
    throw unknownOperationError("brain_maintenance: operation must be run|status");
  }
  const now = new Date();
  if (op === "status") {
    // The journal depth is the caller's, as it is on the CLI. It was
    // hardcoded at ten here, so an agent reading a lane that had refused
    // a task days ago could not see far enough back to find the failures
    // behind the streak - the one thing the journal is kept for. Below
    // local reach the rows lose their capacity reading: the whole-vault
    // byte figures are the same local-reach facts `brain_storage` gates
    // (`journalEntryWithoutCapacityReading`), and status - unlike run -
    // answers at every reach. `limit` is the page size: the full ring is
    // read and one offset window is cut, so `journal_total` counts every
    // journaled row across pages and `next_cursor` continues the walk.
    const local = contextReach(ctx) === TRANSPORT_REACH.local;
    const notice = customTasksOffNotice(resolveCustomTasks(ctx.configPath ?? undefined));
    const journal = listJournal(ctx.vault, MAINTENANCE_JOURNAL_CAP);
    const page = pageSlice(
      journal,
      cursorOffsetArg("brain_maintenance", args),
      coerceInt(args, "limit", 10, 1, MAINTENANCE_JOURNAL_CAP),
    );
    return {
      lease: currentLease(ctx.vault, { now }),
      journal: page.items.map((entry) =>
        local ? entry : journalEntryWithoutCapacityReading(entry),
      ),
      journal_total: page.total,
      ...(notice !== null ? { notice } : {}),
      next_cursor: page.next_cursor,
    };
  }
  // A run executes the whole lane - a real dream pass that moves records,
  // reindexing and the operator's custom tasks - over every page of the
  // vault, so it is the operator's own operation. Below local reach it is
  // refused with one fixed sentence, before the lease or any write, and
  // whatever the vault holds. The test is the transport reach itself, not
  // the owner gate: an owner-gated caller at local reach is still the
  // operator.
  if (contextReach(ctx) !== TRANSPORT_REACH.local) {
    throw new MCPError(INVALID_PARAMS, MAINTENANCE_RUN_LOCAL_ONLY);
  }
  let window: DailyWindow | undefined;
  const startHour = args["window_start_hour"];
  const endHour = args["window_end_hour"];
  if (startHour !== undefined || endHour !== undefined) {
    if (
      typeof startHour !== "number" ||
      typeof endHour !== "number" ||
      !Number.isInteger(startHour) ||
      !Number.isInteger(endHour) ||
      startHour < 0 ||
      startHour > 23 ||
      endHour < 0 ||
      endHour > 23
    ) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_maintenance run: window_start_hour/window_end_hour must be integers 0..23",
      );
    }
    const tz = typeof args["tz"] === "string" ? (args["tz"] as string) : "UTC";
    window = { startHour, endHour, tz };
  }
  // The busy gate, on the CLI's terms: same two knobs, same defaults, so
  // an agent that wants a wider quiet window does not have to reach for
  // `force` - which switches off three gates it never meant to touch.
  const busy = {
    minutes: coerceInt(
      args,
      "busy_minutes",
      MAINTENANCE_BUSY_MINUTES,
      1,
      MAINTENANCE_BUSY_MINUTES_MAX,
    ),
    threshold: coerceInt(
      args,
      "busy_threshold",
      MAINTENANCE_BUSY_THRESHOLD,
      1,
      MAINTENANCE_BUSY_THRESHOLD_MAX,
    ),
  };
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  // Same per-task deadlines as the CLI lane (t_06784b8d): one fresh
  // cooperative safeguard per task, budget resolved per-op -> global
  // -> default. A lane task IS one of the guarded operations, so the task
  // name is the budget key.
  const laneSafeguard = (operation: LaneTask) => toolSafeguard(ctx, operation);
  // The lane is a dispatcher over its tasks, not one more operation, so
  // it forwards the caller's sink to each task rather than counting tasks
  // itself: every event names the operation that emitted it.
  //
  // One shared builder serves this tool and the CLI verb, so the task
  // bodies - and the spend rules of the reindex task: `maintenance_embeddings`
  // opt-in, the preview computed inside the task so a gated-out run reports
  // no banner, `force_cost` recorded on the receipt - cannot drift between
  // the two surfaces. Declared custom tasks ride after the built-ins.
  const lane = buildLaneTasks({
    vault: ctx.vault,
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    searchConfig,
    now,
    // One boolean rule per call: force_cost rides the same coercion
    // relink_apply does, so the string spelling applies and a junk value
    // is refused by name instead of silently spending the caller's
    // default.
    forceCost: coerceOptionalBool(args, "force_cost") === true,
    relinkApply: coerceOptionalBool(args, "relink_apply") === true,
    safeguardFor: laneSafeguard,
    ...(onProgress ? { onProgress } : {}),
  });
  // Refused BY NAME, exactly as the CLI refuses a `--retry` typo: a name
  // this lane does not dispatch retries nothing, and silently accepting
  // it would leave the caller reading a refusal it believed it had just
  // asked past. The bound is the tasks this install registered: once the
  // names are deduplicated, a list longer than that always names an
  // unknown task, so the one refusal below covers it with the CLI's words.
  const requestedRetries = [...new Set(coerceStrList(args, "retry_tasks"))];
  const registered = new Set<string>(lane.taskNames);
  const unknownRetries = requestedRetries.filter((name) => !registered.has(name));
  if (unknownRetries.length > 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_maintenance run: retry_tasks names no lane task: ${unknownRetries.join(", ")} ` +
        `(tasks: ${lane.taskNames.join(", ")})`,
    );
  }
  const retryTasks = requestedRetries as LaneTaskId[];
  const result = await runMaintenance(ctx.vault, {
    now,
    holder: `${agent}@${process.pid}`,
    force: args["force"] === true,
    busy,
    ...(retryTasks.length > 0 ? { retryTasks } : {}),
    ...(window !== undefined ? { window } : {}),
    // The server's own config file, so the capacity gate measures the
    // store a search_db_path in it names.
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    tasks: lane.tasks,
  });
  // The run-level spend block, the CLI JSON payload's shape.
  const spend = lane.reindex.spendBlock(result.tasks);
  // The relink pass's report: the preview on the default arm, the changes
  // under relink_apply - the same block the CLI JSON payload carries, so
  // the two front doors cannot disagree about what the pass would add.
  const relink = lane.relinkReport();
  return {
    verdict: result.verdict,
    tasks: result.tasks,
    // The capacity gate's report on a skipped:capacity run: the tier and
    // the remedy, attached verbatim from the lane so the two front doors
    // cannot disagree about what a skip says.
    ...(result.capacity !== undefined ? { capacity: result.capacity } : {}),
    ...(spend !== undefined ? { spend } : {}),
    ...(relink !== undefined ? { relink } : {}),
    // Named, never dropped: a refused declaration journals nothing, and
    // the valid tasks still ran.
    ...(lane.custom.errors.length > 0 ? { custom_task_errors: lane.custom.errors } : {}),
  };
}

// ----- brain_bridges (t_ab540afe) --------------------------------------------

export const ADMIN_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_labels",
    kind: "write",
    description:
      "Controlled-vocabulary labels from the schema pack: assign (fail-closed, one value per dimension; labels frontmatter plus a label entity), remove, show. suggest: read-only advisory suggestions from the optional labels decision-model use (available: false when off); it never assigns.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["assign", "remove", "show", "suggest"],
          description: "Tool operation.",
        },
        path: { type: "string", description: "Vault-relative note path." },
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "Dimensions to suggest (suggest). Default: every declared dimension.",
        },
        dimension: { type: "string", description: "Label dimension (assign/remove)." },
        value: { type: "string", description: "Label value (assign)." },
        agent: { type: "string", description: "Agent identity override (assign)." },
      },
      required: ["operation", "path"],
      additionalProperties: false,
    },
    handler: toolBrainLabels,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_tiers",
    kind: "write",
    description:
      "Frontmatter tier guard: check lists staged identity-field hand-edits the index post-pass detected, restore (apply=true required) writes the expected value back into the file, accept adopts the hand-edit as the new snapshot baseline. Nothing auto-resolves.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["check", "restore", "accept"],
          description: "Tool operation.",
        },
        path: { type: "string", description: "Vault-relative path (restore/accept)." },
        field: { type: "string", description: "Restrict to one field (restore/accept)." },
        apply: { type: "boolean", description: "Required true for restore - it writes the file." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTiers,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_secrets",
    kind: "write",
    description:
      "Capability-gated secret custody, agent-facing subset: list stored secret metadata (never values) or run an allowlisted command with the secret injected as its declared env var - output comes back redacted. Storing and removing secrets stays on the operator's CLI (o2b brain secret).",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "run"], description: "Tool operation." },
        name: { type: "string", description: "Secret name (run)." },
        command: {
          type: "array",
          items: { type: "string" },
          description: "Command argv to execute (run); must match the secret's allowlist.",
        },
        agent: { type: "string", description: "Agent identity override (run)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainSecrets,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_maintenance",
    kind: "write",
    description:
      "Quiet-window, lease-guarded maintenance lane: run executes dream, reindex, bridges, clusters, relink and declared custom:<name> tasks behind window, busy, pressure, capacity and streak gates; status renders lease and journal. Reindex embeds only with config maintenance_embeddings.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["run", "status"], description: "Tool operation." },
        force: {
          type: "boolean",
          // The old text said "window and busy gates" and had been wrong
          // since the pressure gate and the streak refusal were added.
          // A caller reaching for the widest escape has to be told what
          // it actually switches off.
          description:
            "Bypass the window, busy, host-pressure and storage-capacity gates and every streak refusal; never the lease (run). retry_tasks passes one streak, gates kept.",
        },
        retry_tasks: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_RETRY_TASKS,
          description: `Tasks to retry past their streak refusal, this run only; gates still apply. Known: ${LANE_TASKS.join(", ")}, custom:<name>. Unknown names are refused.`,
        },
        force_cost: {
          type: "boolean",
          description:
            "Bypass a positive embedding cost gate for this run's reindex (run); recorded on the spend receipt when it overrode a gate that would have refused.",
        },
        relink_apply: {
          type: "boolean",
          description:
            "Apply the relink pass (run): rewrite the changed signal pages' entity anchor lines. Default false previews the per-source additions and writes nothing.",
        },
        busy_minutes: {
          type: "integer",
          minimum: 1,
          maximum: MAINTENANCE_BUSY_MINUTES_MAX,
          description: `Busy-gate lookback in minutes (run; default ${MAINTENANCE_BUSY_MINUTES}).`,
        },
        busy_threshold: {
          type: "integer",
          minimum: 1,
          maximum: MAINTENANCE_BUSY_THRESHOLD_MAX,
          description: `Recent queries in the lookback that count as busy (run; default ${MAINTENANCE_BUSY_THRESHOLD}).`,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAINTENANCE_JOURNAL_CAP,
          description: "Journal rows to return, newest first (status; default 10).",
        },
        cursor: CURSOR_SCHEMA,
        window_start_hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "Local hour the window opens, inclusive (run).",
        },
        window_end_hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "Local hour the window closes, exclusive (run).",
        },
        tz: { type: "string", description: "IANA timezone for the window (default UTC)." },
        agent: { type: "string", description: "Agent identity override (run)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainMaintenance,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
]);

/**
 * Administration: label vocabulary, frontmatter tier guard, secret custody, and the quiet-window maintenance lane.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { existsSync } from "node:fs";
import { resolveAgentName } from "../../core/config.ts";
import { indexVault, resolveSearchConfig } from "../../core/search/index.ts";
import { Store } from "../../core/search/store.ts";
import {
  assignNoteLabel,
  LabelVocabularyError,
  readLabels,
  removeNoteLabel,
} from "../../core/brain/labels.ts";
import { StandingRulesWriteRefusedError } from "../../core/brain/standing-rules.ts";
import { loadSchemaPack } from "../../core/brain/schema-pack.ts";
import { listSecrets } from "../../core/brain/secrets/store.ts";
import { runWithSecret, SecretExecDeniedError } from "../../core/brain/secrets/exec.ts";
import {
  discoverBridges,
  readDismissedBridges,
  writeBridgeProposals,
} from "../../core/brain/link-graph/bridge-discovery.ts";
import {
  detectCommunities,
  materializeClusterNotes,
} from "../../core/brain/link-graph/communities.ts";
import { appendMetric } from "../../core/brain/metrics.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import { requiredStringArg, toolSafeguard } from "./shared.ts";
import { currentLease } from "../../core/brain/maintenance/lease.ts";
import { listJournal, MAINTENANCE_JOURNAL_CAP } from "../../core/brain/maintenance/journal.ts";
import {
  isLaneTask,
  LANE_TASK,
  LANE_TASKS,
  MAINTENANCE_BUSY_MINUTES,
  MAINTENANCE_BUSY_MINUTES_MAX,
  MAINTENANCE_BUSY_THRESHOLD,
  MAINTENANCE_BUSY_THRESHOLD_MAX,
  runMaintenance,
  type DailyWindow,
  type LaneTask,
} from "../../core/brain/maintenance/lane.ts";
import { writeFrontmatterAtomic } from "../../core/vault.ts";
import { resolveNotePath } from "../../core/brain/note-path.ts";
import type { FrontmatterMap } from "../../core/types.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { dream } from "../../core/brain/dream.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { coerceInt, coerceStrList } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";

/** Controlled-vocabulary classification over the schema pack's labels. */
function toolBrainLabels(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (op !== "assign" && op !== "remove" && op !== "show") {
    throw new MCPError(INVALID_PARAMS, "brain_labels: operation must be assign|remove|show");
  }
  // a-label-is-not-a-boundary, U12: the ARGUMENT is right and the
  // VALIDATOR's message was wrong. `path` is the only name this tool
  // declares for the note - a caller passing `id` is refused by name by
  // the unknown-argument gate (`src/mcp/argument-guard.ts`) before the
  // handler runs - but this check answered an ABSENT `path` with a
  // sentence about its SHAPE, so a caller who sent the wrong name read
  // it as "my path is malformed" and retried the same call. The shared
  // coercion already tells absence and malformation apart, and stamps
  // the operation into both, so the two failures no longer share a
  // sentence.
  const path = requiredStringArg(`brain_labels ${op}`, args, "path");
  if (op === "show") {
    const [metadata] = parseFrontmatter(vaultContainedPath(ctx.vault, path, "brain_labels show"));
    return { path, labels: readLabels(metadata) };
  }
  const pack = loadSchemaPack(ctx.vault);
  const dimension = args["dimension"];
  if (typeof dimension !== "string" || dimension.trim() === "") {
    throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: dimension must be non-empty`);
  }
  try {
    if (op === "remove") {
      return { ...removeNoteLabel(ctx.vault, path, { dimension, pack }) };
    }
    const value = args["value"];
    if (typeof value !== "string" || value.trim() === "") {
      throw new MCPError(INVALID_PARAMS, "brain_labels assign: value must be non-empty");
    }
    const agentArg = args["agent"];
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    return {
      ...assignNoteLabel(ctx.vault, path, { dimension, value, pack, agent, now: new Date() }),
    };
  } catch (exc) {
    if (exc instanceof LabelVocabularyError) {
      throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: ${exc.message}`);
    }
    // A refused target is a bad argument, not a server fault: the caller
    // named a file this surface will not rewrite, and the message says
    // which one so the agent stops trying rather than retrying blind.
    if (exc instanceof StandingRulesWriteRefusedError) {
      throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: ${exc.message}`);
    }
    throw exc;
  }
}

// ----- brain_tiers (t_3f92d3f1) ----------------------------------------------

/** Staged repair surface for identity-tier frontmatter hand-edits. */
async function toolBrainTiers(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "check" && op !== "restore" && op !== "accept") {
    throw new MCPError(INVALID_PARAMS, "brain_tiers: operation must be check|restore|accept");
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  if (op === "check") {
    // Fail-soft: a vault that was never indexed has no snapshots and
    // therefore no drift - not an error.
    if (!existsSync(searchConfig.dbPath)) return { findings: [] };
    const store = await Store.open(searchConfig, { mode: "read" });
    try {
      return { findings: store.listTierDrift() };
    } finally {
      await store.close();
    }
  }
  // Same conflation as `brain_labels` above, same cure: `path` is
  // optional for `check` and required for the two write operations, and
  // "you did not send it" is a different sentence from "what you sent is
  // not a path".
  const path = requiredStringArg(`brain_tiers ${op}`, args, "path");
  if (op === "restore" && args["apply"] !== true) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_tiers restore: pass apply=true - restore writes the file",
    );
  }
  const field = typeof args["field"] === "string" ? (args["field"] as string) : undefined;
  if (!existsSync(searchConfig.dbPath)) {
    throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: the vault has no search index yet`);
  }
  const store = await Store.open(searchConfig, { mode: "write" });
  try {
    const docId = store.getDocumentIdByPath(path);
    if (docId === null) {
      throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: not indexed: ${path}`);
    }
    const rows = store
      .listTierDrift()
      .filter((r) => r.documentId === docId && (field === undefined || r.field === field));
    if (rows.length === 0) {
      throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: no open drift for ${path}`);
    }
    if (op === "restore") {
      const absolute = vaultContainedPath(ctx.vault, path, "brain_tiers restore");
      const [metadata, body] = parseFrontmatter(absolute);
      const next = { ...metadata };
      for (const r of rows) {
        next[r.field] = frontmatterValueFromSnapshot(r.expected, r.field);
      }
      writeFrontmatterAtomic(absolute, next, body, { overwrite: true });
      for (const r of rows) store.clearTierDrift(docId, r.field);
      return { restored: rows.map((r) => r.field), path };
    }
    const snapshot: Record<string, unknown> = { ...store.getTierSnapshot(docId) };
    for (const r of rows) {
      snapshot[r.field] = r.actual;
      store.clearTierDrift(docId, r.field);
    }
    store.setTierSnapshot(docId, snapshot);
    return { accepted: rows.map((r) => r.field), path };
  } finally {
    await store.close();
  }
}

/** Resolve a vault-relative path, refusing traversal and symlink escapes. */
function vaultContainedPath(vault: string, relPath: string, label: string): string {
  try {
    return resolveNotePath(vault, relPath);
  } catch (exc) {
    throw new MCPError(INVALID_PARAMS, `${label}: ${(exc as Error).message}`);
  }
}

/** Narrow a snapshot value to the shapes frontmatter can carry. */
function frontmatterValueFromSnapshot(value: unknown, field: string): FrontmatterMap[string] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
    return value;
  }
  throw new MCPError(
    INVALID_PARAMS,
    `brain_tiers restore: snapshot value for "${field}" is not a frontmatter scalar or string array`,
  );
}

// ----- brain_secrets (t_0b134404) ---------------------------------------------

/**
 * Capability-gated custody, agent-facing subset: list metadata and
 * run an allowlisted command. Deliberately NO set/get over MCP - the
 * material enters via the operator's CLI and leaves only into a
 * subprocess env.
 */
async function toolBrainSecrets(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "list" && op !== "run") {
    throw new MCPError(INVALID_PARAMS, "brain_secrets: operation must be list|run");
  }
  if (op === "list") {
    return { secrets: listSecrets(ctx.vault) };
  }
  const name = args["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_secrets run: name must be non-empty");
  }
  const command = args["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part): part is string => typeof part === "string")
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_secrets run: command must be a non-empty array of strings",
    );
  }
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  try {
    const result = await runWithSecret(ctx.vault, name, command, { agent, now: new Date() });
    return { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (exc) {
    if (exc instanceof SecretExecDeniedError) {
      throw new MCPError(INVALID_PARAMS, `brain_secrets run: ${exc.message}`);
    }
    throw exc;
  }
}

// ----- brain_maintenance (t_166d1226) ------------------------------------------

/**
 * Bound for `retry_tasks`: naming more tasks than the lane dispatches is
 * a mistake, not a request.
 *
 * The `maxItems` this feeds into the schema is ADVERTISEMENT, not
 * enforcement - nothing in the request path validates a JSON Schema.
 * `src/mcp/argument-guard.ts` checks argument NAMES and `coerceStrList`
 * enforces no length of its own, so a 1000-entry array reached the lane
 * with the schema saying it could not. The handler checks the length
 * itself for that reason; the schema keeps the number so a client that
 * does validate refuses before spending a round trip.
 */
const MAX_RETRY_TASKS = LANE_TASKS.length;

/** Quiet-window, lease-guarded heavy maintenance lane. */
async function toolBrainMaintenance(
  ctx: ServerContext,
  args: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "status") {
    throw new MCPError(INVALID_PARAMS, "brain_maintenance: operation must be run|status");
  }
  const now = new Date();
  if (op === "status") {
    // The journal depth is the caller's, as it is on the CLI. It was
    // hardcoded at ten here, so an agent reading a lane that had refused
    // a task days ago could not see far enough back to find the failures
    // behind the streak - the one thing the journal is kept for.
    return {
      lease: currentLease(ctx.vault, { now }),
      journal: listJournal(ctx.vault, coerceInt(args, "limit", 10, 1, MAINTENANCE_JOURNAL_CAP)),
    };
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
  // Refused BY NAME, exactly as the CLI refuses a `--retry` typo: a name
  // this lane does not dispatch retries nothing, and silently accepting
  // it would leave the caller reading a refusal it believed it had just
  // asked past.
  const requestedRetries = coerceStrList(args, "retry_tasks");
  if (requestedRetries.length > MAX_RETRY_TASKS) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_maintenance run: retry_tasks accepts at most ${MAX_RETRY_TASKS} entries ` +
        `(one per lane task: ${LANE_TASKS.join(", ")}), got ${requestedRetries.length}`,
    );
  }
  const unknownRetries = requestedRetries.filter((name) => !isLaneTask(name));
  if (unknownRetries.length > 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_maintenance run: retry_tasks names no lane task: ${unknownRetries.join(", ")} ` +
        `(tasks: ${LANE_TASKS.join(", ")})`,
    );
  }
  const retryTasks: ReadonlyArray<LaneTask> = requestedRetries.filter(isLaneTask);
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
  // -> default. The lane is the only surface that wants a guard PER
  // TASK rather than per call, so it names the shared factory four
  // times instead of holding one guard.
  // A lane task IS one of the guarded operations, so the task name is the
  // budget key. The union that used to be retyped here is gone: both
  // surfaces read `LANE_TASK`, whose values come from `OPERATION`.
  const laneSafeguard = (operation: LaneTask) => toolSafeguard(ctx, operation);
  // The lane is a dispatcher over four long operations, not a fifth one,
  // so it forwards the caller's sink to each task rather than counting
  // tasks itself: every event names the operation that emitted it, which
  // is what tells a reader which of the four the lane is currently in.
  const laneProgress = onProgress ? { onProgress } : {};
  const result = await runMaintenance(ctx.vault, {
    now,
    holder: `${agent}@${process.pid}`,
    force: args["force"] === true,
    busy,
    ...(retryTasks.length > 0 ? { retryTasks } : {}),
    ...(window !== undefined ? { window } : {}),
    tasks: [
      {
        name: LANE_TASK.dream,
        run: async () => {
          dream(ctx.vault, { now, safeguard: laneSafeguard(LANE_TASK.dream), ...laneProgress });
        },
      },
      {
        name: LANE_TASK.reindex,
        run: async () => {
          await indexVault(searchConfig, {
            safeguard: laneSafeguard(LANE_TASK.reindex),
            ...laneProgress,
          });
        },
      },
      // Same lane contract as the CLI verb (link-recall-intelligence):
      // bridges and clusters run after reindex so they see fresh
      // edges; both are fail-soft without embeddings, and a metrics
      // write failure never fails the task.
      {
        name: LANE_TASK.bridges,
        run: async () => {
          const store = await Store.open(searchConfig, { mode: "read" });
          try {
            const report = discoverBridges(store, {
              dismissed: readDismissedBridges(ctx.vault),
              safeguard: laneSafeguard(LANE_TASK.bridges),
              ...laneProgress,
            });
            writeBridgeProposals(ctx.vault, report, { now });
            try {
              appendMetric(ctx.vault, {
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
        name: LANE_TASK.clusters,
        run: async () => {
          const store = await Store.open(searchConfig, { mode: "read" });
          try {
            const communities = detectCommunities(store, {
              safeguard: laneSafeguard(LANE_TASK.clusters),
              ...laneProgress,
            });
            const materialized = materializeClusterNotes(ctx.vault, communities, { store, now });
            try {
              appendMetric(ctx.vault, {
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
  return { verdict: result.verdict, tasks: result.tasks };
}

// ----- brain_bridges (t_ab540afe) --------------------------------------------

export const ADMIN_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_labels",
    description:
      "Controlled-vocabulary classification against the schema pack's labels field: assign (fail-closed - unknown dimensions/values rejected with the declared vocabulary), remove, or show a note's labels. Single-choice per dimension; persists as a labels frontmatter array plus a canonical label entity.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["assign", "remove", "show"],
          description: "Tool operation.",
        },
        path: { type: "string", description: "Vault-relative note path." },
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
    description:
      "Quiet-window, lease-guarded heavy maintenance lane: run executes dream, reindex, bridges and clusters stale-first behind the window, busy, host-pressure and streak gates and an expiring lease (force bypasses all of those but the lease); status renders the lease holder and recent journal.",
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
            "Bypass the window, busy and host-pressure gates and every streak refusal - never the lease (run). retry_tasks passes one task's streak with the gates kept.",
        },
        retry_tasks: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_RETRY_TASKS,
          description: `Tasks to retry past their streak refusal, this run only; gates still apply. Known: ${LANE_TASKS.join(", ")}. An unknown name is refused.`,
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

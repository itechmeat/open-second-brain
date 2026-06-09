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
import { createSafeguard, resolveSafeguardTimeoutMs } from "../../core/brain/safeguard.ts";
import { currentLease } from "../../core/brain/maintenance/lease.ts";
import { listJournal } from "../../core/brain/maintenance/journal.ts";
import { runMaintenance, type DailyWindow } from "../../core/brain/maintenance/lane.ts";
import { writeFrontmatterAtomic } from "../../core/vault.ts";
import { resolveNotePath } from "../../core/brain/note-path.ts";
import type { FrontmatterMap } from "../../core/types.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { dream } from "../../core/brain/dream.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
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
  const path = args["path"];
  if (typeof path !== "string" || path.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_labels: path must be a vault-relative string");
  }
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
  const path = args["path"];
  if (typeof path !== "string" || path.trim() === "") {
    throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: path must be a vault-relative string`);
  }
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

/** Quiet-window, lease-guarded heavy maintenance lane. */
async function toolBrainMaintenance(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "status") {
    throw new MCPError(INVALID_PARAMS, "brain_maintenance: operation must be run|status");
  }
  const now = new Date();
  if (op === "status") {
    return {
      lease: currentLease(ctx.vault, { now }),
      journal: listJournal(ctx.vault, 10),
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
  // -> default.
  const laneSafeguard = (operation: "dream" | "reindex" | "bridges" | "clusters") =>
    createSafeguard({
      operation,
      timeoutMs: resolveSafeguardTimeoutMs(operation, ctx.configPath ?? undefined),
    });
  const result = await runMaintenance(ctx.vault, {
    now,
    holder: `${agent}@${process.pid}`,
    force: args["force"] === true,
    ...(window !== undefined ? { window } : {}),
    tasks: [
      {
        name: "dream",
        run: async () => {
          dream(ctx.vault, { now, safeguard: laneSafeguard("dream") });
        },
      },
      {
        name: "reindex",
        run: async () => {
          await indexVault(searchConfig, { safeguard: laneSafeguard("reindex") });
        },
      },
      // Same lane contract as the CLI verb (link-recall-intelligence):
      // bridges and clusters run after reindex so they see fresh
      // edges; both are fail-soft without embeddings, and a metrics
      // write failure never fails the task.
      {
        name: "bridges",
        run: async () => {
          const store = await Store.open(searchConfig, { mode: "read" });
          try {
            const report = discoverBridges(store, {
              dismissed: readDismissedBridges(ctx.vault),
              safeguard: laneSafeguard("bridges"),
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
        name: "clusters",
        run: async () => {
          const store = await Store.open(searchConfig, { mode: "read" });
          try {
            const communities = detectCommunities(store, { safeguard: laneSafeguard("clusters") });
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
      "Quiet-window, lease-guarded heavy maintenance lane: run executes dream, reindex, bridges, and clusters stale-first behind the local-time window, busy gate, and an expiring lease (force bypasses the soft gates, never the lease); status renders the lease holder and recent journal.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["run", "status"], description: "Tool operation." },
        force: { type: "boolean", description: "Bypass window and busy gates (run)." },
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

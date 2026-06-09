/**
 * Knowledge graph: foresight, bridge discovery, community clusters, MOC audit, deep synthesis, idea discovery, the claim ledger, and dead ends.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { resolveAgentName, resolveTriggerCooldownDays } from "../../core/config.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import { Store } from "../../core/search/store.ts";
import { loadSchemaPack } from "../../core/brain/schema-pack.ts";
import {
  acceptBridge,
  bridgePairKey,
  discoverBridges,
  dismissBridge,
  readDismissedBridges,
  writeBridgeProposals,
} from "../../core/brain/link-graph/bridge-discovery.ts";
import {
  detectCommunities,
  materializeClusterNotes,
} from "../../core/brain/link-graph/communities.ts";
import { appendMetric } from "../../core/brain/metrics.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { createTriggers } from "../../core/brain/triggers/store.ts";
import { deepSynthesis, synthesisCandidates } from "../../core/brain/deep-synthesis.ts";
import { discoverIdeas, ideaCandidates } from "../../core/brain/idea-discovery.ts";
import { auditMoc, MocAuditError } from "../../core/brain/link-graph/moc-audit.ts";
import { normaliseWikilinkTarget } from "../../core/brain/wikilink.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { normalizeEntityName } from "../../core/brain/entities/canonical.ts";
import { listDeadEnds, recordDeadEnd } from "../../core/brain/dead-ends.ts";
import { buildForesight, FORESIGHT_HORIZON_DAYS } from "../../core/brain/temporal/foresight.ts";
import { aggregateQuantities } from "../../core/brain/truth/aggregate.ts";
import { detectAgentCollisions } from "../../core/brain/truth/collision.ts";
import { computeTruthStateWithConflicts } from "../../core/brain/truth/conflicts.ts";
import { appendClaimEvent, readClaimEvents } from "../../core/brain/truth/store.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceStr, coerceBool } from "../coerce.ts";
import { optionalPositiveInt } from "./shared.ts";

/** Forward-looking projection envelope; read-only fold. */
function toolBrainForesight(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const horizonRaw = args["horizon_days"];
  let horizonDays = FORESIGHT_HORIZON_DAYS;
  if (horizonRaw !== undefined && horizonRaw !== null) {
    if (typeof horizonRaw !== "number" || !Number.isInteger(horizonRaw) || horizonRaw < 1) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_foresight: horizon_days must be a positive integer",
      );
    }
    horizonDays = horizonRaw;
  }
  return { ...buildForesight(ctx.vault, { now: new Date(), horizonDays }) };
}

// ----- brain_labels (t_7a41f42d) ---------------------------------------------

/**
 * Bridge discovery over the vec index: discover regenerates the
 * reviewable proposals artifact, accept writes one related wikilink,
 * dismiss persists a pair suppression, list reads the artifact back.
 */
async function toolBrainBridges(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "discover" && op !== "list" && op !== "accept" && op !== "dismiss") {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_bridges: operation must be discover|list|accept|dismiss",
    );
  }
  if (op === "accept" || op === "dismiss") {
    const source = args["source"];
    const target = args["target"];
    if (typeof source !== "string" || source.trim() === "") {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_bridges ${op}: source must be a vault-relative path`,
      );
    }
    if (typeof target !== "string" || target.trim() === "") {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_bridges ${op}: target must be a vault-relative path`,
      );
    }
    if (op === "dismiss") {
      return {
        dismissed: bridgePairKey(source, target),
        added: dismissBridge(ctx.vault, source, target),
      };
    }
    try {
      const pack = loadSchemaPack(ctx.vault);
      return { ...acceptBridge(ctx.vault, source, target, { pack }), source, target };
    } catch (exc) {
      const message = (exc as Error).message ?? String(exc);
      if (/outside the vault|does not exist|link constraint/.test(message)) {
        throw new MCPError(INVALID_PARAMS, `brain_bridges accept: ${message}`);
      }
      throw exc;
    }
  }
  if (op === "list") {
    const path = join(ctx.vault, "Brain", "proposals", "bridges.md");
    if (!existsSync(path)) return { exists: false, proposals: 0 };
    const [meta] = parseFrontmatter(path);
    return {
      exists: true,
      path: "Brain/proposals/bridges.md",
      generated_at: meta["generated_at"] ?? null,
      proposals: Number(meta["proposals"] ?? 0),
    };
  }
  // discover
  const max = args["max"];
  if (max !== undefined && (!Number.isInteger(max) || (max as number) < 1)) {
    throw new MCPError(INVALID_PARAMS, "brain_bridges discover: max must be a positive integer");
  }
  const minSimilarity = args["min_similarity"];
  if (
    minSimilarity !== undefined &&
    (typeof minSimilarity !== "number" || minSimilarity <= 0 || minSimilarity > 1)
  ) {
    throw new MCPError(INVALID_PARAMS, "brain_bridges discover: min_similarity must be in (0, 1]");
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  if (!existsSync(searchConfig.dbPath)) {
    return { vec_available: false, proposals: [], reason: "index not built" };
  }
  const store = await Store.open(searchConfig, { mode: "read" });
  const now = new Date();
  try {
    const dismissed = readDismissedBridges(ctx.vault);
    const report = discoverBridges(store, {
      ...(max !== undefined ? { maxProposals: max as number } : {}),
      ...(minSimilarity !== undefined ? { minSimilarity } : {}),
      dismissed,
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
          dismissed_total: dismissed.size,
        },
      });
    } catch {
      // Metrics are observability, not correctness.
    }
    return {
      vec_available: report.vecAvailable,
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
      scanned_candidates: report.scannedCandidates,
      proposals: report.proposals,
      artifact: "Brain/proposals/bridges.md",
    };
  } finally {
    await store.close();
  }
}

// ----- brain_clusters (t_4ba927ec) --------------------------------------------

/** Graph-wide community detection with materialized cluster notes. */
async function toolBrainClusters(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "list") {
    throw new MCPError(INVALID_PARAMS, "brain_clusters: operation must be run|list");
  }
  if (op === "list") {
    const dir = join(ctx.vault, "Brain", "clusters");
    if (!existsSync(dir)) return { clusters: [] };
    const clusters = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .toSorted()
      .map((f) => {
        const [meta] = parseFrontmatter(join(dir, f));
        return meta["kind"] === "brain-cluster"
          ? {
              path: `Brain/clusters/${f}`,
              cluster: String(meta["cluster"] ?? ""),
              size: Number(meta["size"] ?? 0),
              density: Number(meta["density"] ?? 0),
              generated_at: String(meta["generated_at"] ?? ""),
            }
          : null;
      })
      .filter((c) => c !== null);
    return { clusters };
  }
  const minSize = args["min_size"];
  if (minSize !== undefined && (!Number.isInteger(minSize) || (minSize as number) < 2)) {
    throw new MCPError(INVALID_PARAMS, "brain_clusters run: min_size must be an integer >= 2");
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  if (!existsSync(searchConfig.dbPath)) {
    return { communities: [], reason: "index not built" };
  }
  const store = await Store.open(searchConfig, { mode: "read" });
  const now = new Date();
  try {
    const communities = detectCommunities(
      store,
      minSize !== undefined ? { minSize: minSize as number } : {},
    );
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
        },
      });
    } catch {
      // Metrics are observability, not correctness.
    }
    return {
      communities: communities.map((c) => ({
        id: c.id,
        size: c.size,
        density: c.density,
        members: c.members.map((m) => m.path),
      })),
      written: materialized.written,
      removed: materialized.removed,
    };
  } finally {
    await store.close();
  }
}

// ----- brain_benchmark (t_e2215d49) -------------------------------------------

/**
 * Per-MOC coverage audit. Classifies cluster members into
 * `wellCovered` / `fragile` / `candidateMissing` and surfaces a
 * `suggestedNext` candidate. MOC detection is purely structural -
 * outbound link count + link density.
 */
async function toolBrainMocAudit(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, "brain_moc_audit: id must be a non-empty string");
  }
  const targetId = normaliseWikilinkTarget(idRaw);
  try {
    const report = auditMoc(ctx.vault, targetId);
    return {
      vault_path: ctx.vault,
      hub_id: report.hubId,
      outbound_count: report.outboundCount,
      well_covered: report.wellCovered,
      fragile: report.fragile,
      candidate_missing: report.candidateMissing,
      ...(report.suggestedNext ? { suggested_next: report.suggestedNext } : {}),
    };
  } catch (err) {
    if (err instanceof MocAuditError) {
      throw new MCPError(INVALID_PARAMS, `brain_moc_audit: ${err.message}`);
    }
    throw err;
  }
}

// ----- Temporal subsystem MCP wrappers (v0.10.18) --------------------------

async function toolBrainDeepSynthesis(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topic = coerceStr(args, "topic", true)!;
  const limit = optionalPositiveInt(args, "limit", "brain_deep_synthesis") ?? 30;
  if (limit > 100) {
    throw new MCPError(INVALID_PARAMS, "brain_deep_synthesis: limit must be at most 100");
  }
  const enqueue = coerceBool(args, "triggers");
  const now = new Date();
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  const report = await deepSynthesis(searchConfig, topic, { now, limit });
  let triggersCreated: number | undefined;
  if (enqueue) {
    const result = createTriggers(ctx.vault, synthesisCandidates(report), {
      now,
      cooldownDays: resolveTriggerCooldownDays(ctx.configPath ?? undefined),
    });
    triggersCreated = result.created.length;
  }
  return {
    topic: report.topic,
    generated_at: report.generatedAt,
    checked: report.checked,
    notes: report.notes,
    agreements: report.agreements,
    contradictions: report.contradictions,
    stale_claims: report.staleClaims.map((s) => ({
      path: s.path,
      age_days: s.ageDays,
      superseded_by: s.supersededBy,
    })),
    gaps: report.gaps,
    contaminated: report.contaminated,
    ...(triggersCreated !== undefined ? { triggers_created: triggersCreated } : {}),
  };
}

// ----- brain_idea_discovery (Workspace Insight Suite) ------------------------

function toolBrainIdeaDiscovery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const cap = optionalPositiveInt(args, "cap", "brain_idea_discovery") ?? 5;
  if (cap > 50) {
    throw new MCPError(INVALID_PARAMS, "brain_idea_discovery: cap must be at most 50");
  }
  const enqueue = coerceBool(args, "triggers");
  const now = new Date();
  const ideas = discoverIdeas(ctx.vault, { now, cap });
  let triggersCreated: number | undefined;
  if (enqueue) {
    const result = createTriggers(ctx.vault, ideaCandidates(ideas), {
      now,
      cooldownDays: resolveTriggerCooldownDays(ctx.configPath ?? undefined),
    });
    triggersCreated = result.created.length;
  }
  return {
    ideas: ideas.map((idea) => ({
      kind: idea.kind,
      title: idea.title,
      reason: idea.reason,
      score: idea.score,
      source_artifacts: idea.sourceArtifacts,
    })),
    ...(triggersCreated !== undefined ? { triggers_created: triggersCreated } : {}),
  };
}

// ----- brain_context_pack (v0.10.15) ---------------------------------------

/**
 * Operator/agent surface over the entity claim ledger: ingest one
 * claim, render slots/conflicts from the fold, aggregate exact-match
 * quantities, report cross-agent collisions. Read ops are pure folds
 * over the append-only ledger.
 */
function toolBrainTruth(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (
    op !== "ingest" &&
    op !== "slots" &&
    op !== "conflicts" &&
    op !== "aggregate" &&
    op !== "collisions"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_truth: operation must be ingest|slots|conflicts|aggregate|collisions",
    );
  }
  const requireStr = (name: string): string => {
    const value = args[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new MCPError(INVALID_PARAMS, `brain_truth ${op}: ${name} must be a non-empty string`);
    }
    return value;
  };

  if (op === "ingest") {
    const quantityValue = args["quantity_value"];
    if (
      (quantityValue === undefined || quantityValue === null) &&
      (typeof args["quantity_unit"] === "string" || typeof args["quantity_action"] === "string")
    ) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_truth ingest: quantity_value is required when quantity_unit or quantity_action is provided",
      );
    }
    let quantity: { value: number; unit: string | null; action: string | null } | undefined;
    if (quantityValue !== undefined && quantityValue !== null) {
      if (typeof quantityValue !== "number" || !Number.isFinite(quantityValue)) {
        throw new MCPError(INVALID_PARAMS, "brain_truth ingest: quantity_value must be a number");
      }
      quantity = {
        value: quantityValue,
        unit: typeof args["quantity_unit"] === "string" ? (args["quantity_unit"] as string) : null,
        action:
          typeof args["quantity_action"] === "string" ? (args["quantity_action"] as string) : null,
      };
    }
    const agentArg = args["agent"];
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    const result = appendClaimEvent(ctx.vault, {
      ts: isoSecond(new Date()),
      agent,
      entity: requireStr("entity"),
      aspect: requireStr("aspect"),
      value: requireStr("value"),
      ...(quantity !== undefined ? { valueKind: "quantity" as const, quantity } : {}),
      source: requireStr("source"),
    });
    return {
      ok: true,
      entity: result.event.entity,
      aspect: result.event.aspect,
      path: result.path,
    };
  }

  const events = readClaimEvents(ctx.vault).events;
  if (op === "slots" || op === "conflicts") {
    const state = computeTruthStateWithConflicts(events);
    if (op === "conflicts") return { events: state.events, conflicts: state.conflicts };
    const entityFilter = args["entity"];
    const slots =
      typeof entityFilter === "string" && entityFilter.trim() !== ""
        ? state.slots.filter((s) => s.entity === normalizeEntityName(entityFilter))
        : state.slots;
    return { events: state.events, slots };
  }
  if (op === "aggregate") {
    const state = computeTruthStateWithConflicts(events);
    return {
      ...aggregateQuantities(state.slots, {
        ...(typeof args["action"] === "string" ? { action: args["action"] as string } : {}),
        unit: typeof args["unit"] === "string" ? (args["unit"] as string) : null,
        ...(typeof args["entity"] === "string" ? { entity: args["entity"] as string } : {}),
      }),
    };
  }
  return {
    collisions: detectAgentCollisions(events, { now: new Date() }),
  };
}

// ----- brain_concept_synthesis (v0.10.17) ----------------------------------

/**
 * Negative-knowledge registry: record one tried-and-failed approach
 * or list the bounded active set, newest first.
 */
function toolBrainDeadEnds(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (op !== "record" && op !== "list") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends: operation must be record|list");
  }
  if (op === "list") {
    const { entries, warnings } = listDeadEnds(ctx.vault);
    return { entries, warnings };
  }
  const approach = args["approach"];
  const reason = args["reason"];
  if (typeof approach !== "string" || approach.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends record: approach must be non-empty");
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends record: reason must be non-empty");
  }
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  const result = recordDeadEnd(ctx.vault, {
    approach,
    reason,
    ...(typeof args["context"] === "string" ? { context: args["context"] as string } : {}),
    agent,
    now: new Date(),
  });
  return { ok: true, id: result.entry.id, path: result.entry.path, archived: result.archived };
}

// ----- brain_truth (Entity Truth & Self-Improving Dream Suite) ---------------

export const KNOWLEDGE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_foresight",
    description:
      "Forward-looking projection (Brain's only anticipatory surface): recurring routines coming due within the horizon via cadence arithmetic, recent open commitments, and open questions - deterministic, every item carries sources.",
    inputSchema: {
      type: "object",
      properties: {
        horizon_days: {
          type: "integer",
          minimum: 1,
          description: "Forward horizon in days (default 14).",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainForesight,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_bridges",
    description:
      "Bridge discovery over the vec index: discover proposes links between embedding-near notes that share no edge (orphan-first, regenerates Brain/proposals/bridges.md, records a metric); accept writes one related wikilink into the source note; dismiss silences a pair; list reads the artifact back.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["discover", "list", "accept", "dismiss"],
          description: "Tool operation.",
        },
        source: { type: "string", description: "Vault-relative source note (accept/dismiss)." },
        target: { type: "string", description: "Vault-relative target note (accept/dismiss)." },
        max: { type: "integer", minimum: 1, description: "Proposal cap (discover)." },
        min_similarity: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 1,
          description: "Cosine similarity threshold (discover, default 0.8).",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainBridges,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_clusters",
    description:
      "Graph-wide community detection: run applies deterministic label propagation over the resolved link graph, materializes one derived note per community of size >= min_size under Brain/clusters/, removes stale generated notes, and records a metric; list reads the generated notes back.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["run", "list"], description: "Tool operation." },
        min_size: {
          type: "integer",
          minimum: 2,
          description: "Smallest community that materializes (run, default 4).",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainClusters,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_moc_audit",
    description:
      "Per-MOC coverage audit. Given a hub note id, classifies its outbound cluster into well-covered / fragile / candidate-missing and surfaces a suggested-next candidate. MOC detection is purely structural (outbound link count + link density). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Hub note id (e.g. `pref-foo`). Wikilink decoration is stripped if present.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainMocAudit,
  },
  {
    name: "brain_deep_synthesis",
    description:
      "Topic-scoped deterministic dossier: matched notes, agreements (positive typed relations), contradictions, stale claims, and knowledge gaps (dangling wikilinks). Evidence assembly only - prose synthesis stays with the caller. Optional triggers=true enqueues findings.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        triggers: {
          type: "boolean",
          description: "Enqueue contradiction/gap findings into the trigger queue.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainDeepSynthesis,
  },
  {
    name: "brain_idea_discovery",
    description:
      "Ranked next-direction candidates from the vault's open loops: unanswered open questions, orphan research notes (no inbound links), and aging unresolved inbox signals. Deterministic scoring; triggers=true enqueues the ranked ideas.",
    inputSchema: {
      type: "object",
      properties: {
        cap: { type: "integer", minimum: 1, maximum: 50 },
        triggers: {
          type: "boolean",
          description: "Enqueue the ranked ideas into the trigger queue.",
        },
      },
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainIdeaDiscovery,
  },
  {
    name: "brain_truth",
    description:
      "Entity claim ledger: ingest a claim, render current-truth slots with superseded history, list contested conflicts (ask_user), aggregate exact-match quantities, report cross-agent collisions.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["ingest", "slots", "conflicts", "aggregate", "collisions"],
          description: "Tool operation.",
        },
        entity: {
          type: "string",
          description: "Entity name (ingest, slots filter, aggregate filter).",
        },
        aspect: { type: "string", description: "Aspect slot for ingest." },
        value: { type: "string", description: "Claim value for ingest." },
        source: { type: "string", description: "Provenance wikilink/path for ingest." },
        agent: { type: "string", description: "Agent identity override for ingest." },
        quantity_value: { type: "number", description: "Numeric value for quantity claims." },
        quantity_unit: { type: "string", description: "Unit token for quantity claims." },
        quantity_action: { type: "string", description: "Measured action for quantity claims." },
        action: { type: "string", description: "Measured action for aggregate." },
        unit: { type: "string", description: "Unit token for aggregate (omit for unitless)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTruth,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_dead_ends",
    description:
      "Negative-knowledge registry (Brain/dead-ends/): record one tried-and-failed approach with why it failed, or list the bounded active set so recall surfaces avoid-X alongside prefer-Y.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["record", "list"],
          description: "Tool operation.",
        },
        approach: { type: "string", description: "What was tried (record)." },
        reason: { type: "string", description: "Why it failed or was set aside (record)." },
        context: { type: "string", description: "Optional context (record)." },
        agent: { type: "string", description: "Agent identity override (record)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainDeadEnds,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
]);

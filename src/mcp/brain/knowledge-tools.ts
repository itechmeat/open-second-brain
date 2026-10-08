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
import { OPERATION } from "../../core/brain/safeguard.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import { createTriggers } from "../../core/brain/triggers/store.ts";
import {
  deepSynthesis,
  synthesisCandidates,
  synthesisFindingsJson,
} from "../../core/brain/deep-synthesis.ts";
import { diarize, DiarizationError } from "../../core/brain/diarization.ts";
import { discoverIdeas, ideaCandidates } from "../../core/brain/idea-discovery.ts";
import { auditMoc, MocAuditError } from "../../core/brain/link-graph/moc-audit.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { everyArtifactRefView } from "../../core/brain/artifact-ref-view.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { recordRefs } from "../../core/brain/log-events-at-reach.ts";
import { normaliseWikilinkTarget } from "../../core/brain/wikilink.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { normalizeEntityName } from "../../core/brain/entities/canonical.ts";
import { listEntities } from "../../core/brain/entities/registry.ts";
import {
  ENTITY_STATUS_SCOPE,
  entityStatusInScope,
} from "../../core/brain/entities/status-scope.ts";
import {
  appendStatedClaims,
  StatedClaimsRefusal,
  type StatedClaim,
} from "../../core/brain/truth/stated-claims.ts";
import { listDeadEnds, recordDeadEnd } from "../../core/brain/dead-ends.ts";
import { buildCodegraphReport } from "../../core/partner/codegraph-report.ts";
import { buildForesight, FORESIGHT_HORIZON_DAYS } from "../../core/brain/temporal/foresight.ts";
import { aggregateQuantities } from "../../core/brain/truth/aggregate.ts";
import { detectAgentCollisions } from "../../core/brain/truth/collision.ts";
import { computeTruthStateWithConflicts } from "../../core/brain/truth/conflicts.ts";
import {
  appendClaimEvent,
  ClaimWindowRefusal,
  readClaimEvents,
} from "../../core/brain/truth/store.ts";
import { claimEventLimit, matchClaimEvents } from "../../core/brain/truth/events-window.ts";
import {
  allClaims,
  buildClaimGraph,
  currentTruth,
  loadClaimGraph,
  rebuildClaimGraph,
  truthAt,
  whatContests,
  whatReplaced,
  type ClaimGraph,
  type ClaimNode,
} from "../../core/brain/claim-graph.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import type { TransportReach } from "../../core/graph/transport-reach.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import {
  AGENT_SCOPE_SCHEMA,
  coerceAgentScope,
  coerceStr,
  coerceBool,
  unknownOperationError,
} from "../coerce.ts";
import { coercePositiveInteger, toolSafeguard, vaultRelativeSafe } from "./shared.ts";
import { readableAtContextReach, readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { resolveTimeBounds } from "./time-bounds.ts";

/**
 * Vault-relative locations these two handlers read BY PATH, rather than
 * through one of the three read roots. Named here because each was
 * spelled twice - once to build the absolute path and once to report the
 * relative one - and the two spellings had to agree for the boundary
 * check below to be asking about the page it was returning.
 */
const BRAIN_CLUSTERS_REL = "Brain/clusters";
const BRAIN_PROPOSALS_REL = "Brain/proposals";
const BRIDGE_PROPOSALS_FILE = "bridges.md";

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
  onProgress?: ProgressSink,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "discover" && op !== "list" && op !== "accept" && op !== "dismiss") {
    throw unknownOperationError("brain_bridges: operation must be discover|list|accept|dismiss");
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
    const rel = join(BRAIN_PROPOSALS_REL, BRIDGE_PROPOSALS_FILE);
    const path = join(ctx.vault, rel);
    // Root closure: this reads a vault page BY PATH without going through
    // one of the three read roots, so it asks the rule here. A reserved
    // proposals page answers exactly as an absent one - the same shape
    // the by-path read primitives hold.
    if (!existsSync(path) || !reachView(ctx.vault, contextReach(ctx)).visible(rel)) {
      return { exists: false, proposals: 0 };
    }
    const [meta] = parseFrontmatter(path);
    return {
      exists: true,
      path: rel,
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
      safeguard: toolSafeguard(ctx, OPERATION.bridges),
      ...(onProgress ? { onProgress } : {}),
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
    // Root closure over what the CALLER is told. Detection stays
    // vault-wide - a bridge proposed from the visible half of a link
    // graph would differ per caller and the proposals are written to one
    // shared artifact - so the walk is unfiltered, the write is
    // unfiltered, and the response is not. A proposal names two pages by
    // path, so one withheld end withholds the proposal WHOLE: a bridge
    // reported with one end missing is not a narrower true finding but a
    // false one. `scanned_candidates` is a corpus size that names nothing
    // and is the same number at every reach, so it stays as measured.
    //
    // `list` reads the artifact this branch just wrote, and asks the rule
    // over the FILE - which is why writing it unfiltered is safe here.
    const view = reachView(ctx.vault, contextReach(ctx));
    return {
      vec_available: report.vecAvailable,
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
      scanned_candidates: report.scannedCandidates,
      proposals: report.proposals.filter((p) => view.row(p.source, p.target)),
      artifact: join(BRAIN_PROPOSALS_REL, BRIDGE_PROPOSALS_FILE),
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
  onProgress?: ProgressSink,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "list") {
    throw unknownOperationError("brain_clusters: operation must be run|list");
  }
  if (op === "list") {
    const dir = join(ctx.vault, BRAIN_CLUSTERS_REL);
    if (!existsSync(dir)) return { clusters: [] };
    // Root closure: a directory listing by path, outside the three read
    // roots, so the rule is asked per page here. A withheld cluster is
    // dropped and nothing counts it - the caller cannot tell this listing
    // from one over a vault that never held the page.
    const view = reachView(ctx.vault, contextReach(ctx));
    const clusters = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .toSorted()
      .map((f) => {
        const rel = join(BRAIN_CLUSTERS_REL, f);
        if (!view.visible(rel)) return null;
        const [meta] = parseFrontmatter(join(dir, f));
        return meta["kind"] === "brain-cluster"
          ? {
              path: rel,
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
  const batchSize = args["batch_size"];
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || (batchSize as number) < 1)) {
    throw new MCPError(INVALID_PARAMS, "brain_clusters run: batch_size must be an integer >= 1");
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
    const communities = detectCommunities(store, {
      ...(minSize !== undefined ? { minSize: minSize as number } : {}),
      safeguard: toolSafeguard(ctx, OPERATION.clusters),
      ...(onProgress ? { onProgress } : {}),
    });
    const materialized = materializeClusterNotes(ctx.vault, communities, {
      store,
      now,
      ...(batchSize !== undefined ? { batchSize: batchSize as number } : {}),
    });
    try {
      appendMetric(ctx.vault, {
        surface: "communities",
        runAt: isoSecond(now),
        payload: {
          communities: communities.length,
          sizes: communities.map((c) => c.size),
          written: materialized.written.length,
          removed: materialized.removed.length,
          ...(materialized.batches
            ? {
                batches: materialized.batches.length,
                failed_batches: materialized.batches.filter((b) => b.error !== undefined).length,
              }
            : {}),
        },
      });
    } catch {
      // Metrics are observability, not correctness.
    }
    // A community is reported by the pages it contains: `members` are
    // vault-relative paths, `id` is derived from the seed page's path,
    // and the materialised `written` note is named after the same seed
    // (a-label-is-not-a-boundary, U3). A community is dropped WHOLE
    // rather than trimmed - its `size` and `density` describe the
    // subgraph the detector measured, so a community of seven reported
    // as four is not a narrower true finding, it is a false one, and the
    // same argument `brain_health` makes about a batch-inflation burst.
    //
    // Detection and materialisation stay vault-wide: clustering the
    // visible half of a link graph would produce different communities
    // for every caller and write them over each other. This filters what
    // the CALLER is told, which is the boundary the gate declares.
    // Both rules, ANDed: a community naming a page EITHER rule withholds
    // is dropped whole. The reserved-token half arrived with the read
    // roots; the argument above for dropping rather than trimming is the
    // same for it, and detection stays vault-wide for the same reason -
    // clustering the visible half of a link graph would produce different
    // communities per caller and write them over each other.
    const view = everyArtifactRefView(
      gatedOwnerScopeView(ctx.vault, ctx.agentName),
      reachView(ctx.vault, contextReach(ctx)),
    );
    const visible = view.keep(communities, (c) => c.members.map((m) => m.path));
    // `written` / `removed` are the cluster NOTES, and a cluster note is
    // named `cluster-<community id>.md` after the seed page - so its own
    // frontmatter carries no owner while its filename spells one. They
    // are therefore filtered by which community they belong to, through
    // the materialiser's own naming rule, not by asking the note file
    // what it owns.
    const visibleNotes = new Set(visible.map((c) => `Brain/clusters/cluster-${c.id}.md`));
    return {
      communities: visible.map((c) => ({
        id: c.id,
        size: c.size,
        density: c.density,
        members: c.members.map((m) => m.path),
      })),
      written: materialized.written.filter((p) => visibleNotes.has(p)),
      // A removal names a community that no longer exists, so there is
      // no surviving membership to ask about. Whenever ANY rule is live
      // the list is withheld whole: it is the one field here whose
      // subject cannot be resolved, and a `removed` entry naming a hidden
      // seed is the same disclosure as a `written` one.
      removed: view.filtersNothing ? materialized.removed : [],
      ...(materialized.batches ? { batches: materialized.batches } : {}),
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
    // `fragile[].id`, `bodyChars` and the exists-vs-missing verdict all
    // describe cluster members; unscoped they described another owner's
    // (a-label-is-not-a-boundary, U3, recon C4).
    const report = auditMoc(ctx.vault, targetId, {
      ownerScope: gatedOwnerScopeView(ctx.vault, ctx.agentName).scope,
      readable: readableAtContextReach(ctx),
    });
    return {
      vault_path: vaultPathField(ctx),
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
  const limit = coercePositiveInteger("brain_deep_synthesis", "limit", args["limit"]) ?? 30;
  if (limit > 100) {
    throw new MCPError(INVALID_PARAMS, "brain_deep_synthesis: limit must be at most 100");
  }
  const enqueue = coerceBool(args, "triggers");
  const now = new Date();
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  const agentScope = coerceAgentScope(ctx, args, false);
  const report = await deepSynthesis(searchConfig, topic, {
    now,
    limit,
    ...(agentScope !== undefined ? { agentScope } : {}),
    transportReach: contextReach(ctx),
  });
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
    strongest_objection: report.strongestObjection
      ? {
          basis: report.strongestObjection.basis,
          statement: report.strongestObjection.statement,
          source_artifacts: report.strongestObjection.sourceArtifacts,
        }
      : null,
    ...synthesisFindingsJson(report),
    ...(triggersCreated !== undefined ? { triggers_created: triggersCreated } : {}),
  };
}

// ----- brain_diarize (subject diarization, t_28ba3fc4) ----------------------

async function toolBrainDiarize(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = coerceStr(args, "entity", true)!;
  const category = coerceStr(args, "category", false);
  try {
    const report = diarize(
      ctx.vault,
      { query, ...(category ? { category } : {}) },
      // The envelope's candidate list names Brain artifact ids, so it is
      // filtered through the same gated view every other report surface
      // here uses - an unscoped list would publish another owner's
      // preference ids as citation targets.
      // A page the caller may not read at its reach is withheld from the
      // candidates exactly as an absent one.
      {
        now: new Date(),
        ownerScope: gatedOwnerScopeView(ctx.vault, ctx.agentName).scope,
        readable: readableAtContextReach(ctx),
      },
    );
    return {
      entity_id: report.entityId,
      entity_name: report.entityName,
      category: report.category,
      generated_at: report.generatedAt,
      document_set: report.documentSet,
      stated_vs_evidenced: report.statedVsEvidenced.map((l) => ({
        kind: l.kind,
        statement: l.statement,
        evidence: l.evidence,
        evidence_frequency: l.evidenceFrequency,
        last_evidenced_at: l.lastEvidencedAt,
      })),
      excluded_line_count: report.excludedLineCount,
      skeleton: report.skeleton,
      llm_step: report.llmStep,
    };
  } catch (err) {
    if (err instanceof DiarizationError) {
      throw new MCPError(INVALID_PARAMS, `brain_diarize: ${err.message}`);
    }
    throw err;
  }
}

// ----- brain_idea_discovery (Workspace Insight Suite) ------------------------

function toolBrainIdeaDiscovery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const cap = coercePositiveInteger("brain_idea_discovery", "cap", args["cap"]) ?? 5;
  if (cap > 50) {
    throw new MCPError(INVALID_PARAMS, "brain_idea_discovery: cap must be at most 50");
  }
  const enqueue = coerceBool(args, "triggers");
  const now = new Date();
  // `source_artifacts` are vault-relative artifact paths and the `reason`
  // sentence spells one out, so an unscoped ranking named another owner's
  // notes (a-label-is-not-a-boundary, U3). Filtered BEFORE the trigger
  // pass so a hidden artifact cannot be enqueued either.
  const view = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  // A page the caller may not read at its reach is left out of the walk
  // itself, before the ranking and the cap, so the list is the one a vault
  // without that page would give.
  const ideas = view.keep(
    discoverIdeas(ctx.vault, { now, cap, include: readableAtContextReach(ctx) }),
    (i) => i.sourceArtifacts,
  );
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
 * quantities, report cross-agent collisions, recall a windowed slice of
 * the ledger via the events operation, and commit grounded agent-stated
 * claims via the state operation with per-claim anchoring verdicts. The
 * read ops are pure folds over the append-only ledger.
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
    op !== "collisions" &&
    op !== "events" &&
    op !== "state"
  ) {
    throw unknownOperationError(
      "brain_truth: operation must be ingest|slots|conflicts|aggregate|collisions|events|state",
    );
  }
  const requireStr = (name: string): string => {
    const value = args[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new MCPError(INVALID_PARAMS, `brain_truth ${op}: ${name} must be a non-empty string`);
    }
    return value;
  };
  // An optional string parameter is either a string or absent; any other
  // type is refused rather than silently ignored - a mistyped bound that
  // read as "no filter" would widen what the caller sees.
  const optionalStr = (name: string): string | undefined => {
    const value = args[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new MCPError(INVALID_PARAMS, `brain_truth ${op}: ${name} must be a string`);
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
    // Declared optional validity fields (design decision 3): explicit
    // input wins outright, bound by bound, over what ingest resolves
    // from the source record's frontmatter; absent fields leave every
    // line byte-identical to the pre-window ledger.
    const validFrom = optionalStr("valid_from");
    const validUntil = optionalStr("valid_until");
    // The source's window resolves at the CALLER's reach: a source page
    // the caller cannot read is treated exactly like an absent one -
    // windowless claim, no validity keys in the response, no signal
    // distinguishing withheld from absent. Without this gate the ingest
    // response would read a withheld page's validity frontmatter back
    // and triple as an existence oracle. (The CLI verb runs at operator
    // reach and passes no gate.)
    const readable = readableAtContextReachOrUndefined(ctx);
    // The store's window refusal is strict by design; here it is a
    // mistyped parameter, so it answers as the same failure class as the
    // sibling mistyped inputs (entity, since/until, limit) - typed
    // INVALID_PARAMS, never an internal error.
    let result;
    try {
      result = appendClaimEvent(
        ctx.vault,
        {
          ts: isoSecond(new Date()),
          agent,
          entity: requireStr("entity"),
          aspect: requireStr("aspect"),
          value: requireStr("value"),
          ...(quantity !== undefined ? { valueKind: "quantity" as const, quantity } : {}),
          ...(validFrom !== undefined ? { validFrom } : {}),
          ...(validUntil !== undefined ? { validUntil } : {}),
          source: requireStr("source"),
        },
        readable !== undefined ? { readableSource: readable } : {},
      );
    } catch (exc) {
      if (exc instanceof ClaimWindowRefusal) {
        throw new MCPError(INVALID_PARAMS, `brain_truth ingest: ${(exc as Error).message}`);
      }
      throw exc;
    }
    return {
      ok: true,
      entity: result.event.entity,
      aspect: result.event.aspect,
      path: result.path,
      ...(result.event.validFrom !== undefined ? { valid_from: result.event.validFrom } : {}),
      ...(result.event.validUntil !== undefined ? { valid_until: result.event.validUntil } : {}),
    };
  }

  // Windowed recall over the ledger (truth-correctable-time-aware,
  // Task 8): the response body is the shared claimEventsReport, so the
  // CLI subcommand answers byte-identically at the same query.
  if (op === "events") {
    const bounds = resolveTimeBounds(optionalStr("since"), optionalStr("until"));
    let limit: number;
    try {
      limit = claimEventLimit(args["limit"]);
    } catch (exc) {
      throw new MCPError(INVALID_PARAMS, `brain_truth events: ${(exc as Error).message}`);
    }
    return claimEventsReport(ctx.vault, ctx.agentName, contextReach(ctx), {
      entity: optionalStr("entity"),
      sinceMs: bounds.sinceMs,
      untilMs: bounds.untilMs,
      limit,
    });
  }

  // Grounded agent-stated claims (truth-correctable-time-aware, Task 8),
  // through lane 1's grounded-claim core: the payload boundary refuses
  // WHOLE calls (unknown relation, missing text, missing source, empty
  // agent, malformed ts) before ANY write, and anchoring verdicts are
  // per claim - the one
  // partial-commit lane in this subsystem, safe because each event is an
  // independent append in an append-only ledger and the response reports
  // exactly what landed.
  if (op === "state") {
    const claims = args["claims"];
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new MCPError(INVALID_PARAMS, "brain_truth state: claims must be a non-empty array");
    }
    const stated = claims.map((raw, index): StatedClaim => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new MCPError(INVALID_PARAMS, `brain_truth state: claims[${index}] must be an object`);
      }
      const claim = raw as Record<string, unknown>;
      // Type-shaped fields only; an empty subject or object is not a
      // refusal here but a per-claim ungrounded verdict downstream.
      const readField = (name: string): string => {
        const value = claim[name];
        if (typeof value !== "string") {
          throw new MCPError(
            INVALID_PARAMS,
            `brain_truth state: claims[${index}].${name} must be a string`,
          );
        }
        return value;
      };
      return {
        subject: readField("subject"),
        relation: readField("relation"),
        object: readField("object"),
      };
    });
    const agentArg = args["agent"];
    if (agentArg !== undefined && typeof agentArg !== "string") {
      throw new MCPError(INVALID_PARAMS, "brain_truth state: agent must be a string");
    }
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    // The source's frontmatter window resolves at the CALLER's reach,
    // exactly as ingest gates it: a withheld source freezes a windowless
    // event and the committed rows carry no validity keys, so the state
    // response reads a withheld page's frontmatter no more than an
    // absent one's.
    const readable = readableAtContextReachOrUndefined(ctx);
    try {
      const outcome = appendStatedClaims(
        ctx.vault,
        {
          claims: stated,
          text: requireStr("text"),
          agent,
          ts: isoSecond(new Date()),
          source: requireStr("source"),
        },
        {
          entities: statedClaimEntities(ctx.vault),
          ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
          ...(readable !== undefined ? { readableSource: readable } : {}),
        },
      );
      return {
        ok: true,
        operation: "state",
        committed: outcome.committed.map((result) => ({ ...result.event })),
        ungrounded: outcome.ungrounded.map(({ claim, reasons }) => ({
          subject: claim.subject,
          relation: claim.relation,
          object: claim.object,
          reasons,
        })),
      };
    } catch (exc) {
      // Both refusal channels are mistyped-input refusals - the payload
      // boundary's, and the store's when the stated claim's window
      // resolves from the source record's frontmatter and inverts there
      // - so both answer as the same failure class the ingest operation
      // maps, never an internal error.
      if (exc instanceof StatedClaimsRefusal || exc instanceof ClaimWindowRefusal) {
        throw new MCPError(INVALID_PARAMS, `brain_truth state: ${exc.message}`);
      }
      throw exc;
    }
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
    throw unknownOperationError("brain_dead_ends: operation must be record|list");
  }
  // A dead-end page the caller cannot read at its reach is treated as
  // absent: `list` leaves it out of the entries and the warnings.
  const readable = readableAtContextReachOrUndefined(ctx);
  if (op === "list") {
    const { entries, warnings } = listDeadEnds(ctx.vault);
    if (readable === undefined) return { entries, warnings };
    const shown = (path: string): boolean => readable(vaultRelativeSafe(ctx.vault, path));
    return {
      entries: entries.filter((entry) => shown(entry.path)),
      warnings: warnings.filter((warning) => shown(warning.path)),
    };
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
    ...(readable !== undefined ? { readable } : {}),
  });
  // The overflow trim walks every active dead end, so below local reach the
  // ids it archived are left out: they would name or count withheld pages.
  // It archives only pages the caller can read; a withheld one stays put.
  return {
    ok: true,
    id: result.entry.id,
    path: result.entry.path,
    ...(readable === undefined ? { archived: result.archived } : {}),
  };
}

// ----- brain_codegraph_report (t_a1e76788) -----------------------------------

/**
 * Read-only codegraph partner report: index status plus structural Cargo
 * workspace membership. Never installs, initializes, extracts, or mutates a
 * partner index or the vault - a missing CLI, missing index, or non-Rust
 * project are honest report states, not errors.
 */
function toolBrainCodegraphReport(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Record<string, unknown> {
  const report = buildCodegraphReport({ cwd: process.cwd(), vault: ctx.vault });
  return report as unknown as Record<string, unknown>;
}

// ----- brain_claims (Belief lifecycle suite, A3) -----------------------------

function renderClaimNode(n: ClaimNode): Record<string, unknown> {
  return {
    id: n.id,
    path: n.path,
    topic: n.topic,
    principle: n.principle,
    valid_from: n.valid_from,
    valid_until: n.valid_until,
    superseded_by: n.superseded_by,
    contradicts: n.contradicts,
    provenance: n.provenance,
    tombstoned: n.tombstoned,
  };
}

const CLAIMS_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Load the persisted claim graph, or build a fresh in-memory one. */
function resolveClaimGraph(vault: string): ClaimGraph {
  return loadClaimGraph(vault) ?? buildClaimGraph(vault);
}

/**
 * Claim-graph query surface: current truth (default), truth at an
 * instant, history, what replaced X, what contests X, or rebuild.
 */
function toolBrainClaims(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", false) ?? "current";
  // A claim row carries the artifact's id, its vault-relative path, its
  // topic AND its full principle text - the sharpest counter-example in
  // recon C6 to the "this bucket is metadata" label. Every row-returning
  // operation is filtered, and so is the rebuild count: a count the
  // caller cannot decompose still says how many claims exist.
  // At the caller's reach a row is asked over every record it names: its
  // page, its id under the pref- and ret- spellings, and the records that
  // superseded or contest it.
  const owner = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  const reach = reachView(ctx.vault, contextReach(ctx));
  const shown = (n: ClaimNode): boolean =>
    owner.row(n.path, n.id) &&
    reach.row(
      n.path,
      ...recordRefs(n.id),
      ...recordRefs(n.superseded_by ?? undefined),
      ...n.contradicts.flatMap((id) => recordRefs(id)),
    );
  const visible = (rows: ReadonlyArray<ClaimNode>): ReadonlyArray<ClaimNode> => rows.filter(shown);
  switch (operation) {
    case "rebuild": {
      const graph = rebuildClaimGraph(ctx.vault);
      return {
        operation,
        rebuilt: true,
        node_count: visible(allClaims(graph)).length,
        truncated: graph.truncated,
      };
    }
    case "replaced": {
      const id = coerceStr(args, "id", true)!;
      const tip = whatReplaced(resolveClaimGraph(ctx.vault), id);
      return { operation, id, tip: tip !== null && shown(tip) ? renderClaimNode(tip) : null };
    }
    case "contests": {
      const id = coerceStr(args, "id", true)!;
      const rows = visible(whatContests(resolveClaimGraph(ctx.vault), id));
      return { operation, id, claims: rows.map(renderClaimNode) };
    }
    case "at": {
      const at = coerceStr(args, "at", true)!;
      const iso = CLAIMS_DATE_ONLY_RE.test(at) ? `${at}T00:00:00Z` : at;
      const probe = Date.parse(iso);
      if (Number.isNaN(probe)) {
        throw new MCPError(
          INVALID_PARAMS,
          `brain_claims: 'at' must be an ISO instant or YYYY-MM-DD date; got ${at}`,
        );
      }
      const rows = visible(truthAt(resolveClaimGraph(ctx.vault), probe));
      return { operation, at, count: rows.length, claims: rows.map(renderClaimNode) };
    }
    case "history": {
      const rows = visible(allClaims(resolveClaimGraph(ctx.vault)));
      return { operation, count: rows.length, claims: rows.map(renderClaimNode) };
    }
    case "current": {
      const rows = visible(currentTruth(resolveClaimGraph(ctx.vault)));
      return { operation, count: rows.length, claims: rows.map(renderClaimNode) };
    }
    default:
      throw unknownOperationError(
        "brain_claims: 'operation' must be one of current, at, history, replaced, contests, rebuild",
      );
  }
}

// ----- brain_truth (Entity Truth & Self-Improving Dream Suite) ---------------

/**
 * The registry slice the stated-claims anchoring consumes: canonical-
 * scope entities only (the anchoring kernel's status discipline,
 * applied where the registry is read), narrowed to AtomicEntityLike.
 * Shared by the MCP `state` operation and the CLI `brain truth state`
 * subcommand so the two surfaces anchor identically.
 */
export function statedClaimEntities(vault: string): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly status: string;
}> {
  return listEntities(vault)
    .filter((entity) => entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical))
    .map(({ id, name, aliases, status }) => ({ id, name, aliases, status }));
}

/**
 * One windowed events query, shared by the MCP `events` operation and
 * the CLI `brain truth events` subcommand so the two surfaces cannot
 * drift on shape, ordering, gating or paging. Bounds arrive already
 * resolved (unix-ms); the page size must already be validated.
 *
 * Windowed recall (truth-correctable-time-aware, Tasks 8-9):
 * `sinceMs`/`untilMs` filter ASSERTION `ts` only; the per-claim
 * validity windows ride on the rows verbatim and are never consulted
 * here (contract item 1 keeps the two temporal vocabularies separate).
 * Every matched row passes the same per-row owner/reach gate
 * `brain_claims` asks, and the account covers ONLY the rows that pass
 * it: a withheld row is dropped and nothing counts it (the views'
 * identical-to-absent convention - a dropped-but-counted row would tell
 * the caller that a claim it may not see exists, and per entity or
 * window would let it measure the hidden population). A filtered answer
 * is therefore byte-identical to the answer over a vault that never
 * held the withheld rows.
 */
export function claimEventsReport(
  vault: string,
  agentName: string | undefined,
  reach: TransportReach,
  query: {
    readonly entity?: string;
    readonly sinceMs: number | null;
    readonly untilMs: number | null;
    readonly limit: number;
  },
): Record<string, unknown> {
  const entityFilter =
    query.entity !== undefined && query.entity.trim() !== "" ? query.entity : undefined;
  const view = everyArtifactRefView(gatedOwnerScopeView(vault, agentName), reachView(vault, reach));
  const matched = matchClaimEvents(readClaimEvents(vault).events, {
    ...(entityFilter !== undefined ? { entity: entityFilter } : {}),
    sinceMs: query.sinceMs,
    untilMs: query.untilMs,
  });
  const gated = view.filtersNothing ? matched : matched.filter((event) => view.row(event.source));
  return {
    ok: true,
    operation: "events",
    entity: entityFilter === undefined ? null : normalizeEntityName(entityFilter),
    events: gated.slice(0, query.limit),
    total: gated.length,
    truncated: gated.length > query.limit,
  };
}

export const KNOWLEDGE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_claims",
    description:
      "Claim-graph query (a projection over superseded_by / contradicts / valid_from / valid_until). operation: current (default) = truth now; at = truth at an instant; history = every claim incl. tombstoned; replaced = what replaced X; contests = what contests X; rebuild = rebuild the projection.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["current", "at", "history", "replaced", "contests", "rebuild"],
          description: "Which claim-graph query to run (default: current).",
        },
        at: {
          type: "string",
          description: "at: ISO-8601 instant or YYYY-MM-DD date to evaluate truth.",
        },
        id: { type: "string", description: "replaced/contests: the claim id/wikilink to resolve." },
      },
      required: [],
      additionalProperties: false,
    },
    handler: toolBrainClaims,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_codegraph_report",
    description:
      "Read-only codegraph partner report: in-scope project, index state + counts, and Cargo.toml workspace members. When indexed, adds a non-blocking graph-health gate (index.health: dangling refs, self-loops, collapsed edges, cache-root mismatch) before labeling/import trust the graph. Never mutates.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolBrainCodegraphReport,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
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
      "Graph-wide community detection: run applies deterministic label propagation, materializes one note per community of size >= min_size under Brain/clusters/, removes stale notes, records a metric; list reads them back. Optional batch_size chunks work with isolated, reported per-batch failures.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["run", "list"], description: "Tool operation." },
        min_size: {
          type: "integer",
          minimum: 2,
          description: "Smallest community that materializes (run, default 4).",
        },
        batch_size: {
          type: "integer",
          minimum: 1,
          description:
            "Materialize communities in chunks of this size (run); each batch is isolated and reported in the batches array. Default: single pass.",
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
      "Topic-scoped deterministic dossier: matched notes, agreements, contradictions, stale claims, knowledge gaps (dangling wikilinks), plus per-finding causal context, decomposed confidence, and a visible evidence-loss ledger. Evidence assembly only. triggers=true enqueues findings.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Subject the dossier is built around; matched notes are recalled for it.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "How many matched notes feed the synthesis. Default 30.",
        },
        triggers: {
          type: "boolean",
          description: "Enqueue contradiction/gap findings into the trigger queue.",
        },
        agent_scope: AGENT_SCOPE_SCHEMA,
      },
      required: ["topic"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainDeepSynthesis,
  },
  {
    name: "brain_diarize",
    description:
      "Subject profile for a registry entity: assembles its document set from the registry and sources, computes a deterministic stated-vs-evidenced gap (claims vs evidence frequency and recency), and emits a profile skeleton plus one needs-llm-step envelope. Read-only. Unknown entity errors.",
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Entity name or alias to profile.",
        },
        category: {
          type: "string",
          description: "Optional category to disambiguate the entity lookup.",
        },
      },
      required: ["entity"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainDiarize,
  },
  {
    name: "brain_idea_discovery",
    description:
      "Ranked next-direction candidates from the vault's open loops: unanswered open questions, orphan research notes (no inbound links), and aging unresolved inbox signals. Deterministic scoring; triggers=true enqueues the ranked ideas.",
    inputSchema: {
      type: "object",
      properties: {
        cap: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many ranked ideas to return. Default 5.",
        },
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
      "Entity claim ledger: ingest a claim, render current-truth slots, list conflicts, aggregate quantities, report collisions, window recall via the events operation, or commit grounded agent-stated claims via the state operation with per-claim anchoring verdicts.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["ingest", "slots", "conflicts", "aggregate", "collisions", "events", "state"],
          description: "Tool operation.",
        },
        entity: {
          type: "string",
          description: "Entity name (ingest, slots filter, aggregate filter, events filter).",
        },
        aspect: { type: "string", description: "Aspect slot for ingest." },
        value: { type: "string", description: "Claim value for ingest." },
        source: { type: "string", description: "Provenance wikilink/path for ingest and state." },
        agent: { type: "string", description: "Agent identity override for ingest and state." },
        quantity_value: { type: "number", description: "Numeric value for quantity claims." },
        quantity_unit: { type: "string", description: "Unit token for quantity claims." },
        quantity_action: { type: "string", description: "Measured action for quantity claims." },
        valid_from: {
          type: "string",
          description:
            "ingest: validity window start (bare ISO date or canonical UTC timestamp); wins over the source frontmatter's valid_from.",
        },
        valid_until: {
          type: "string",
          description:
            "ingest: exclusive validity window end (bare ISO date or canonical UTC timestamp); wins over the source frontmatter's valid_until.",
        },
        action: { type: "string", description: "Measured action for aggregate." },
        unit: { type: "string", description: "Unit token for aggregate (omit for unitless)." },
        since: {
          type: "string",
          description:
            "events: inclusive lower bound on the events' assertion ts (ISO date/datetime, today/yesterday, last week/month, <n>h/<n>d/<n>w). Never a validity filter.",
        },
        until: {
          type: "string",
          description:
            "events: inclusive upper bound on the events' assertion ts, same grammar as since. Never a validity filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "events: page size (default 200, capped at 1000); rows are ascending assertion ts, so tail-following paginates by advancing since.",
        },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: { type: "string", description: "Entity the claim is about." },
              relation: {
                type: "string",
                description:
                  "Relation-vocabulary token between subject and object (related, extends, depends_on, refines, contradicts, superseded_by).",
              },
              object: { type: "string", description: "Entity the claim points at." },
            },
            required: ["subject", "relation", "object"],
            additionalProperties: false,
          },
          description:
            "state: the agent-stated claims to ground; each commits only when its subject and object anchor in text.",
        },
        text: {
          type: "string",
          description: "state: the assertion text every claim is anchored against.",
        },
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

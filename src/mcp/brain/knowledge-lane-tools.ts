/**
 * The lane and synthesis tools of the knowledge family (task 3.19):
 * foresight, bridges, clusters, the MOC audit, deep synthesis,
 * diarization and idea discovery, each reading its lane pages through
 * the visibility rule the caller holds. Split from `knowledge-tools.ts`;
 * registration happens through that module's registry, which preserves
 * the public KNOWLEDGE_TOOLS surface.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveTriggerCooldownDays } from "../../core/config.ts";
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
import { normaliseWikilinkTarget } from "../../core/brain/wikilink.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { laneVault } from "./lane-vault.ts";
import { buildForesight, FORESIGHT_HORIZON_DAYS } from "../../core/brain/temporal/foresight.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import type { ServerContext } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { coerceAgentScope, coerceStr, coerceBool, unknownOperationError } from "../coerce.ts";
import { coercePositiveInteger, toolSafeguard } from "./shared.ts";
import {
  lanePageExists,
  lanePagesInStore,
  listLaneFiles,
  parseLanePage,
} from "../../core/store/lane-pages.ts";
import { readableAtContextReach } from "./reach-readable.ts";

/**
 * Who may see a lane page by its vault-relative path: the reach view of
 * the vault's files on an unswitched machine, the store-aware predicate
 * (the page's record fields) once switched or with no vault.
 */
export function laneVisible(ctx: ServerContext, vault: string): (rel: string) => boolean {
  if (lanePagesInStore(vault)) return readableAtContextReach(ctx);
  const view = reachView(vault, contextReach(ctx));
  return (rel) => view.visible(rel);
}

/**
 * Vault-relative locations these two handlers read BY PATH, rather than
 * through one of the three read roots. Named here because each was
 * spelled twice - once to build the absolute path and once to report the
 * relative one - and the two spellings had to agree for the boundary
 * check below to be asking about the page it was returning.
 */
export const BRAIN_CLUSTERS_REL = "Brain/clusters";
export const BRAIN_PROPOSALS_REL = "Brain/proposals";
export const BRIDGE_PROPOSALS_FILE = "bridges.md";

/** Forward-looking projection envelope; read-only fold. */
export function toolBrainForesight(
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
  // A private continuity record is withheld below local reach, the same
  // withholding flag every other report fold here takes: its text is the
  // item title and its refs the sources, so an unfiltered fold would read
  // the private partition back to a remote caller.
  return {
    ...buildForesight(ctx.vault, {
      now: new Date(),
      horizonDays,
      withholdsPrivate: contextReach(ctx) !== TRANSPORT_REACH.local,
    }),
  };
}

// ----- brain_labels (t_7a41f42d) ---------------------------------------------

/**
 * Bridge discovery over the vec index: discover regenerates the
 * reviewable proposals artifact, accept writes one related wikilink,
 * dismiss persists a pair suppression, list reads the artifact back.
 */
export async function toolBrainBridges(
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
    const vault = laneVault(ctx);
    const rel = join(BRAIN_PROPOSALS_REL, BRIDGE_PROPOSALS_FILE);
    const path = join(vault, rel);
    // Root closure: this reads a vault page BY PATH without going through
    // one of the three read roots, so it asks the rule here. A reserved
    // proposals page answers exactly as an absent one - the same shape
    // the by-path read primitives hold. A lane page (a store record once
    // switched) is read through the lane page store.
    if (!lanePageExists(vault, path) || !laneVisible(ctx, vault)(rel)) {
      return { exists: false, proposals: 0 };
    }
    const [meta] = parseLanePage(vault, path);
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
export async function toolBrainClusters(
  ctx: ServerContext,
  args: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "list") {
    throw unknownOperationError("brain_clusters: operation must be run|list");
  }
  if (op === "list") {
    const vault = laneVault(ctx);
    const dir = join(vault, BRAIN_CLUSTERS_REL);
    if (!lanePageExists(vault, dir)) return { clusters: [] };
    // Root closure: a directory listing by path, outside the three read
    // roots, so the rule is asked per page here. A withheld cluster is
    // dropped and nothing counts it - the caller cannot tell this listing
    // from one over a vault that never held the page.
    const visible = laneVisible(ctx, vault);
    const clusters = listLaneFiles(vault, dir)
      .map((f) => {
        const rel = join(BRAIN_CLUSTERS_REL, f);
        if (!visible(rel)) return null;
        const [meta] = parseLanePage(vault, join(dir, f));
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
      // The batches are withheld whole whenever ANY rule is live - the
      // same rule the top-level `removed` follows. A batch's very
      // EXISTENCE is the disclosure: rebuilding them over the visible
      // communities would still count hidden ones through the offsets
      // and the renumbered indexes (with `batch_size: 2` and the order
      // visible, hidden, visible, hidden, two batches would appear where
      // an unrestricted vault shows one), and a raw `error` names a
      // `cluster-<community id>.md` file - the hidden seed's path.
      ...(materialized.batches ? { batches: view.filtersNothing ? materialized.batches : [] } : {}),
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
export async function toolBrainMocAudit(
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
      withholdsPrivate: contextReach(ctx) !== TRANSPORT_REACH.local,
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

export async function toolBrainDeepSynthesis(
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

export async function toolBrainDiarize(
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

export function toolBrainIdeaDiscovery(
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
    discoverIdeas(ctx.vault, {
      now,
      cap,
      include: readableAtContextReach(ctx),
      withholdsPrivate: contextReach(ctx) !== TRANSPORT_REACH.local,
    }),
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

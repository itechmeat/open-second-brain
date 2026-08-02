/**
 * Procedural memory: skill proposals, procedural reconcile, recurrence diagnostics, and the procedural graph.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { join } from "node:path";
import {
  acceptSkillProposal,
  discardUnreadableSkillAcceptJournals,
  learnSkillProposals,
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  rejectSkillProposal,
  resolveSkillProposalEvidence,
  type SkillContractInput,
} from "../../core/brain/skill-proposals.ts";
import { deriveSkillUsage } from "../../core/brain/skill-usage.ts";
import {
  listProceduralMemory,
  markProceduralMemoryUsed,
  recordProceduralOutcome,
  rankProceduralMemory,
  reconcileProceduralMemory,
} from "../../core/brain/procedural-memory.ts";
import { readProceduralGraph, rebuildProceduralGraph } from "../../core/brain/procedural-graph.ts";
import { readProceduralHints, rebuildProceduralHints } from "../../core/brain/procedural-hints.ts";
import {
  applyRecurrenceEvidence,
  getRecurrenceEntry,
  listRecurrenceEntries,
  purgeRecurrenceSource,
} from "../../core/brain/recurrence.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceStrList } from "../coerce.ts";
import { coercePositiveInteger, optionalStringArg, requiredStringArg } from "./shared.ts";

async function toolBrainSkillProposals(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_skill_proposals", args, "operation");
  if (operation === "learn") {
    const minSupport = coercePositiveInteger(
      "brain_skill_proposals",
      "min_support",
      args["min_support"],
    );
    const result =
      minSupport !== undefined
        ? learnSkillProposals(ctx.vault, { minSupport })
        : learnSkillProposals(ctx.vault);
    return { ...result };
  }
  if (operation === "list") {
    const proposals = listPendingSkillProposals(ctx.vault);
    return { total: proposals.length, proposals };
  }
  if (operation === "accept") {
    const slug = requiredStringArg("brain_skill_proposals", args, "slug");
    const note = optionalStringArg("brain_skill_proposals", args, "note");
    const contract = readSkillContract(args);
    const reviewed = acceptSkillProposal(ctx.vault, slug, {
      ...(note ? { note } : {}),
      ...(contract ? { contract } : {}),
    });
    return { ...reviewed };
  }
  if (operation === "evidence") {
    const slug = requiredStringArg("brain_skill_proposals", args, "slug");
    return { ...resolveSkillProposalEvidence(ctx.vault, slug) };
  }
  if (operation === "reject") {
    const slug = requiredStringArg("brain_skill_proposals", args, "slug");
    const note = requiredStringArg("brain_skill_proposals", args, "note");
    const reviewed = rejectSkillProposal(ctx.vault, slug, { note });
    return { ...reviewed };
  }
  if (operation === "recover") {
    // The accept sequence's write-ahead journal was recoverable in the
    // library and reachable from no tool, so an agent whose accept
    // crashed had nothing to call. Both refusals it can raise carry the
    // file and the exit in their message; they surface as errors here
    // rather than as a result field, because neither is a state this
    // operation completed.
    const discarded =
      args["discard_unreadable"] === true ? discardUnreadableSkillAcceptJournals(ctx.vault) : [];
    const recovered = recoverSkillProposalAccepts(ctx.vault);
    return { discarded, recovered, total: recovered.length };
  }
  if (operation === "usage") {
    // Per-skill invocation telemetry (t_56a12bde): deterministic counts
    // derived from skill_invoked continuity records, distinct from proposing
    // or ranking. Real usage evidence for the dream/synthesis pass.
    // Each row also carries `offerAttributedCount` (t_ccb05134) - how many of
    // those invocations cited the offer they came from. The command-line
    // surface prints the same figure as `from_offer=`. The remainder are not
    // unattributed-by-error: most runtimes' skill calls follow no offer.
    const usage = deriveSkillUsage(ctx.vault);
    return { total: usage.length, usage };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_skill_proposals: operation must be one of learn|list|accept|reject|recover|usage|evidence",
  );
}

/**
 * Read the optional execution contract from an accept payload. Returns
 * undefined when the caller supplied none, so the accept path stays
 * byte-identical to a pre-contract acceptance.
 */
function readSkillContract(args: Record<string, unknown>): SkillContractInput | undefined {
  const prerequisites = coerceStrList(args, "prerequisites");
  const rollback = coerceStrList(args, "rollback");
  const sideEffects = coerceStrList(args, "side_effects");
  const verification = coerceStrList(args, "verification");
  if (
    prerequisites.length === 0 &&
    rollback.length === 0 &&
    sideEffects.length === 0 &&
    verification.length === 0
  ) {
    return undefined;
  }
  return { prerequisites, rollback, sideEffects, verification };
}

async function toolBrainProceduralMemory(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_procedural_memory", args, "operation");
  if (operation === "reconcile") {
    const roots = coerceStrList(args, "roots");
    const effectiveRoots =
      roots.length > 0
        ? roots
        : [
            join(ctx.vault, "Brain", "procedures"),
            join(ctx.vault, "skills"),
            join(ctx.vault, "runbooks"),
          ];
    return {
      ...reconcileProceduralMemory(ctx.vault, { roots: effectiveRoots }),
    };
  }
  if (operation === "list") {
    const entries = listProceduralMemory(ctx.vault);
    // Opt-in success-rate ranking (t_703f7b18); default order unchanged.
    const ordered = args["ranked"] === true ? rankProceduralMemory(entries) : entries;
    return { total: ordered.length, entries: ordered };
  }
  if (operation === "mark_used") {
    const id = requiredStringArg("brain_procedural_memory", args, "id");
    const updated = markProceduralMemoryUsed(ctx.vault, id);
    if (!updated) {
      throw new MCPError(INVALID_PARAMS, `brain_procedural_memory: unknown entry id: ${id}`);
    }
    return { ...updated };
  }
  if (operation === "mark_outcome") {
    const id = requiredStringArg("brain_procedural_memory", args, "id");
    const outcome = requiredStringArg("brain_procedural_memory", args, "outcome");
    if (outcome !== "success" && outcome !== "failure") {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_procedural_memory: outcome must be 'success' or 'failure'",
      );
    }
    const updated = recordProceduralOutcome(ctx.vault, id, outcome);
    if (!updated) {
      throw new MCPError(INVALID_PARAMS, `brain_procedural_memory: unknown entry id: ${id}`);
    }
    return { ...updated };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_procedural_memory: operation must be one of reconcile|list|mark_used|mark_outcome",
  );
}

async function toolBrainRecurrence(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_recurrence", args, "operation");
  if (operation === "list") {
    const entries = listRecurrenceEntries(ctx.vault);
    return { total: entries.length, entries };
  }
  if (operation === "show") {
    const contentHash = requiredStringArg("brain_recurrence", args, "content_hash");
    const entry = getRecurrenceEntry(ctx.vault, contentHash);
    if (!entry) {
      throw new MCPError(INVALID_PARAMS, `brain_recurrence: unknown content hash: ${contentHash}`);
    }
    return { ...entry };
  }
  if (operation === "learn" || operation === "forget") {
    const contentHash = requiredStringArg("brain_recurrence", args, "content_hash");
    const scope = requiredStringArg("brain_recurrence", args, "scope");
    const sourceId = requiredStringArg("brain_recurrence", args, "source_id");
    const entry = applyRecurrenceEvidence(ctx.vault, {
      contentHash,
      scope,
      sourceId,
      action: operation,
    });
    return { operation, entry };
  }
  if (operation === "purge_source") {
    const sourceId = requiredStringArg("brain_recurrence", args, "source_id");
    purgeRecurrenceSource(ctx.vault, sourceId);
    return { ok: true, source_id: sourceId };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_recurrence: operation must be one of list|show|learn|forget|purge_source",
  );
}

async function toolBrainProceduralGraph(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_procedural_graph", args, "operation");
  if (operation === "rebuild") {
    const graph = rebuildProceduralGraph(ctx.vault);
    const hints = rebuildProceduralHints(ctx.vault, { graph });
    return {
      operation,
      graph: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        generated_at: graph.generated_at,
      },
      hints: {
        entries: hints.entries.length,
        generated_at: hints.generated_at,
      },
    };
  }
  if (operation === "show") {
    const graph = readProceduralGraph(ctx.vault);
    if (!graph) {
      throw new MCPError(INVALID_PARAMS, "brain_procedural_graph: graph projection not found");
    }
    return { ...graph };
  }
  if (operation === "hints") {
    const hints = readProceduralHints(ctx.vault);
    if (!hints) {
      throw new MCPError(INVALID_PARAMS, "brain_procedural_graph: hints projection not found");
    }
    return { ...hints };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_procedural_graph: operation must be one of rebuild|show|hints",
  );
}

export const PROCEDURE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_skill_proposals",
    description:
      "Deterministic skill proposals from continuity records: learn, list, accept, reject; resolve abandoned accept sequences (recover); read per-skill invocation and offer-attribution counts (usage); resolve a proposal's self-reported support against the recorded procedural outcome ledger (evidence).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["learn", "list", "accept", "reject", "recover", "usage", "evidence"],
          description: "Tool operation.",
        },
        discard_unreadable: {
          type: "boolean",
          description:
            "recover only: delete accept-journal markers that cannot be parsed. Off by default: removing one unblocks accepting without resolving the sequence it marked.",
        },
        min_support: {
          type: "integer",
          minimum: 1,
          description: "Optional minimum evidence support for learn.",
        },
        slug: {
          type: "string",
          description: "Proposal slug for accept/reject/evidence.",
        },
        note: {
          type: "string",
          description: "Optional review note; required for reject.",
        },
        prerequisites: {
          type: "array",
          items: { type: "string" },
          description: "accept only: conditions that must hold before the procedure runs.",
        },
        rollback: {
          type: "array",
          items: { type: "string" },
          description: "accept only: steps that undo the procedure.",
        },
        side_effects: {
          type: "array",
          items: { type: "string" },
          description: "accept only: state the procedure changes outside its own output.",
        },
        verification: {
          type: "array",
          items: { type: "string" },
          description: "accept only: checks that confirm the procedure worked.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainSkillProposals,
  },
  {
    name: "brain_procedural_memory",
    description:
      "Reconcile/list procedural memory and update the usage + outcome sidecar (reconcile, list, mark_used, mark_outcome). list accepts ranked:true to order by validated success rate.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["reconcile", "list", "mark_used", "mark_outcome"],
          description: "Tool operation.",
        },
        roots: {
          type: "array",
          items: { type: "string" },
          description: "Optional root directories for reconcile.",
        },
        id: {
          type: "string",
          description: "Procedural entry id for mark_used / mark_outcome.",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description: "Host-reported result for mark_outcome.",
        },
        ranked: {
          type: "boolean",
          description: "list only: order entries by validated success rate.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainProceduralMemory,
  },
  {
    name: "brain_recurrence",
    description:
      "Inspect and update recurrence/support diagnostics (list, show, learn, forget, purge_source).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "show", "learn", "forget", "purge_source"],
          description: "Tool operation.",
        },
        content_hash: {
          type: "string",
          description: "Content hash for show/learn/forget.",
        },
        scope: {
          type: "string",
          description: "Scope for learn/forget.",
        },
        source_id: {
          type: "string",
          description: "Source id for learn/forget/purge_source.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainRecurrence,
  },
  {
    name: "brain_procedural_graph",
    description:
      "Rebuild/show procedural graph projection and prospective hint projection (rebuild, show, hints).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["rebuild", "show", "hints"],
          description: "Tool operation.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainProceduralGraph,
  },
]);

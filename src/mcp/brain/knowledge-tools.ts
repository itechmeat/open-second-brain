/**
 * Knowledge graph: foresight, bridge discovery, community clusters, MOC audit, deep synthesis, idea discovery, the claim ledger, and dead ends.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import type { ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { AGENT_SCOPE_SCHEMA } from "../coerce.ts";
import { toolBrainClaims } from "./knowledge-claim-tools.ts";
import {
  toolBrainCodegraphReport,
  toolBrainDeadEnds,
  toolBrainTruth,
} from "./knowledge-truth-tools.ts";
import {
  toolBrainBridges,
  toolBrainClusters,
  toolBrainDeepSynthesis,
  toolBrainDiarize,
  toolBrainForesight,
  toolBrainIdeaDiscovery,
  toolBrainMocAudit,
} from "./knowledge-lane-tools.ts";

export { statedClaimEntities, claimEventsReport } from "./knowledge-claim-tools.ts";

export const KNOWLEDGE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_claims",
    kind: "write",
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
    kind: "read",
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
    kind: "read",
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
    kind: "write",
    description:
      "Bridge discovery over the vec index: discover proposes links between embedding-near notes that share no edge (orphan-first, regenerates the bridge proposals page, records a metric); accept writes one related wikilink into the source note; dismiss silences a pair; list reads the artifact back.",
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
    kind: "write",
    description:
      "Graph-wide community detection: run applies deterministic label propagation, materializes one note per community of size >= min_size, removes stale notes, records a metric; list reads them back. Optional batch_size chunks work with isolated, reported per-batch failures.",
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
    kind: "read",
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
    kind: "write",
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
    kind: "read",
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
    kind: "write",
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
    kind: "write",
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
        sample_id: {
          type: "string",
          description:
            "state: the quality-sample id (a context receipt id or opaque hash) these claims were stated against; frozen per claim, reads hydrate it into provenance.",
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
    kind: "write",
    description:
      "Negative-knowledge registry (dead-ends): record one tried-and-failed approach with why it failed, or list the bounded active set so recall surfaces avoid-X alongside prefer-Y.",
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

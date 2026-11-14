/**
 * Source-ingest tool (Knowledge Provenance suite).
 *
 * The calling agent reads a text-bearing source, extracts its entities and
 * relations, and writes a summary; it submits all of that here. OSB runs no
 * model - it routes the extraction through the shared intake primitive and
 * writes a per-source summary page that backlinks the source, lists the
 * entities it introduced, and lists its connections to pre-existing material.
 * Idempotent on the source path.
 */

import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { type ToolDefinition } from "../tool-contract.ts";
import {
  BATCH_PLAN_TOOL,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_BATCH_FILES,
  DELETE_TOOL,
  SEARCH_TOOL,
  TOOL,
  toolBrainDeleteBySource,
  toolBrainIngestSource,
  toolBrainSearchBySource,
} from "./ingest-source-tools.ts";
import { toolBrainIngestBatchPlan } from "./ingest-batch-tools.ts";

export { serializeBatchPlan } from "./ingest-batch-tools.ts";

export const INGEST_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    kind: "write",
    description:
      "Ingest one text-bearing source into the brain. Supply `source_path` (vault path or URL), a `summary`, the extracted `entities`, and optional `relations`. OSB creates/updates entity pages and a per-source summary page that backlinks the source and lists its connections. Idempotent; no model, no OCR.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description: "Source identity: a vault-relative path or a URL.",
        },
        summary: {
          type: "string",
          description: "Agent-written summary prose for the source.",
        },
        entities: {
          type: "array",
          description: "Entities extracted from the source (non-empty).",
          items: {
            type: "object",
            properties: {
              category: { type: "string", description: "Entity category slug." },
              name: { type: "string", description: "Canonical display name." },
              aliases: {
                type: "array",
                items: { type: "string" },
                description: "Optional alternate names.",
              },
              confidence: {
                type: "string",
                description: "Optional confidence label passed through verbatim.",
              },
            },
            required: ["category", "name"],
            additionalProperties: false,
          },
        },
        relations: {
          type: "array",
          description: "Optional typed relations between extracted entities.",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source entity name." },
              from_category: { type: "string", description: "Optional source category." },
              relation: {
                type: "string",
                description: "Relation token from the relation vocabulary (e.g. `related`).",
              },
              to: { type: "string", description: "Target entity name." },
              to_category: { type: "string", description: "Optional target category." },
            },
            required: ["from", "relation", "to"],
            additionalProperties: false,
          },
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
        plan_id: {
          type: "string",
          description:
            "Optional batch-plan id (from brain_ingest_batch_plan). When set, a successful ingest records this source into that plan's resume checkpoint.",
        },
        pre_extract: {
          type: "boolean",
          description:
            "No-LLM code-structure pass under `pre_extract`: class/function and Terraform block seeds; import/inheritance/uses/depends_on/references edges. Off by default.",
        },
      },
      required: ["source_path", "summary", "entities"],
      additionalProperties: false,
    },
    handler: toolBrainIngestSource,
  },
  {
    name: SEARCH_TOOL,
    kind: "read",
    description:
      "Find every Brain page derived from one EXACT source file (`source_file`: a vault path or URL): the ingest summary page, session-derived signals, `[[source]]` provenance wikilinks, and preferences folded from those signals. Read-only; each entry flags deletable vs protected mention.",
    inputSchema: {
      type: "object",
      properties: {
        source_file: {
          type: "string",
          description: "Exact source identity to trace: a vault-relative path or a URL.",
        },
        agent_scope: {
          type: "string",
          description:
            "Optional owner scope: a derived page declaring an `owner:` is returned only to its own scope; ownerless pages always match. Absent = no filtering.",
        },
      },
      required: ["source_file"],
      additionalProperties: false,
    },
    handler: toolBrainSearchBySource,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: DELETE_TOOL,
    kind: "write",
    description:
      "Remove everything derived from one EXACT source file. DRY-RUN BY DEFAULT: no `confirm` reports the blast radius, deletes nothing. `confirm` deletes derived entries + ingest index artifacts (shared/aggregate pages only reported); the original source files only with `include_originals`. Auditable.",
    inputSchema: {
      type: "object",
      properties: {
        source_file: {
          type: "string",
          description: "Exact source identity to purge: a vault-relative path or a URL.",
        },
        confirm: {
          type: "boolean",
          description: "Required true to actually delete; absent/false is a dry run.",
        },
        include_originals: {
          type: "boolean",
          description:
            "Also remove the original source file(s) the entries were derived from. Default false.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity recorded in the audit reason.",
        },
        expect: {
          type: "integer",
          minimum: 0,
          description:
            "Count guard: assert the blast radius equals N. On mismatch the op aborts without deleting and returns the matched list.",
        },
        strict: {
          type: "boolean",
          description: "Refuse a confirmed deletion that carries no `expect` guard. Default false.",
        },
      },
      required: ["source_file"],
      additionalProperties: false,
    },
    handler: toolBrainDeleteBySource,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: BATCH_PLAN_TOOL,
    kind: "write",
    description:
      "Plan a folder ingest into bounded parallel batches. Walks `source_dir` for ingestible files, skips unchanged ones via the content-hash manifest, and packs the new/modified remainder into batches bounded by `max_batch_bytes`/`max_batch_files`. Read-only; the caller dispatches each batch.",
    inputSchema: {
      type: "object",
      properties: {
        source_dir: {
          type: "string",
          description: "Vault-relative directory to plan ingest over.",
        },
        max_batch_bytes: {
          type: "integer",
          minimum: 1,
          description: `Byte cap per batch. Default ${DEFAULT_MAX_BATCH_BYTES}.`,
        },
        max_batch_files: {
          type: "integer",
          minimum: 1,
          description: `File-count cap per batch. Default ${DEFAULT_MAX_BATCH_FILES}.`,
        },
        resume: {
          type: "boolean",
          description:
            "Resume an interrupted plan: exclude items already recorded completed in this plan's checkpoint. Default false.",
        },
        reconcile: {
          type: "boolean",
          description:
            "Also return a `reconcile` gap report diffing the plan's dispatched sources against the checkpoint's ingested set. Read-only; no retry. Default false.",
        },
        src_subpath: {
          type: "string",
          description:
            "Scope discovery to a subtree of source_dir (e.g. pkg/a). Narrows only: escaping source_dir or entering a submodule errors; an ignored subtree plans nothing.",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description:
            "Gitignore-style patterns (relative to source_dir) whose matches are dropped from discovery. Same engine as the hygiene scan.",
        },
      },
      required: ["source_dir"],
      additionalProperties: false,
    },
    handler: toolBrainIngestBatchPlan,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
]);

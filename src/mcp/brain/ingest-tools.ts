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

import { ingestSource } from "../../core/brain/ingest/ingest.ts";
import { IntakeValidationError } from "../../core/brain/intake/extract-intake.ts";
import {
  deleteBySource,
  searchBySourceFile,
  type SourceCleanupEntry,
  type SourceCleanupPlan,
} from "../../core/brain/source-cleanup.ts";
import { resolveAgentName } from "../../core/config.ts";
import { coerceBoolOptional, coerceStr } from "../coerce.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { parseExtractionIntakeArgs } from "./intake-args.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_ingest_source";
const SEARCH_TOOL = "brain_search_by_source";
const DELETE_TOOL = "brain_delete_by_source";

async function toolBrainIngestSource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourcePath = coerceStr(args, "source_path", true)!;
  const summary = coerceStr(args, "summary", true)!;
  const parsed = parseExtractionIntakeArgs(args, TOOL);
  const agent =
    parsed.agent && parsed.agent.trim().length > 0
      ? parsed.agent
      : resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, [IntakeValidationError], async () => {
    const res = ingestSource(
      ctx.vault,
      { sourcePath, summary, extraction: parsed.intake },
      { agent, now: new Date() },
    );
    return {
      summary_path: res.summaryPath,
      created: res.created,
      entities_created: [...res.entitiesCreated],
      entities_updated: [...res.entitiesUpdated],
      connections: [...res.connections],
    };
  });
}

function serializeEntry(entry: SourceCleanupEntry): Record<string, unknown> {
  return {
    path: entry.path,
    id: entry.id,
    kind: entry.kind,
    match: entry.match,
    is_index_artifact: entry.isIndexArtifact,
    deletable: entry.deletable,
  };
}

function serializePlan(plan: SourceCleanupPlan): Record<string, unknown> {
  return {
    source: plan.source,
    confirmed: plan.confirmed,
    include_originals: plan.includeOriginals,
    blast_radius: plan.blastRadius,
    derived: plan.derived.map(serializeEntry),
    mentions: plan.mentions.map(serializeEntry),
    originals: [...plan.originals],
    manifest_entry: plan.manifestEntry,
    deleted: [...plan.deleted],
    manifest_entry_removed: plan.manifestEntryRemoved,
    audit_record_id: plan.auditRecordId,
  };
}

async function toolBrainSearchBySource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourceFile = coerceStr(args, "source_file", true)!;
  const hits = searchBySourceFile(ctx.vault, sourceFile);
  return {
    source_file: sourceFile,
    total: hits.length,
    entries: hits.map(serializeEntry),
  };
}

async function toolBrainDeleteBySource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourceFile = coerceStr(args, "source_file", true)!;
  const confirm = coerceBoolOptional(args, "confirm") ?? false;
  const includeOriginals = coerceBoolOptional(args, "include_originals") ?? false;
  const agent = coerceStr(args, "agent", false) ?? undefined;
  const plan = deleteBySource(ctx.vault, sourceFile, {
    confirm,
    includeOriginals,
    now: new Date(),
    ...(agent !== undefined ? { agent } : {}),
  });
  return serializePlan(plan);
}

export const INGEST_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
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
              aliases: { type: "array", items: { type: "string" } },
              confidence: { type: "string" },
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
              from: { type: "string" },
              from_category: { type: "string" },
              relation: { type: "string" },
              to: { type: "string" },
              to_category: { type: "string" },
            },
            required: ["from", "relation", "to"],
            additionalProperties: false,
          },
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["source_path", "summary", "entities"],
      additionalProperties: false,
    },
    handler: toolBrainIngestSource,
  },
  {
    name: SEARCH_TOOL,
    description:
      "Find every Brain page derived from one EXACT source file (`source_file`: a vault path or URL): the ingest summary page, session-derived signals, `[[source]]` provenance wikilinks, and preferences folded from those signals. Read-only; each entry flags deletable vs protected mention.",
    inputSchema: {
      type: "object",
      properties: {
        source_file: {
          type: "string",
          description: "Exact source identity to trace: a vault-relative path or a URL.",
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
    description:
      "Remove everything derived from one EXACT source file. DRY-RUN BY DEFAULT: no `confirm` reports the blast radius, deletes nothing. `confirm` deletes derived entries + ingest index artifacts (shared/aggregate pages only reported); originals outside Brain/ only with `include_originals`. Auditable.",
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
          description: "Also remove the original source file(s) outside Brain/. Default false.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity recorded in the audit reason.",
        },
      },
      required: ["source_file"],
      additionalProperties: false,
    },
    handler: toolBrainDeleteBySource,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
]);

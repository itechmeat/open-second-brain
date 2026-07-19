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

import { planBatches, type BatchPlan } from "../../core/brain/ingest/batch-plan.ts";
import { clearCheckpoint } from "../../core/brain/ingest/checkpoint.ts";
import { ingestSource } from "../../core/brain/ingest/ingest.ts";
import { reconcilePlan } from "../../core/brain/ingest/reconcile.ts";
import { IntakeValidationError } from "../../core/brain/intake/extract-intake.ts";
import {
  deleteBySource,
  searchBySourceFile,
  type SourceCleanupEntry,
  type SourceCleanupPlan,
} from "../../core/brain/source-cleanup.ts";
import { resolveAgentName } from "../../core/config.ts";
import { coerceBoolOptional, coerceInt, coerceStr, coerceStrList } from "../coerce.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { parseExtractionIntakeArgs } from "./intake-args.ts";
import { enforceCountGuard, readCountGuardArgs, wrapToolErrors } from "./shared.ts";

const TOOL = "brain_ingest_source";
const SEARCH_TOOL = "brain_search_by_source";
const DELETE_TOOL = "brain_delete_by_source";
const BATCH_PLAN_TOOL = "brain_ingest_batch_plan";

/** Default batch caps when the caller omits them (1 MiB / 25 files per batch). */
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_BATCH_FILES = 25;

async function toolBrainIngestSource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourcePath = coerceStr(args, "source_path", true)!;
  const summary = coerceStr(args, "summary", true)!;
  const planId = coerceStr(args, "plan_id", false) ?? undefined;
  const preExtract = coerceBoolOptional(args, "pre_extract") ?? false;
  const parsed = parseExtractionIntakeArgs(args, TOOL);
  const agent =
    parsed.agent && parsed.agent.trim().length > 0
      ? parsed.agent
      : resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, [IntakeValidationError], async () => {
    const res = ingestSource(
      ctx.vault,
      { sourcePath, summary, extraction: parsed.intake },
      {
        agent,
        now: new Date(),
        ...(planId !== undefined ? { planId } : {}),
        ...(preExtract ? { preExtract: true } : {}),
      },
    );
    return {
      summary_path: res.summaryPath,
      created: res.created,
      entities_created: [...res.entitiesCreated],
      entities_updated: [...res.entitiesUpdated],
      connections: [...res.connections],
      // Only emitted when the pre-extract pass ran, so a call without it is
      // byte-identical to before (P4).
      ...(res.preExtract !== undefined ? { pre_extract: res.preExtract } : {}),
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
    // Honest matched-vs-changed accounting: `matched` is what the plan would
    // touch; `changed` is what was actually removed (0 on a dry run).
    matched: plan.blastRadius,
    changed: plan.deleted.length,
    derived: plan.derived.map(serializeEntry),
    mentions: plan.mentions.map(serializeEntry),
    originals: [...plan.originals],
    manifest_entry: plan.manifestEntry,
    deleted: [...plan.deleted],
    manifest_entry_removed: plan.manifestEntryRemoved,
    audit_record_id: plan.auditRecordId,
    // The D1 recovery point. Only the run id is surfaced here (not the
    // absolute archive path) so the response stays free of host paths; the
    // archive lives at the deterministic `Brain/.snapshots/<run_id>.tar.zst`.
    snapshot_run_id: plan.snapshotRunId,
  };
}

/** The vault-relative identities a cleanup plan would touch (for guard output). */
function planMatchList(plan: SourceCleanupPlan): string[] {
  return [
    ...plan.derived.map((e) => e.match ?? e.id),
    ...plan.mentions.map((e) => e.match ?? e.id),
    ...plan.originals,
  ];
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
  const { expect, strict } = readCountGuardArgs(args);
  const now = new Date();
  const baseOpts = {
    includeOriginals,
    now,
    ...(agent !== undefined ? { agent } : {}),
  };

  // Compute the (non-destructive) plan first so the count guard can assert the
  // blast radius BEFORE anything is deleted; only then confirm the removal.
  const preview = deleteBySource(ctx.vault, sourceFile, { confirm: false, ...baseOpts });
  enforceCountGuard({
    matched: preview.blastRadius,
    expect,
    strict,
    willMutate: confirm,
    matchList: planMatchList(preview),
  });
  const plan = confirm
    ? deleteBySource(ctx.vault, sourceFile, { confirm: true, ...baseOpts })
    : preview;
  return serializePlan(plan);
}

function serializeBatchPlan(plan: BatchPlan): Record<string, unknown> {
  return {
    source_dir: plan.sourceDir,
    max_batch_bytes: plan.maxBatchBytes,
    max_batch_files: plan.maxBatchFiles,
    total_files: plan.totalFiles,
    total_bytes: plan.totalBytes,
    skipped: [...plan.skipped],
    // Only emitted when the extractable gate skipped something, so a plan with
    // no extractable declaration serializes byte-identically to before.
    ...(plan.skippedNonExtractable.length > 0
      ? {
          skipped_non_extractable: plan.skippedNonExtractable.map((s) => ({
            path: s.path,
            reason: s.reason,
          })),
        }
      : {}),
    plan_id: plan.planId,
    resumed_completed: plan.resumedCompleted,
    batches: plan.batches.map((b) => ({
      index: b.index,
      total_bytes: b.totalBytes,
      files: b.files.map((f) => ({ path: f.path, bytes: f.bytes, status: f.status })),
    })),
  };
}

async function toolBrainIngestBatchPlan(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourceDir = coerceStr(args, "source_dir", true)!;
  const maxBatchBytes = coerceInt(
    args,
    "max_batch_bytes",
    DEFAULT_MAX_BATCH_BYTES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const maxBatchFiles = coerceInt(
    args,
    "max_batch_files",
    DEFAULT_MAX_BATCH_FILES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const resume = coerceBoolOptional(args, "resume") ?? false;
  const reconcile = coerceBoolOptional(args, "reconcile") ?? false;
  const srcSubpath = coerceStr(args, "src_subpath", false) ?? undefined;
  const exclude = coerceStrList(args, "exclude");
  const plan = planBatches(ctx.vault, sourceDir, {
    maxBatchBytes,
    maxBatchFiles,
    resume,
    ...(srcSubpath !== undefined ? { srcSubpath } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  // Reconcile BEFORE any checkpoint clear below, so the gap report reads a live
  // checkpoint. Read-only: it only diffs dispatched vs completed.
  const report = reconcile ? reconcilePlan(ctx.vault, plan) : undefined;
  // A resumed plan that comes back empty is fully drained: drop its checkpoint
  // (the content manifest is the authoritative final state from here on).
  if (resume && plan.batches.length === 0) {
    clearCheckpoint(ctx.vault, plan.planId);
  }
  const serialized = serializeBatchPlan(plan);
  return report === undefined
    ? serialized
    : {
        ...serialized,
        reconcile: {
          plan_id: report.planId,
          dispatched: [...report.dispatched],
          ingested: [...report.ingested],
          missing: [...report.missing],
          complete: report.complete,
        },
      };
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
        plan_id: {
          type: "string",
          description:
            "Optional batch-plan id (from brain_ingest_batch_plan). When set, a successful ingest records this source into that plan's resume checkpoint.",
        },
        pre_extract: {
          type: "boolean",
          description:
            "Run the deterministic no-LLM code-structure pass over the source file; returns class/function/import/inheritance seeds under `pre_extract`. Off by default.",
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
            "Scope discovery to a subtree of source_dir (e.g. pkg/a). A value escaping source_dir is a typed error. Absent walks the whole dir.",
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

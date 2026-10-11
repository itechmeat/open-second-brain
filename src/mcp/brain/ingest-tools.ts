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

import { existsSync } from "node:fs";
import { join } from "node:path";

import { serializeImportCensus } from "../../core/brain/import-census.ts";
import { planBatches, type BatchPlan } from "../../core/brain/ingest/batch-plan.ts";
import { clearCheckpoint, PLAN_ID_LABEL } from "../../core/brain/ingest/checkpoint.ts";
import { assertCheckpointId } from "../../core/brain/checkpoint-store.ts";
import { ingestSource } from "../../core/brain/ingest/ingest.ts";
import type { PartsOutcome, TableOutcome } from "../../core/brain/ingest/extract-source.ts";
import type { CodeEdgeSeed, PreExtractResult } from "../../core/brain/ingest/pre-extract.ts";
import { reconcilePlan } from "../../core/brain/ingest/reconcile.ts";
import { IntakeValidationError } from "../../core/brain/intake/extract-intake.ts";
import {
  discardSourceArchive,
  isArchiveHash,
  SOURCE_ARCHIVE_HASH_KEY,
  sourceArchiveCitingPages,
  sourceArchiveEntryRel,
} from "../../core/brain/provenance/source-archive.ts";
import { parseFrontmatter } from "../../core/vault.ts";
import {
  deleteBySource,
  searchBySourceFile,
  type SourceCleanupEntry,
  type SourceCleanupPlan,
} from "../../core/brain/source-cleanup.ts";
import { resolveAgentName } from "../../core/config.ts";
import { normalizeAgentScope } from "../../core/graph/agent-scope.ts";
import { isPathOwnerVisible, type FrontmatterCache } from "../../core/search/result-filters.ts";
import {
  coerceAgentScope,
  coerceBoolOptional,
  coerceInt,
  coerceStr,
  coerceStrList,
} from "../coerce.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { parseExtractionIntakeArgs } from "./intake-args.ts";
import { readableAtContextReach } from "./reach-readable.ts";
import {
  PENDING_STAGED_DIAGNOSTIC_CODE,
  PendingStageConflictError,
  WriteRefusedError,
} from "../../core/brain/pending/pending-lanes.ts";
import { nextCommandField } from "../../core/brain/next-step.ts";
import { enforceCountGuard, readCountGuardArgs, wrapToolErrors } from "./shared.ts";
import type { IngestSourceResult } from "../../core/brain/ingest/ingest.ts";
import { refuseAgentClaim } from "./agent-claim.ts";

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
  // `plan_id` is caller-supplied and becomes a checkpoint filename, so the
  // store's grammar is enforced HERE, where the caller can be told it is
  // their argument that is wrong. Left to the ingest it would surface as an
  // INTERNAL_ERROR, and before that it was swallowed entirely: the ingest
  // succeeded, resume never engaged, and `--reconcile` reported the whole
  // batch as never ingested.
  if (planId !== undefined) {
    try {
      assertCheckpointId(PLAN_ID_LABEL, planId);
    } catch (err) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${(err as Error).message}`);
    }
  }
  const preExtract = coerceBoolOptional(args, "pre_extract") ?? false;
  // This tool names its source as `source_path` and hands it to the pipeline
  // itself, so `source` is not part of its contract. Declaring that stops the
  // shared parser building a provenance out of an argument this schema never
  // declared and this handler never read.
  const parsed = parseExtractionIntakeArgs(args, TOOL, "absent");
  // The transport-minted identity wins over the config fallback, and a
  // token caller claiming another agent is refused outright
  // (write-side-trust, Task 7). resolveAgentName stays the stdio/CLI
  // fallback.
  const claimedAgent = parsed.agent && parsed.agent.trim().length > 0 ? parsed.agent : undefined;
  refuseAgentClaim(ctx.requestIdentity, claimedAgent ?? null, TOOL);
  const agent =
    claimedAgent ?? ctx.requestIdentity?.agent ?? resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, [IntakeValidationError], async () => {
    let res: IngestSourceResult;
    try {
      res = ingestSource(
        ctx.vault,
        { sourcePath, summary, extraction: parsed.intake },
        {
          agent,
          now: new Date(),
          // A page the caller may not read at its reach answers as an absent one.
          readable: readableAtContextReach(ctx),
          // The review disposition answers for the credential-minted
          // subject, never for the caller-named agent.
          ...(ctx.requestIdentity !== undefined ? { subject: ctx.requestIdentity } : {}),
          ...(planId !== undefined ? { planId } : {}),
          ...(preExtract ? { preExtract: true } : {}),
        },
      );
    } catch (err) {
      // Write-side trust (Task 12): a permissions document rule denied the
      // ingest. Named code, the rule that decided, and the operator exit -
      // never an internal error a caller would retry into the same wall.
      if (err instanceof WriteRefusedError) {
        throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, {
          code: err.code,
          rule: err.rule,
          agent: err.agent,
          next_command: err.nextCommand,
        });
      }
      // An ingest retried while its first run is still staged: the queue
      // refuses by name, so the answer names the queue entry holding the
      // summary target instead of an internal error a caller would retry
      // into the same wall.
      if (err instanceof PendingStageConflictError) {
        throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, {
          code: err.code,
          existing_id: err.existingId,
          target: err.target,
        });
      }
      throw err;
    }
    return {
      summary_path: res.summaryPath,
      created: res.created,
      entities_created: [...res.entitiesCreated],
      entities_updated: [...res.entitiesUpdated],
      connections: [...res.connections],
      // How much of the source the vault holds, as the summary page records
      // it. Always present: absence would read as "full-local" to a caller
      // that never learned the key exists.
      capture_scope: res.captureScope,
      // The durable archive stamp (answer trust, Task C4), following the
      // capture_scope pattern: the hash is ALWAYS present, null when the
      // source was not archived, so absence never reads as a missing key.
      // The byte count rides only with a hash, mirroring the page's
      // frontmatter; the named refusal rides only when an ELIGIBLE source
      // could not be archived.
      source_archive_hash: res.sourceArchiveHash ?? null,
      ...(res.sourceArchiveHash !== undefined
        ? { source_archive_bytes: res.sourceArchiveBytes }
        : {}),
      ...(res.sourceArchiveRefusal !== undefined
        ? { source_archive_refusal: res.sourceArchiveRefusal }
        : {}),
      // Write-side trust (Task 9): a first publish of the summary page
      // stages under the review gate while registration completes. The
      // receipt names the queue entry and the command that publishes it,
      // so a staged ingest reads as staged, never as missing.
      ...(res.staged === true && res.pendingId !== undefined
        ? {
            staged: true,
            pending_id: res.pendingId,
            ...nextCommandField(PENDING_STAGED_DIAGNOSTIC_CODE),
          }
        : {}),
      // Only for an HTML or CSV/TSV source, so a text source's payload is
      // byte-identical to before. Counts and tokens only, never content.
      ...(res.parts !== undefined ? { parts: serializeParts(res.parts) } : {}),
      ...(res.table !== undefined ? { table: serializeTable(res.table) } : {}),
      // Only emitted when the pre-extract pass ran, so a call without it is
      // byte-identical to before (P4).
      ...(res.preExtract !== undefined ? { pre_extract: serializePreExtract(res.preExtract) } : {}),
    };
  });
}

/** The HTML outcome on the wire: `{extracted, count, omitted?}` or `{extracted: false, reason}`. */
function serializeParts(parts: PartsOutcome): Record<string, unknown> {
  if (!parts.extracted) return { extracted: false, reason: parts.reason };
  return {
    extracted: true,
    count: parts.count,
    ...(parts.omitted !== undefined ? { omitted: parts.omitted } : {}),
  };
}

/** The table outcome on the wire, snake_case, `truncated` only when a cap cut it. */
function serializeTable(table: TableOutcome): Record<string, unknown> {
  if (!table.rendered) {
    return {
      rendered: false,
      format: table.format,
      reason: table.reason,
      ...(table.detail !== undefined ? { detail: table.detail } : {}),
    };
  }
  return {
    rendered: true,
    format: table.format,
    delimiter: table.delimiter,
    columns: table.columns,
    rows: table.rows,
    rows_rendered: table.rowsRendered,
    ...(table.truncated.length > 0 ? { truncated: [...table.truncated] } : {}),
    redacted_cells: table.redactedCells,
  };
}

/** The pre-extract result with its edge keys in the payload's snake_case. */
function serializePreExtract(result: PreExtractResult): Record<string, unknown> {
  if (!result.extracted) return { ...result };
  return { ...result, edges: result.edges.map(serializeEdgeSeed) };
}

function serializeEdgeSeed(edge: CodeEdgeSeed): Record<string, unknown> {
  return {
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    ...(edge.resolvedTo !== undefined ? { resolved_to: edge.resolvedTo } : {}),
  };
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

/**
 * One archive entry a source cleanup takes with it (answer trust, Task C4),
 * reported as its own kind beside the page entries - the hash and the
 * vault-relative path, never a host path.
 */
interface ArchiveCleanupEntry {
  readonly hash: string;
  readonly path: string;
}

/**
 * Harvest the archive digests stamped on the plan's summary pages, sorted.
 * Read BEFORE a confirmed deletion runs: once the pages are gone their
 * stamps are gone with them, and the entry orphan decision needs them.
 */
function stampedArchiveHashes(vault: string, plan: SourceCleanupPlan): ReadonlyArray<string> {
  const hashes = new Set<string>();
  for (const entry of plan.derived) {
    if (entry.kind !== "summary" || !existsSync(join(vault, entry.path))) continue;
    const [meta] = parseFrontmatter(join(vault, entry.path));
    const value = meta[SOURCE_ARCHIVE_HASH_KEY];
    if (typeof value === "string" && isArchiveHash(value)) hashes.add(value);
  }
  return [...hashes].toSorted();
}

/**
 * Which of the plan's stamped entries this deletion orphans: an entry goes
 * only when EVERY page citing it is in the deleted set - removing a source
 * whose summary shares an entry with another source's page (identical
 * bytes, content-addressed dedup) leaves the entry standing. Vacuously
 * true when no citing page remains: the hash got here from the plan's own
 * pages, so an empty citation list means the last citing page is exactly
 * what this run deleted. A page the caller may not read is not in the
 * deleted set, so a hidden citation keeps the entry too: the fail-safe
 * direction.
 */
function orphanedArchiveEntries(
  vault: string,
  hashes: ReadonlyArray<string>,
  deletedPaths: ReadonlySet<string>,
): ReadonlyArray<ArchiveCleanupEntry> {
  const out: ArchiveCleanupEntry[] = [];
  for (const hash of hashes) {
    const citing = sourceArchiveCitingPages(vault, hash);
    if (citing.every((page) => deletedPaths.has(page))) {
      out.push({ hash, path: sourceArchiveEntryRel(hash) });
    }
  }
  return out;
}

/**
 * Best-effort removal of one orphaned entry: false both when there was
 * nothing to remove and when the removal itself failed. The confirmed
 * deletion has already completed by the time this runs, so a cleanup that
 * throws - a permission denial, an entry replaced by something rmSync
 * cannot remove - must not fail the tool after the fact, and its error
 * message carries a host path this surface never reports. What is
 * tolerated here is exactly the transient half: the page deletion is done
 * and correct, and the leftover entry is durable evidence, not a lost
 * deletion - the doctor's archive section names it in its `uncited`
 * count, and a retry of the cleanup is harmless.
 */
function discardOrphanedArchiveEntry(vault: string, hash: string): boolean {
  try {
    return discardSourceArchive(vault, hash);
  } catch {
    return false;
  }
}

function serializePlan(
  plan: SourceCleanupPlan,
  archiveEntries: ReadonlyArray<ArchiveCleanupEntry>,
): Record<string, unknown> {
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
    // The archive-entry cleanup kind (answer trust, Task C4), reported as
    // its own kind rather than folded into the page entries: on a dry run,
    // the entries removing the source's last citing page WOULD orphan; on
    // confirm, the entries actually removed. They are deterministic
    // consequences of the page deletion, never targets of their own, so
    // they sit outside the count guard's blast radius. Emitted only when
    // non-empty, so a plan over an unstamped source is byte-identical.
    ...(archiveEntries.length > 0 ? { archive_entries: archiveEntries } : {}),
    // The D1 recovery point. Only the run id is surfaced here (not the
    // absolute archive path) so the response stays free of host paths; the
    // archive lives at the deterministic `Brain/.snapshots/<run_id>.tar.zst`.
    snapshot_run_id: plan.snapshotRunId,
    // What that run id is worth. `include_originals` deletes files that
    // are outside `Brain/` by construction and therefore outside every
    // archive ever taken; reporting the run id with nothing beside it
    // told a caller the deletion was reversible when half of it was not.
    recoverability: {
      state: plan.recoverability.state,
      coverage: [...plan.recoverability.coverage],
      blockers: [...plan.recoverability.blockers],
    },
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
  // A page the caller may not read at its reach (a summary page that
  // inherited a reserved source's visibility) is answered as an absent one.
  const readable = readableAtContextReach(ctx);
  const hits = searchBySourceFile(ctx.vault, sourceFile).filter((entry) => readable(entry.path));
  // Owner-scope isolation (context-integrity-gates, Unit A). Every entry
  // names a Brain page, so the ownership rule applies through the same
  // path-based resolver the ranked search path uses - including its
  // fail-closed treatment of frontmatter that will not parse. `total`
  // counts what is returned; a total over the hidden pages would leak
  // their number. An absent scope filters nothing.
  const scope = normalizeAgentScope(coerceAgentScope(ctx, args, false));
  const cache: FrontmatterCache = new Map();
  const visible =
    scope === null
      ? hits
      : hits.filter((entry) => isPathOwnerVisible(ctx.vault, entry.path, scope, cache));
  return {
    source_file: sourceFile,
    total: visible.length,
    entries: visible.map(serializeEntry),
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
  // An original the caller may not read at its reach is planned and
  // deleted exactly as an absent one: never confirmed, never removed.
  const baseOpts = {
    includeOriginals,
    now,
    include: readableAtContextReach(ctx),
    // The deny consult answers for the credential-minted subject, never
    // for the caller-named agent (write-side-trust, Task 7).
    ...(ctx.requestIdentity !== undefined ? { subject: ctx.requestIdentity } : {}),
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
  // The stamps must be read BEFORE a confirmed deletion erases the pages
  // that carry them; the orphan decision then runs against whichever set
  // this run actually removed (a dry run answers with what confirm would
  // remove).
  const stamped = stampedArchiveHashes(ctx.vault, preview);
  try {
    let archiveEntries: ReadonlyArray<ArchiveCleanupEntry> = [];
    if (confirm) {
      const plan = deleteBySource(ctx.vault, sourceFile, { confirm: true, ...baseOpts });
      archiveEntries = orphanedArchiveEntries(ctx.vault, stamped, new Set(plan.deleted)).filter(
        (entry) => discardOrphanedArchiveEntry(ctx.vault, entry.hash),
      );
      return serializePlan(plan, archiveEntries);
    }
    archiveEntries = orphanedArchiveEntries(
      ctx.vault,
      stamped,
      new Set(preview.derived.map((entry) => entry.path)),
    );
    return serializePlan(preview, archiveEntries);
  } catch (err) {
    // Write-side trust (Task 12): a permissions document rule denied the
    // confirmed cleanup. Named code, the rule that decided, and the
    // operator exit - never an internal error a caller would retry into
    // the same wall.
    if (err instanceof WriteRefusedError) {
      throw new MCPError(INVALID_PARAMS, `${DELETE_TOOL}: ${err.message}`, {
        code: err.code,
        rule: err.rule,
        agent: err.agent,
        next_command: err.nextCommand,
      });
    }
    throw err;
  }
}

/**
 * The wire shape of a batch plan, shared by every surface that emits one: this
 * tool and `o2b brain batch-plan --json` (which spreads its own `reconcile` on
 * top). One serializer means a field added here cannot reach one surface and
 * miss the other.
 */
export function serializeBatchPlan(plan: BatchPlan): Record<string, unknown> {
  return {
    source_dir: plan.sourceDir,
    max_batch_bytes: plan.maxBatchBytes,
    max_batch_files: plan.maxBatchFiles,
    total_files: plan.totalFiles,
    total_bytes: plan.totalBytes,
    skipped: [...plan.skipped],
    // Only emitted when the manifest's recorded extraction contract differs
    // from the live one (t_586d5d8b), so a plan under an unchanged contract
    // serializes byte-identically to before. The count names how many files
    // reprocess because of the contract rather than their bytes.
    ...(plan.contractChanged
      ? { contract_changed: true, contract_changed_files: plan.contractChangedFiles }
      : {}),
    // Only emitted when the extractable gate skipped something, so a plan with
    // no extractable declaration serializes byte-identically to before. The
    // reason is the typed token (P4) and `detail` carries the value behind
    // it - the schema_type, or the format of a format skip - so a reader can
    // check the skip without re-reading.
    ...(plan.skippedNonExtractable.length > 0
      ? {
          skipped_non_extractable: plan.skippedNonExtractable.map((s) => ({
            path: s.path,
            reason: s.reason,
            detail: s.detail,
          })),
        }
      : {}),
    // Per-reason counts (P4), emitted only when something was skipped.
    ...(Object.keys(plan.skipReasonCounts).length > 0
      ? { skip_reason_counts: plan.skipReasonCounts }
      : {}),
    // Per-extension unclassifiable counts (P4), emitted only when the walk
    // dropped at least one non-ingestible file, so a tree that is all
    // ingestible serializes byte-identically to before.
    ...(plan.unclassifiable.total > 0
      ? {
          unclassifiable: {
            total: plan.unclassifiable.total,
            by_extension: plan.unclassifiable.byExtension,
          },
        }
      : {}),
    // Only emitted when the repository's own ignore files carried a malformed
    // pattern (t_4b2bd8f7), so a tree that declares none - or declares only
    // well-formed patterns - serializes byte-identically to before.
    ...(plan.ignoreWarnings.length > 0
      ? {
          ignore_warnings: plan.ignoreWarnings.map((w) => ({
            source: w.source,
            line: w.line,
            pattern: w.pattern,
            reason: w.reason,
          })),
        }
      : {}),
    plan_id: plan.planId,
    resumed_completed: plan.resumedCompleted,
    batches: plan.batches.map((b) => ({
      index: b.index,
      total_bytes: b.totalBytes,
      // `format` only for a non-text file, so a Markdown plan is unchanged.
      files: b.files.map((f) => ({
        path: f.path,
        bytes: f.bytes,
        status: f.status,
        ...(f.format !== undefined ? { format: f.format } : {}),
      })),
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
  // A file the caller may not read at its reach is planned as an absent one.
  const include = readableAtContextReach(ctx);
  const plan = planBatches(ctx.vault, sourceDir, {
    maxBatchBytes,
    maxBatchFiles,
    resume,
    include,
    ...(srcSubpath !== undefined ? { srcSubpath } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  // Reconcile BEFORE any checkpoint clear below, so the gap report reads a live
  // checkpoint. Read-only: it only diffs dispatched vs completed.
  const report = reconcile ? reconcilePlan(ctx.vault, plan, include) : undefined;
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
          census: serializeImportCensus(report.census),
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

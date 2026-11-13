/**
 * The source-ingest tools (task 3.19): `brain_ingest_source`,
 * `brain_search_by_source` and `brain_delete_by_source`, with the
 * capacity refusal envelope they answer, the cleanup-plan serializers
 * and the archive-orphan helpers. Split from `ingest-tools.ts`;
 * registration happens through that module's registry, which preserves
 * the public INGEST_TOOLS surface.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PLAN_ID_LABEL } from "../../core/brain/ingest/checkpoint.ts";
import { assertCheckpointId } from "../../core/brain/checkpoint-store.ts";
import { STORAGE_CAPACITY_CRITICAL_CODE } from "../../core/brain/doctor/storage-capacity.ts";
import { MAINTENANCE_CAPACITY_REMEDY } from "../../core/brain/maintenance/lane.ts";
import {
  StorageCapacityError,
  type StorageErrorCode,
} from "../../core/brain/storage/capacity-error.ts";
import {
  CAPACITY_GATE_DECISION,
  evaluateCapacityGate,
  type CapacityGateDecision,
} from "../../core/brain/storage/gate.ts";
import {
  loadGateStorageConfig,
  StorageGateConfigError,
} from "../../core/brain/storage/gate-config.ts";
import { ingestSource } from "../../core/brain/ingest/ingest.ts";
import type { PartsOutcome, TableOutcome } from "../../core/brain/ingest/extract-source.ts";
import type { CodeEdgeSeed, PreExtractResult } from "../../core/brain/ingest/pre-extract.ts";
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
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import { isPathOwnerVisible, type FrontmatterCache } from "../../core/search/result-filters.ts";
import { coerceAgentScope, coerceBoolOptional, coerceStr } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { codeForError } from "../tool-error-codes.ts";
import { contextReach, type ServerContext } from "../tool-contract.ts";
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

export const TOOL = "brain_ingest_source";
export const SEARCH_TOOL = "brain_search_by_source";
export const DELETE_TOOL = "brain_delete_by_source";
export const BATCH_PLAN_TOOL = "brain_ingest_batch_plan";

/** Default batch caps when the caller omits them (1 MiB / 25 files per batch). */
export const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
export const DEFAULT_MAX_BATCH_FILES = 25;

/** The wire code of the capacity admission refusal, from the leaf's closed union. */
export const ADMISSION_REFUSAL_CODE: StorageErrorCode = "capacity_exhausted";

/**
 * The registered wire code for an unreadable or invalid `_brain.yaml` - the
 * same code the error-code registry maps {@link BrainConfigError} to.
 */
export const CONFIG_GATE_REFUSAL_CODE = "config_invalid";

/**
 * Refuse the ingest when a fresh census measures the vault at its
 * critical storage tier - the interactive half of the storage lifecycle's
 * backpressure, beside the maintenance lane's gate.
 *
 * The check sits in the VALIDATE phase, before `ingestSource` opens the
 * write path: the commit phase is never entered, so there is nothing to
 * roll back, and a refusal leaves the vault byte-identical. Only a
 * MEASURED critical tier closes it, exactly as the lane's gate does - an
 * unmeasurable store stays open, because a census that could not be taken
 * is not a vault with room, but neither is it a vault without. No
 * configured cap is the documented default and means the check does not
 * exist: no gate, no byte walk, no cost.
 *
 * The gate itself is a write gate, not a secret, so it fires at every
 * reach - but the refusal throws the registered leaf carrying the
 * envelope's fields, and {@link admissionDetails} gates the whole-vault
 * figures by reach, for the same reason `brain_storage` refuses to take
 * its census below local reach.
 *
 * The remedy is the lane's own sentence, quoted rather than restated, so
 * the two walls an operator can hit - the paused lane and the refused
 * write - cannot disagree about what to do next.
 */
export function refuseWhenVaultExhausted(
  vault: string,
  reach: TransportReach,
  now: Date,
  configPath: string | null,
): void {
  const storage = loadGateStorageConfig(vault);
  if (storage.cap_bytes === null) return;
  const decision = evaluateCapacityGate(vault, {
    now,
    ...(configPath ? { configPath } : {}),
    capBytes: storage.cap_bytes,
    warnPercent: storage.warn_percent,
    criticalPercent: storage.critical_percent,
    warnDays: storage.warn_days,
    criticalDays: storage.critical_days,
  });
  if (decision.decision !== CAPACITY_GATE_DECISION.skip) return;
  throw new StorageCapacityError(
    ADMISSION_REFUSAL_CODE,
    `${TOOL}: refused (${ADMISSION_REFUSAL_CODE}): the vault measured at the ` +
      `${decision.tier} storage tier. ${MAINTENANCE_CAPACITY_REMEDY}.`,
    admissionDetails(decision, reach),
  );
}

/**
 * The structured fields beside the admission refusal's code. The tier and
 * the remedy ride at every reach; the whole-vault figures do not - they
 * are the same local-reach facts the storage report refuses to take below
 * local reach (`buildStorageReport`), and handing them to a remote caller
 * would answer the refusal with a census and a growth oracle in one
 * payload. The `next_command` field stays: the local remedy is the one
 * thing a refused caller still needs in hand.
 */
export function admissionDetails(
  decision: CapacityGateDecision,
  reach: TransportReach,
): Record<string, unknown> {
  const reading = decision.reading;
  return {
    tier: decision.tier,
    ...(reach === TRANSPORT_REACH.local
      ? {
          measured_bytes: reading?.measuredBytes ?? null,
          cap_bytes: reading?.capBytes ?? null,
          percent_used: reading?.percentUsed ?? null,
        }
      : {}),
    remedy: MAINTENANCE_CAPACITY_REMEDY,
    // The registered next step for a critical vault (the storage
    // report), resolved from the diagnostics registry - a refusal whose
    // value is the pointer never spells the command by hand.
    ...nextCommandField(STORAGE_CAPACITY_CRITICAL_CODE),
  };
}

/**
 * The MCP envelope for an admission refusal, from the thrown leaf: the
 * wire code is the code the registered `carried()` classification reads
 * off this leaf (`codeForError`), never a restated literal, and the data
 * fields are the leaf's own - so the envelope cannot drift from the
 * vocabulary the wire registry knows.
 */
export function capacityRefusalEnvelope(err: StorageCapacityError): MCPError {
  return new MCPError(INVALID_PARAMS, err.message, {
    code: codeForError(err),
    ...err.details,
  });
}

export async function toolBrainIngestSource(
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
    // The admission wall, in the validate phase: past this call the write
    // path opens, and the commit phase ahead of it is never rolled back.
    // The check throws the registered leaf; it is mapped onto its wire
    // envelope here, before the generic wrapper could flatten it into an
    // internal error.
    try {
      refuseWhenVaultExhausted(ctx.vault, contextReach(ctx), new Date(), ctx.configPath ?? null);
    } catch (err) {
      if (err instanceof StorageCapacityError) throw capacityRefusalEnvelope(err);
      // A broken config the gate cannot see through refuses by name, with
      // prose free of host paths (review M1) - never an internal error a
      // caller would retry into the same wall.
      if (err instanceof StorageGateConfigError) {
        throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, {
          code: CONFIG_GATE_REFUSAL_CODE,
        });
      }
      throw err;
    }
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
      // The appended delta this run proved (t_a9cd4221, review M14): the
      // boundary-safe byte range beside its named kind, absent on every
      // shape that is not a proven append - a first ingest, a rewrite, a
      // source with no watermark. The range lets the caller see what this
      // summary is newly about; extraction itself stays whole-source, so
      // the field is reporting, never a claim that only the tail was read.
      ...(res.extractionDelta !== undefined
        ? {
            extraction_delta: {
              kind: res.extractionDelta.kind,
              from_byte: res.extractionDelta.fromByte,
              to_byte: res.extractionDelta.toByte,
            },
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
export function serializeParts(parts: PartsOutcome): Record<string, unknown> {
  if (!parts.extracted) return { extracted: false, reason: parts.reason };
  return {
    extracted: true,
    count: parts.count,
    ...(parts.omitted !== undefined ? { omitted: parts.omitted } : {}),
  };
}

/** The table outcome on the wire, snake_case, `truncated` only when a cap cut it. */
export function serializeTable(table: TableOutcome): Record<string, unknown> {
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
export function serializePreExtract(result: PreExtractResult): Record<string, unknown> {
  if (!result.extracted) return { ...result };
  return { ...result, edges: result.edges.map(serializeEdgeSeed) };
}

export function serializeEdgeSeed(edge: CodeEdgeSeed): Record<string, unknown> {
  return {
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    ...(edge.resolvedTo !== undefined ? { resolved_to: edge.resolvedTo } : {}),
  };
}

export function serializeEntry(entry: SourceCleanupEntry): Record<string, unknown> {
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
export interface ArchiveCleanupEntry {
  readonly hash: string;
  readonly path: string;
}

/**
 * Harvest the archive digests stamped on the plan's summary pages, sorted.
 * Read BEFORE a confirmed deletion runs: once the pages are gone their
 * stamps are gone with them, and the entry orphan decision needs them.
 */
export function stampedArchiveHashes(
  vault: string,
  plan: SourceCleanupPlan,
): ReadonlyArray<string> {
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
export function orphanedArchiveEntries(
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
export function discardOrphanedArchiveEntry(vault: string, hash: string): boolean {
  try {
    return discardSourceArchive(vault, hash);
  } catch {
    return false;
  }
}

export function serializePlan(
  plan: SourceCleanupPlan,
  archiveEntries: ReadonlyArray<ArchiveCleanupEntry>,
  local: boolean,
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
    // The per-entry removal failures reach the tool answer (review M8): a
    // confirmed removal that could not delete a file must never read as a
    // clean run with a smaller count. Always carried (empty on a clean or
    // dry run) so an automations can read the field unconditionally, like
    // `deleted` beside it.
    // Below local reach the raised message, which can carry a host path,
    // is replaced by the errno code; the vault-relative path stays.
    failed: plan.failed.map((f) => ({
      path: f.path,
      message: local ? f.message : `removal failed (${f.code ?? "error"})`,
    })),
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
export function planMatchList(plan: SourceCleanupPlan): string[] {
  return [
    ...plan.derived.map((e) => e.match ?? e.id),
    ...plan.mentions.map((e) => e.match ?? e.id),
    ...plan.originals,
  ];
}

export async function toolBrainSearchBySource(
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

export async function toolBrainDeleteBySource(
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
      return serializePlan(plan, archiveEntries, contextReach(ctx) === TRANSPORT_REACH.local);
    }
    archiveEntries = orphanedArchiveEntries(
      ctx.vault,
      stamped,
      new Set(preview.derived.map((entry) => entry.path)),
    );
    return serializePlan(preview, archiveEntries, contextReach(ctx) === TRANSPORT_REACH.local);
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

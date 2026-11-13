/**
 * The note write tools (`brain_create_note`, `brain_update_note`,
 * `brain_append_note`) with the single-write runner, the audit and
 * refresh-claim fields they answer, and the near-duplicate widening the
 * create hint reads. Split from `notes-tools.ts` (task 3.19);
 * registration happens through that module's registry, which preserves
 * the public NOTES_TOOLS surface.
 */

import {
  createNote,
  CreateNoteError,
  CREATE_NOTE_IF_EXISTS,
  type CreateNoteIfExists,
} from "../../core/brain/notes/create-note.ts";
import {
  applyWriteBatch,
  type AppendNoteOperation,
  type UpdateNoteOperation,
  type NoteWriteAudit,
  type WriteBatchOpResult,
} from "../../core/brain/write-batch.ts";
import type { ReadableRef } from "../../core/brain/near-duplicate.ts";
import { nextCommandField } from "../../core/brain/next-step.ts";
import {
  PENDING_STAGED_DIAGNOSTIC_CODE,
  PendingStageConflictError,
  WriteRefusedError,
} from "../../core/brain/pending/pending-lanes.ts";
import {
  lintWrittenPages,
  pageLintField,
  type LintWrittenPagesOptions,
  type PageLintField,
} from "../../core/brain/page-lint.ts";
import {
  collectWideningCandidates,
  wideningUnavailable,
  type WideningResult,
} from "../../core/brain/page-lint-widening.ts";
import { resolveNearDuplicateWriteWideningEnabled } from "../../core/config.ts";
import { ROUTE_STAGE, timeStage, timeStageSync } from "../../core/route-scope.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import type { ResolvedSearchConfig } from "../../core/search/types.ts";
import {
  claimNoteWriteRefresh,
  type PostWriteRefreshClaim,
} from "../../core/brain/notes/index-refresh.ts";
import {
  WRITE_PATH_ADVISORY_KEY,
  type WritePathAdvisoryField,
} from "../../core/brain/write-path-advisory.ts";
import { rethrowVaultFrozen } from "../frozen-refusal.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { coerceBoolOptional, coerceStr, coerceStringOptional } from "../coerce.ts";
import { readableAtContextReach } from "./reach-readable.ts";
import {
  ANY_TEMPLATE_VARIABLE_NAME,
  TEMPLATE_MAX_LEN,
  advisoryFields,
  parseFrontmatterArg,
  rpcCodeFor,
  writeBatchErrorToMcp,
} from "./notes-shared.ts";

/**
 * Read the occupied-target policy. An unrecognised value is refused
 * rather than falling back to the default: a caller that asked for a
 * disposition this tool does not have must not be told its write
 * succeeded under a different one.
 */
export function coerceIfExists(args: Record<string, unknown>): CreateNoteIfExists | undefined {
  const raw = coerceStringOptional(args, "if_exists", 16);
  if (raw === undefined) return undefined;
  const match = CREATE_NOTE_IF_EXISTS.find((policy) => policy === raw);
  if (match === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_create_note: if_exists must be one of ${CREATE_NOTE_IF_EXISTS.join(", ")}`,
    );
  }
  return match;
}

export async function toolBrainCreateNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const content = coerceStr(args, "content", false);
  const frontmatter = parseFrontmatterArg(args["frontmatter"], "brain_create_note");
  const ifExists = coerceIfExists(args);
  const strict = coerceBoolOptional(args, "strict");
  const template = coerceStringOptional(args, "template", TEMPLATE_MAX_LEN);
  const templateVariables = parseFrontmatterArg(
    args["template_variables"],
    "brain_create_note",
    "template_variables",
    ANY_TEMPLATE_VARIABLE_NAME,
  );

  try {
    const res = createNote(ctx.vault, {
      path,
      ...(frontmatter !== undefined ? { frontmatter } : {}),
      ...(content !== null && content !== undefined ? { content } : {}),
      ...(ifExists !== undefined ? { ifExists } : {}),
      ...(strict !== undefined ? { strict } : {}),
      ...(template !== undefined ? { template } : {}),
      ...(templateVariables !== undefined ? { templateVariables } : {}),
      // The note-write record names the agent this server runs as, which
      // is the one THIS config declares - not the one a machine-default
      // discovery would find (who-wrote-what, Task A).
      ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
      // The transport-minted identity wins as the permission subject and
      // the owner gate's resolved identity (write-side-trust, Task 7): a
      // token's create answers for the token's agent.
      ...(ctx.requestIdentity !== undefined ? { subject: ctx.requestIdentity } : {}),
    });
    // `outcome` is the discriminant; `created` is the boolean this tool
    // has always returned and stays in lockstep with it, so a skip can
    // never be read as a create by either field. A skip authored no
    // bytes, so it names no page for the lint. A STAGED create (review
    // gate on) also authored nothing at the target: its receipt carries
    // the pending id and the queue command that publishes it, and names
    // no page for the lint because nothing was published.
    if (res.outcome === "staged") {
      return await noteWriteResult(ctx, [], {
        created: false,
        outcome: "staged",
        staged: true,
        path: res.path,
        pending_id: res.pendingId,
        ...nextCommandField(PENDING_STAGED_DIAGNOSTIC_CODE),
      });
    }
    // An APPLIED create claims the same detached index refresh a
    // lifecycle write claims: the card names created notes among the
    // writes that must resolve without a reindex, and the PR says a
    // create claims. Fire-and-forget, never failing the write it
    // follows; a skip or a staged create authored nothing at the target,
    // so neither claims and neither carries the marker. The claim
    // resolves through the SERVER's own config path - the same file
    // every other search-resolving call in this file reads - so a
    // non-default config's index path and freshen settings are the ones
    // the evidence reads and the child spawns with.
    const claim = res.created
      ? await claimNoteWriteRefresh(ctx.vault, undefined, undefined, ctx.configPath ?? undefined)
      : null;
    return await noteWriteResult(ctx, res.created ? [res.path] : [], {
      created: res.created,
      outcome: res.outcome,
      path: res.path,
      // The audit half rides on the receipt for a create and NOT for a
      // skip (who-wrote-what, Task A): a skip authored no bytes, so it
      // has no write to attribute and no null that could be mistaken for
      // a lost one.
      ...(res.outcome === "created" ? auditFields(res) : {}),
      ...(claim !== null ? refreshClaimFields(claim) : {}),
    });
  } catch (err) {
    // Almost every CreateNoteError is a client-input fault (bad path,
    // excluded location, an existing target, an invalid document, a
    // malformed template, a destination outside the declared binding);
    // report it with the typed code, its registry spelling and exit, and
    // the validator's fix list when there is one. `config_invalid` is
    // the exception the split in `rpcCodeFor` exists for: no argument
    // the caller could send would succeed. Anything else is a genuine
    // I/O fault.
    if (err instanceof CreateNoteError) {
      throw new MCPError(rpcCodeFor(err.code), `brain_create_note: ${err.message}`, {
        code: err.code,
        ...advisoryFields(err.code),
        ...(err.violations.length > 0 ? { violations: err.violations } : {}),
      });
    }
    // Write-side trust (Task 12): a permissions document rule denied the
    // create. Named code, the rule that decided, and the operator exit.
    if (err instanceof WriteRefusedError) {
      throw new MCPError(INVALID_PARAMS, `brain_create_note: ${err.message}`, {
        code: err.code,
        rule: err.rule,
        agent: err.agent,
        next_command: err.nextCommand,
      });
    }
    // A create retried while its first run is still staged: the queue
    // refuses by name, so the answer names the queue entry holding the
    // target instead of an internal error a caller would retry into.
    if (err instanceof PendingStageConflictError) {
      throw new MCPError(INVALID_PARAMS, `brain_create_note: ${err.message}`, {
        code: err.code,
        existing_id: err.existingId,
        target: err.target,
      });
    }
    rethrowVaultFrozen(err);
    // An answer already shaped for the wire (the `vault_required` refusal
    // of a server with no vault) keeps its code.
    if (err instanceof MCPError) throw err;
    throw new MCPError(INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The `content` an update carries, distinguishing ABSENT from EMPTY.
 *
 * {@link coerceStr} collapses `""` and a whitespace-only string to
 * `null`, which every other surface reads as "the caller did not send
 * this argument". On an update that reading is wrong in a way that loses
 * the caller's intent: `{path, frontmatter, content: ""}` asked for the
 * body to be cleared and was answered with `updated: true` over a body
 * left exactly as it was, and `{path, content: ""}` was refused as if no
 * argument had arrived at all. Both are silent about what happened to
 * the request. Reading presence directly lets the empty body reach the
 * kernel, where it is either refused by name or - with `allow_empty` -
 * honoured.
 */
export function updateBodyArgument(args: Record<string, unknown>): string | undefined {
  const raw = args["content"];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new MCPError(INVALID_PARAMS, "brain_update_note: argument 'content' must be a string");
  }
  return raw;
}

/**
 * Update an existing note: merge frontmatter keys and/or replace the
 * body. A single-operation batch over kernel 2 so a mid-write failure
 * leaves the target byte-identical. Requires at least one of frontmatter
 * or content; a missing target is a typed error.
 */
export async function toolBrainUpdateNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const frontmatter = parseFrontmatterArg(args["frontmatter"], "brain_update_note");
  const content = updateBodyArgument(args);
  const allowEmpty = coerceBoolOptional(args, "allow_empty");
  if (frontmatter === undefined && content === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_update_note: provide 'frontmatter', 'content', or both",
    );
  }
  const op: UpdateNoteOperation = {
    kind: "update_note",
    path,
    ...(frontmatter !== undefined ? { frontmatter } : {}),
    ...(content !== undefined ? { body: content } : {}),
    ...(allowEmpty !== undefined ? { allowEmpty } : {}),
  };
  const result = runSingleWrite(ctx, op, "brain_update_note");
  // The flag comes off the kernel result rather than being restated here:
  // one fact, one source. A skipped update wrote no bytes, so it names no
  // page for the lint and carries no audit half - the same shape a
  // skipped create spells.
  //
  // An APPLIED update - a content edit, frontmatter or both - claims the
  // same detached index refresh the lifecycle's writes claim, with the
  // marker on the receipt under the same vocabulary. A byte-identical
  // re-apply wrote nothing, so it claims nothing and carries no marker.
  // The claim resolves through the server's own config path, like every
  // other search-resolving call here.
  const claim = result.updated
    ? await claimNoteWriteRefresh(ctx.vault, undefined, undefined, ctx.configPath ?? undefined)
    : null;
  return noteWriteResult(ctx, result.updated ? [result.path] : [], {
    updated: result.updated,
    path: result.path,
    ...(result.updated ? auditFields(result) : {}),
    ...pathAdvisoryFields(result),
    ...(claim !== null ? refreshClaimFields(claim) : {}),
  });
}

/**
 * Append body text to an existing note. A single-operation batch over
 * kernel 2; a missing target is a typed error.
 */
export async function toolBrainAppendNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const content = coerceStr(args, "content", true)!;
  const op: AppendNoteOperation = { kind: "append_note", path, content };
  const result = runSingleWrite(ctx, op, "brain_append_note");
  // Skipped-append receipts follow the skipped-update shape: no bytes
  // landed, so no page to lint and no audit half to mistake.
  //
  // An APPLIED append wrote body bytes, so it is a content edit and
  // claims the same detached index refresh the update claims - the one
  // note-write surface left claiming nothing, and the only one whose
  // receipt contradicted the "a content edit claims" line. The claim
  // resolves through the server's own config path, like every other
  // search-resolving call here.
  const claim = result.appended
    ? await claimNoteWriteRefresh(ctx.vault, undefined, undefined, ctx.configPath ?? undefined)
    : null;
  return noteWriteResult(ctx, result.appended ? [result.path] : [], {
    appended: result.appended,
    path: result.path,
    ...(result.appended ? auditFields(result) : {}),
    ...pathAdvisoryFields(result),
    ...(claim !== null ? refreshClaimFields(claim) : {}),
  });
}

/**
 * The `write_id` (and, when it is null, the `audit_reason`) of one note
 * write, as receipt fields.
 *
 * The bytes land before the event is appended, so `write_id: null` is a
 * state the caller has to be able to see: the note exists and nothing
 * attributes it. Both keys are always spelled together - the receipt
 * never carries a bare null - so an agent reading the reply learns which
 * of the two happened rather than inferring it from an absence.
 */
export function auditFields(audit: NoteWriteAudit): Record<string, unknown> {
  return {
    write_id: audit.write_id,
    ...(audit.audit_reason !== undefined ? { audit_reason: audit.audit_reason } : {}),
  };
}

/**
 * The refresh-claim marker a landed create or content edit carries on
 * its receipt, in the same vocabulary the note-lifecycle tool renders:
 * `index_refresh` is `claimed` (a detached run is IN FLIGHT, never
 * landed) or `not_claimed`, and `index_refresh_reason` spells why
 * nothing was started - the freshen machinery's own skip token, or the
 * error it raised. Both keys render together or not at all: a write
 * that authored no bytes claims nothing, and its receipt is
 * byte-identical to the one that shipped before this field existed.
 */
export function refreshClaimFields(claim: PostWriteRefreshClaim): Record<string, unknown> {
  return {
    index_refresh: claim.refresh,
    index_refresh_reason: claim.refreshReason,
  };
}

/**
 * The absolute-path advisory a kernel result computed over the call's
 * authored content, passed through under its own key. Byte-identical-
 * when-absent: a clean write contributes nothing, exactly as the page
 * lint does at the envelope level. The kernel already advises - this
 * only lets the receipt say it.
 */
export function pathAdvisoryFields(result: NoteOpResult): WritePathAdvisoryField {
  const report = result[WRITE_PATH_ADVISORY_KEY];
  return report === undefined ? {} : { [WRITE_PATH_ADVISORY_KEY]: report };
}

/** The kernel results that name a note file: exactly the three note ops. */
export type NoteOpResult = Extract<WriteBatchOpResult, { readonly path: string }>;

/** The single-note operations these two handlers submit. */
export type SingleNoteOperation = UpdateNoteOperation | AppendNoteOperation;

/**
 * Run a single-operation write batch and unwrap its one result, mapping
 * a typed {@link WriteBatchError} to a structured INVALID_PARAMS.
 *
 * The result kind is tied to the operation kind, so the caller reads the
 * kernel's own success flag back without restating it. This used to
 * return `path: "path" in only ? only.path : ""` - an unreachable arm
 * that, had it ever been reached, would have reported a successful write
 * at no path at all. A result whose kind does not match the operation is
 * a broken contract between this layer and the kernel, so it is raised as
 * one rather than papered over with an empty string.
 */
export function runSingleWrite<K extends SingleNoteOperation["kind"]>(
  ctx: ServerContext,
  op: Extract<SingleNoteOperation, { readonly kind: K }>,
  tool: string,
): Extract<NoteOpResult, { readonly kind: K }> {
  let batch;
  try {
    // A target the caller may not read at its reach is refused exactly
    // as a missing one. The transport-minted identity rides along as the
    // batch's subject (write-side-trust, Task 7): a token's update or
    // append answers for the token's agent, in the owner gate and the
    // deny-only document consult alike.
    batch = applyWriteBatch(ctx.vault, [op], {
      readable: readableAtContextReach(ctx),
      ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
      ...(ctx.requestIdentity !== undefined ? { subject: ctx.requestIdentity } : {}),
    });
  } catch (err) {
    throw writeBatchErrorToMcp(err, tool);
  }
  const only = batch.results[0]!;
  if (only.kind !== op.kind) {
    throw new MCPError(
      INTERNAL_ERROR,
      `${tool}: the write kernel returned a '${only.kind}' result for a '${op.kind}' operation`,
    );
  }
  return only as Extract<NoteOpResult, { readonly kind: K }>;
}

/**
 * The one write-result envelope, adopted by all four note-write tools
 * (evidence-at-the-boundary, task A4).
 *
 * Before this there was no shared envelope at all: four handlers
 * hand-built four shapes, two of them hardcoding a success flag the
 * kernel result already carried. This composes the tool's own receipt
 * with the write-time page lint over exactly the pages the call
 * committed.
 *
 * The lint runs AFTER the commit and reads what is on disk, because the
 * batch kernel wrote the bytes and the handler never composed them. It
 * never gates the write, and it contributes NO key when there is nothing
 * to say - so a receipt for a clean write is byte-identical to the one
 * that shipped before. `pages` empty (a skipped create, a log-only batch)
 * means no bytes were authored, so there is nothing to lint.
 *
 * The lint answers at the caller's reach: a near-duplicate sibling the
 * caller may not read is never named, scored or counted on the receipt, a
 * wikilink to a withheld Brain page reads as broken, and a merge chain
 * ends at its first withheld hop, as they would if the page were absent.
 *
 * With `near_duplicate_write_widening_enabled` on, the near-duplicate hint
 * also compares the pages with keyword-index candidates from other
 * directories ({@link collectWideningCandidates}), and the report states
 * whether that ran. With the key off nothing is opened and the receipt is
 * exactly the one that shipped before.
 *
 * Under an open route scope the lint is timed as the `lint` stage and the
 * widening as `near_duplicate_lookup`, the stage the lint's own
 * near-duplicate scoring also adds to.
 */
export async function noteWriteResult<T extends Record<string, unknown>>(
  ctx: ServerContext,
  pages: ReadonlyArray<string>,
  receipt: T,
): Promise<T & PageLintField> {
  if (pages.length === 0) return receipt;
  const readable = readableAtContextReach(ctx);
  const widening = await timeStage(ROUTE_STAGE.nearDuplicateLookup, () =>
    widenNearDuplicates(ctx, pages, readable),
  );
  const opts: LintWrittenPagesOptions =
    widening === undefined
      ? { readable }
      : {
          readable,
          extraCandidates: widening.candidates,
          widening: widening.status,
          ...(widening.detail !== undefined ? { wideningDetail: widening.detail } : {}),
        };
  const report = timeStageSync(ROUTE_STAGE.lint, () => lintWrittenPages(ctx.vault, pages, opts));
  return { ...receipt, ...pageLintField(report) };
}

/**
 * Keyword-index candidates for the near-duplicate hint, or `undefined`
 * when widening is off. A search config that does not resolve leaves no
 * index to read, which is the same named `index_unavailable` an index
 * that will not open reports, with the failure named in its detail: the
 * write is never failed by its hint.
 */
export async function widenNearDuplicates(
  ctx: ServerContext,
  pages: ReadonlyArray<string>,
  readable: ReadableRef,
): Promise<WideningResult | undefined> {
  const configPath = ctx.configPath ?? undefined;
  if (!resolveNearDuplicateWriteWideningEnabled(configPath)) return undefined;
  let config: ResolvedSearchConfig;
  try {
    config = resolveSearchConfig({ vault: ctx.vault, configPath });
  } catch (err) {
    return wideningUnavailable(err);
  }
  return collectWideningCandidates(config, ctx.vault, pages, readable);
}

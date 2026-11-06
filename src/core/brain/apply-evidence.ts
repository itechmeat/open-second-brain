/**
 * apply-evidence event appender.
 *
 * `apply-evidence` is the canonical durable signal that a preference was
 * exercised against real work. It is the only log event that drives the
 * `unconfirmed → confirmed` transition and the `applied_count` /
 * `violated_count` / `last_evidence_at` counters that `dream` recomputes
 * on every run.
 *
 * Surface:
 *
 *   - {@link appendApplyEvidence} writes one apply-evidence entry to
 *     `Brain/log/<today>.md`. The file is created on the first event of
 *     the day; subsequent calls append. Returns the resolved log path
 *     and the ISO timestamp used in the heading.
 *
 *   - {@link BrainPreferenceNotFoundError} is the typed failure surface
 *     for the "wrong pref_id" path. The CLI in Task 6 catches it and
 *     exits with code 2 (informative, not error). We deliberately use a
 *     distinct error class so callers can pattern-match on it without
 *     a `.message.includes()` regex.
 *
 * The check on the preference is intentionally cheap: we resolve the
 * preference path under `Brain/preferences/<pref_id>.md` and verify it
 * exists + parses. We don't update the preference file from here —
 * `dream` is the only writer of preference frontmatter (counters,
 * confidence, status); `apply-evidence` only records the event. That
 * keeps the log as the single source of truth for evidence counts and
 * lets `dream` stay deterministic from the log alone.
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { vaultRelative } from "../path-safety.ts";
import { sanitiseTextField } from "../redactor.ts";
import {
  computePayloadHash,
  IdempotencyPayloadMismatchError,
  lookupKey,
  REMEMBER_KEY_STATUS,
  rememberKey,
} from "./idempotency-ledger.ts";
import {
  appendLogEvent,
  logEventPrivacyContent,
  type AppendLogEventResult,
  type BrainLogEntry,
} from "./log.ts";
import { dualWrite, isDualWriteEnabled } from "../store/dual-write.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { isPrivatePageFile, preferenceEvidenceRecord } from "../store/dual-write-records.ts";
import {
  callerInput,
  opaqueFields,
  operationPrivacy,
  type OperationPrivacy,
  type PrivacyVerdict,
} from "../store/operation-privacy.ts";
import { parsePreference } from "./preference.ts";
import { preferencePath, validateSlug } from "./paths.ts";
import { isoSecond } from "./time.ts";
import { checkRolePermission } from "./trust/check-role-permission.ts";
import { BRAIN_OPERATIONS, type BrainRole } from "./trust/role.ts";
import { renderPrefLink } from "./wikilink.ts";
import {
  BRAIN_APPLY_OUTCOME,
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  type BrainApplyOutcome,
  type BrainApplyResult,
} from "./types.ts";

const ARTIFACT_MAX_LEN = 512;
const NOTE_MAX_LEN = 4096;

/**
 * Thrown by {@link appendApplyEvidence} when the targeted preference
 * does not exist on disk. The CLI surfaces this as exit code 2 (not an
 * error per se — the agent referenced an unknown rule and the operator
 * should learn about it without the run looking like a crash).
 */
export class BrainPreferenceNotFoundError extends Error {
  readonly prefId: string;
  readonly searchedPath: string;

  constructor(prefId: string, searchedPath: string) {
    super(
      `preference not found: ${prefId}; expected ${searchedPath}. ` +
        "Use `o2b brain query` to list active preferences.",
    );
    this.name = "BrainPreferenceNotFoundError";
    this.prefId = prefId;
    this.searchedPath = searchedPath;
  }
}

/**
 * Thrown when {@link appendApplyEvidence} is called with a role that
 * is not permitted to record evidence (v0.10.16).
 */
export class BrainRolePermissionError extends Error {
  readonly role: BrainRole;

  constructor(role: BrainRole, reason: string) {
    super(`apply-evidence permission denied for role '${role}': ${reason}`);
    this.name = "BrainRolePermissionError";
    this.role = role;
  }
}

/** Input contract for {@link appendApplyEvidence}. */
export interface AppendApplyEvidenceInput {
  /**
   * Preference id, with or without the `pref-` prefix. Both
   * `pref-foo` and `foo` are accepted so the CLI and MCP layers can
   * be lenient about how callers spell the target.
   */
  readonly pref_id: string;
  /**
   * Wikilink target of the artifact where the rule was applied
   * (`[[Daily/2026.05.14#section]]`, `[[blog-header-draft]]`, …).
   * The string is recorded verbatim — we do not validate the link
   * resolves; the user's workflow chooses the convention.
   */
  readonly artifact: string;
  readonly result: BrainApplyResult;
  readonly agent: string;
  readonly note?: string;
  /**
   * Downstream outcome of the artifact the rule was applied to
   * (t_d478df53). Optional and additive: `unknown` is treated like an
   * absent outcome, only `success`/`failure` persist in the log.
   */
  readonly outcome?: BrainApplyOutcome;
  /**
   * Client-supplied idempotency key (C1 / t_213f356b). Additive and
   * optional: absent → byte-identical to the historical append path.
   * When present, the appender hashes the semantic payload (pref id,
   * artifact, result, agent, note, outcome) and consults the idempotency
   * ledger before appending. A repeat with the same key + same payload is
   * a deduped no-op (no second log row); the same key + a different
   * payload throws {@link IdempotencyPayloadMismatchError}.
   */
  readonly idempotency_key?: string;
}

export interface AppendApplyEvidenceOptions {
  /**
   * Override the wall clock. Defaults to `new Date()`. Tests pin this
   * so the resulting log entry is byte-deterministic.
   */
  readonly now?: Date;
  /**
   * Caller role (v0.10.16). When provided, the role-permission gate
   * runs and rejects calls from roles that are not allowed to record
   * evidence. Legacy callers that omit the field bypass the gate -
   * the default is to preserve pre-v0.10.16 behaviour.
   */
  readonly role?: BrainRole;
  /**
   * The vault-relative paths the caller may read. A preference file it
   * may not read is refused with {@link BrainPreferenceNotFoundError}
   * exactly as a missing one is, before anything is written. Absent,
   * every preference counts.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * The privacy verdict of an enclosing operation (a write batch), which
   * every store record of this call inherits (`store/operation-privacy.ts`).
   */
  readonly storePrivate?: PrivacyVerdict;
}

/**
 * Does `prefFilePath` name a preference the caller may record evidence
 * against? A file the caller may not read answers as a missing one.
 */
export function isApplyEvidenceTargetPresent(
  vault: string,
  prefFilePath: string,
  readable: ((rel: string) => boolean) | undefined,
): boolean {
  if (!existsSync(prefFilePath)) return false;
  return readable === undefined || readable(vaultRelative(prefFilePath, vault));
}

export interface AppendApplyEvidenceResult {
  /** ISO-8601 UTC timestamp written to the log heading. */
  readonly logged_at: string;
  /** Absolute path of the log file the event landed in. */
  readonly log_path: string;
  /**
   * Set to `true` when an `idempotency_key` matched a prior append with an
   * identical payload, so this call was a deduped no-op (no second row).
   * The returned `logged_at`/`log_path` point at the ORIGINAL event.
   * Absent on a normal append.
   */
  readonly deduped?: boolean;
}

/** A validated evidence call: its target and the event body it appends. */
interface PreparedEvidence {
  readonly prefFilePath: string;
  readonly target: ReturnType<typeof parsePreference>;
  /** The event body, as the call hands it to the log appender. */
  readonly body: Record<string, string>;
}

/**
 * Validate one evidence call and render the event body it appends. Shared
 * by {@link appendApplyEvidence} and {@link applyEvidencePrivacy}, so the
 * privacy a write batch judges before it commits is judged from the very
 * body the append writes.
 */
function prepareEvidence(
  vault: string,
  input: AppendApplyEvidenceInput,
  readable: ((rel: string) => boolean) | undefined,
): PreparedEvidence {
  if (!input.pref_id || !input.pref_id.trim()) {
    throw new Error("apply-evidence missing field: pref_id");
  }
  // Sanitise free-form fields up-front so a pure-control-char input
  // falls into the "missing-field" branch instead of into YAML.
  const artifact = sanitiseTextField(input.artifact, {
    maxLen: ARTIFACT_MAX_LEN,
    singleLine: true,
  });
  const note =
    input.note !== undefined ? sanitiseTextField(input.note, { maxLen: NOTE_MAX_LEN }) : undefined;
  if (!artifact || !artifact.trim()) {
    throw new Error("apply-evidence missing field: artifact");
  }
  if (!input.agent || !input.agent.trim()) {
    throw new Error("apply-evidence missing field: agent");
  }
  if (
    input.result !== BRAIN_APPLY_RESULT.applied &&
    input.result !== BRAIN_APPLY_RESULT.violated &&
    input.result !== BRAIN_APPLY_RESULT.outdated
  ) {
    throw new Error(
      `apply-evidence field 'result' must be 'applied', 'violated', or 'outdated'; got ${JSON.stringify(input.result)}`,
    );
  }
  if (
    input.outcome !== undefined &&
    input.outcome !== BRAIN_APPLY_OUTCOME.success &&
    input.outcome !== BRAIN_APPLY_OUTCOME.failure &&
    input.outcome !== BRAIN_APPLY_OUTCOME.unknown
  ) {
    throw new Error(
      `apply-evidence field 'outcome' must be 'success', 'failure', or 'unknown'; got ${JSON.stringify(input.outcome)}`,
    );
  }

  // Resolve and validate the preference file. We accept both the bare
  // slug (`foo`) and the prefixed id (`pref-foo`) for caller comfort.
  const rawId = input.pref_id.trim();
  const slug = rawId.startsWith("pref-") ? rawId.slice("pref-".length) : rawId;
  if (!slug) {
    throw new Error(`apply-evidence: invalid pref_id (empty slug): ${input.pref_id}`);
  }
  validateSlug(slug);
  const prefFilePath = preferencePath(vault, slug);
  if (!isApplyEvidenceTargetPresent(vault, prefFilePath, readable)) {
    throw new BrainPreferenceNotFoundError(`pref-${slug}`, prefFilePath);
  }
  // Parse so a corrupted target produces a meaningful error rather
  // than silently appending an evidence row that points at garbage.
  // The parsed pref also supplies the principle used to title the
  // wikilink we emit below.
  const target = parsePreference(prefFilePath);
  const wikilink = renderPrefLink({ id: target.id, principle: target.principle });

  // Render the canonical payload. Ordering is deliberate: the wikilink
  // to the preference comes first so a human scrolling the log finds
  // the target rule immediately; the result follows so the reader sees
  // "what happened" before the optional note. Keys not present in the
  // input are omitted so the file stays as small as possible.
  const body: Record<string, string> = {
    preference: wikilink,
    artifact: artifact.trim(),
    agent: input.agent.trim(),
    result: input.result,
  };
  if (
    input.outcome === BRAIN_APPLY_OUTCOME.success ||
    input.outcome === BRAIN_APPLY_OUTCOME.failure
  ) {
    body["outcome"] = input.outcome;
  }
  const trimmedNote = note?.trim();
  if (trimmedNote) body["note"] = trimmedNote;
  return { prefFilePath, target, body };
}

/**
 * The privacy verdict of one evidence call (`store/operation-privacy.ts`):
 * private when the target preference is private or cannot be judged, when
 * the event body or any field of the caller's `input` (its idempotency
 * key included) names a private or unresolvable page or carries a
 * `<private>` region, or when `inherit` (an enclosing operation) is.
 */
function evidencePrivacy(
  vault: string,
  input: AppendApplyEvidenceInput,
  prepared: PreparedEvidence,
  inherit?: PrivacyVerdict,
): OperationPrivacy {
  return operationPrivacy(vault, {
    target: () => isPrivatePageFile(prepared.prefFilePath),
    content: [logEventPrivacyContent(prepared.body), callerInput(input, EVIDENCE_INPUT_OPAQUE)],
    inherit: [inherit],
  });
}

/** Opaque fields of an evidence call's input: its idempotency key. */
const EVIDENCE_INPUT_OPAQUE: ReadonlySet<string> = opaqueFields();

/**
 * The privacy verdict {@link appendApplyEvidence} would give `input`, for
 * an enclosing operation (a write batch) that judges itself before it
 * commits. A call that would be refused cannot be judged and counts as
 * private.
 */
export function applyEvidencePrivacy(
  vault: string,
  input: AppendApplyEvidenceInput,
  readable?: (rel: string) => boolean,
): OperationPrivacy {
  let prepared: PreparedEvidence;
  try {
    prepared = prepareEvidence(vault, input, readable);
  } catch {
    return () => true;
  }
  return evidencePrivacy(vault, input, prepared);
}

/**
 * Append one `apply-evidence` event to today's log. Throws
 * {@link BrainPreferenceNotFoundError} when the preference id does not
 * resolve to a file under `Brain/preferences/`.
 *
 * The log file is created on the first event of the day (the appender
 * inside `log.ts` handles that transparently). Subsequent calls on the
 * same UTC day append.
 */
export function appendApplyEvidence(
  vault: string,
  input: AppendApplyEvidenceInput,
  opts: AppendApplyEvidenceOptions = {},
): AppendApplyEvidenceResult {
  if (opts.role !== undefined) {
    const verdict = checkRolePermission(opts.role, BRAIN_OPERATIONS.evidence_record);
    if (!verdict.allowed) {
      throw new BrainRolePermissionError(opts.role, verdict.reason ?? "denied");
    }
  }
  const prepared = prepareEvidence(vault, input, opts.readable);
  const { target, body } = prepared;
  // One privacy verdict for every store record this call writes: the log
  // event, the idempotency receipt and the evidence record. It is judged
  // once, before anything is appended, so it follows the preference as
  // read here even if the file is rewritten or retired meanwhile. Judged
  // only when the dual write is on (with it off nothing changes).
  const privacy = evidencePrivacy(vault, input, prepared, opts.storePrivate);
  if (isDualWriteEnabled()) privacy();
  // Every store record written from here on, by this call or by any
  // writer it calls, carries this verdict (`store/operation-scope.ts`).
  return withOperationPrivacy(privacy, () => {
    const now = opts.now ?? new Date();
    const timestamp = isoSecond(now);

    // Idempotency consult (C1): a repeat with the same key + same payload
    // dedupes (no second row); the same key + a different payload throws
    // before appending. The hash covers the rendered event body — exactly
    // what would land in the log.
    const idKey = input.idempotency_key?.trim();
    let idContentHash: string | undefined;
    if (idKey) {
      idContentHash = computePayloadHash(body);
      const existing = lookupKey(vault, idKey);
      if (existing) {
        if (existing.contentHash === idContentHash) {
          const ref = (existing.ref ?? {}) as { logged_at?: string; log_path?: string };
          return {
            logged_at: ref.logged_at ?? timestamp,
            log_path: ref.log_path ? join(vault, ref.log_path) : "",
            deduped: true,
          };
        }
        throw new IdempotencyPayloadMismatchError(idKey, existing.contentHash, idContentHash);
      }
    }

    const entry: BrainLogEntry = {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body,
    };
    const result: AppendLogEventResult = appendLogEvent(vault, entry, { storePrivate: privacy });

    // Record the key AFTER the row lands so a future retry dedupes. Under a
    // concurrent same-key race the unlocked lookupKey above can miss a rival
    // write; rememberKey re-checks under its shard lock and returns the verdict,
    // which we MUST act on (the ledger never throws — the writer decides).
    if (idKey && idContentHash !== undefined) {
      const remembered = rememberKey(vault, {
        key: idKey,
        contentHash: idContentHash,
        createdAt: timestamp,
        ref: { logged_at: timestamp, log_path: relative(vault, result.logPath) },
        private: privacy,
      });
      if (remembered.status === REMEMBER_KEY_STATUS.payload_mismatch) {
        throw new IdempotencyPayloadMismatchError(
          idKey,
          remembered.record.contentHash,
          idContentHash,
        );
      }
      if (remembered.status === REMEMBER_KEY_STATUS.duplicate_match) {
        // A rival process won the key with the same payload between our unlocked
        // lookup and this locked record; report the winner's row as the deduped
        // result instead of a second normal write.
        const ref = (remembered.record.ref ?? {}) as { logged_at?: string; log_path?: string };
        return {
          logged_at: ref.logged_at ?? timestamp,
          log_path: ref.log_path ? join(vault, ref.log_path) : result.logPath,
          deduped: true,
        };
      }
    }

    // Brain store dual write (task 1.11): the log event above is dual-written
    // by the log appender; the evidence record feeds the preference fold's
    // counters. Off by default, never fails this append.
    dualWrite(
      () =>
        preferenceEvidenceRecord({
          id: target.id,
          result: input.result,
          artifact: body["artifact"]!,
          agent: body["agent"]!,
          private: privacy(),
        }),
      { vault },
    );

    return { logged_at: timestamp, log_path: result.logPath };
  });
}

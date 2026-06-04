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

import { sanitiseTextField } from "../redactor.ts";
import { appendLogEvent, type AppendLogEventResult, type BrainLogEntry } from "./log.ts";
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
}

export interface AppendApplyEvidenceResult {
  /** ISO-8601 UTC timestamp written to the log heading. */
  readonly logged_at: string;
  /** Absolute path of the log file the event landed in. */
  readonly log_path: string;
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
  if (!existsSync(prefFilePath)) {
    throw new BrainPreferenceNotFoundError(`pref-${slug}`, prefFilePath);
  }
  // Parse so a corrupted target produces a meaningful error rather
  // than silently appending an evidence row that points at garbage.
  // The parsed pref also supplies the principle used to title the
  // wikilink we emit below.
  const target = parsePreference(prefFilePath);

  const now = opts.now ?? new Date();
  const timestamp = isoSecond(now);
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

  const entry: BrainLogEntry = {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
    body,
  };
  const result: AppendLogEventResult = appendLogEvent(vault, entry);
  return { logged_at: timestamp, log_path: result.logPath };
}

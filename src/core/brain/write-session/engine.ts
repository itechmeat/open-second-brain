/**
 * Write-session engine (Agent Write Contract Suite, t_bc36a8a2).
 *
 * The lifecycle the calling agent drives:
 *
 *   open  -> `needs-llm-step` envelope (prompt + schema hints +
 *            collision metadata when the target is occupied)
 *   submit-> `done` (validated, committed atomically)
 *          | `needs-correction` (machine-readable errors + compact
 *            correction prompt; session state preserved)
 *          | `needs-review` (validated, parked for operator approve)
 *          | `failed` (retry cap exhausted - terminal)
 *   approve / abandon -> operator-side terminal transitions.
 *
 * Hard rules, enforced here and only here:
 *   - OSB never generates content; every artifact byte comes from the
 *     caller. Fail-closed: nothing lands unless validation is clean.
 *   - `create` intent NEVER overwrites; `overwrite` replaces;
 *     `merge` appends a session-stamped delimited section - existing
 *     bytes are preserved verbatim in both non-destructive modes.
 *   - Every terminal transition appends exactly one `write-session`
 *     audit event through the existing log chokepoint.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { appendLogEvent } from "../log.ts";
import { loadSchemaPack } from "../schema-pack.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { createWriteSession, readWriteSession, saveWriteSession } from "./store.ts";
import {
  buildCorrectionPrompt,
  inspectExistingTarget,
  validateArtifact,
  validateTargetPath,
} from "./validate.ts";
import {
  isTerminalWriteSessionStatus,
  type ExistingTargetInfo,
  type WriteSessionEnvelope,
  type WriteSessionError,
  type WriteSessionIntent,
  type WriteSessionRecord,
} from "./types.ts";

export const DEFAULT_RETRY_CAP = 3;
export const DEFAULT_TTL_MS = 24 * 3600 * 1000;

/** Structured request failure - carries the machine-readable errors. */
export class WriteSessionRequestError extends Error {
  readonly errors: ReadonlyArray<WriteSessionError>;

  constructor(message: string, errors: ReadonlyArray<WriteSessionError> = []) {
    super(message);
    this.name = "WriteSessionRequestError";
    this.errors = errors;
  }
}

export interface OpenArtifactSessionInput {
  readonly agent: string;
  readonly targetPath: string;
  /** Operator/agent-supplied generation instruction; a default is built. */
  readonly prompt?: string;
  readonly schemaType?: string | null;
  readonly intent?: WriteSessionIntent;
  readonly requireReview?: boolean;
  readonly retryCap?: number;
  readonly ttlMs?: number;
  /** ISO timestamp; fixtures pass a constant for determinism. */
  readonly now?: string;
}

/** Open an artifact session; throws {@link WriteSessionRequestError} on a bad target. */
export function openArtifactSession(
  vault: string,
  input: OpenArtifactSessionInput,
): WriteSessionEnvelope {
  const targetErrors = validateTargetPath(input.targetPath);
  if (targetErrors.length > 0) {
    throw new WriteSessionRequestError(
      `target rejected: ${targetErrors[0]!.message}`,
      targetErrors,
    );
  }
  const now = resolveNow(input.now);
  const schemaType = input.schemaType?.trim() || null;
  const expiresAt = new Date(Date.parse(now) + normalizeTtlMs(input.ttlMs)).toISOString();
  const retryCap = normalizeRetryCap(input.retryCap);
  const record = createWriteSession(vault, now, (id) =>
    Object.freeze({
      id,
      kind: "artifact" as const,
      status: "needs-llm-step" as const,
      step: "artifact",
      agent: input.agent.trim() || "unknown",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      attempts: 0,
      retryCap,
      targetPath: input.targetPath,
      intent: input.intent ?? ("create" as const),
      requireReview: input.requireReview === true,
      prompt: input.prompt?.trim() || buildArtifactPrompt(input.targetPath, schemaType),
      schemaType,
      topic: null,
      personas: [],
      responses: {},
      pendingArtifact: null,
      lastErrors: [],
      failReason: null,
    }),
  );
  return sessionEnvelope(record, inspectExistingTarget(vault, record.targetPath));
}

export interface SubmitToSessionInput {
  readonly sessionId: string;
  readonly artifact: string;
  readonly now?: string;
}

/**
 * Submit the current step's text. Artifact sessions validate + commit;
 * panel sessions are routed by the caller through the panel module
 * (which reuses {@link acceptArtifactSubmission} semantics per step).
 */
export function submitToSession(vault: string, input: SubmitToSessionInput): WriteSessionEnvelope {
  const now = resolveNow(input.now);
  const session = loadLiveSession(vault, input.sessionId, now);
  if (session.kind !== "artifact") {
    throw new WriteSessionRequestError(
      `session ${session.id} is a '${session.kind}' session - submit through its kind-specific surface`,
    );
  }

  // Collision guard runs at COMMIT time, not just open time: the target
  // may have appeared between open and submit (another device, another
  // agent). `create` intent treats an occupied target as an error.
  const errors: WriteSessionError[] = [
    ...validateArtifactForSession(vault, session, input.artifact),
  ];
  if (session.intent === "create" && inspectExistingTarget(vault, session.targetPath) !== null) {
    errors.push(
      Object.freeze({
        code: "target-exists",
        path: "target",
        message:
          `${session.targetPath} already exists; reopen the session with overwrite or merge intent ` +
          "(or abandon)",
      }),
    );
  }

  if (errors.length > 0) {
    return recordFailedAttempt(vault, session, errors, now);
  }
  if (session.requireReview) {
    const parked: WriteSessionRecord = Object.freeze({
      ...session,
      status: "needs-review" as const,
      updatedAt: now,
      pendingArtifact: input.artifact,
      lastErrors: [],
      prompt: "Awaiting operator review - no further generation needed.",
    });
    saveWriteSession(vault, parked);
    return sessionEnvelope(parked);
  }
  return commitArtifact(vault, session, input.artifact, now);
}

export interface SessionOpInput {
  readonly sessionId: string;
  readonly now?: string;
}

/** Operator-side approval of a `needs-review` session. */
export function approveSession(vault: string, input: SessionOpInput): WriteSessionEnvelope {
  const now = resolveNow(input.now);
  const session = loadLiveSession(vault, input.sessionId, now);
  if (session.status !== "needs-review" || session.pendingArtifact === null) {
    throw new WriteSessionRequestError(
      `session ${session.id} is not awaiting review (status: ${session.status})`,
    );
  }
  return commitArtifact(vault, session, session.pendingArtifact, now);
}

/** Terminal abandon; safe on any non-terminal session. */
export function abandonSession(vault: string, input: SessionOpInput): WriteSessionEnvelope {
  const now = resolveNow(input.now);
  const session = loadLiveSession(vault, input.sessionId, now);
  const abandoned: WriteSessionRecord = Object.freeze({
    ...session,
    status: "failed" as const,
    updatedAt: now,
    failReason: "abandoned",
    pendingArtifact: null,
  });
  saveWriteSession(vault, abandoned);
  auditTerminal(vault, abandoned, now);
  return sessionEnvelope(abandoned);
}

/** Envelope view of a session record (status/list surfaces). */
export function sessionEnvelope(
  session: WriteSessionRecord,
  existing: ExistingTargetInfo | null = null,
): WriteSessionEnvelope {
  return Object.freeze({
    status: session.status,
    session_id: session.id,
    kind: session.kind,
    step: session.step,
    prompt: session.prompt,
    schema_hints: buildSchemaHints(session),
    errors: session.lastErrors,
    attempts_left: Math.max(0, session.retryCap - session.attempts),
    expires_at: session.expiresAt,
    target_path: session.targetPath,
    existing,
  });
}

// ----- Shared internals (panel module reuses these) -------------------------

export function resolveNow(now: string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  const ts = Date.parse(now);
  if (Number.isNaN(ts)) {
    throw new WriteSessionRequestError(`invalid 'now' timestamp: ${now}`);
  }
  return new Date(ts).toISOString();
}

/** TTL must be a positive integer; reject before any date arithmetic. */
function normalizeTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new WriteSessionRequestError(`ttlMs must be a positive integer, got: ${ttlMs}`);
  }
  return ttlMs;
}

function normalizeRetryCap(cap: number | undefined): number {
  if (cap === undefined) return DEFAULT_RETRY_CAP;
  if (!Number.isInteger(cap) || cap < 1 || cap > 20) {
    throw new WriteSessionRequestError(`retry cap must be an integer in [1, 20], got: ${cap}`);
  }
  return cap;
}

/**
 * Load a session that can still accept operations. An expired-on-read
 * session is persisted as failed (the lazy-TTL transform becomes
 * durable the moment anyone touches the session) and then refused.
 */
export function loadLiveSession(vault: string, id: string, now: string): WriteSessionRecord {
  const probe = readWriteSession(vault, id, now);
  if (probe.error !== null) {
    throw new WriteSessionRequestError(probe.error);
  }
  if (probe.session === null) {
    throw new WriteSessionRequestError(`unknown write-session: ${id}`);
  }
  const session = probe.session;
  if (isTerminalWriteSessionStatus(session.status)) {
    if (probe.expiredOnRead) {
      // The TTL transform fired on THIS read (disk record was still
      // non-terminal): make the expiry durable + audited exactly once.
      // A record already terminal on disk skips both.
      saveWriteSession(vault, session);
      auditTerminal(vault, session, now);
    }
    throw new WriteSessionRequestError(
      `write-session ${id} is terminal (${session.status}${
        session.failReason ? `/${session.failReason}` : ""
      })`,
    );
  }
  return session;
}

export function validateArtifactForSession(
  vault: string,
  session: WriteSessionRecord,
  artifact: string,
): ReadonlyArray<WriteSessionError> {
  return validateArtifact(artifact, {
    schemaType: session.schemaType,
    vocabulary: loadSchemaPack(vault).vocabulary,
  });
}

/** Failed attempt bookkeeping shared by artifact and panel steps. */
export function recordFailedAttempt(
  vault: string,
  session: WriteSessionRecord,
  errors: ReadonlyArray<WriteSessionError>,
  now: string,
): WriteSessionEnvelope {
  const attempts = session.attempts + 1;
  if (attempts >= session.retryCap) {
    const failed: WriteSessionRecord = Object.freeze({
      ...session,
      status: "failed" as const,
      attempts,
      updatedAt: now,
      lastErrors: errors,
      failReason: "retry-cap",
      pendingArtifact: null,
    });
    saveWriteSession(vault, failed);
    auditTerminal(vault, failed, now);
    return sessionEnvelope(failed);
  }
  const corrected: WriteSessionRecord = Object.freeze({
    ...session,
    status: "needs-correction" as const,
    attempts,
    updatedAt: now,
    lastErrors: errors,
    prompt: buildCorrectionPrompt(errors),
  });
  saveWriteSession(vault, corrected);
  return sessionEnvelope(corrected);
}

/** Validated commit + terminal bookkeeping (artifact and panel share it). */
export function commitArtifact(
  vault: string,
  session: WriteSessionRecord,
  artifact: string,
  now: string,
): WriteSessionEnvelope {
  // Last-line-of-defense containment: `validateTargetPath` runs at open
  // time and is purely lexical (it rejects `..`/backslashes/NUL but is
  // blind to symlinked ancestors), and the persisted session record is
  // decoupled from that check. Re-resolve at the write chokepoint so a
  // target that lands outside the vault - e.g. `Brain/<symlink>/x.md`
  // whose ancestor links out - is rejected before any mkdir/read/write.
  const absolute = ensureInsideVault(join(vault, session.targetPath), vault);
  // Last-line-of-defense collision guard: submit-time checks cannot
  // cover the window between a needs-review park and the operator's
  // approve - if the target appeared meanwhile, `create` must still
  // refuse to overwrite at the write chokepoint itself.
  if (session.intent === "create" && existsSync(absolute)) {
    return recordFailedAttempt(
      vault,
      session,
      [
        Object.freeze({
          code: "target-exists",
          path: "target",
          message:
            `${session.targetPath} already exists; reopen the session with overwrite or merge intent ` +
            "(or abandon)",
        }),
      ],
      now,
    );
  }
  const body = artifact.endsWith("\n") ? artifact : `${artifact}\n`;
  mkdirSync(dirname(absolute), { recursive: true });
  if (session.intent === "merge" && existsSync(absolute)) {
    const existing = readFileSync(absolute, "utf8").replace(/\s+$/u, "");
    const merged = `${existing}\n\n<!-- o2b:ws-merge ${session.id} -->\n\n${body}`;
    atomicWriteFileSync(absolute, merged);
  } else {
    atomicWriteFileSync(absolute, body);
  }
  const done: WriteSessionRecord = Object.freeze({
    ...session,
    status: "done" as const,
    updatedAt: now,
    pendingArtifact: null,
    lastErrors: [],
    prompt: "Committed - no further generation needed.",
  });
  saveWriteSession(vault, done);
  auditTerminal(vault, done, now);
  return sessionEnvelope(done);
}

function buildArtifactPrompt(targetPath: string, schemaType: string | null): string {
  const schemaLine = schemaType ? ` The frontmatter must declare \`type: ${schemaType}\`.` : "";
  return (
    `Produce the complete markdown artifact for ${targetPath}. ` +
    "Start with a YAML frontmatter block (at minimum a `kind` key), follow with a heading and the body." +
    schemaLine +
    " Submit the full file content - it is validated before anything is written."
  );
}

function buildSchemaHints(session: WriteSessionRecord): ReadonlyArray<string> {
  const hints = [
    "frontmatter: required YAML block with at least one key",
    "format: UTF-8 markdown, no raw control characters",
  ];
  if (session.schemaType) hints.push(`type: ${session.schemaType} (frontmatter 'type' key)`);
  return Object.freeze(hints);
}

/** One audit row per terminal transition through the log chokepoint. */
export function auditTerminal(vault: string, session: WriteSessionRecord, now: string): void {
  appendLogEvent(vault, {
    timestamp: now.replace(/\.\d{3}Z$/u, "Z"),
    eventType: BRAIN_LOG_EVENT_KIND.writeSession,
    agent: session.agent,
    body: {
      session_id: session.id,
      kind: session.kind,
      status: session.status,
      target: session.targetPath,
      attempts: String(session.attempts),
      review: session.requireReview ? "required" : "not-required",
      ...(session.failReason ? { reason: session.failReason } : {}),
    },
  });
}

/**
 * Write-session contract types (Agent Write Contract Suite, t_bc36a8a2).
 *
 * One generic, file-backed session lifecycle serves every agent-facing
 * structured write: a caller opens a session, receives a JSON envelope
 * telling it exactly what to generate, submits the artifact back, and
 * OSB validates locally before anything lands in the vault. The kernel
 * is provider-agnostic by construction - OSB never calls an LLM; the
 * calling agent owns generation, OSB owns sequencing, validation, and
 * the final atomic commit.
 *
 * The decision panel (t_0cc6fdff) is a session KIND on this kernel,
 * not a parallel lifecycle: panel-only state lives on the session
 * record; the envelope grammar below is shared and stable.
 */

/** Session kinds. `artifact` writes one note; `panel` deliberates. */
export type WriteSessionKind = "artifact" | "panel";

/**
 * Envelope statuses (design doc grammar, stable across CLI and MCP):
 *
 *   - `needs-llm-step`   - OSB needs the caller to generate the current
 *                          step's text (artifact body or persona answer).
 *   - `needs-correction` - the last submit failed validation; errors and
 *                          a compact correction prompt are attached and
 *                          the session state is preserved.
 *   - `needs-review`     - the artifact validated but the session was
 *                          opened with `require_review`; an operator
 *                          `approve` commits it.
 *   - `done`             - terminal; the artifact is committed.
 *   - `failed`           - terminal; retry cap, TTL expiry, or abandon.
 */
export type WriteSessionStatus =
  | "needs-llm-step"
  | "needs-correction"
  | "needs-review"
  | "done"
  | "failed";

/** Commit intent against an existing target path. */
export type WriteSessionIntent = "create" | "overwrite" | "merge";

/** Machine-readable validation error. */
export interface WriteSessionError {
  readonly code: string;
  /** What the error is about: a frontmatter key, `body`, `target`, ... */
  readonly path: string;
  readonly message: string;
}

/** One panel persona (loaded from Brain/personas/ or built-in). */
export interface WriteSessionPersona {
  readonly slug: string;
  readonly lens: string;
  readonly prompt: string;
}

/**
 * Persisted session record (`Brain/.sessions/write/<id>.json`,
 * snake_case on disk). Panel-only fields (`topic`, `personas`,
 * `responses`) stay empty for artifact sessions - the record shape is
 * uniform so the store stays kind-agnostic.
 */
export interface WriteSessionRecord {
  readonly id: string;
  readonly kind: WriteSessionKind;
  readonly status: WriteSessionStatus;
  /** Current step: `artifact`, `persona:<slug>`, or `synthesis`. */
  readonly step: string;
  readonly agent: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  /** Failed submits against the CURRENT step. */
  readonly attempts: number;
  readonly retryCap: number;
  /** Vault-relative commit target. */
  readonly targetPath: string;
  readonly intent: WriteSessionIntent;
  readonly requireReview: boolean;
  /** Generation prompt for the current step. */
  readonly prompt: string;
  /** Declared schema-pack type the artifact must satisfy, if any. */
  readonly schemaType: string | null;
  readonly topic: string | null;
  readonly personas: ReadonlyArray<WriteSessionPersona>;
  /** Accepted per-step submissions, keyed by step name. */
  readonly responses: Readonly<Record<string, string>>;
  /** Validated artifact awaiting operator approval (`needs-review`). */
  readonly pendingArtifact: string | null;
  readonly lastErrors: ReadonlyArray<WriteSessionError>;
  /** Terminal-failure reason: `retry-cap`, `expired`, `abandoned`. */
  readonly failReason: string | null;
}

/** Read probe mirroring the store conventions (git state, continuity). */
export interface WriteSessionProbe {
  readonly session: WriteSessionRecord | null;
  readonly error: string | null;
}

/**
 * The JSON envelope every operation returns. Stable grammar shared by
 * the CLI verb and the MCP tool; `existing` is populated only when the
 * target path already holds content the caller must decide about.
 */
export interface WriteSessionEnvelope {
  readonly status: WriteSessionStatus;
  readonly session_id: string;
  readonly kind: WriteSessionKind;
  readonly step: string;
  readonly prompt: string;
  readonly schema_hints: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<WriteSessionError>;
  readonly attempts_left: number;
  readonly expires_at: string;
  readonly target_path: string;
  readonly existing: ExistingTargetInfo | null;
}

/** Collision metadata for an already-occupied target path. */
export interface ExistingTargetInfo {
  readonly bytes: number;
  readonly content_hash: string;
  readonly first_heading: string | null;
}

export const WRITE_SESSION_TERMINAL_STATUSES: ReadonlySet<WriteSessionStatus> = new Set([
  "done",
  "failed",
]);

export function isTerminalWriteSessionStatus(status: WriteSessionStatus): boolean {
  return WRITE_SESSION_TERMINAL_STATUSES.has(status);
}

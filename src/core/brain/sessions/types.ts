/**
 * Public contract for `o2b brain import-session` adapters (§16).
 *
 * Each runtime (Claude Code, Codex CLI, Hermes, opencode) stores
 * chat transcripts in its own JSONL schema (opencode via the spool
 * the bundled plugin writes). An adapter normalises one
 * such schema into the `SessionTurn` shape so the orchestrator
 * (`sessions/import.ts`) can extract `@osb` markers from text and
 * replay `brain_feedback` tool-use calls without caring which
 * runtime wrote the file.
 *
 * Closed-set ID enum: extending to a new runtime requires adding a
 * new id literal here, a new module under `sessions/`, and a registry
 * entry — no other code path needs to change.
 */

export type SessionAdapterId = "claude" | "codex" | "hermes" | "opencode" | "grok";

export interface SessionToolCall {
  /** Tool name as emitted by the runtime, e.g. `brain_feedback`. */
  readonly name: string;
  /** Tool input as the runtime serialised it. Validated downstream. */
  readonly input: Record<string, unknown>;
  /** Optional tool-use id for tool_result correlation. */
  readonly id?: string;
}

export interface SessionTurn {
  /** Adapter-specific stable id (UUID / sequence / synthetic). */
  readonly turnId: string;
  /** ISO-8601 UTC. Adapters synthesize from epoch if the field is absent. */
  readonly timestamp: string;
  readonly role: "user" | "assistant" | "system" | "tool" | "meta";
  /** Flat-text view of the turn's content blocks; undefined for meta. */
  readonly text?: string;
  /** Tool-use blocks emitted by the agent in this turn. */
  readonly toolCalls?: ReadonlyArray<SessionToolCall>;
}

export interface SessionAdapter {
  readonly id: SessionAdapterId;
  /** Default `agent` label stamped on imported signals for this runtime. */
  readonly defaultAgent: string;
  /**
   * Match the first line of the session file. Adapters identify by
   * structural fields (`"originator":"codex_exec"`, `"role":"session_meta"`,
   * etc.), not fuzzy text. False positives across adapters are
   * unacceptable — they would silently mis-parse content.
   */
  detect(firstLine: string): boolean;
  /** Stream normalised turns from a single .jsonl file. */
  iterate(path: string): AsyncIterable<SessionTurn>;
}

/**
 * Typed error surface for the session import flow. `code` lets the
 * CLI map back to the §6.8 exit-code matrix:
 *
 *   - `DETECT_FAIL` — autodetect didn't recognise the file. Exit 2,
 *     user should pass `--format`.
 *   - `IO` — read / open failure. Exit 1.
 *   - `PARSE` — JSONL or per-line JSON failure. Exit 1.
 *   - `UNKNOWN_FORMAT` — `--format` argument doesn't match any
 *     registered adapter. Exit 2.
 */
export class SessionImportError extends Error {
  readonly code: "DETECT_FAIL" | "IO" | "PARSE" | "UNKNOWN_FORMAT";

  constructor(code: "DETECT_FAIL" | "IO" | "PARSE" | "UNKNOWN_FORMAT", message: string) {
    super(message);
    this.name = "SessionImportError";
    this.code = code;
  }
}

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
 *
 * An adapter no longer carries a `defaultAgent`. It duplicated `id` in all
 * five shipped adapters, and its single consumer stamped it onto every
 * imported signal ahead of the operator's own `--agent` - so three
 * runtimes attributed memory to `claude` / `codex` / `hermes`, strings
 * `normalizeAgentArgument` rejects as placeholders everywhere else, and
 * the flag the CLI validated could never take effect. Identity now comes
 * from the caller, or from the delegated turn itself.
 */

/**
 * The extension a session transcript is written with, stated once for
 * every consumer that has to decide whether a file is one.
 *
 * There were three answers to that question and they disagreed.
 * `session-files.ts` - the primitive extracted precisely so the two
 * walkers could not drift - accepted `.jsonl`; the Codex rows in
 * `src/core/runtime/host-facts.ts` declared `**` + `/*.json*`, so the
 * machine-wide sweep enrolled `.json` files that `import-session <dir>`
 * and `export --transcripts <dir>` then skipped without a word; and every
 * shipped adapter parses line-delimited JSON and can read neither a
 * pretty-printed `.json` nor anything else. This constant is the one
 * answer, and it sits in the vocabulary module because that is the only
 * thing `host-facts.ts` is allowed to import from here.
 *
 * Narrow rather than wide on purpose. Enrolling `.json` into discovery
 * does not make a `.json` importable - no adapter in this build can read
 * one - it only turns every such file into a `DETECT_FAIL` that drives
 * `--discover --all` to exit 1. Finding a file this build cannot parse is
 * worse than not finding it, because a failure an operator cannot fix is
 * indistinguishable from one they can.
 */
export const SESSION_FILE_EXTENSION = ".jsonl";

/**
 * What every adapter puts in {@link SessionTurn.timestamp} when the line
 * it read carried no usable one: the Unix epoch, as an ISO instant.
 *
 * `SessionTurn.timestamp` is not optional, so an adapter facing a line
 * without a clock has to write something, and all five write this. That
 * made the sentinel a real part of the contract while it was spelled
 * `new Date(0).toISOString()` in five files and described in prose in a
 * sixth (`resolveEventInstant`, which already reads `ms <= 0` as "no
 * timestamp"). A consumer that did not know the convention could not
 * distinguish "recorded at the epoch" from "not recorded", and the
 * transcript export's `--since` window did exactly that: it compared the
 * sentinel as an instant, found it before every realistic window, and
 * silently dropped the transcript - the outcome its own docblock forbids.
 *
 * Naming it is what lets a consumer ask the question. It is a SENTINEL,
 * not a time: code that means "is this turn inside a window" must check
 * for it before it parses.
 */
export const SESSION_TIMESTAMP_UNKNOWN = new Date(0).toISOString();

/**
 * The runtimes whose adapters ship in this tree.
 *
 * Closed, because it is what `--format` is validated against: a value that
 * arrives as a raw CLI string is either one of these or a typo, and
 * {@link isSessionAdapterId} is the boundary between the two. The registry
 * itself is keyed by `string` and open to a caller's own adapter
 * (`createSessionAdapterRegistry`), so this vocabulary answers "which
 * runtimes ship here", not "which adapters can exist" - and
 * `tests/core/brain/sessions/adapter-registry.test.ts` locks the two
 * together for the built-in registry.
 */
export const SESSION_ADAPTER_ID = Object.freeze({
  claude: "claude",
  codex: "codex",
  hermes: "hermes",
  opencode: "opencode",
  grok: "grok",
} as const);

export type SessionAdapterId = (typeof SESSION_ADAPTER_ID)[keyof typeof SESSION_ADAPTER_ID];

/** The shipped adapter ids, in registry order. */
export const SESSION_ADAPTER_IDS: ReadonlyArray<SessionAdapterId> = Object.freeze([
  SESSION_ADAPTER_ID.claude,
  SESSION_ADAPTER_ID.codex,
  SESSION_ADAPTER_ID.hermes,
  SESSION_ADAPTER_ID.opencode,
  SESSION_ADAPTER_ID.grok,
]);

export function isSessionAdapterId(value: unknown): value is SessionAdapterId {
  return (
    typeof value === "string" && (SESSION_ADAPTER_IDS as ReadonlyArray<string>).includes(value)
  );
}

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
  /**
   * Host-assigned id of the DELEGATED agent that wrote this turn.
   *
   * A sub-agent's transcript reuses its parent's session id, so the id is
   * the only thing distinguishing the two; present only where the runtime
   * records one, absent everywhere else so a flat transcript keeps the
   * pre-delegation shape exactly.
   */
  readonly agentId?: string;
  /**
   * True when the runtime marked this turn as a delegated sidechain turn.
   *
   * Only `true` is carried - an absent or false flag emits no key, for the
   * same reason the id does: an ordinary turn must stay byte-identical to
   * what it was before the boundary was readable.
   */
  readonly sidechain?: boolean;
}

export interface SessionAdapter {
  /**
   * Registry key. `string` rather than {@link SessionAdapterId} so that
   * registering an adapter is the ONE change adding a runtime requires -
   * a union here would make every new adapter a change to this file too,
   * and would put a test's own adapter outside the type system entirely.
   * The shipped adapters carry ids from {@link SESSION_ADAPTER_ID}.
   */
  readonly id: string;
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

/**
 * Read the full stdin payload Claude Code / Codex hand to a hook as one
 * JSON object. Both runtimes pass a single JSON document on stdin and
 * close the pipe; we read until EOF, parse once, and return the parsed
 * value. Empty payload returns `null` so the caller can short-circuit.
 */

export async function readHookInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return null;
  return JSON.parse(raw);
}

export interface HookPayloadBase {
  readonly session_id?: string;
  /**
   * Native session-lineage fields (continuity-hygiene-freshness
   * suite). Hosts that rotate the session id across a context
   * compression report the predecessor here; upstream Hermes PR
   * NousResearch/hermes-agent#42940 adds `parent_session_id` to the
   * shell-hook payload. All optional - a host without lineage simply
   * omits them and capture degrades to flat-id behavior.
   */
  readonly parent_session_id?: string | null;
  readonly root_session_id?: string | null;
  readonly compression_depth?: number | null;
  /** SessionStart discriminator (`startup|resume|clear|compact`). */
  readonly source?: string;
  readonly transcript_path?: string | null;
  readonly cwd?: string;
  readonly hook_event_name?: string;
  /** UserPromptSubmit: the submitted user prompt text. */
  readonly prompt?: string;
  readonly stop_hook_active?: boolean;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
}

/**
 * Grok Build delivers the hook event with camelCase keys and a snake_case
 * event VALUE (`hookEventName: "session_start"`), where Claude Code and Codex
 * use snake_case keys and a PascalCase value (`hook_event_name:
 * "SessionStart"`). Each tuple maps a grok key to its internal snake_case
 * equivalent; the optional transform reshapes the value. Verified against grok
 * 0.2.45 (`~/.grok/docs/user-guide/10-hooks.md`).
 */
const GROK_KEY_MAP: ReadonlyArray<readonly [string, string, ((v: unknown) => unknown)?]> = [
  ["hookEventName", "hook_event_name", snakeToPascalEvent],
  ["sessionId", "session_id"],
  ["toolName", "tool_name"],
  ["toolInput", "tool_input"],
  ["toolResponse", "tool_response"],
  ["parentSessionId", "parent_session_id"],
];

/**
 * Convert grok's snake_case event value to the canonical PascalCase the rest
 * of the hook layer compares against. Idempotent on a value that is already
 * PascalCase (Claude/Codex), so it is safe to apply unconditionally to the
 * grok-sourced field. Non-strings pass through untouched.
 */
function snakeToPascalEvent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .split("_")
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("");
}

/**
 * Normalize a raw hook payload into the internal snake_case shape. Grok's
 * camelCase fields are mapped to their snake_case equivalents (filling a key
 * only when it is not already present, so a Claude/Codex payload is returned
 * unchanged); the original keys are preserved so {@link detectHookRuntime} can
 * still recognize the grok shape. A non-object value passes through unchanged.
 */
export function normalizeHookPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };
  for (const [camelKey, snakeKey, transform] of GROK_KEY_MAP) {
    if (result[snakeKey] === undefined && source[camelKey] !== undefined) {
      result[snakeKey] = transform ? transform(source[camelKey]) : source[camelKey];
    }
  }
  return result;
}

export function asHookPayload(value: unknown): HookPayloadBase {
  const normalized = normalizeHookPayload(value);
  if (normalized !== null && typeof normalized === "object") {
    return normalized as HookPayloadBase;
  }
  return {};
}

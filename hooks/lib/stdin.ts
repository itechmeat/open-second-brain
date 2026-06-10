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
  readonly stop_hook_active?: boolean;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
}

export function asHookPayload(value: unknown): HookPayloadBase {
  if (value !== null && typeof value === "object") {
    return value as HookPayloadBase;
  }
  return {};
}

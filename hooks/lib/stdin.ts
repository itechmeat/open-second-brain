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

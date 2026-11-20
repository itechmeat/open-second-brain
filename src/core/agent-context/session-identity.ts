/**
 * The session a topic record was written in (owner check of concurrent
 * agents): several sessions of one agent name on one device (several
 * windows of one host, each with its own MCP server) are neighbours of
 * each other, so "mine" is the session, not the agent name and device.
 *
 * A writer that knows its session stamps the record body with
 * {@link SESSION_FIELD}: {@link sessionKey} of the session id, never the id
 * itself. The writer and the neighbour-updates hook resolve the stamp by
 * one rule, {@link sessionStamp}: {@link SESSION_ENV} when it is set (the
 * name the launcher gave the session, which the writer and the hook both
 * inherit from the host's environment), else the host's own session id
 * (for the writer, Claude Code's variable below; for the hook, the
 * payload's `session_id`). A record without the stamp (an older release,
 * a host that names no session to its MCP server, the CLI without
 * {@link SESSION_ENV}) keeps the older rule: same device and same agent
 * name is own.
 *
 * Verified inheritance: Claude Code gives its stdio MCP servers its whole
 * environment (the servers' `/proc/<pid>/environ` holds the variables of
 * the shell that started it) and its documentation says a hook process
 * inherits the parent environment. Codex (codex-cli 0.169.0) passes the
 * shell's environment to hooks but gives an MCP server only a short fixed
 * list unless its `env_vars` names a variable: there the variable stamps
 * nothing unless forwarded, and the records stay unstamped (own by device
 * and agent name), never mismatched. Setting the variable only in an MCP
 * server's own `env` block, where the hooks do not see it, gives the two
 * sides different stamps: each session is then shown its own records once.
 *
 * Where the session comes from, verified per host:
 *  - {@link SESSION_ENV}, set by whoever starts the writer, on every host.
 *    It must name one session and reach the writer and the hook alike.
 *    Several sessions that share one value share one stamp, so each takes
 *    the others' records for its own and none of them gets the others'
 *    neighbour updates. A value that reaches only one side (the writer
 *    stamps it, the hook resolves the host's id, or the other way round)
 *    gives the two sides different stamps, so each session is shown its
 *    own records once. It must also be hard to guess (the stamp is an
 *    unsalted hash, synced with the record);
 *  - Claude Code sets `CLAUDE_CODE_SESSION_ID` in the environment of the
 *    stdio MCP servers it starts, the same id its hooks receive as
 *    `session_id` (observed on Claude Code 2.1, not documented). It is
 *    read only when the server was started with `--harness claude-code`,
 *    so a process another host started from inside a Claude Code session
 *    never inherits that session.
 */

import { sha256Hex } from "../integrity/digest.ts";

/** The body field of a topic record that names its writing session. */
export const SESSION_FIELD = "session";

/** The environment variable any host may set to name the writer's session. */
export const SESSION_ENV = "OPEN_SECOND_BRAIN_SESSION_ID";

/** Claude Code's session variable in the environment of its MCP servers. */
const CLAUDE_CODE_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

/** Longest session id taken, in characters; a longer one is ignored. */
const SESSION_ID_MAX = 512;

/**
 * The stamp of session `id`: the first 32 lowercase hex characters of the
 * sha256 of the UTF-8 bytes of `open-second-brain-session`, one NUL
 * (U+0000) and the id (trimmed of surrounding white space by
 * {@link sessionStamp}).
 */
export function sessionKey(id: string): string {
  return sha256Hex(`open-second-brain-session\u0000${id}`).slice(0, 32);
}

function usable(value: string | undefined): string | null {
  if (value === undefined) return null;
  const id = value.trim();
  return id === "" || id.length > SESSION_ID_MAX ? null : id;
}

/**
 * The one rule both sides resolve a session's stamp by: {@link SESSION_ENV}
 * when it is set, since it is what the launcher named the session and the
 * writer and the hook inherit it alike; else the host's own session id;
 * null when neither is usable.
 */
export function sessionStamp(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hostSessionId: string | null | undefined;
}): string | null {
  const id = usable(input.env[SESSION_ENV]) ?? usable(input.hostSessionId ?? undefined);
  return id === null ? null : sessionKey(id);
}

/**
 * The stamp of the writer's session, or null when the writer names none:
 * {@link sessionStamp} with Claude Code's variable as the host's id for a
 * server started for Claude Code, and no host id otherwise.
 */
export function writerSessionKey(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly harness?: string | null;
}): string | null {
  return sessionStamp({
    env: input.env,
    hostSessionId: input.harness === "claude-code" ? input.env[CLAUDE_CODE_SESSION_ENV] : null,
  });
}

/** The session stamp of a record body, or undefined without a well-formed one. */
export function recordSessionOf(body: Readonly<Record<string, unknown>>): string | undefined {
  const value = body[SESSION_FIELD];
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

/**
 * Whether a record is this session's own: same device and agent name,
 * and either the record names no session or it names this one.
 */
export function isOwnRecord(
  row: { readonly device: string; readonly agent: string },
  recordSession: string | undefined,
  self: { readonly device: string; readonly agent: string; readonly session: string },
): boolean {
  if (row.device !== self.device || row.agent !== self.agent) return false;
  return recordSession === undefined || recordSession === self.session;
}

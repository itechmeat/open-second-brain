/**
 * Where a record a person would read was written: the project of the
 * session that wrote it and, where the host names one, the session id
 * (design D17, "What planning reads"). Topic planning groups the records of
 * one project into a topic and counts the sessions behind a group, so a
 * signal, a note or a decision that carries neither can never make a topic.
 *
 * The project is never a caller's word. It is the project key of the
 * session's working directory as the scoped standing rules resolve it
 * (`scope-identity.ts` `resolveProjectScope`): the directory that holds the
 * nearest `.o2b-vault.json` pointer naming the vault being written, written
 * by `o2b brain project link`. A directory no such pointer covers, a
 * process with no vault, or a directory that cannot be read gives no
 * project: the record is written without one, never with a guess.
 *
 *  - An MCP server learns its directory once, at launch (the working
 *    directory it was started in, `ServerContext.ruleScope`); no tool
 *    takes a project or a workspace argument.
 *  - A CLI verb uses the directory it runs in.
 *  - A hook uses the `cwd` its host payload carries, and the payload's
 *    `session_id`.
 *
 * The session id is stamped only where the host gives one (a hook payload,
 * a session checkpoint). An MCP call carries none, so its records fall back
 * to the device, agent and day that wrote them, as every record without a
 * session does (`topics/candidates.ts`).
 *
 * Both fields are optional additions to bodies and frontmatter readers
 * already tolerate: a log event's `project` and `session` sit in its body,
 * a signal's in its frontmatter (FORMAT.md, `log-event` and `signal`).
 */

import { resolveProjectScope } from "./scope-identity.ts";
import { scopedRuleKey } from "./scoped-rule-key.ts";

/** The project and session a candidate record was written in. */
export interface RecordOrigin {
  /** The project key (`resolveProjectScope`), absent when none was resolved. */
  readonly project?: string;
  /** The host's session id, absent when the host gave none. */
  readonly session?: string;
}

/** The longest session id stamped; a longer one is not a host session id. */
const SESSION_MAX_CHARS = 200;

/**
 * The origin of a write made from `workspaceDir` into `vault`, with the
 * host's `session` id when it gave one. Never throws: a directory or
 * pointer that cannot be read gives no project.
 */
export function recordOriginOf(
  workspaceDir: string | null | undefined,
  vault: string | null,
  session?: string | null,
): RecordOrigin {
  let project: string | null = null;
  if (
    vault !== null &&
    workspaceDir !== null &&
    workspaceDir !== undefined &&
    workspaceDir !== ""
  ) {
    try {
      project = resolveProjectScope(workspaceDir, vault);
    } catch {
      project = null;
    }
  }
  const id = typeof session === "string" ? session.trim() : "";
  const sessionOk = id !== "" && id.length <= SESSION_MAX_CHARS && !/[\r\n]/.test(id);
  return {
    ...(project !== null ? { project } : {}),
    ...(sessionOk ? { session: id } : {}),
  };
}

/**
 * The project key a record's stored `project` field names, read by the
 * rule that wrote it (`scopedRuleKey`, which `resolveProjectScope`
 * applies): letters, marks and digits of every script survive, so a
 * directory named in another script or with an accent keeps its own key.
 * The one reader of the axis: topic planning, the topic scopes and the
 * session start digest all compare this key, so the writer and the readers
 * cannot drift apart. A stored key reads back unchanged; a value that is
 * not a string, or keys to nothing, names no project.
 */
export function recordProjectOf(value: unknown): string | null {
  return typeof value === "string" ? scopedRuleKey(value) : null;
}

/**
 * The origin as the string fields a log event body or a signal's
 * frontmatter carries: `project` and `session`, each only when known.
 */
export function originFields(origin: RecordOrigin | undefined): Record<string, string> {
  if (origin === undefined) return {};
  return {
    ...(origin.project !== undefined ? { project: origin.project } : {}),
    ...(origin.session !== undefined ? { session: origin.session } : {}),
  };
}

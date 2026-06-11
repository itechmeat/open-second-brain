/**
 * Grok Build session adapter.
 *
 * Grok persists each session under
 * `${GROK_HOME:-~/.grok}/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl`
 * as a newline-delimited ACP session-update stream. Every line is
 *
 *   {"timestamp": <unix-seconds>, "method": "session/update",
 *    "params": {"sessionId": "...", "update": {"sessionUpdate": "<kind>", ...}}}
 *
 * (shapes captured from live grok 0.2.45). The kinds this adapter maps:
 *   - `user_message_chunk` / `agent_message_chunk`: `update.content.text` is a
 *     fragment of a streamed message. Consecutive chunks of the same role are
 *     coalesced into one turn so a message - and any `@osb` marker inside it -
 *     is never split across turns.
 *   - `tool_call`: `update.title` is the tool name (e.g.
 *     `open-second-brain__brain_note`), `update.rawInput` the input,
 *     `update.toolCallId` the id. (`tool_call_update` carries only progress /
 *     output for the same id, so it is skipped.)
 * Other kinds (`available_commands_update`, `agent_thought_chunk`,
 * `tool_call_update`, `plan`, ...) are skipped: the ACP stream is an evolving
 * protocol, so an unrecognized update kind is ignored rather than failing the
 * import. The structural gate is the first line - it must be a grok
 * `session/update`, or the import throws PARSE.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { SessionImportError } from "./types.ts";
import type { SessionAdapter, SessionTurn } from "./types.ts";

interface GrokUpdate {
  readonly sessionId: string | null;
  readonly kind: string;
  readonly raw: Record<string, unknown>;
  /** ISO-8601 derived from the line's unix-seconds `timestamp`. */
  readonly timestamp: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isoFrom(ts: unknown): string {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return new Date(ts * 1000).toISOString();
  }
  return new Date(0).toISOString();
}

/** Parse one line into its `session/update` payload, or null if it is not one. */
function parseUpdateLine(line: string): GrokUpdate | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const o = asRecord(obj);
  if (!o || o["method"] !== "session/update") return null;
  const params = asRecord(o["params"]);
  if (!params) return null;
  const update = asRecord(params["update"]);
  if (!update || typeof update["sessionUpdate"] !== "string") return null;
  return {
    sessionId: typeof params["sessionId"] === "string" ? params["sessionId"] : null,
    kind: update["sessionUpdate"],
    raw: update,
    timestamp: isoFrom(o["timestamp"]),
  };
}

function chunkText(update: Record<string, unknown>): string {
  const content = asRecord(update["content"]);
  return content && typeof content["text"] === "string" ? content["text"] : "";
}

/**
 * Grok namespaces MCP tools as `<server>__<tool>` (e.g.
 * `open-second-brain__brain_feedback`); built-in tools (`search_replace`,
 * `run_terminal_command`) carry no `__`. Strip the namespace to the bare tool
 * name so the import's exact-match replay (`name === "brain_feedback"`) fires,
 * matching what every other adapter yields. Built-in names pass through.
 */
function bareToolName(title: string): string {
  const sep = title.lastIndexOf("__");
  return sep === -1 ? title : title.slice(sep + 2);
}

const ROLE_BY_KIND: Readonly<Record<string, "user" | "assistant">> = {
  user_message_chunk: "user",
  agent_message_chunk: "assistant",
};

export const grokAdapter: SessionAdapter = {
  id: "grok",
  defaultAgent: "grok",

  detect(firstLine: string): boolean {
    return parseUpdateLine(firstLine) !== null;
  },

  async *iterate(path: string): AsyncIterable<SessionTurn> {
    const lines = readFileSync(path, "utf8").split("\n");
    const firstNonEmpty = lines.find((l) => l.trim() !== "");
    if (firstNonEmpty === undefined || parseUpdateLine(firstNonEmpty.trim()) === null) {
      throw new SessionImportError(
        "PARSE",
        "grok session: first line is not an ACP session/update; not a grok updates.jsonl stream",
      );
    }

    const sessionId = parseUpdateLine(firstNonEmpty.trim())?.sessionId ?? basename(dirname(path));
    let seq = 0;
    const nextId = (): string => `${sessionId}:${seq++}`;

    // Buffered coalescing of consecutive same-role message chunks.
    let buf: { role: "user" | "assistant"; parts: string[]; timestamp: string } | null = null;
    const flush = (): SessionTurn | null => {
      if (buf === null) return null;
      const turn: SessionTurn = {
        turnId: nextId(),
        timestamp: buf.timestamp,
        role: buf.role,
        text: buf.parts.join(""),
      };
      buf = null;
      return turn;
    };

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed === "") continue;
      const parsed = parseUpdateLine(trimmed);
      if (parsed === null) continue;
      const timestamp = parsed.timestamp;

      const role = ROLE_BY_KIND[parsed.kind];
      if (role !== undefined) {
        const text = chunkText(parsed.raw);
        if (buf !== null && buf.role === role) {
          buf.parts.push(text);
        } else {
          const pending = flush();
          if (pending !== null) yield pending;
          buf = { role, parts: [text], timestamp };
        }
        continue;
      }

      // Any non-message update is a turn boundary: flush the buffered message.
      const pending = flush();
      if (pending !== null) yield pending;

      if (parsed.kind === "tool_call") {
        const title = parsed.raw["title"];
        if (typeof title === "string" && title.length > 0) {
          const input = asRecord(parsed.raw["rawInput"]) ?? {};
          const id = parsed.raw["toolCallId"];
          yield {
            turnId: nextId(),
            timestamp,
            role: "assistant",
            toolCalls: [
              { name: bareToolName(title), input, ...(typeof id === "string" ? { id } : {}) },
            ],
          };
        }
      }
      // Every other kind (available_commands_update, agent_thought_chunk,
      // tool_call_update, plan, ...) is intentionally skipped.
    }

    const tail = flush();
    if (tail !== null) yield tail;
  },
};

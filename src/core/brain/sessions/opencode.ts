/**
 * opencode spool adapter.
 *
 * Unlike the claude/codex/hermes adapters, which parse a third-party
 * transcript schema, this one reads a format Open Second Brain owns:
 * the JSONL spool written by the bundled opencode plugin
 * (`plugins/opencode/open-second-brain.ts`) under
 * `${XDG_DATA_HOME:-~/.local/share}/open-second-brain/opencode/`.
 *
 *   - Line 1: `{type: "session_meta", originator:
 *     "open-second-brain-opencode-plugin", format: 1, session_id, ...}`
 *   - Lines 2+: `{type: "turn", turnId, timestamp, role, text?,
 *     toolCalls?}` — deliberately shaped like `SessionTurn`, so this
 *     adapter is a validator, not a translator.
 *
 * `format` is a hard gate: a spool written by a newer plugin fails
 * with a PARSE error naming the version instead of silently dropping
 * fields it does not understand.
 */

import { readFileSync } from "node:fs";

import { SessionImportError } from "./types.ts";
import type { SessionAdapter, SessionToolCall, SessionTurn } from "./types.ts";

const ORIGINATOR = "open-second-brain-opencode-plugin";
const SUPPORTED_FORMAT = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseMetaLine(line: string): Record<string, unknown> | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const o = asRecord(obj);
  if (!o) return null;
  if (o["type"] !== "session_meta" || o["originator"] !== ORIGINATOR) return null;
  return o;
}

function buildTurn(obj: Record<string, unknown>): SessionTurn | null {
  if (obj["type"] !== "turn") return null;
  const turnId = obj["turnId"];
  if (typeof turnId !== "string" || turnId.length === 0) return null;
  const role = obj["role"];
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const timestamp =
    typeof obj["timestamp"] === "string" ? obj["timestamp"] : new Date(0).toISOString();

  const toolCalls: SessionToolCall[] = [];
  if (Array.isArray(obj["toolCalls"])) {
    for (const raw of obj["toolCalls"]) {
      const tc = asRecord(raw);
      if (!tc || typeof tc["name"] !== "string" || tc["name"].length === 0) continue;
      const input = asRecord(tc["input"]) ?? {};
      toolCalls.push({
        name: tc["name"],
        input,
        ...(typeof tc["id"] === "string" ? { id: tc["id"] } : {}),
      });
    }
  }

  return {
    turnId,
    timestamp,
    role,
    ...(typeof obj["text"] === "string" && obj["text"].length > 0 ? { text: obj["text"] } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

export const opencodeAdapter: SessionAdapter = {
  id: "opencode",
  defaultAgent: "opencode",
  detect(firstLine: string): boolean {
    return parseMetaLine(firstLine) !== null;
  },
  async *iterate(path: string): AsyncIterable<SessionTurn> {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    // Hard gate even under explicit `--format opencode`: a file whose
    // first line is not our meta line must not partially import.
    const meta = lines.length > 0 ? parseMetaLine(lines[0]!.trim()) : null;
    if (meta === null) {
      throw new SessionImportError(
        "PARSE",
        `opencode spool meta line missing or invalid; expected first line ` +
          `with originator ${ORIGINATOR}`,
      );
    }
    const format = meta["format"];
    if (typeof format !== "number") {
      throw new SessionImportError(
        "PARSE",
        `opencode spool meta line carries no numeric format field; ` +
          `expected format ${SUPPORTED_FORMAT}`,
      );
    }
    if (format > SUPPORTED_FORMAT) {
      throw new SessionImportError(
        "PARSE",
        `opencode spool format ${format} is newer than supported ` +
          `format ${SUPPORTED_FORMAT}; upgrade Open Second Brain to import it`,
      );
    }
    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const o = asRecord(obj);
      if (!o) continue;
      const turn = buildTurn(o);
      if (turn) yield turn;
    }
  },
};

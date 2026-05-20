/**
 * Safe merge of OSB's two `mcpServers` keys into an existing JSON
 * config file (Cursor, opencode, kiro, Gemini CLI, Copilot CLI fallback).
 *
 * Invariants:
 *   - User-authored keys (other than the two OSB names) are preserved
 *     byte-for-byte at the JSON-value level. Stringification uses the
 *     same indentation detected from the original.
 *   - OSB keys land in insertion order at the end of the chosen
 *     top-level object (`mcpServers` by default).
 *   - Empty / whitespace-only input yields a minimal valid document.
 *   - Malformed JSON throws `JsonMergeError` with the original parse
 *     error attached.
 */

import type { McpPayload, McpServerEntry } from "./types.ts";

export class JsonMergeError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JsonMergeError";
  }
}

export const OSB_KEY_FULL = "open-second-brain";
export const OSB_KEY_WRITER = "open-second-brain-writer";
const DEFAULT_TOP_KEY = "mcpServers";

export interface MergeOpts {
  /** Top-level object key under which MCP servers live. Default `mcpServers`. */
  readonly topLevelKey?: string;
}

export function mergeMcpServers(
  current: string,
  payload: McpPayload,
  opts: MergeOpts = {},
): string {
  const topKey = opts.topLevelKey ?? DEFAULT_TOP_KEY;
  const trimmed = current.trim();
  const root: Record<string, unknown> = trimmed.length === 0 ? {} : parseJson(current);

  const existing = root[topKey];
  const block: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  // Preserve insertion order: user keys first (without our two), then ours.
  delete block[OSB_KEY_FULL];
  delete block[OSB_KEY_WRITER];
  block[OSB_KEY_FULL] = serializeEntry(payload.full);
  block[OSB_KEY_WRITER] = serializeEntry(payload.writer);

  root[topKey] = block;

  const indent = detectIndent(current) ?? 2;
  return JSON.stringify(root, null, indent) + "\n";
}

export function removeMcpServers(current: string, opts: MergeOpts = {}): string {
  const topKey = opts.topLevelKey ?? DEFAULT_TOP_KEY;
  if (current.trim().length === 0) return current;
  const root = parseJson(current);
  const existing = root[topKey];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const block = { ...(existing as Record<string, unknown>) };
    delete block[OSB_KEY_FULL];
    delete block[OSB_KEY_WRITER];
    root[topKey] = block;
  }
  const indent = detectIndent(current) ?? 2;
  return JSON.stringify(root, null, indent) + "\n";
}

function parseJson(text: string): Record<string, unknown> {
  // Strip a leading UTF-8 BOM if the editor saved one. `JSON.parse` does
  // not accept BOM at the head of input — silently dropping it lets the
  // adapter survive files saved by Windows-side editors.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    const parsed = JSON.parse(stripped);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JsonMergeError("expected JSON object at root, got " + typeof parsed);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof JsonMergeError) throw e;
    throw new JsonMergeError("failed to parse JSON: " + (e as Error).message, e);
  }
}

function serializeEntry(e: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    command: e.command,
    args: [...e.args],
  };
  if (e.env && Object.keys(e.env).length > 0) {
    out["env"] = { ...e.env };
  }
  return out;
}

/**
 * Best-effort indent detection. Looks at the first indented JSON line.
 * Returns the indent width in spaces, or `null` if not detectable.
 */
function detectIndent(text: string): number | null {
  const lines = text.split("\n");
  for (const line of lines) {
    const m = /^( +)\S/.exec(line);
    if (m) return m[1]!.length;
  }
  return null;
}

/**
 * `o2b search expand` — progressive disclosure layers 2 + 3: drill a
 * layer-1 card (from `o2b search --disclosure cards`) into the fuller note
 * and the paginated raw chunk transcript. Read-only; never rebuilds the
 * index.
 */

import { expandHit, SearchError } from "../../../core/search/index.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  isIntegerWithin,
  parseFlags,
  resolveConfig,
  VAULT_FLAGS,
} from "../helpers.ts";

export async function cmdSearchExpand(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    chunk: { type: "string" },
    "raw-limit": { type: "string" },
    cursor: { type: "string" },
    "agent-scope": { type: "string" },
    json: { type: "boolean" },
  });
  const chunkId = Number(flags["chunk"]);
  if (!isIntegerWithin(chunkId, { min: 1 })) {
    throw new CliError("--chunk must be a positive integer chunk id (from a card)");
  }
  let rawLimit: number | undefined;
  const rawLimitFlag = flagString(flags, "raw-limit");
  if (rawLimitFlag !== undefined) {
    rawLimit = Number(rawLimitFlag);
    if (!isIntegerWithin(rawLimit, { min: 1 })) {
      throw new CliError("--raw-limit must be a positive integer");
    }
  }
  const cfg = resolveConfig(flags);
  const cursor = flagString(flags, "cursor");
  const agentScope = flagString(flags, "agent-scope");
  let result;
  try {
    result = await expandHit(cfg, {
      chunkId,
      ...(rawLimit !== undefined ? { rawLimit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(agentScope !== undefined ? { agentScope } : {}),
    });
  } catch (e) {
    if (e instanceof SearchError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({
        chunk_id: result.chunkId,
        note: {
          document_id: result.note.documentId,
          path: result.note.path,
          title: result.note.title,
          line_start: result.note.lineStart,
          line_end: result.note.lineEnd,
          pointer: result.note.pointer,
          content: result.note.content,
        },
        raw_content: result.raw_content.map((c) => ({
          chunk_id: c.chunkId,
          chunk_index: c.chunkIndex,
          start_line: c.startLine,
          end_line: c.endLine,
          pointer: c.pointer,
          content: c.content,
        })),
        next_cursor: result.next_cursor,
      }) + "\n",
    );
    return 0;
  }
  const lines: string[] = [];
  lines.push(`note: ${result.note.pointer}`);
  if (result.note.title !== null) lines.push(`title: ${result.note.title}`);
  lines.push("");
  lines.push(result.note.content);
  lines.push("");
  lines.push(`── raw chunks (${result.raw_content.length}) ──`);
  for (const c of result.raw_content) {
    lines.push(`[${c.pointer}]`);
    lines.push(c.content);
    lines.push("");
  }
  if (result.next_cursor !== null) {
    lines.push(`more: o2b search expand --chunk ${result.chunkId} --cursor ${result.next_cursor}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

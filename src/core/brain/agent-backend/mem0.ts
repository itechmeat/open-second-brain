/**
 * mem0 memory-store backend (Ingestion & Import Robustness suite, t_ac9d2588).
 *
 * Imports a mem0 export - a popular agent-memory store - into Brain
 * preferences. mem0's `get_all` / export shape is a list of memory records,
 * delivered either as a top-level JSON array or under a `results` / `memories`
 * key. Each record's memory text becomes a preference body; its id / name and
 * metadata description fill the frontmatter. Built from the shared JSON-backend
 * factory (see {@link makeJsonBackend}); rendering and slugging reuse the
 * Claude-memory functions, so an imported mem0 memory is a first-class Brain
 * preference indistinguishable in format from any other.
 *
 * Pointed at a single export file via `--memory`; it has no per-vault default
 * location, so `discoverMemoryDir` fails loudly rather than guessing.
 */

import { makeJsonBackend } from "./json-source.ts";
import type { MemorySourceBackend } from "./types.ts";

export const mem0MemoryBackend: MemorySourceBackend = makeJsonBackend({
  id: "mem0",
  label: "mem0",
  collectionKeys: ["results", "memories", "data"],
  bodyKeys: ["memory", "text", "data", "content"],
  errorPrefix: "mem0 export",
  recordNoun: "mem0 record",
  noDefaultDirMessage:
    "the mem0 backend has no default memory location - pass the export with --memory <mem0-export.json>",
});

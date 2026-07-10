/**
 * Generic JSON memory-store backend (Ingestion & Import Robustness suite,
 * t_ac9d2588).
 *
 * The catch-all importer for any memory store that can emit a neutral JSON
 * dump. The documented schema is a list of memory objects - a top-level array,
 * or an object with the list under `memories` / `entries` - where each object
 * carries a `body` (or `text` / `memory`), an optional `name`, and an optional
 * `description`:
 *
 *   [ { "name": "no-shouting", "description": "Tone rule", "body": "Never..." } ]
 *
 * Missing name/description fall back to a body-derived value, so a minimal
 * `[{ "body": "..." }]` still imports. Built from the shared JSON-backend
 * factory (see {@link makeJsonBackend}); rendering and slugging reuse the
 * Claude-memory functions for a uniform Brain preference format.
 *
 * Pointed at a single dump file via `--memory`; no per-vault default location.
 */

import { makeJsonBackend } from "./json-source.ts";
import type { MemorySourceBackend } from "./types.ts";

export const genericMemoryBackend: MemorySourceBackend = makeJsonBackend({
  id: "generic",
  label: "Generic JSON",
  collectionKeys: ["memories", "entries", "data"],
  bodyKeys: ["body", "text", "memory", "content"],
  errorPrefix: "generic dump",
  recordNoun: "generic record",
  noDefaultDirMessage:
    "the generic backend has no default memory location - pass the dump with --memory <dump.json>",
});

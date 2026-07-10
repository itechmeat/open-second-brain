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
 * `[{ "body": "..." }]` still imports. Rendering and slugging delegate to the
 * shared Claude-memory render functions for a uniform Brain preference format.
 *
 * Pointed at a single dump file via `--memory`; no per-vault default location.
 */

import { readdirSync } from "node:fs";

import { renderPreferenceFromMemory, slugifyMemoryName } from "../claude-memory-render.ts";
import { buildFeedbackEntry, firstString, metadataString, readJsonItems } from "./json-source.ts";
import type { MemoryRenderInput, MemorySourceBackend, MemorySourceParse } from "./types.ts";

/** Keys under which a generic dump nests its record array. */
const COLLECTION_KEYS = ["memories", "entries", "data"] as const;

export const genericMemoryBackend: MemorySourceBackend = Object.freeze({
  id: "generic",
  label: "Generic JSON",
  discoverMemoryDir(_vault: string): string {
    throw new Error(
      "the generic backend has no default memory location - pass the dump with --memory <dump.json>",
    );
  },
  discoverMemoryFiles(dir: string): string[] {
    return readdirSync(dir)
      .toSorted()
      .filter((name) => name.toLowerCase().endsWith(".json"));
  },
  parseMemoryEntries(text: string): MemorySourceParse[] {
    const res = readJsonItems(text, COLLECTION_KEYS);
    if ("error" in res) return [{ kind: "skip", skipReason: `generic dump ${res.error}` }];
    return res.items.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return { kind: "skip", skipReason: "generic record is not an object" };
      }
      const rec = item as Record<string, unknown>;
      return buildFeedbackEntry({
        name: firstString(rec, ["name", "title", "id"]),
        description: firstString(rec, ["description"]) || metadataString(rec, "description"),
        body: firstString(rec, ["body", "text", "memory", "content"]),
      });
    });
  },
  renderPreference(input: MemoryRenderInput): string {
    return renderPreferenceFromMemory(input);
  },
  slugifyName(name: string): string {
    return slugifyMemoryName(name);
  },
});

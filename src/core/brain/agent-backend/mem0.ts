/**
 * mem0 memory-store backend (Ingestion & Import Robustness suite, t_ac9d2588).
 *
 * Imports a mem0 export - a popular agent-memory store - into Brain
 * preferences. mem0's `get_all` / export shape is a list of memory records,
 * delivered either as a top-level JSON array or under a `results` / `memories`
 * key. Each record's memory text becomes a preference body; its id / name and
 * metadata description fill the frontmatter. Rendering and slugging delegate to
 * the shared Claude-memory render functions, so an imported mem0 memory is a
 * first-class Brain preference indistinguishable in format from any other.
 *
 * Pointed at a single export file via `--memory`; it has no per-vault default
 * location, so {@link discoverMemoryDir} fails loudly rather than guessing.
 */

import { readdirSync } from "node:fs";

import { renderPreferenceFromMemory, slugifyMemoryName } from "../claude-memory-render.ts";
import { buildFeedbackEntry, firstString, metadataString, readJsonItems } from "./json-source.ts";
import type { MemoryRenderInput, MemorySourceBackend, MemorySourceParse } from "./types.ts";

/** Keys under which a mem0 export nests its record array. */
const COLLECTION_KEYS = ["results", "memories", "data"] as const;

export const mem0MemoryBackend: MemorySourceBackend = Object.freeze({
  id: "mem0",
  label: "mem0",
  discoverMemoryDir(_vault: string): string {
    throw new Error(
      "the mem0 backend has no default memory location - pass the export with --memory <mem0-export.json>",
    );
  },
  discoverMemoryFiles(dir: string): string[] {
    return readdirSync(dir)
      .toSorted()
      .filter((name) => name.toLowerCase().endsWith(".json"));
  },
  parseMemoryEntries(text: string): MemorySourceParse[] {
    const res = readJsonItems(text, COLLECTION_KEYS);
    if ("error" in res) return [{ kind: "skip", skipReason: `mem0 export ${res.error}` }];
    return res.items.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return { kind: "skip", skipReason: "mem0 record is not an object" };
      }
      const rec = item as Record<string, unknown>;
      return buildFeedbackEntry({
        name: firstString(rec, ["name", "title", "id"]),
        description: firstString(rec, ["description"]) || metadataString(rec, "description"),
        body: firstString(rec, ["memory", "text", "data", "content"]),
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

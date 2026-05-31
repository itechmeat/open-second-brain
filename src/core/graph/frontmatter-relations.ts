/**
 * Extract typed relation edges from a page's frontmatter.
 *
 * A frontmatter field whose name is a known relation (`related`,
 * `extends`, `contradicts`, `superseded_by` - see relation-vocab.ts)
 * declares one edge per target. Targets may be written as Obsidian
 * wikilinks (`[[id]]`), quoted (`"[[id]]"`), or bare ids, and the
 * lightweight frontmatter parser sometimes mangles `[[id]]` into `[id]`;
 * `normalizeRelationTarget` recovers the bare id from every shape.
 */

import type { FrontmatterMap } from "../types.ts";
import { relationFromFrontmatterField } from "./relation-vocab.ts";

export interface RelationEdge {
  readonly relation: string;
  readonly target: string;
}

/**
 * Recover the bare link target from a frontmatter value, peeling any
 * combination of wrapping `[[ ]]`, `[ ]`, and quotes, then dropping an
 * alias (`|`) or heading/block anchor (`#`). Returns `null` when nothing
 * usable remains.
 */
export function normalizeRelationTarget(raw: string): string | null {
  let s = raw.trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    if (s.startsWith("[[") && s.endsWith("]]")) s = s.slice(2, -2).trim();
    else if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1).trim();
    else if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
  }
  const cuts = [s.indexOf("|"), s.indexOf("#")].filter((i) => i >= 0);
  if (cuts.length > 0) s = s.slice(0, Math.min(...cuts)).trim();
  return s.length > 0 ? s : null;
}

/** Every typed relation edge declared by this frontmatter, in field order. */
export function extractFrontmatterRelations(meta: FrontmatterMap): RelationEdge[] {
  const out: RelationEdge[] = [];
  for (const [key, value] of Object.entries(meta)) {
    const relation = relationFromFrontmatterField(key);
    if (!relation) continue;
    const items = Array.isArray(value) ? value : value === "" ? [] : [value];
    for (const item of items) {
      const target = normalizeRelationTarget(String(item));
      if (target) out.push({ relation, target });
    }
  }
  return out;
}

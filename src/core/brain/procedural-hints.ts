import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { proceduralHintsPath } from "./paths.ts";
import {
  readProceduralGraph,
  type ProceduralGraphProjection,
} from "./procedural-graph.ts";

export interface ProceduralHintEntry {
  readonly node_id: string;
  readonly cues: ReadonlyArray<string>;
}

export interface ProceduralHintsProjection {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly entries: ReadonlyArray<ProceduralHintEntry>;
}

export function rebuildProceduralHints(
  vault: string,
  opts: { now?: Date; graph?: ProceduralGraphProjection } = {},
): ProceduralHintsProjection {
  const graph = opts.graph ?? readProceduralGraph(vault);
  const now = opts.now ?? new Date();
  const entries: ProceduralHintEntry[] = [];
  if (graph !== null) {
    for (const node of graph.nodes) {
      if (node.kind === "entity") continue;
      const cues = new Set<string>();
      cues.add(node.title.toLowerCase());
      if (node.sourcePath) {
        for (const token of tokenizeCue(node.sourcePath)) cues.add(token);
      }
      for (const value of Object.values(node.metadata)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string") {
              for (const token of tokenizeCue(item)) cues.add(token);
            }
          }
        } else if (typeof value === "string") {
          for (const token of tokenizeCue(value)) cues.add(token);
        }
      }
      entries.push({
        node_id: node.id,
        cues: Object.freeze(
          [...cues].filter((item) => item.length >= 3).toSorted(),
        ),
      });
    }
  }

  const projection: ProceduralHintsProjection = {
    schema_version: 1,
    generated_at: now.toISOString(),
    entries: Object.freeze(
      entries.toSorted((l, r) => l.node_id.localeCompare(r.node_id)),
    ),
  };

  const path = proceduralHintsPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(projection, null, 2)}\n`);
  return projection;
}

export function readProceduralHints(
  vault: string,
): ProceduralHintsProjection | null {
  const path = proceduralHintsPath(vault);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as ProceduralHintsProjection;
    if (parsed.schema_version !== 1) return null;
    if (!Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function tokenizeCue(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

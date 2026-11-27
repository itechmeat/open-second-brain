/**
 * The procedural graph and hints as a caller below local reach may see
 * them: private-partition lane entries are withheld below local reach.
 *
 * Both projections are built from every procedure and stored whole as
 * machine state (`procedural-graph.ts`, `procedural-hints.ts`), so a
 * caller below local reach is answered through this read-time filter, in
 * two passes:
 *
 * 1. a node with a source (`procedure`, `skill`, `runbook`, `proposal`)
 *    is kept only when its `sourcePath` is a non-empty string the
 *    caller's predicate reads as readable, and, for a `Brain/` path that
 *    names a lane entry on a machine whose lane pages live in the store,
 *    the caller's fold holds that entry (the predicate alone falls back
 *    to the vault rule for an entry the fold does not hold, which reads a
 *    missing file as readable);
 * 2. an `entity` node (a trigger, tag or path segment, shared between the
 *    nodes that point at it) is kept only through an edge to a kept node;
 *    an edge is kept only when both its ends are kept.
 *
 * A kept entity node that a dropped node links to is titled from its id
 * (`Tag: <slug>` for `ent-tag-<slug>`), not with its stored title: the
 * projection keeps the spelling of the first procedure that named the
 * entity, which may be one the caller may not read (change
 * `lane-reach-residuals`, design R2). It answers under an id of this
 * answer (`ent-retitled:<n>`), not its stored id, which keeps the
 * entity's spelling as a slug, and its kept edges are rewritten to that
 * id.
 *
 * A hint entry is kept only when its node is a kept node with a source.
 * The answer is built from the known fields only, so a field a later
 * release adds to a projection does not cross unfiltered.
 */

import { join } from "node:path";

import { BRAIN_ROOT_REL } from "../../core/brain/path-constants.ts";
import type {
  ProceduralGraphNode,
  ProceduralGraphProjection,
} from "../../core/brain/procedural-graph.ts";
import type { ProceduralHintsProjection } from "../../core/brain/procedural-hints.ts";
import { lanePlaceOf } from "../../core/store/lane-paths.ts";
import { lanePagesInStore, readLanePage } from "../../core/store/lane-pages.ts";

type Readable = (rel: string) => boolean;

/** Whether `value` is an object a filter can judge: rows of a stored projection are not trusted. */
function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The nodes of `graph` a filter can judge: objects with a string id and kind. */
function judgeableNodes(graph: ProceduralGraphProjection): ProceduralGraphNode[] {
  return graph.nodes.filter(
    (node: unknown): node is ProceduralGraphNode =>
      isRow(node) && typeof node["id"] === "string" && typeof node["kind"] === "string",
  );
}

/** Whether the caller may see the node with a source `node`. */
function sourceVisible(
  vault: string,
  node: ProceduralGraphNode,
  readable: Readable,
  configPath?: string,
): boolean {
  const rel = node.sourcePath;
  if (typeof rel !== "string" || rel === "") return false;
  try {
    if (!readable(rel)) return false;
    const prefix = `${BRAIN_ROOT_REL}/`;
    if (!rel.startsWith(prefix) || !lanePagesInStore(vault, configPath)) return true;
    if (lanePlaceOf(rel.slice(prefix.length)) === null) return true;
    return readLanePage(vault, join(vault, rel), configPath) !== null;
  } catch {
    // A node that cannot be judged is dropped (fail closed).
    return false;
  }
}

/** The ids of the nodes with a source the caller may see. */
function keptSourceNodes(
  vault: string,
  graph: ProceduralGraphProjection,
  readable: Readable,
  configPath?: string,
): Set<string> {
  return new Set(
    judgeableNodes(graph)
      .filter((node) => node.kind !== "entity" && sourceVisible(vault, node, readable, configPath))
      .map((node) => node.id),
  );
}

/** Entity id prefixes (`procedural-graph.ts` `entityNodeId`) and the title each names. */
const ENTITY_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["ent-proposal-path-", "Proposal Path"],
  ["ent-trigger-", "Trigger"],
  ["ent-tag-", "Tag"],
  ["ent-path-", "Path"],
];

/** The title of an entity node derived from its id alone. */
function titleFromEntityId(id: string): string {
  for (const [prefix, label] of ENTITY_TITLES) {
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return `${label}: ${id.slice(prefix.length)}`;
    }
  }
  return id;
}

/** The kept entity nodes a node the caller may not see links to. */
function entitiesLinkedFromDropped(
  nodes: ReadonlyArray<ProceduralGraphNode>,
  edges: ReadonlyArray<ProceduralGraphProjection["edges"][number]>,
  kept: ReadonlySet<string>,
  entities: ReadonlySet<string>,
): Set<string> {
  const dropped = new Set(nodes.filter((node) => !kept.has(node.id)).map((node) => node.id));
  const linked = new Set<string>();
  for (const edge of edges) {
    if (dropped.has(edge.from) && entities.has(edge.to) && kept.has(edge.to)) linked.add(edge.to);
    if (dropped.has(edge.to) && entities.has(edge.from) && kept.has(edge.from)) {
      linked.add(edge.from);
    }
  }
  return linked;
}

/** The graph a caller below local reach may see. */
export function visibleProceduralGraph(
  vault: string,
  graph: ProceduralGraphProjection,
  readable: Readable,
  configPath?: string,
): ProceduralGraphProjection {
  const kept = keptSourceNodes(vault, graph, readable, configPath);
  const nodes = judgeableNodes(graph);
  const edges = graph.edges.filter(
    (edge: unknown): edge is ProceduralGraphProjection["edges"][number] =>
      isRow(edge) && typeof edge["from"] === "string" && typeof edge["to"] === "string",
  );
  const entities = new Set(nodes.filter((n) => n.kind === "entity").map((n) => n.id));
  for (const edge of edges) {
    if (kept.has(edge.from) && entities.has(edge.to)) kept.add(edge.to);
    if (kept.has(edge.to) && entities.has(edge.from)) kept.add(edge.from);
  }
  const retitled = entitiesLinkedFromDropped(nodes, edges, kept, entities);
  const keptNodes = nodes.filter((node) => kept.has(node.id));
  const renamed = answerEntityIds(keptNodes, retitled);
  const idOf = (id: string): string => renamed.get(id) ?? id;
  return {
    schema_version: graph.schema_version,
    generated_at: graph.generated_at,
    nodes: keptNodes.map((node) =>
      retitled.has(node.id)
        ? { ...node, id: idOf(node.id), title: titleFromEntityId(node.id) }
        : node,
    ),
    edges: edges
      .filter((edge) => kept.has(edge.from) && kept.has(edge.to))
      .map((edge) =>
        renamed.has(edge.from) || renamed.has(edge.to)
          ? { ...edge, from: idOf(edge.from), to: idOf(edge.to) }
          : edge,
      ),
  };
}

/**
 * The id each retitled entity node answers under: `ent-retitled:<n>`, by
 * its place in the answer, so it is stable within one answer and carries
 * no spelling of the entity (`entityNodeId` keeps the trigger or tag as a
 * slug). The colon keeps it apart from every id `entityNodeId` makes.
 */
function answerEntityIds(
  nodes: ReadonlyArray<ProceduralGraphNode>,
  retitled: ReadonlySet<string>,
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const node of nodes) {
    if (retitled.has(node.id) && !ids.has(node.id)) {
      ids.set(node.id, `ent-retitled:${ids.size + 1}`);
    }
  }
  return ids;
}

/**
 * The hints a caller below local reach may see: the entries of the kept
 * nodes with a source of `graph`; none without a graph to judge them by.
 */
export function visibleProceduralHints(
  vault: string,
  hints: ProceduralHintsProjection,
  graph: ProceduralGraphProjection | null,
  readable: Readable,
  configPath?: string,
): ProceduralHintsProjection {
  const kept =
    graph === null ? new Set<string>() : keptSourceNodes(vault, graph, readable, configPath);
  return {
    schema_version: hints.schema_version,
    generated_at: hints.generated_at,
    entries: hints.entries.filter(
      (entry: unknown) =>
        isRow(entry) && typeof entry["node_id"] === "string" && kept.has(entry["node_id"]),
    ),
  };
}

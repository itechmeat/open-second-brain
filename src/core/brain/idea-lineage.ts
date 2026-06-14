/**
 * Idea lineage (Session Knowledge Synthesis, t_635a3ea5).
 *
 * A read-only provenance tracer: given a derived artifact, reconstruct
 * the observation -> synthesis -> conclusion chain from edges that
 * already exist - it writes nothing and computes nothing new.
 *
 * Two resolvers behind one shape:
 *   - continuity records (a ctn_ id): walk the `sourceRefs` graph
 *     backward. A raw `session_turn` is an observation, intermediate
 *     summary/extract/digest records are synthesis, the queried record
 *     is the conclusion. Edges resolve by record id (`session_summary_node`
 *     -> continuity_record) or by turn id (`session_summary_digest` ->
 *     `session_turn.payload.turn_id`). A seen-set guards cycles and a
 *     depth bound caps traversal (reported as `truncated`).
 *   - preferences (a pref-/ret- id): adapt the existing
 *     `buildBeliefEvolution` lifecycle into the same node/edge shape -
 *     creation is the observation, promotion the synthesis, retirement a
 *     terminal conclusion. No belief logic is reimplemented here.
 *
 * Unknown ids fail with {@link IdeaLineageError} rather than returning a
 * silent empty chain.
 */

import { listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import { buildTimelineIndex } from "./temporal/build-index.ts";
import { buildBeliefEvolution } from "./temporal/belief-evolution.ts";

export class IdeaLineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeaLineageError";
  }
}

export type LineageStage = "observation" | "synthesis" | "conclusion";

export interface IdeaLineageNode {
  readonly id: string;
  readonly kind: string;
  readonly stage: LineageStage;
  /** 0 for the queried artifact, increasing toward observations. */
  readonly depth: number;
  readonly createdAt: string | null;
  readonly label: string;
}

export interface IdeaLineageEdge {
  /** The more-derived node. */
  readonly from: string;
  /** The source it was derived from. */
  readonly to: string;
  readonly relation: string;
}

export interface IdeaLineageResult {
  readonly root: IdeaLineageNode;
  readonly nodes: ReadonlyArray<IdeaLineageNode>;
  readonly edges: ReadonlyArray<IdeaLineageEdge>;
  /** True when the depth bound stopped traversal before exhausting sources. */
  readonly truncated: boolean;
}

export interface TraceIdeaLineageInput {
  readonly id: string;
}

export interface TraceIdeaLineageOptions {
  /** Maximum backward hops from the queried artifact. Default 8. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const SNIPPET = 80;

export function traceIdeaLineage(
  vault: string,
  input: TraceIdeaLineageInput,
  opts: TraceIdeaLineageOptions = {},
): IdeaLineageResult {
  const id = input.id.trim();
  if (id.length === 0) throw new IdeaLineageError("idea lineage requires a non-empty id");
  if (id.startsWith("pref-") || id.startsWith("ret-")) {
    return preferenceLineage(vault, id);
  }
  return continuityLineage(vault, id, Math.max(1, opts.maxDepth ?? DEFAULT_MAX_DEPTH));
}

// ----- continuity source graph ---------------------------------------------

function continuityLineage(vault: string, id: string, maxDepth: number): IdeaLineageResult {
  const records = listContinuityRecords(vault);
  const byId = new Map<string, ContinuityRecord>();
  const byTurnId = new Map<string, ContinuityRecord>();
  for (const record of records) {
    byId.set(record.id, record);
    if (record.kind === "session_turn") {
      const turnId = String(record.payload["turn_id"] ?? "");
      if (turnId.length > 0 && !byTurnId.has(turnId)) byTurnId.set(turnId, record);
    }
  }

  const root = byId.get(id);
  if (root === undefined) throw new IdeaLineageError(`no continuity record with id ${id}`);

  const nodes: IdeaLineageNode[] = [continuityNode(root, 0, true)];
  const edges: IdeaLineageEdge[] = [];
  const seen = new Set<string>([root.id]);
  const edgeKeys = new Set<string>();
  let truncated = false;

  let frontier: ContinuityRecord[] = [root];
  let depth = 0;
  while (frontier.length > 0) {
    if (depth >= maxDepth) {
      if (frontier.some((record) => hasUnseenSource(record, byId, byTurnId, seen)))
        truncated = true;
      break;
    }
    const next: ContinuityRecord[] = [];
    for (const record of frontier) {
      for (const source of resolveSources(record, byId, byTurnId)) {
        const edgeKey = `${record.id}->${source.record.id}`;
        if (!edgeKeys.has(edgeKey)) {
          edgeKeys.add(edgeKey);
          edges.push(
            Object.freeze({ from: record.id, to: source.record.id, relation: source.relation }),
          );
        }
        if (!seen.has(source.record.id)) {
          seen.add(source.record.id);
          nodes.push(continuityNode(source.record, depth + 1, false));
          next.push(source.record);
        }
      }
    }
    frontier = next;
    depth += 1;
  }

  return Object.freeze({
    root: nodes[0]!,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    truncated,
  });
}

interface ResolvedSource {
  readonly record: ContinuityRecord;
  readonly relation: string;
}

function resolveSources(
  record: ContinuityRecord,
  byId: ReadonlyMap<string, ContinuityRecord>,
  byTurnId: ReadonlyMap<string, ContinuityRecord>,
): ResolvedSource[] {
  const sources: ResolvedSource[] = [];
  const claimed = new Set<string>();
  for (const ref of record.sourceRefs) {
    const refId = typeof ref.id === "string" ? ref.id : "";
    if (refId.length === 0 || refId === record.id) continue;
    const candidate = byId.get(refId) ?? byTurnId.get(refId);
    if (candidate === undefined || candidate.id === record.id || claimed.has(candidate.id))
      continue;
    claimed.add(candidate.id);
    sources.push({ record: candidate, relation: refRelation(ref) });
  }
  return sources;
}

function hasUnseenSource(
  record: ContinuityRecord,
  byId: ReadonlyMap<string, ContinuityRecord>,
  byTurnId: ReadonlyMap<string, ContinuityRecord>,
  seen: ReadonlySet<string>,
): boolean {
  return resolveSources(record, byId, byTurnId).some((source) => !seen.has(source.record.id));
}

function refRelation(ref: { readonly kind?: string }): string {
  return typeof ref.kind === "string" && ref.kind.length > 0 ? ref.kind : "source";
}

function continuityNode(record: ContinuityRecord, depth: number, isRoot: boolean): IdeaLineageNode {
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    stage: continuityStage(record, isRoot),
    depth,
    createdAt: record.createdAt,
    label: continuityLabel(record),
  });
}

function continuityStage(record: ContinuityRecord, isRoot: boolean): LineageStage {
  if (record.kind === "session_turn") return "observation";
  if (isRoot) return "conclusion";
  return "synthesis";
}

function continuityLabel(record: ContinuityRecord): string {
  const payload = record.payload;
  if (record.kind === "session_turn") {
    const role = String(payload["role"] ?? "");
    return `${role}: ${snippet(String(payload["text"] ?? ""))}`.trim();
  }
  if (record.kind === "session_summary_node") {
    return `summary depth ${String(payload["depth"] ?? "?")}`;
  }
  if (record.kind === "session_summary_digest") {
    return "session summary digest";
  }
  if (record.kind === "pre_compact_extract") {
    return `${String(payload["extract_type"] ?? "extract")}: ${snippet(String(payload["text"] ?? ""))}`;
  }
  return record.kind;
}

function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET ? `${oneLine.slice(0, SNIPPET - 3)}...` : oneLine;
}

// ----- preference belief evolution -----------------------------------------

function preferenceLineage(vault: string, prefId: string): IdeaLineageResult {
  const index = buildTimelineIndex(vault, {});
  const evo = buildBeliefEvolution(index, vault, { prefId });
  if (evo.transitions.length === 0 && evo.evidence.length === 0 && evo.retirements.length === 0) {
    throw new IdeaLineageError(`no belief lineage for ${prefId}`);
  }

  const firstAt = evo.transitions[0]?.at ?? null;
  const root: IdeaLineageNode = Object.freeze({
    id: prefId,
    kind: "preference",
    stage: "conclusion",
    depth: 0,
    createdAt: firstAt,
    label: prefId,
  });
  const nodes: IdeaLineageNode[] = [root];
  const edges: IdeaLineageEdge[] = [];
  for (const transition of evo.transitions) {
    const nodeId = `${transition.kind}:${transition.prefId}:${transition.at}`;
    nodes.push(
      Object.freeze({
        id: nodeId,
        kind: "belief_transition",
        stage: transitionStage(transition.kind),
        depth: 1,
        createdAt: transition.at,
        label: `${transition.kind} ${transition.at}`,
      }),
    );
    edges.push(Object.freeze({ from: prefId, to: nodeId, relation: transition.kind }));
  }

  return Object.freeze({
    root,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    truncated: false,
  });
}

function transitionStage(kind: "creation" | "promotion" | "retirement"): LineageStage {
  if (kind === "creation") return "observation";
  if (kind === "promotion") return "synthesis";
  return "conclusion";
}

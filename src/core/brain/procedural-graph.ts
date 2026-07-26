import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { parseFrontmatter } from "../vault.ts";
import {
  proceduralGraphPath,
  proceduralMemoryIndexPath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
  skillProposalRejectedPath,
} from "./paths.ts";
import type { ProceduralMemoryEntry } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export type ProceduralGraphNodeKind = "procedure" | "skill" | "runbook" | "proposal" | "entity";
export type ProceduralGraphEdgeKind =
  | "derived_from_proposal"
  | "trigger_matches"
  | "tag_matches"
  | "source_mentions"
  | "proposal_mentions";

export interface ProceduralGraphNode {
  readonly id: string;
  readonly kind: ProceduralGraphNodeKind;
  readonly title: string;
  readonly sourcePath: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ProceduralGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: ProceduralGraphEdgeKind;
}

export interface ProceduralGraphProjection {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly nodes: ReadonlyArray<ProceduralGraphNode>;
  readonly edges: ReadonlyArray<ProceduralGraphEdge>;
}

export interface ProceduralGraphBuildOptions {
  readonly now?: Date;
}

export function rebuildProceduralGraph(
  vault: string,
  opts: ProceduralGraphBuildOptions = {},
): ProceduralGraphProjection {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const now = opts.now ?? new Date();
  const nodes: ProceduralGraphNode[] = [];
  const edges: ProceduralGraphEdge[] = [];

  const entries = readProceduralIndex(vault);
  const nodeById = new Set<string>();
  for (const entry of entries) {
    const node: ProceduralGraphNode = {
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      sourcePath: entry.sourcePath,
      metadata: {
        triggers: [...entry.triggers],
        tags: [...entry.tags],
        source: entry.source,
        version: entry.version,
      },
    };
    nodes.push(node);
    nodeById.add(node.id);

    if (entry.kind === "procedure") {
      const proposalId = detectProcedureSourceProposal(vault, entry.sourcePath);
      if (proposalId) {
        edges.push({
          from: node.id,
          to: proposalId,
          kind: "derived_from_proposal",
        });
      }
    }

    for (const trigger of entry.triggers) {
      const entityId = entityNodeId(`trigger:${trigger}`);
      ensureEntityNode(nodes, nodeById, entityId, `Trigger: ${trigger}`);
      edges.push({ from: node.id, to: entityId, kind: "trigger_matches" });
    }

    for (const tag of entry.tags) {
      const entityId = entityNodeId(`tag:${tag}`);
      ensureEntityNode(nodes, nodeById, entityId, `Tag: ${tag}`);
      edges.push({ from: node.id, to: entityId, kind: "tag_matches" });
    }

    for (const token of sourcePathTokens(entry.sourcePath)) {
      const entityId = entityNodeId(`path:${token}`);
      ensureEntityNode(nodes, nodeById, entityId, `Path: ${token}`);
      edges.push({ from: node.id, to: entityId, kind: "source_mentions" });
    }
  }

  for (const proposal of listProposals(vault)) {
    nodes.push(proposal);
    nodeById.add(proposal.id);
    for (const token of sourcePathTokens(proposal.sourcePath ?? "")) {
      const entityId = entityNodeId(`proposal-path:${token}`);
      ensureEntityNode(nodes, nodeById, entityId, `Proposal Path: ${token}`);
      edges.push({
        from: proposal.id,
        to: entityId,
        kind: "proposal_mentions",
      });
    }
  }

  const projection: ProceduralGraphProjection = {
    schema_version: 1,
    generated_at: now.toISOString(),
    nodes: Object.freeze(
      nodes
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map((item) => Object.freeze(item)),
    ),
    edges: Object.freeze(
      dedupeEdges(edges)
        .toSorted(
          (left, right) =>
            left.from.localeCompare(right.from) ||
            left.to.localeCompare(right.to) ||
            left.kind.localeCompare(right.kind),
        )
        .map((item) => Object.freeze(item)),
    ),
  };

  const path = proceduralGraphPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(projection, null, 2)}\n`);
  return projection;
}

export function readProceduralGraph(vault: string): ProceduralGraphProjection | null {
  const path = proceduralGraphPath(vault);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProceduralGraphProjection;
    if (parsed.schema_version !== 1) return null;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readProceduralIndex(vault: string): ProceduralMemoryEntry[] {
  const path = proceduralMemoryIndexPath(vault);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      schema_version?: unknown;
      entries?: ProceduralMemoryEntry[];
    };
    if (parsed.schema_version !== 1) return [];
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries;
  } catch {
    return [];
  }
}

function detectProcedureSourceProposal(vault: string, sourcePath: string): string | null {
  if (!sourcePath.startsWith("Brain/procedures/")) return null;
  let absPath: string;
  try {
    absPath = ensureInsideVault(join(vault, sourcePath), vault);
  } catch {
    return null;
  }
  if (!existsSync(absPath)) return null;
  // Unit F: `parseFrontmatter` cannot throw (it reads inside its own try;
  // everything after is string work), so the `catch { return null }` that
  // stood here was unreachable - and redundant, since a failed read
  // yields an empty map and falls through to the same `return null`.
  // Dropped lines are reported centrally; see the "Why most readers keep
  // the two-tuple form" section in src/core/vault.ts.
  const [fm] = parseFrontmatter(absPath);
  if (typeof fm["source_proposal"] === "string" && fm["source_proposal"].trim()) {
    return fm["source_proposal"].trim();
  }
  return null;
}

function listProposals(vault: string): ProceduralGraphNode[] {
  const out: ProceduralGraphNode[] = [];
  for (const tuple of [
    ["pending", skillProposalPendingPath],
    ["accepted", skillProposalAcceptedPath],
    ["rejected", skillProposalRejectedPath],
  ] as const) {
    const [status, builder] = tuple;
    const dir = dirname(builder(vault, "sample"));
    if (!existsSync(dir)) continue;
    for (const name of readDirSorted(dir)) {
      if (!name.endsWith(".md")) continue;
      const absPath = `${dir}/${name}`;
      // Unit F: unreachable `catch { continue }` removed - nothing in this
      // body throws (`parseFrontmatter` reads inside its own try, and the
      // rest is property reads and `basename`). A file whose frontmatter
      // could not be read yields an empty map, fails the `kind` check on
      // the next line, and is skipped exactly as the dead branch intended.
      // See the "Why most readers keep the two-tuple form" section in
      // src/core/vault.ts for where the condition IS reported.
      const [fm] = parseFrontmatter(absPath);
      if (fm["kind"] !== "brain-skill-proposal") continue;
      const id = typeof fm["id"] === "string" ? fm["id"] : `proposal-${basename(name, ".md")}`;
      out.push({
        id,
        kind: "proposal",
        title:
          typeof fm["slug"] === "string"
            ? `Proposal: ${fm["slug"]}`
            : `Proposal: ${basename(name, ".md")}`,
        sourcePath: `Brain/skill-proposals/${status}/${name}`,
        metadata: {
          status,
          pattern_kind: fm["pattern_kind"] ?? null,
        },
      });
    }
  }
  return out;
}

function readDirSorted(dir: string): string[] {
  try {
    return readdirSync(dir).toSorted();
  } catch {
    return [];
  }
}

function sourcePathTokens(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3 && /^[a-z0-9._-]+$/.test(part));
}

function ensureEntityNode(
  nodes: ProceduralGraphNode[],
  nodeById: Set<string>,
  id: string,
  title: string,
): void {
  if (nodeById.has(id)) return;
  nodes.push({
    id,
    kind: "entity",
    title,
    sourcePath: null,
    metadata: {},
  });
  nodeById.add(id);
}

function entityNodeId(raw: string): string {
  return `ent-${raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

function dedupeEdges(edges: ReadonlyArray<ProceduralGraphEdge>): ProceduralGraphEdge[] {
  const out: ProceduralGraphEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/**
 * Bridge discovery (link-recall-intelligence, t_ab540afe).
 *
 * Traversal only follows edges someone wrote; unlinked-mentions only
 * catches textual name-drops. This pass finds the third kind of
 * latent structure: two notes that are embedding-near but share no
 * edge and never name each other. Orphan-first - candidates are
 * scanned in ascending inbound-link order, so weakly connected notes
 * get bridged before well-wired hubs.
 *
 * Strictly read-only against note bodies. Output is a REVIEWABLE
 * artifact (`Brain/proposals/bridges.md`, regenerated per run);
 * `acceptBridge` is the only path that mutates a user note, one pair
 * at a time, on operator/agent initiative. Dismissals persist in
 * `Brain/proposals/bridges-dismissed.json` so re-runs stay quiet.
 *
 * Similarity: chunk embeddings are unit-normalised, so the sqlite-vec
 * L2 distance converts exactly (cos = 1 - d^2 / 2). Fail-soft: a
 * vault without embeddings reports `vecAvailable: false` and proposes
 * nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Store } from "../../search/store.ts";
import { linkConstraintAllows } from "../../search/link-constraints.ts";
import { normalizeRelationTarget } from "../../graph/frontmatter-relations.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { isoSecond } from "../time.ts";
import { formatFrontmatter, parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { resolveNotePath } from "../note-path.ts";
import type { SchemaPack } from "../schema-pack.ts";

export const BRIDGE_DEFAULT_MIN_SIMILARITY = 0.8;
export const BRIDGE_DEFAULT_MAX_PROPOSALS = 10;
export const BRIDGE_DEFAULT_MAX_CANDIDATES = 25;
/** Chunk embeddings sampled per candidate document. */
const BRIDGE_CHUNKS_PER_DOC = 3;
/** KNN depth per sampled chunk. */
const BRIDGE_KNN_K = 10;

export interface BridgeProposal {
  readonly source: string;
  readonly target: string;
  /** Cosine similarity of the closest chunk pair, [0, 1]. */
  readonly similarity: number;
  readonly sourceInbound: number;
  readonly targetInbound: number;
}

export interface BridgeDiscoveryReport {
  readonly proposals: ReadonlyArray<BridgeProposal>;
  readonly scannedCandidates: number;
  readonly vecAvailable: boolean;
  readonly reason?: string;
}

export interface DiscoverBridgesOptions {
  readonly minSimilarity?: number;
  readonly maxProposals?: number;
  readonly maxCandidates?: number;
  /** Pair keys (see {@link bridgePairKey}) to suppress. */
  readonly dismissed?: ReadonlySet<string>;
}

/** Canonical unordered pair key. */
export function bridgePairKey(a: string, b: string): string {
  return [a, b].toSorted().join("::");
}

/**
 * Propose bridges over the open store. Deterministic for a fixed
 * index state; performs no writes.
 */
export function discoverBridges(
  store: Store,
  opts: DiscoverBridgesOptions = {},
): BridgeDiscoveryReport {
  const minSimilarity = opts.minSimilarity ?? BRIDGE_DEFAULT_MIN_SIMILARITY;
  const maxProposals = Math.max(1, opts.maxProposals ?? BRIDGE_DEFAULT_MAX_PROPOSALS);
  const maxCandidates = Math.max(1, opts.maxCandidates ?? BRIDGE_DEFAULT_MAX_CANDIDATES);
  const dismissed = opts.dismissed ?? new Set<string>();

  if (!store.vecLoaded() || store.countEmbeddings() === 0) {
    return Object.freeze({
      proposals: Object.freeze([]),
      scannedCandidates: 0,
      vecAvailable: false,
      reason: "no embedding layer: index the vault with embeddings enabled first",
    });
  }

  const documents = store.listDocuments();
  const pathById = new Map<number, string>();
  for (const [path, summary] of documents) pathById.set(summary.id, path);

  // Existing doc-level edges (either direction) and inbound counts.
  const linkedPairs = new Set<string>();
  const inbound = new Map<number, number>();
  for (const { source, target } of store.resolvedDocLinkPairs()) {
    if (source === target) continue;
    const sourcePath = pathById.get(source);
    const targetPath = pathById.get(target);
    if (!sourcePath || !targetPath) continue;
    linkedPairs.add(bridgePairKey(sourcePath, targetPath));
    inbound.set(target, (inbound.get(target) ?? 0) + 1);
  }

  // Orphans first: ascending inbound count, path tie-break.
  const candidates = [...documents.entries()]
    .map(([path, summary]) => ({ path, id: summary.id, inbound: inbound.get(summary.id) ?? 0 }))
    .toSorted((a, b) =>
      a.inbound !== b.inbound ? a.inbound - b.inbound : a.path < b.path ? -1 : 1,
    )
    .slice(0, maxCandidates);

  // Best similarity per unordered pair.
  const best = new Map<string, BridgeProposal>();
  for (const candidate of candidates) {
    const chunks = store.chunksForDocument(candidate.id).slice(0, BRIDGE_CHUNKS_PER_DOC);
    for (const chunk of chunks) {
      const embedding = store.embeddingForChunk(chunk.id);
      if (embedding === null) continue;
      for (const hit of store.semanticTopK(embedding, { limit: BRIDGE_KNN_K })) {
        if (hit.documentId === candidate.id) continue;
        const otherPath = pathById.get(hit.documentId);
        if (!otherPath) continue;
        // Unit vectors: L2^2 = 2 - 2cos.
        const similarity = 1 - (hit.distance * hit.distance) / 2;
        if (similarity < minSimilarity) continue;
        const key = bridgePairKey(candidate.path, otherPath);
        if (linkedPairs.has(key) || dismissed.has(key)) continue;
        const existing = best.get(key);
        if (existing && existing.similarity >= similarity) continue;
        best.set(
          key,
          Object.freeze({
            source: candidate.path,
            target: otherPath,
            similarity,
            sourceInbound: candidate.inbound,
            targetInbound: inbound.get(hit.documentId) ?? 0,
          }),
        );
      }
    }
  }

  const proposals = [...best.values()]
    .toSorted((a, b) =>
      a.similarity !== b.similarity
        ? b.similarity - a.similarity
        : bridgePairKey(a.source, a.target) < bridgePairKey(b.source, b.target)
          ? -1
          : 1,
    )
    .slice(0, maxProposals);

  return Object.freeze({
    proposals: Object.freeze(proposals),
    scannedCandidates: candidates.length,
    vecAvailable: true,
  });
}

// ── proposal artifact ────────────────────────────────────────────────────────

function proposalsPath(vault: string): string {
  return join(vault, "Brain", "proposals", "bridges.md");
}

function dismissedPath(vault: string): string {
  return join(vault, "Brain", "proposals", "bridges-dismissed.json");
}

/**
 * Regenerate the reviewable proposals artifact. Derived file: the
 * whole document is replaced on every run.
 */
export function writeBridgeProposals(
  vault: string,
  report: BridgeDiscoveryReport,
  opts: { readonly now: Date },
): string {
  const path = proposalsPath(vault);
  const lines: string[] = [
    "# Bridge proposals",
    "",
    "Auto-generated by `o2b brain links discover`. Do not edit - regenerated",
    "on every run. Accept a pair with `o2b brain links accept <source> <target>`,",
    "silence one with `o2b brain links dismiss <source> <target>`.",
    "",
  ];
  if (report.proposals.length === 0) {
    lines.push(
      report.vecAvailable
        ? "No bridge proposals: every embedding-near pair is already linked or dismissed."
        : `No bridge proposals: ${report.reason ?? "vec layer unavailable"}.`,
    );
  } else {
    lines.push("| source | target | similarity | inbound (src/tgt) |");
    lines.push("| --- | --- | --- | --- |");
    for (const p of report.proposals) {
      lines.push(
        `| [[${noteId(p.source)}]] (${p.source}) | [[${noteId(p.target)}]] (${p.target}) | ${p.similarity.toFixed(3)} | ${p.sourceInbound}/${p.targetInbound} |`,
      );
    }
  }
  const content = formatFrontmatter(
    {
      kind: "brain-bridge-proposals",
      generated_at: isoSecond(opts.now),
      proposals: report.proposals.length,
      scanned_candidates: report.scannedCandidates,
    },
    lines.join("\n"),
  );
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, content);
  return path;
}

/** Persisted dismissals, unordered pair keys. Fail-soft read. */
export function readDismissedBridges(vault: string): Set<string> {
  const path = dismissedPath(vault);
  if (!existsSync(path)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const pairs = (parsed as { pairs?: unknown }).pairs;
    if (!Array.isArray(pairs)) return new Set();
    return new Set(pairs.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

/** Persist one dismissal; returns true when it was new. */
export function dismissBridge(vault: string, source: string, target: string): boolean {
  const key = bridgePairKey(source, target);
  const dismissed = readDismissedBridges(vault);
  if (dismissed.has(key)) return false;
  dismissed.add(key);
  const path = dismissedPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pairs: [...dismissed].toSorted() }, null, 2) + "\n");
  return true;
}

// ── accept ───────────────────────────────────────────────────────────────────

export interface AcceptBridgeResult {
  readonly changed: boolean;
  /** Normalised related targets after the write. */
  readonly related: ReadonlyArray<string>;
}

/** Note id used inside a wikilink: basename without `.md`. */
function noteId(relPath: string): string {
  return basename(relPath, ".md");
}

/**
 * Accept one proposal: append `related: "[[target]]"` to the source
 * note's frontmatter. Idempotent (normalised target comparison);
 * validates both endpoints exist inside the vault; honors a schema
 * pack's `related` link constraints when one is supplied.
 */
export function acceptBridge(
  vault: string,
  source: string,
  target: string,
  opts: { readonly pack?: SchemaPack } = {},
): AcceptBridgeResult {
  const sourceAbs = resolveNotePath(vault, source, { mustExist: true });
  resolveNotePath(vault, target, { mustExist: true });

  const [meta, body] = parseFrontmatter(sourceAbs);
  const link = `[[${noteId(target)}]]`;

  const current = meta["related"];
  const items: string[] =
    current === undefined || current === ""
      ? []
      : Array.isArray(current)
        ? current.map(String)
        : [String(current)];

  const targetIdNorm = normalizeRelationTarget(link);
  const existingNorm = items.map((item) => normalizeRelationTarget(item));
  if (targetIdNorm !== null && existingNorm.includes(targetIdNorm)) {
    return Object.freeze({ changed: false, related: Object.freeze([...items]) });
  }

  if (opts.pack && Object.keys(opts.pack.link_constraints).length > 0) {
    const sourceType = frontmatterType(meta);
    const targetType = frontmatterType(
      parseFrontmatter(resolveNotePath(vault, target, { mustExist: true }))[0],
    );
    if (!linkConstraintAllows(opts.pack.link_constraints, "related", sourceType, targetType)) {
      const declared = opts.pack.link_constraints["related"] ?? [];
      throw new Error(
        `link constraint violation: related ${sourceType ?? "?"}->${targetType ?? "?"} is not allowed ` +
          `(declared: ${declared.join(", ")})`,
      );
    }
  }

  const next = [...items, link];
  const metadata = { ...meta, related: next.length === 1 ? next[0]! : next };
  writeFrontmatterAtomic(sourceAbs, metadata, body, { overwrite: true });
  return Object.freeze({ changed: true, related: Object.freeze(next) });
}

function frontmatterType(meta: Record<string, unknown>): string | null {
  const raw = meta["type"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim().toLowerCase() : null;
}

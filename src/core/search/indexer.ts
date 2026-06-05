/**
 * Index lifecycle orchestrator.
 *
 * `indexVault` is the incremental path: walk → diff against stored
 * documents → upsert/replace/delete. `reindexVault` is the atomic
 * rebuild: write to `brain.sqlite.new`, then a same-file rename swap
 * with `.bak` retention.
 *
 * `indexStatus` and `indexCheck` are the read-side diagnostics that
 * power `o2b search status|check` and the MCP status enrichment.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §6, §8,
 * §13, §15.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname } from "node:path";

import { chunkMarkdown } from "./chunker.ts";
import { expandTextForCjkFts } from "./cjk-tokenizer.ts";
import { makeProvider } from "./embeddings/provider.ts";
import {
  embeddingSignature,
  estimateCostUsd,
  estimateTokens,
  evaluateCostGate,
  pricePerMillionTokens,
  LOCAL_EMBEDDING_MODEL,
} from "./embeddings/signature.ts";
import { extractLinks } from "./links.ts";
import { extractFrontmatterRelations } from "../graph/frontmatter-relations.ts";
import { loadSchemaPack, type SchemaPack } from "../brain/schema-pack.ts";
import { tieredFieldsForKind } from "../brain/frontmatter-tiers.ts";
import { normalizeSchemaToken } from "../brain/schema-vocab.ts";
import { parseFrontmatterText } from "../vault.ts";
import { extractEntities } from "./entities.ts";
import { Store } from "./store.ts";
import { SearchError } from "./types.ts";
import { walkVault } from "./walker.ts";
import { withTimeout } from "./with-timeout.ts";
import type { ChunkInput, LinkInput } from "./store.ts";
import type {
  IndexCheckReport,
  IndexStats,
  IndexStatusSnapshot,
  ResolvedSearchConfig,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────

export interface IndexProgressEvent {
  readonly path: string;
  readonly kind: "added" | "updated" | "unchanged" | "deleted" | "error";
  readonly message?: string;
}

export interface IndexVaultOptions {
  readonly embeddings?: boolean;
  /** When true, every file is reindexed even if hash + mtime match. */
  readonly force?: boolean;
  /** When true, bypass the embedding cost gate for this run. */
  readonly forceCost?: boolean;
  readonly onFile?: (event: IndexProgressEvent) => void;
}

interface MutableStats {
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  chunksTotal: number;
  embeddingsComputed: number;
  embeddingsRetries: number;
  errors: Array<{ readonly path: string; readonly message: string }>;
  relationViolations: IndexStats["relationViolations"];
  tierDrift: IndexStats["tierDrift"];
}

function newStats(): MutableStats {
  return {
    added: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    chunksTotal: 0,
    embeddingsComputed: 0,
    embeddingsRetries: 0,
    errors: [],
    relationViolations: [],
    tierDrift: [],
  };
}

function freezeStats(s: MutableStats, durationMs: number): IndexStats {
  return Object.freeze({
    added: s.added,
    updated: s.updated,
    unchanged: s.unchanged,
    deleted: s.deleted,
    chunksTotal: s.chunksTotal,
    embeddingsComputed: s.embeddingsComputed,
    embeddingsRetries: s.embeddingsRetries,
    errors: Object.freeze([...s.errors]),
    relationViolations: Object.freeze([...s.relationViolations]),
    tierDrift: Object.freeze([...s.tierDrift]),
    durationMs,
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Deep-ish equality for frontmatter scalar/array values. */
function tierValueEquals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((v, i) => tierValueEquals(v, right[i]));
  }
  return left === right;
}

/**
 * The page's declared frontmatter `type` as a normalized token, or
 * null when undeclared or not a usable scalar. Tolerant by design:
 * a malformed `type` value never fails indexing, it just leaves the
 * page untyped for constraint purposes.
 */
function pageTypeFromFrontmatter(frontmatter: Record<string, unknown>): string | null {
  const raw = frontmatter["type"];
  if (typeof raw !== "string") return null;
  const normalized = normalizeSchemaToken(raw);
  return normalized.length > 0 ? normalized : null;
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

function readUtf8(absPath: string): string {
  const buf = readFileSync(absPath);
  try {
    return UTF8_FATAL.decode(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SearchError("INVALID_INPUT", `file is not valid UTF-8: ${absPath} (${msg})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// indexVault — incremental
// ─────────────────────────────────────────────────────────────────────────────

export async function indexVault(
  config: ResolvedSearchConfig,
  opts?: IndexVaultOptions,
): Promise<IndexStats> {
  return indexInto(config, opts);
}

async function indexInto(
  config: ResolvedSearchConfig,
  opts?: IndexVaultOptions,
  storeOverride?: Store,
): Promise<IndexStats> {
  const t0 = Date.now();
  const ownsStore = !storeOverride;
  const store = storeOverride ?? (await Store.open(config, { mode: "write" }));
  const stats = newStats();

  try {
    const existing = store.listDocuments();
    const seen = new Set<string>();
    // Changed docs declaring a frontmatter `kind`, for the tier-guard
    // post-pass (write-time-integrity-governance).
    const tieredDocs: Array<{
      docId: number;
      relPath: string;
      frontmatter: Record<string, unknown>;
    }> = [];

    for (const file of walkVault(config)) {
      // Mark seen FIRST. If anything downstream throws (read fault,
      // chunker bug, transient FS error), the file must not look
      // "missing" to the deletion sweep below — that would wipe a
      // present file from the index just because a single read failed.
      seen.add(file.relPath);
      try {
        const mtimeSec = Math.floor(file.stat.mtimeMs / 1000);
        const size = file.stat.size;
        const prev = existing.get(file.relPath);

        // Fastpath: if mtime and size both match, skip the full
        // content read + SHA256 hash. This is the same trade-off
        // as `make` — mtime can theoretically be fooled but the
        // probability is negligible for vault editing workflows.
        if (!opts?.force && prev && prev.mtime === mtimeSec && prev.size === size) {
          stats.unchanged++;
          opts?.onFile?.({ path: file.relPath, kind: "unchanged" });
          continue;
        }

        const content = readUtf8(file.absPath);
        const contentHash = sha256(content);

        // Fallback: fastpath missed (mtime or size changed). If
        // the content hash still matches, the file is logically
        // unchanged — update stored mtime/size to re-arm the
        // fastpath on the next run, but skip chunk/link work.
        if (!opts?.force && prev && prev.contentHash === contentHash) {
          stats.unchanged++;
          // Re-arm the fastpath: store the current stat so next
          // run can skip the read entirely.
          store.touchDocument(file.relPath, mtimeSec, size);
          opts?.onFile?.({ path: file.relPath, kind: "unchanged" });
          continue;
        }

        const filenameBase = basename(file.relPath, ".md");
        const chunkResult = chunkMarkdown(content, filenameBase, {
          maxTokens: config.chunkSize,
          overlapTokens: config.chunkOverlap,
        });
        for (const w of chunkResult.warnings) {
          stats.errors.push({ path: file.relPath, message: w });
        }

        // The document's declared frontmatter `type` is persisted so
        // the link-constraint post-pass can join endpoint types
        // without re-reading files (v6).
        const [frontmatter] = parseFrontmatterText(content);
        const docId = store.upsertDocument({
          path: file.relPath,
          title: chunkResult.title,
          contentHash,
          mtime: mtimeSec,
          size: file.stat.size,
          pageType: pageTypeFromFrontmatter(frontmatter),
        });
        // Framework-kind files feed the tier-guard post-pass: keep the
        // parsed frontmatter of this run's changed docs that declare a
        // `kind` (bounded - only Brain artifacts carry one).
        if (typeof frontmatter["kind"] === "string" && frontmatter["kind"].length > 0) {
          tieredDocs.push({ docId, relPath: file.relPath, frontmatter });
        }

        const chunkInputs: ChunkInput[] = chunkResult.chunks.map((c) => ({
          chunkIndex: c.chunkIndex,
          content: c.content,
          ftsContent: expandTextForCjkFts(c.content),
          contentHash: sha256(c.content),
          startLine: c.startLine,
          endLine: c.endLine,
          tokenCount: c.tokenCount,
          headingPath: c.headingPath,
        }));
        const chunkIds = store.replaceChunks(docId, chunkInputs);

        const links: LinkInput[] = [];
        for (let i = 0; i < chunkResult.chunks.length; i++) {
          const cid = chunkIds[i]!;
          const content = chunkResult.chunks[i]!.content;
          const extracted = extractLinks(content);
          for (const l of extracted) {
            links.push({
              sourceChunkId: cid,
              targetPath: l.targetPath,
              linkText: l.linkText,
              linkType: l.linkType,
            });
          }
          // Entity-boosted retrieval (v0.13.0): persist the chunk's
          // deterministic entity set alongside its links.
          store.replaceEntities(cid, extractEntities(content));
        }
        // Typed graph semantics (v3): frontmatter relation fields
        // (related / extends / contradicts / superseded_by) become typed
        // edges. They belong to the document, not a chunk, so anchor them
        // on the first chunk (or null when the doc produced no chunks).
        const relationChunkId = chunkIds[0] ?? null;
        for (const edge of extractFrontmatterRelations(frontmatter)) {
          links.push({
            sourceChunkId: relationChunkId,
            targetPath: edge.target,
            linkText: null,
            linkType: "wikilink",
            relation: edge.relation,
          });
        }
        store.replaceLinks(docId, links);

        stats.chunksTotal += chunkInputs.length;
        if (!prev) {
          stats.added++;
          opts?.onFile?.({ path: file.relPath, kind: "added" });
        } else {
          stats.updated++;
          opts?.onFile?.({ path: file.relPath, kind: "updated" });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        stats.errors.push({ path: file.relPath, message: msg });
        opts?.onFile?.({ path: file.relPath, kind: "error", message: msg });
      }
    }

    for (const [path] of existing) {
      if (!seen.has(path)) {
        store.deleteDocument(path);
        stats.deleted++;
        opts?.onFile?.({ path, kind: "deleted" });
      }
    }

    store.resolveLinkTargets();

    // Link-constraint materialization post-pass
    // (write-time-integrity-governance): recompute every typed edge's
    // blocked flag from the current schema pack. Runs every pass - with
    // no constraints declared it only resets stale flags, so removing a
    // constraint restores edges without touching files. Fail-soft: an
    // unparseable pack indexes as if no constraints were declared.
    let pack: SchemaPack | null = null;
    try {
      pack = loadSchemaPack(config.vault);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stats.errors.push({ path: "Brain/_brain.yaml", message: `schema pack unreadable: ${msg}` });
    }
    stats.relationViolations = Object.freeze(
      store.recomputeRelationConstraintFlags(pack?.link_constraints ?? {}),
    );

    // Tier-guard post-pass: for each changed framework-kind doc,
    // compare the new identity-field values against the stored
    // snapshot. A changed identity value stages a tier_drift finding
    // (ask_user via `o2b brain tiers check|restore|accept`) and the
    // snapshot keeps the expected value so repeated reindexes never
    // absorb the hand-edit; system/business fields update silently -
    // framework writers mutate them legitimately on every pass.
    if (pack !== null) {
      const detectedAt = new Date().toISOString();
      for (const doc of tieredDocs) {
        const kind = doc.frontmatter["kind"];
        if (typeof kind !== "string") continue;
        const fields = tieredFieldsForKind(pack, kind);
        if (Object.keys(fields).length === 0) continue;
        const prev = store.getTierSnapshot(doc.docId);
        const next: Record<string, unknown> = {};
        for (const [field, tier] of Object.entries(fields)) {
          const current = doc.frontmatter[field];
          if (prev === null || !(field in prev)) {
            if (current !== undefined) next[field] = current;
            continue;
          }
          const expected = prev[field];
          if (tier === "identity" && current !== undefined && !tierValueEquals(expected, current)) {
            store.upsertTierDrift({
              documentId: doc.docId,
              field,
              expected,
              actual: current,
              detectedAt,
            });
            stats.tierDrift = [
              ...stats.tierDrift,
              { path: doc.relPath, field, expected, actual: current },
            ];
            next[field] = expected; // the snapshot keeps the truth
            continue;
          }
          store.clearTierDrift(doc.docId, field);
          if (current !== undefined) next[field] = current;
        }
        store.setTierSnapshot(doc.docId, next);
      }
    }

    if (opts?.embeddings) {
      await populateEmbeddings(store, config, stats, opts?.forceCost === true);
    }

    const now = new Date().toISOString();
    store.setState("last_indexed_at", now);
    if (opts?.force) store.setState("last_full_index_at", now);

    // Bump the corpus-generation revision whenever the index actually
    // changed, so the persistent query cache (v0.20.0) is invalidated
    // after a content reindex even though the embedding model/dimension
    // and schema are unchanged.
    if (stats.added + stats.updated + stats.deleted > 0) {
      store.bumpIndexRevision();
    }

    return freezeStats(stats, Date.now() - t0);
  } finally {
    if (ownsStore) await store.close();
  }
}

/**
 * Canonical signature of the ACTIVE embedding configuration for status
 * reporting. Null when semantic search is disabled. Stored model and
 * dimension fill in fields the config leaves unset (e.g. an
 * auto-detected dimension or the local provider's implicit model).
 */
function activeEmbeddingSignature(
  config: ResolvedSearchConfig,
  storedModel: string | null = null,
  storedDim: number | null = null,
): string | null {
  if (!config.semantic.enabled) return null;
  const provider = config.semantic.provider;
  const model =
    provider === "local" ? LOCAL_EMBEDDING_MODEL : (config.semantic.model ?? storedModel);
  const dimension = config.semantic.dimension ?? storedDim;
  return embeddingSignature({ provider, model, dimension });
}

async function populateEmbeddings(
  store: Store,
  config: ResolvedSearchConfig,
  stats: MutableStats,
  forceCost: boolean,
): Promise<void> {
  if (!config.semantic.enabled) {
    throw new SearchError(
      "EMBEDDING_DISABLED",
      "set search_semantic_enabled=true and embedding_* keys to compute embeddings",
    );
  }
  // The offline local provider needs no key; every remote provider does.
  if (config.semantic.provider !== "local" && !config.semantic.apiKey) {
    throw new SearchError(
      "EMBEDDING_KEY_MISSING",
      "embedding_api_key is required when computing embeddings",
    );
  }
  if (!store.vecLoaded()) {
    throw new SearchError(
      "VEC_EXTENSION_UNAVAILABLE",
      "sqlite-vec did not load; cannot store embeddings",
    );
  }

  const pending = store.findChunksWithoutEmbeddings();
  if (pending.length === 0) return;

  const provider = makeProvider(config.semantic);
  const model = config.semantic.model ?? provider.model;

  // Cost gate: estimate the spend for the whole pending set up front and
  // refuse the run when it exceeds the configured ceiling, unless forced.
  // The local provider (price 0) and unknown-price models never block.
  const gate = evaluateCostGate({
    texts: pending.map((p) => p.content),
    model,
    gateUsd: config.semantic.costGateUsd,
    forced: forceCost,
  });
  if (gate.blocked) {
    throw new SearchError(
      "EMBEDDING_COST_GATE",
      `estimated embedding cost $${gate.estimatedUsd.toFixed(4)} for ${pending.length} chunk(s) ` +
        `exceeds embedding_cost_gate_usd $${config.semantic.costGateUsd.toFixed(4)}. ` +
        `Re-run with --force-cost to proceed or raise the gate.`,
    );
  }
  const batchSize = Math.max(1, config.semantic.batchSize);
  // Hand the provider a super-batch sized to fully saturate its
  // internal `embedding_concurrency` semaphore. Without this multiplier
  // the indexer's outer loop would serialise provider.embed() calls and
  // the configured concurrency would never kick in.
  const superBatch = batchSize * Math.max(1, config.semantic.concurrency);

  for (let i = 0; i < pending.length; i += superBatch) {
    const batch = pending.slice(i, i + superBatch);
    const texts = batch.map((p) => p.content);
    const vectors = await provider.embed(texts);
    stats.embeddingsRetries += provider.consumeRetryCount?.() ?? 0;
    if (vectors.length !== batch.length) {
      throw new SearchError(
        "EMBEDDING_PROVIDER_HTTP",
        `provider returned ${vectors.length} vectors for ${batch.length} inputs`,
      );
    }
    // Lock in the auto-detected dimension on the very first batch.
    const dim = provider.dimension ?? vectors[0]?.length ?? 0;
    if (dim <= 0) {
      throw new SearchError(
        "EMBEDDING_DIMENSION_MISMATCH",
        "provider returned vectors of zero length",
      );
    }
    store.ensureEmbeddingModel(model, dim);
    for (let j = 0; j < batch.length; j++) {
      const chunkId = batch[j]!.chunkId;
      const vec = vectors[j]!;
      const embHash = sha256(vec.map((x) => x.toFixed(8)).join(","));
      store.vecUpsert(chunkId, vec, model, dim, embHash);
      stats.embeddingsComputed++;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// reindexVault — atomic full rebuild
// ─────────────────────────────────────────────────────────────────────────────

export async function reindexVault(
  config: ResolvedSearchConfig,
  opts?: IndexVaultOptions,
): Promise<IndexStats> {
  const newPath = config.dbPath + ".new";
  const bakPath = config.dbPath + ".bak";

  mkdirSync(dirname(config.dbPath), { recursive: true });
  tryUnlink(newPath);

  // Build into the temp file with an override config.
  const tempConfig: ResolvedSearchConfig = Object.freeze({
    ...config,
    dbPath: newPath,
  });
  const stats = await indexVault(tempConfig, { ...opts, force: true });

  // Same-directory rename swap. The two renames are each atomic on
  // POSIX; the gap between them is the only crash window, which the
  // .bak restore on Store.open handles.
  tryUnlink(bakPath);
  tryRename(config.dbPath, bakPath); // no-op (ENOENT) on fresh reindex
  renameSync(newPath, config.dbPath); // must succeed — `newPath` was just built
  return stats;
}

/** `unlinkSync` that tolerates ENOENT (file already absent). */
function tryUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

/** `renameSync` that tolerates ENOENT on the source. */
function tryRename(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

// ─────────────────────────────────────────────────────────────────────────────
// indexStatus
// ─────────────────────────────────────────────────────────────────────────────

export async function indexStatus(config: ResolvedSearchConfig): Promise<IndexStatusSnapshot> {
  let store: Store;
  try {
    store = await Store.open(config, { mode: "read" });
  } catch (e) {
    if (e instanceof SearchError && e.code === "INDEX_MISSING") {
      return Object.freeze({
        indexPath: config.dbPath,
        exists: false,
        schemaVersion: null,
        documents: 0,
        chunks: 0,
        embeddings: 0,
        staleEmbeddings: 0,
        embeddingModel: null,
        embeddingDimension: null,
        embeddingSignature: activeEmbeddingSignature(config),
        estimatedRefreshCostUsd: 0,
        vecExtension: "unknown" as const,
        semanticEnabled: config.semantic.enabled,
        embeddingKeyPresent: !!config.semantic.apiKey,
        lastIndexedAt: null,
        lastFullIndexAt: null,
        warnings: Object.freeze([]),
      });
    }
    throw e;
  }
  try {
    const counts = store.counts();
    const model = store.getState("embedding_model");
    const dimRaw = store.getState("embedding_dimension");
    const dim = dimRaw ? Number(dimRaw) : null;
    const last = store.getState("last_indexed_at");
    const full = store.getState("last_full_index_at");

    const warnings: string[] = [];
    if (config.semantic.enabled && !store.vecLoaded()) {
      warnings.push("sqlite-vec unavailable; semantic search disabled this session");
    }
    if (
      config.semantic.enabled &&
      config.semantic.provider !== "local" &&
      !config.semantic.apiKey
    ) {
      warnings.push("embedding_api_key not configured; semantic search disabled");
    }

    // Best-effort spend estimate to bring stale/missing embeddings current.
    // Only scan chunk content when the active model is actually priced.
    const activeModel =
      config.semantic.provider === "local"
        ? LOCAL_EMBEDDING_MODEL
        : (config.semantic.model ?? model);
    let estimatedRefreshCostUsd = 0;
    if (config.semantic.enabled && pricePerMillionTokens(activeModel) > 0) {
      const pending = store.findChunksWithoutEmbeddings();
      estimatedRefreshCostUsd = estimateCostUsd(
        estimateTokens(pending.map((p) => p.content)),
        activeModel,
      );
    }

    return Object.freeze({
      indexPath: config.dbPath,
      exists: true,
      schemaVersion: store.schemaVersion(),
      documents: counts.documents,
      chunks: counts.chunks,
      embeddings: counts.embeddings,
      staleEmbeddings: counts.staleEmbeddings,
      embeddingModel: model,
      embeddingDimension: dim,
      embeddingSignature: activeEmbeddingSignature(config, model, dim),
      estimatedRefreshCostUsd,
      vecExtension: store.vecLoaded() ? ("loaded" as const) : ("unavailable" as const),
      semanticEnabled: config.semantic.enabled,
      embeddingKeyPresent: !!config.semantic.apiKey,
      lastIndexedAt: last,
      lastFullIndexAt: full,
      warnings: Object.freeze(warnings),
    });
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// indexCheck
// ─────────────────────────────────────────────────────────────────────────────

function isDirectoryWritable(dir: string): boolean {
  try {
    // `recursive: true` is idempotent — no separate existsSync check.
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function indexCheck(config: ResolvedSearchConfig): Promise<IndexCheckReport> {
  const warnings: string[] = [];
  const fatal: string[] = [];

  let vaultReadable = false;
  try {
    if (statSync(config.vault).isDirectory()) {
      vaultReadable = true;
    } else {
      fatal.push(`vault path exists but is not a directory: ${config.vault}`);
    }
  } catch {
    fatal.push(`vault not readable: ${config.vault}`);
  }

  const dir = dirname(config.dbPath);
  const indexDirWritable = isDirectoryWritable(dir);
  if (!indexDirWritable) fatal.push(`index directory not writable: ${dir}`);

  let sqliteOk = false;
  let fts5Ok = false;
  let vecExtension: "loaded" | "unavailable" | "not-attempted" = "not-attempted";
  try {
    // Use an in-memory DB so the check never touches the real index.
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    sqliteOk = true;
    try {
      db.exec(
        "CREATE VIRTUAL TABLE probe USING fts5(content, tokenize='unicode61 remove_diacritics 2')",
      );
      fts5Ok = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fatal.push(`FTS5 not available: ${msg}`);
    }
    if (config.semantic.enabled) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vec = require("sqlite-vec") as { getLoadablePath(): string };
        db.loadExtension(vec.getLoadablePath());
        db.query("SELECT vec_version()").get();
        vecExtension = "loaded";
      } catch (e) {
        vecExtension = "unavailable";
        warnings.push(`sqlite-vec unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    db.close();
  } catch (e) {
    fatal.push(`bun:sqlite open failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const embeddingKeyResolved = !!(config.semantic.enabled && config.semantic.apiKey);
  if (config.semantic.enabled && !config.semantic.apiKey) {
    warnings.push("embedding_api_key not configured");
  }

  let providerReachable: boolean | null = null;
  let providerReason: string | null = null;
  if (config.semantic.enabled && embeddingKeyResolved) {
    try {
      const provider = makeProvider(config.semantic);
      const probe = await withTimeout(provider.ping(), 5_000);
      if (probe.ok) {
        providerReachable = true;
      } else {
        providerReachable = false;
        providerReason = probe.reason;
        warnings.push(`embedding provider check failed: ${probe.reason}`);
      }
    } catch (e) {
      providerReachable = false;
      providerReason = e instanceof Error ? e.message : String(e);
      warnings.push(`embedding provider check failed: ${providerReason}`);
    }
  }

  // §E.2 — Actionable hints derived from the check state.
  // Rules match the design doc table; agents and operators read the
  // list to know what command to run next without learning the
  // internals of OSB.
  const recommendations = buildRecommendations({
    config,
    embeddingKeyResolved,
    vecExtension,
    providerReachable,
  });

  return Object.freeze({
    vaultReadable,
    indexDirWritable,
    sqliteOk,
    fts5Ok,
    vecExtension,
    embeddingKeyResolved,
    providerReachable,
    providerReason,
    warnings: Object.freeze(warnings),
    fatal: Object.freeze(fatal),
    recommendations: Object.freeze(recommendations),
  });
}

interface BuildRecommendationsInput {
  readonly config: ResolvedSearchConfig;
  readonly embeddingKeyResolved: boolean;
  readonly vecExtension: "loaded" | "unavailable" | "not-attempted";
  readonly providerReachable: boolean | null;
}

function buildRecommendations(input: BuildRecommendationsInput): string[] {
  const recs: string[] = [];

  if (input.config.semantic.enabled && !input.embeddingKeyResolved) {
    recs.push(
      "Set OPEN_SECOND_BRAIN_EMBEDDING_KEY in ~/.hermes/.env (or the configured env file).",
    );
    recs.push(
      "Provider: OpenAI `text-embedding-3-small` is the default; any OpenAI-compatible endpoint works via OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL.",
    );
  }

  if (input.vecExtension === "unavailable") {
    if (process.platform === "darwin") {
      recs.push(
        "Install Homebrew SQLite: `brew install sqlite`. The o2b wrapper picks it up automatically on the next invocation via DYLD_LIBRARY_PATH.",
      );
    } else {
      recs.push(
        "sqlite-vec did not load. Confirm the optional dependency with `bun pm ls`, or rebuild with `bun install --force`.",
      );
    }
  }

  // "Everything wired, no embeddings yet" → suggest the first
  // reindex plus the optional cron template. providerReachable is
  // `true` only after both key and vec are present, so it is the
  // tightest proxy for "ready to compute but never did".
  if (input.providerReachable === true && input.vecExtension === "loaded") {
    recs.push(
      "Run `o2b search reindex --embeddings` to compute the first vectors, then optionally `o2b search reindex --cron-template` for periodic refresh.",
    );
  }

  return recs;
}

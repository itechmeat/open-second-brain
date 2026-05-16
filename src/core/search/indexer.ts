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
import { makeProvider } from "./embeddings/provider.ts";
import { extractLinks } from "./links.ts";
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
    durationMs,
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

    for (const file of walkVault(config)) {
      // Mark seen FIRST. If anything downstream throws (read fault,
      // chunker bug, transient FS error), the file must not look
      // "missing" to the deletion sweep below — that would wipe a
      // present file from the index just because a single read failed.
      seen.add(file.relPath);
      try {
        const content = readUtf8(file.absPath);
        const contentHash = sha256(content);
        const mtimeSec = Math.floor(file.stat.mtimeMs / 1000);
        const prev = existing.get(file.relPath);

        if (!opts?.force && prev && prev.contentHash === contentHash && prev.mtime === mtimeSec) {
          stats.unchanged++;
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

        const docId = store.upsertDocument({
          path: file.relPath,
          title: chunkResult.title,
          contentHash,
          mtime: mtimeSec,
          size: file.stat.size,
        });

        const chunkInputs: ChunkInput[] = chunkResult.chunks.map((c) => ({
          chunkIndex: c.chunkIndex,
          content: c.content,
          contentHash: sha256(c.content),
          startLine: c.startLine,
          endLine: c.endLine,
          tokenCount: c.tokenCount,
        }));
        const chunkIds = store.replaceChunks(docId, chunkInputs);

        const links: LinkInput[] = [];
        for (let i = 0; i < chunkResult.chunks.length; i++) {
          const cid = chunkIds[i]!;
          const extracted = extractLinks(chunkResult.chunks[i]!.content);
          for (const l of extracted) {
            links.push({
              sourceChunkId: cid,
              targetPath: l.targetPath,
              linkText: l.linkText,
              linkType: l.linkType,
            });
          }
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

    if (opts?.embeddings) {
      await populateEmbeddings(store, config, stats);
    }

    const now = new Date().toISOString();
    store.setState("last_indexed_at", now);
    if (opts?.force) store.setState("last_full_index_at", now);

    return freezeStats(stats, Date.now() - t0);
  } finally {
    if (ownsStore) await store.close();
  }
}

async function populateEmbeddings(
  store: Store,
  config: ResolvedSearchConfig,
  stats: MutableStats,
): Promise<void> {
  if (!config.semantic.enabled) {
    throw new SearchError(
      "EMBEDDING_DISABLED",
      "set search_semantic_enabled=true and embedding_* keys to compute embeddings",
    );
  }
  if (!store.vecLoaded()) {
    throw new SearchError(
      "VEC_EXTENSION_UNAVAILABLE",
      "sqlite-vec did not load; cannot store embeddings",
    );
  }
  if (!config.semantic.apiKey) {
    throw new SearchError(
      "EMBEDDING_KEY_MISSING",
      "embedding_api_key is required when computing embeddings",
    );
  }

  const pending = store.findChunksWithoutEmbeddings();
  if (pending.length === 0) return;

  const provider = makeProvider(config.semantic);
  const model = config.semantic.model ?? provider.model;
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
      throw new SearchError("EMBEDDING_DIMENSION_MISMATCH", "provider returned vectors of zero length");
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
    if (config.semantic.enabled && !config.semantic.apiKey) {
      warnings.push("embedding_api_key not configured; semantic search disabled");
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
  });
}


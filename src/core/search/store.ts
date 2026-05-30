/**
 * Single SQL boundary for `src/core/search/*`. Every read or write of
 * the index passes through this module. Other modules use the typed
 * surface defined here so that:
 *
 *   - the SQLite backend can be swapped without touching callers;
 *   - the explicit two-step deletion of `chunk_vec` rows (which the
 *     SQLite FK cascade does NOT reach, see design §5) is centralised
 *     in one place;
 *   - the embedding-model fingerprint check runs in one place at open
 *     time.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §5, §15.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

import { computeCorpusGeneration } from "./corpus-generation.ts";
import { SearchError } from "./types.ts";
import type { ResolvedSearchConfig } from "./types.ts";
import {
  applyMigrations,
  dropVecTable,
  ensureVecTable,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
} from "./schema.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreOpenOptions {
  /** "read" never locks; "write" acquires an exclusive proper-lockfile. */
  readonly mode: "read" | "write";
  /** When false, the vec extension is not auto-loaded (used by tests). */
  readonly loadVec?: boolean;
}

export interface DocumentInput {
  readonly path: string; // vault-relative POSIX
  readonly title: string | null;
  readonly contentHash: string;
  readonly mtime: number; // unix seconds
  readonly size: number;
}

export interface DocumentSummary {
  readonly id: number;
  readonly contentHash: string;
  readonly mtime: number;
  readonly size: number;
}

export interface ChunkInput {
  readonly chunkIndex: number;
  readonly content: string;
  readonly ftsContent?: string;
  readonly contentHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokenCount: number;
  /**
   * Heading breadcrumb in effect at the chunk (v0.13.0). Indexed in the
   * dedicated FTS column; defaults to "" so callers that do not supply
   * it (and pre-v0.13.0 fixtures) index an empty heading column.
   */
  readonly headingPath?: string;
}

export interface ChunkRow {
  readonly id: number;
  readonly documentId: number;
  readonly chunkIndex: number;
  readonly content: string;
  readonly contentHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokenCount: number;
}

export interface LinkInput {
  readonly sourceChunkId: number | null;
  readonly targetPath: string | null;
  readonly linkText: string | null;
  readonly linkType: "wikilink" | "markdown_link" | "tag";
  /**
   * Semantic relation type for this edge (v3 / typed graph semantics),
   * orthogonal to `linkType`. `null`/absent for plain syntactic links;
   * set for frontmatter-relation and MCP-config edges. Validated
   * against the open vocabulary in src/core/graph/relation-vocab.ts.
   */
  readonly relation?: string | null;
}

export interface KeywordHit {
  readonly chunkId: number;
  readonly documentId: number;
  /** Lower is better (FTS5 returns negative bm25). */
  readonly bm25: number;
}

export interface SemanticHit {
  readonly chunkId: number;
  readonly documentId: number;
  /** L2 distance on unit-normalised vectors. */
  readonly distance: number;
}

export interface HydratedChunk {
  readonly chunkId: number;
  readonly documentId: number;
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly mtime: number;
}

export interface StoreCounts {
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  /** Embeddings whose `model`/`dimension` no longer match the current config. */
  readonly staleEmbeddings: number;
}

export interface ModelChangeOutcome {
  readonly wasChanged: boolean;
  readonly previousModel: string | null;
  readonly previousDimension: number | null;
  readonly currentModel: string | null;
  readonly currentDimension: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  // Wait briefly for a concurrent writer (e.g. an indexer holding the WAL
  // write lock) instead of failing immediately with SQLITE_BUSY. Matters
  // for the opportunistic query-cache writes a read-mode connection makes
  // during search (v0.20.0); search itself also degrades gracefully.
  db.exec("PRAGMA busy_timeout = 5000");
}

function ensureFts5(db: Database): void {
  // Probe FTS5 by attempting a benign expression. bun:sqlite ships with
  // FTS5 enabled in the embedded amalgamation; failing here means a
  // custom build without FTS5 and the index is unusable.
  try {
    db.query("SELECT fts5_source('chunk_fts')").get();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Older SQLite returns "no such function" or "no such table" depending
    // on whether FTS5 is even compiled in. We treat any failure here as
    // FTS5-unavailable rather than guessing the build flag.
    if (!/fts5|chunk_fts/i.test(msg)) {
      throw new SearchError("INDEX_UNREADABLE", `FTS5 probe failed: ${msg}`);
    }
  }
}

function tryLoadVecExtension(db: Database): boolean {
  try {
    // sqlite-vec is an optional dependency. Wrap the import + load so
    // a missing platform package degrades to "extension unavailable"
    // instead of crashing the process.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(vec.getLoadablePath());
    // Confirm by calling vec_version() — guards against partial loads.
    db.query("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function vecToBuffer(values: ReadonlyArray<number> | Float32Array): Buffer {
  const arr = values instanceof Float32Array ? values : Float32Array.from(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

export class Store {
  private db: Database;
  private readonly config: ResolvedSearchConfig;
  private readonly _vecLoaded: boolean;
  private readonly release: (() => Promise<void>) | null;
  private closed = false;

  private constructor(
    db: Database,
    config: ResolvedSearchConfig,
    vecLoaded: boolean,
    release: (() => Promise<void>) | null,
  ) {
    this.db = db;
    this.config = config;
    this._vecLoaded = vecLoaded;
    this.release = release;
  }

  static async open(config: ResolvedSearchConfig, opts: StoreOpenOptions): Promise<Store> {
    const loadVec = opts.loadVec !== false;

    // Crash recovery: if the main index is missing but `.bak` is present
    // from a failed `reindex` rename window, restore it. Stderr notice
    // (not a thrown error) so existing tooling keeps working.
    if (!existsSync(config.dbPath)) {
      const bak = config.dbPath + ".bak";
      if (existsSync(bak)) {
        try {
          renameSync(bak, config.dbPath);
          // eslint-disable-next-line no-console
          console.error(`restored search index from ${bak} (previous reindex crash)`);
        } catch {
          /* fall through — open path below will report INDEX_MISSING */
        }
      }
    }

    if (opts.mode === "read") {
      if (!existsSync(config.dbPath)) {
        throw new SearchError(
          "INDEX_MISSING",
          `search index not initialised at ${config.dbPath}. Run: o2b search index`,
        );
      }
      let db: Database;
      try {
        db = new Database(config.dbPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new SearchError("INDEX_UNREADABLE", `cannot open ${config.dbPath}: ${msg}`);
      }
      try {
        applyPragmas(db);
        ensureFts5(db);
        let version: number;
        try {
          version = readSchemaVersion(db);
        } catch (e) {
          // A corrupt or non-OSB sqlite file at the index path can make
          // readSchemaVersion throw raw SQLITE errors (e.g. "no such
          // table: index_state"). Surface those as a typed
          // INDEX_UNREADABLE so callers see a code, not a stray Error.
          if (e instanceof SearchError) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          throw new SearchError(
            "INDEX_UNREADABLE",
            `cannot read schema_version from ${config.dbPath}: ${msg}`,
          );
        }
        if (version !== LATEST_SCHEMA_VERSION) {
          throw new SearchError(
            "SCHEMA_MISMATCH",
            `index schema version ${version} != ${LATEST_SCHEMA_VERSION}. Run: o2b search reindex`,
          );
        }
        const vecLoaded = loadVec && tryLoadVecExtension(db);
        return new Store(db, config, vecLoaded, null);
      } catch (e) {
        db.close();
        throw e;
      }
    }

    // mode === "write"
    mkdirSync(dirname(config.dbPath), { recursive: true });
    if (!existsSync(config.dbPath)) {
      const seed = new Database(config.dbPath);
      seed.close();
    }

    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(config.dbPath, {
        retries: { retries: 3, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
        stale: 60_000,
        realpath: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SearchError("INDEX_LOCKED", `another writer holds the search index lock: ${msg}`);
    }

    let db: Database;
    try {
      db = new Database(config.dbPath);
    } catch (e) {
      await release();
      const msg = e instanceof Error ? e.message : String(e);
      throw new SearchError("INDEX_UNREADABLE", `cannot open ${config.dbPath}: ${msg}`);
    }

    try {
      applyPragmas(db);
      applyMigrations(db);
      ensureFts5(db);
      const vecLoaded = loadVec && tryLoadVecExtension(db);
      const store = new Store(db, config, vecLoaded, release);
      store.ensureEmbeddingModel(config.semantic.model, config.semantic.dimension);
      return store;
    } catch (e) {
      try {
        db.close();
      } catch {
        /* ignore close errors */
      }
      await release();
      throw e;
    }
  }

  vecLoaded(): boolean {
    return this._vecLoaded;
  }

  schemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Writer mode: consolidate WAL into the main file and switch back to
      // DELETE journal mode so the `-wal`/`-shm` siblings are removed. This
      // matters for `reindexVault`: after the temp-file rename swap, any
      // orphan `*-wal` next to the new main would trigger
      // SQLITE_IOERR_SHORT_READ on the next open.
      if (this.release) {
        try {
          this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          this.db.exec("PRAGMA journal_mode = DELETE");
        } catch (e) {
          // Don't fail the close, but make the failure visible — an
          // unconsolidated WAL is the exact thing that triggers
          // SQLITE_IOERR_SHORT_READ after a `reindexVault` rename swap.
          const msg = e instanceof Error ? e.message : String(e);
          // eslint-disable-next-line no-console
          console.error(`search store: WAL consolidation failed on close: ${msg}`);
        }
      }
      this.db.close();
    } finally {
      if (this.release) await this.release();
    }
  }

  // ── index_state KV ─────────────────────────────────────────────────────────

  getState(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.run(
      "INSERT INTO index_state(key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, value, nowIso()],
    );
  }

  deleteState(key: string): void {
    this.db.run("DELETE FROM index_state WHERE key = ?", [key]);
  }

  // ── index revision + corpus generation (v0.20.0) ─────────────────────────────

  /** Monotonic counter bumped on every index mutation; 0 if never set. */
  indexRevision(): number {
    const raw = this.getState("index_revision");
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /** Increment the index revision. Called after a mutating index run. */
  bumpIndexRevision(): void {
    this.setState("index_revision", String(this.indexRevision() + 1));
  }

  /**
   * Current corpus-generation fingerprint: embedding model + dimension +
   * schema version + index revision. The query cache gates on this so any
   * embedding change or content reindex invalidates cached results.
   */
  corpusGeneration(): string {
    const dimRaw = this.getState("embedding_dimension");
    const dim = dimRaw === null ? null : Number(dimRaw);
    return computeCorpusGeneration({
      embeddingModel: this.getState("embedding_model"),
      embeddingDimension: dim !== null && Number.isFinite(dim) ? dim : null,
      schemaVersion: LATEST_SCHEMA_VERSION,
      indexRevision: this.indexRevision(),
    });
  }

  // ── query cache (v0.20.0) ────────────────────────────────────────────────────

  queryCacheGet(key: string): { generation: string; payload: string; createdAt: number } | null {
    const row = this.db
      .query<{ generation: string; payload: string; created_at: number }, [string]>(
        "SELECT generation, payload, created_at FROM query_cache WHERE cache_key = ?",
      )
      .get(key);
    if (!row) return null;
    return {
      generation: row.generation,
      payload: row.payload,
      createdAt: row.created_at,
    };
  }

  queryCachePut(key: string, generation: string, payload: string, createdAtMs: number): void {
    this.db.run(
      "INSERT INTO query_cache(cache_key, generation, payload, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(cache_key) DO UPDATE SET generation = excluded.generation, " +
        "payload = excluded.payload, created_at = excluded.created_at",
      [key, generation, payload, createdAtMs],
    );
  }

  /** Delete rows from a stale generation or created before the cutoff. */
  queryCacheSweep(currentGeneration: string, expiredBeforeMs: number): void {
    this.db.run("DELETE FROM query_cache WHERE generation <> ? OR created_at < ?", [
      currentGeneration,
      expiredBeforeMs,
    ]);
  }

  // ── documents ──────────────────────────────────────────────────────────────

  listDocuments(): Map<string, DocumentSummary> {
    const rows = this.db
      .query<
        {
          id: number;
          path: string;
          content_hash: string;
          mtime: number;
          size: number;
        },
        []
      >("SELECT id, path, content_hash, mtime, size FROM documents")
      .all();
    const map = new Map<string, DocumentSummary>();
    for (const r of rows) {
      map.set(r.path, {
        id: r.id,
        contentHash: r.content_hash,
        mtime: r.mtime,
        size: r.size,
      });
    }
    return map;
  }

  getDocumentIdByPath(path: string): number | null {
    const row = this.db
      .query<{ id: number }, [string]>("SELECT id FROM documents WHERE path = ?")
      .get(path);
    return row?.id ?? null;
  }

  upsertDocument(doc: DocumentInput): number {
    const now = nowIso();
    // SQLite RETURNING on INSERT...ON CONFLICT works in 3.35+; bun:sqlite ships modern SQLite.
    const row = this.db
      .query<
        { id: number },
        [string, string | null, string, number, number, string, string, string]
      >(
        "INSERT INTO documents(path, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET " +
          "  title = excluded.title, " +
          "  content_hash = excluded.content_hash, " +
          "  mtime = excluded.mtime, " +
          "  size = excluded.size, " +
          "  updated_at = excluded.updated_at, " +
          "  indexed_at = excluded.indexed_at " +
          "RETURNING id",
      )
      .get(doc.path, doc.title, doc.contentHash, doc.mtime, doc.size, now, now, now);
    if (!row) {
      throw new SearchError("INDEX_UNREADABLE", `upsertDocument returned no id for '${doc.path}'`);
    }
    return row.id;
  }

  /**
   * Delete a document and everything that hangs off it. The vec rows
   * are removed first because the FK cascade does not reach the
   * `chunk_vec` virtual table.
   */
  deleteDocument(path: string): void {
    const id = this.getDocumentIdByPath(path);
    if (id === null) return;
    this.purgeVecRowsForDocument(id);
    this.db.run("DELETE FROM documents WHERE id = ?", [id]);
  }

  /**
   * Touch a document's mtime and size without changing its title,
   * hash, or triggering chunk replacement. Used by the indexer's
   * mtime-fastpath fallback to re-arm the stat cache after a
   * same-content touch.
   */
  touchDocument(path: string, mtime: number, size: number): void {
    const now = nowIso();
    this.db.run(
      "UPDATE documents SET mtime = ?, size = ?, updated_at = ?, indexed_at = ? WHERE path = ?",
      [mtime, size, now, now, path],
    );
  }

  // ── chunks ─────────────────────────────────────────────────────────────────

  getChunksByDocument(documentId: number): ChunkRow[] {
    const rows = this.db
      .query<
        {
          id: number;
          document_id: number;
          chunk_index: number;
          content: string;
          content_hash: string;
          start_line: number;
          end_line: number;
          token_count: number;
        },
        [number]
      >(
        "SELECT id, document_id, chunk_index, content, content_hash, start_line, end_line, token_count " +
          "FROM chunks WHERE document_id = ? ORDER BY chunk_index",
      )
      .all(documentId);
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      contentHash: r.content_hash,
      startLine: r.start_line,
      endLine: r.end_line,
      tokenCount: r.token_count,
    }));
  }

  /**
   * Atomically replace every chunk for a document. Old vec rows are
   * removed first; FTS5 stays in sync via the chunks_ai/ad/au triggers.
   * Returns the new chunk ids in `chunkIndex` order.
   */
  replaceChunks(documentId: number, chunks: ReadonlyArray<ChunkInput>): number[] {
    const ids: number[] = [];
    this.db.exec("BEGIN");
    try {
      this.purgeVecRowsForDocument(documentId);
      this.db.run("DELETE FROM chunks WHERE document_id = ?", [documentId]);
      const insert = this.db.prepare<
        { id: number },
        [number, number, string, string, string, number, number, number, string, string, string]
      >(
        "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, heading_path, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      );
      const now = nowIso();
      for (const c of chunks) {
        const row = insert.get(
          documentId,
          c.chunkIndex,
          c.content,
          c.ftsContent ?? c.content,
          c.contentHash,
          c.startLine,
          c.endLine,
          c.tokenCount,
          c.headingPath ?? "",
          now,
          now,
        );
        if (!row) throw new SearchError("INDEX_UNREADABLE", "chunk insert returned no id");
        ids.push(row.id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return ids;
  }

  /**
   * Delete a set of chunks by id. Vec rows removed first.
   */
  deleteChunks(chunkIds: ReadonlyArray<number>): void {
    if (chunkIds.length === 0) return;
    this.db.exec("BEGIN");
    try {
      this.purgeVecRowsByChunkIds(chunkIds);
      const placeholders = chunkIds.map(() => "?").join(",");
      this.db.run(`DELETE FROM chunks WHERE id IN (${placeholders})`, chunkIds as number[]);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private purgeVecRowsForDocument(documentId: number): void {
    if (!this._vecLoaded) return;
    const vecRows = this.db
      .query<{ vec_rowid: number }, [number]>(
        "SELECT vec_rowid FROM chunk_vec_map WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
      )
      .all(documentId);
    if (vecRows.length === 0) return;
    this.purgeVecRowidsRaw(vecRows.map((r) => r.vec_rowid));
  }

  private purgeVecRowsByChunkIds(chunkIds: ReadonlyArray<number>): void {
    if (!this._vecLoaded || chunkIds.length === 0) return;
    const placeholders = chunkIds.map(() => "?").join(",");
    const vecRows = this.db
      .query<{ vec_rowid: number }, number[]>(
        `SELECT vec_rowid FROM chunk_vec_map WHERE chunk_id IN (${placeholders})`,
      )
      .all(...(chunkIds as number[]));
    if (vecRows.length === 0) return;
    this.purgeVecRowidsRaw(vecRows.map((r) => r.vec_rowid));
  }

  private purgeVecRowidsRaw(vecRowids: number[]): void {
    if (!this._vecLoaded || vecRowids.length === 0) return;
    const placeholders = vecRowids.map(() => "?").join(",");
    this.db.run(`DELETE FROM chunk_vec WHERE rowid IN (${placeholders})`, vecRowids);
  }

  // ── embeddings ─────────────────────────────────────────────────────────────

  /**
   * Insert or replace a single embedding. The vec table receives the
   * raw float32 bytes; the metadata row in `embeddings` tracks model /
   * dimension / hash for stale detection.
   *
   * Throws VEC_EXTENSION_UNAVAILABLE if sqlite-vec didn't load. The
   * caller decides whether to surface this (explicit semantic) or warn
   * and skip (implicit semantic).
   */
  vecUpsert(
    chunkId: number,
    vector: ReadonlyArray<number> | Float32Array,
    model: string,
    dimension: number,
    embeddingHash: string,
  ): void {
    if (!this._vecLoaded) {
      throw new SearchError(
        "VEC_EXTENSION_UNAVAILABLE",
        "sqlite-vec extension not loaded; cannot store embeddings",
      );
    }
    const len = vector instanceof Float32Array ? vector.length : vector.length;
    if (len !== dimension) {
      throw new SearchError(
        "EMBEDDING_DIMENSION_MISMATCH",
        `vector dimension ${len} != configured dimension ${dimension}`,
      );
    }
    this.db.exec("BEGIN");
    try {
      const existing = this.db
        .query<{ vec_rowid: number }, [number]>(
          "SELECT vec_rowid FROM chunk_vec_map WHERE chunk_id = ?",
        )
        .get(chunkId);
      const buf = vecToBuffer(vector);
      let vecRowid: number;
      if (existing) {
        this.db.run("UPDATE chunk_vec SET embedding = ? WHERE rowid = ?", [
          buf,
          existing.vec_rowid,
        ]);
        vecRowid = existing.vec_rowid;
      } else {
        this.db.run("INSERT INTO chunk_vec(embedding) VALUES (?)", [buf]);
        const row = this.db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
        if (!row) throw new SearchError("INDEX_UNREADABLE", "chunk_vec insert returned no rowid");
        vecRowid = row.id;
        this.db.run("INSERT INTO chunk_vec_map(chunk_id, vec_rowid) VALUES (?, ?)", [
          chunkId,
          vecRowid,
        ]);
      }
      const now = nowIso();
      this.db.run(
        "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(chunk_id) DO UPDATE SET " +
          "  model = excluded.model, dimension = excluded.dimension, " +
          "  embedding_hash = excluded.embedding_hash, updated_at = excluded.updated_at",
        [chunkId, model, dimension, embeddingHash, now, now],
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getEmbeddingHash(chunkId: number): string | null {
    const row = this.db
      .query<{ embedding_hash: string }, [number]>(
        "SELECT embedding_hash FROM embeddings WHERE chunk_id = ?",
      )
      .get(chunkId);
    return row?.embedding_hash ?? null;
  }

  /**
   * Drop all embeddings + vec storage. Used when the configured model
   * or dimension changes. `chunks` and `chunk_fts` are preserved.
   */
  clearEmbeddings(): void {
    this.db.exec("BEGIN");
    try {
      this.db.run("DELETE FROM embeddings");
      this.db.run("DELETE FROM chunk_vec_map");
      if (this._vecLoaded) dropVecTable(this.db);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Compare the configured embedding model/dimension with what was
   * recorded in `index_state` on the last index run. If they differ
   * and both old + new are non-null, drop embeddings + vec table and
   * log one line per design §13. First-time set just records state.
   */
  ensureEmbeddingModel(model: string | null, dimension: number | null): ModelChangeOutcome {
    const prevModel = this.getState("embedding_model");
    const prevDimRaw = this.getState("embedding_dimension");
    const prevDim = prevDimRaw === null ? null : Number(prevDimRaw);

    const modelChanged = prevModel !== null && model !== null && prevModel !== model;
    const dimChanged =
      prevDim !== null && dimension !== null && Number.isFinite(prevDim) && prevDim !== dimension;

    if (modelChanged || dimChanged) {
      this.clearEmbeddings();
      // eslint-disable-next-line no-console
      console.error(
        `embedding model changed from ${prevModel}/${prevDim} to ${model}/${dimension}, embeddings cleared`,
      );
      this.deleteState("embedding_model");
      this.deleteState("embedding_dimension");
    }

    if (model !== null) this.setState("embedding_model", model);
    if (dimension !== null) this.setState("embedding_dimension", String(dimension));

    // (Re)create vec table when we know the dimension and vec is loaded.
    if (this._vecLoaded && dimension !== null) {
      ensureVecTable(this.db, dimension);
    }

    return Object.freeze({
      wasChanged: modelChanged || dimChanged,
      previousModel: prevModel,
      previousDimension: prevDim,
      currentModel: model,
      currentDimension: dimension,
    });
  }

  // ── links ──────────────────────────────────────────────────────────────────

  replaceLinks(sourceDocumentId: number, links: ReadonlyArray<LinkInput>): void {
    this.db.exec("BEGIN");
    try {
      this.db.run("DELETE FROM links WHERE source_document_id = ?", [sourceDocumentId]);
      if (links.length > 0) {
        const insert = this.db.prepare<
          undefined,
          [number, number | null, string | null, string | null, string, string | null, string]
        >(
          "INSERT INTO links(source_document_id, source_chunk_id, target_path, link_text, link_type, relation, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        const now = nowIso();
        for (const l of links) {
          insert.run(
            sourceDocumentId,
            l.sourceChunkId,
            l.targetPath,
            l.linkText,
            l.linkType,
            l.relation ?? null,
            now,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  resolveLinkTargets(): void {
    this.db.run(
      "UPDATE links SET target_document_id = (SELECT id FROM documents WHERE documents.path = links.target_path) " +
        "WHERE target_path IS NOT NULL",
    );
  }

  /**
   * For each document id, the typed relation edges it declares
   * (v3 / typed graph semantics): rows whose `relation` is set, in
   * insertion order. The target is the edge's `target_path` as written.
   * Documents with no typed edges are absent from the returned map.
   */
  typedRelationsForDocuments(
    documentIds: ReadonlyArray<number>,
  ): Map<number, Array<{ relation: string; target: string }>> {
    const out = new Map<number, Array<{ relation: string; target: string }>>();
    if (documentIds.length === 0) return out;
    const placeholders = documentIds.map(() => "?").join(",");
    const rows = this.db
      .query<
        {
          source_document_id: number;
          relation: string;
          target_path: string | null;
        },
        number[]
      >(
        "SELECT source_document_id, relation, target_path FROM links " +
          `WHERE source_document_id IN (${placeholders}) AND relation IS NOT NULL ` +
          "ORDER BY id",
      )
      .all(...(documentIds as number[]));
    for (const r of rows) {
      const target = r.target_path ?? "";
      if (target === "") continue;
      const arr = out.get(r.source_document_id);
      const edge = { relation: r.relation, target };
      if (arr) arr.push(edge);
      else out.set(r.source_document_id, [edge]);
    }
    return out;
  }

  // ── search ─────────────────────────────────────────────────────────────────

  /**
   * Top-K BM25 keyword hits. `fts5Query` is an already-escaped FTS5
   * MATCH expression; building it is fts.ts's job.
   */
  keywordTopK(
    fts5Query: string,
    opts: { readonly limit: number; readonly pathPrefix?: string | null },
  ): KeywordHit[] {
    const limit = Math.max(1, opts.limit | 0);
    const prefix = opts.pathPrefix && opts.pathPrefix.length > 0 ? opts.pathPrefix : null;

    if (prefix) {
      const rows = this.db
        .query<
          { chunk_id: number; document_id: number; bm25: number },
          [string, string, string, number]
        >(
          "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_fts, 1.0, 0.3) AS bm25 " +
            "FROM chunk_fts " +
            "JOIN chunks c ON c.id = chunk_fts.rowid " +
            "JOIN documents d ON d.id = c.document_id " +
            "WHERE chunk_fts MATCH ? AND substr(d.path, 1, length(?)) = ? " +
            "ORDER BY bm25 ASC LIMIT ?",
        )
        .all(fts5Query, prefix, prefix, limit);
      return rows.map((r) => ({
        chunkId: r.chunk_id,
        documentId: r.document_id,
        bm25: r.bm25,
      }));
    }

    const rows = this.db
      .query<{ chunk_id: number; document_id: number; bm25: number }, [string, number]>(
        "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_fts, 1.0, 0.3) AS bm25 " +
          "FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid " +
          "WHERE chunk_fts MATCH ? ORDER BY bm25 ASC LIMIT ?",
      )
      .all(fts5Query, limit);
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      bm25: r.bm25,
    }));
  }

  semanticTopK(
    queryVector: ReadonlyArray<number> | Float32Array,
    opts: { readonly limit: number; readonly pathPrefix?: string | null },
  ): SemanticHit[] {
    if (!this._vecLoaded) {
      throw new SearchError(
        "VEC_EXTENSION_UNAVAILABLE",
        "sqlite-vec extension not loaded; semantic search unavailable",
      );
    }
    const limit = Math.max(1, opts.limit | 0);
    const prefix = opts.pathPrefix && opts.pathPrefix.length > 0 ? opts.pathPrefix : null;

    const buf = vecToBuffer(queryVector);
    if (prefix) {
      const rows = this.db
        .query<
          { chunk_id: number; document_id: number; distance: number },
          [Buffer, number, string, string]
        >(
          "SELECT m.chunk_id AS chunk_id, c.document_id AS document_id, v.distance AS distance " +
            "FROM chunk_vec v " +
            "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid " +
            "JOIN chunks c ON c.id = m.chunk_id " +
            "JOIN documents d ON d.id = c.document_id " +
            "WHERE v.embedding MATCH ? AND k = ? AND substr(d.path, 1, length(?)) = ? " +
            "ORDER BY v.distance ASC",
        )
        .all(buf, limit * 4, prefix, prefix);
      return rows.slice(0, limit).map((r) => ({
        chunkId: r.chunk_id,
        documentId: r.document_id,
        distance: r.distance,
      }));
    }

    const rows = this.db
      .query<{ chunk_id: number; document_id: number; distance: number }, [Buffer, number]>(
        "SELECT m.chunk_id AS chunk_id, c.document_id AS document_id, v.distance AS distance " +
          "FROM chunk_vec v " +
          "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid " +
          "JOIN chunks c ON c.id = m.chunk_id " +
          "WHERE v.embedding MATCH ? AND k = ? " +
          "ORDER BY v.distance ASC",
      )
      .all(buf, limit);
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      distance: r.distance,
    }));
  }

  hydrateChunks(chunkIds: ReadonlyArray<number>): Map<number, HydratedChunk> {
    const out = new Map<number, HydratedChunk>();
    if (chunkIds.length === 0) return out;
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = this.db
      .query<
        {
          chunk_id: number;
          document_id: number;
          path: string;
          title: string | null;
          content: string;
          start_line: number;
          end_line: number;
          mtime: number;
        },
        number[]
      >(
        "SELECT c.id AS chunk_id, c.document_id, d.path AS path, d.title AS title, " +
          "       c.content AS content, c.start_line AS start_line, c.end_line AS end_line, d.mtime AS mtime " +
          "FROM chunks c JOIN documents d ON d.id = c.document_id " +
          `WHERE c.id IN (${placeholders})`,
      )
      .all(...(chunkIds as number[]));
    for (const r of rows) {
      out.set(r.chunk_id, {
        chunkId: r.chunk_id,
        documentId: r.document_id,
        path: r.path,
        title: r.title,
        content: r.content,
        startLine: r.start_line,
        endLine: r.end_line,
        mtime: r.mtime,
      });
    }
    return out;
  }

  /**
   * For each chunk id, return the document ids that link TO that
   * chunk's document via wikilink or markdown_link. Pure data; the
   * ranker decides how to convert this into a boost.
   */
  inboundLinkSources(candidateChunkIds: ReadonlyArray<number>): Map<number, Set<number>> {
    const out = new Map<number, Set<number>>();
    if (candidateChunkIds.length === 0) return out;
    const placeholders = candidateChunkIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ chunk_id: number; source_document_id: number }, number[]>(
        "SELECT c.id AS chunk_id, l.source_document_id " +
          `FROM chunks c JOIN links l ON l.target_document_id = c.document_id ` +
          `WHERE c.id IN (${placeholders}) AND l.link_type IN ('wikilink','markdown_link') ` +
          `  AND l.source_document_id != c.document_id`,
      )
      .all(...(candidateChunkIds as number[]));
    for (const r of rows) {
      let set = out.get(r.chunk_id);
      if (!set) {
        set = new Set();
        out.set(r.chunk_id, set);
      }
      set.add(r.source_document_id);
    }
    return out;
  }

  /**
   * For each source document id, the list of resolved outbound link
   * target document ids (wikilink / markdown_link only; tags and
   * unresolved targets excluded; self-links dropped). Used by the
   * recall traversal layer to walk one or more hops out from a hit.
   */
  outboundLinkTargets(sourceDocumentIds: ReadonlyArray<number>): Map<number, number[]> {
    const out = new Map<number, number[]>();
    if (sourceDocumentIds.length === 0) return out;
    const placeholders = sourceDocumentIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ source_document_id: number; target_document_id: number }, number[]>(
        "SELECT DISTINCT l.source_document_id, l.target_document_id " +
          `FROM links l ` +
          `WHERE l.source_document_id IN (${placeholders}) ` +
          `  AND l.target_document_id IS NOT NULL ` +
          `  AND l.target_document_id != l.source_document_id ` +
          `  AND l.link_type IN ('wikilink','markdown_link') ` +
          `ORDER BY l.source_document_id, l.target_document_id`,
      )
      .all(...(sourceDocumentIds as number[]));
    for (const r of rows) {
      let list = out.get(r.source_document_id);
      if (!list) {
        list = [];
        out.set(r.source_document_id, list);
      }
      list.push(r.target_document_id);
    }
    return out;
  }

  /**
   * One representative chunk per document - the lowest `chunk_index`,
   * which for markdown is the document head (title / opening section).
   * The traversal layer surfaces this when a linked document is not
   * already a relevance hit.
   */
  representativeChunks(documentIds: ReadonlyArray<number>): Map<number, HydratedChunk> {
    const out = new Map<number, HydratedChunk>();
    if (documentIds.length === 0) return out;
    const placeholders = documentIds.map(() => "?").join(",");
    const rows = this.db
      .query<
        {
          chunk_id: number;
          document_id: number;
          path: string;
          title: string | null;
          content: string;
          start_line: number;
          end_line: number;
          mtime: number;
        },
        number[]
      >(
        "SELECT c.id AS chunk_id, c.document_id AS document_id, d.path AS path, " +
          "d.title AS title, c.content AS content, c.start_line AS start_line, " +
          "c.end_line AS end_line, d.mtime AS mtime " +
          "FROM chunks c JOIN documents d ON d.id = c.document_id " +
          `WHERE c.document_id IN (${placeholders}) ` +
          "ORDER BY c.document_id, c.chunk_index ASC",
      )
      .all(...(documentIds as number[]));
    for (const r of rows) {
      if (out.has(r.document_id)) continue; // first row per doc = lowest chunk_index
      out.set(
        r.document_id,
        Object.freeze({
          chunkId: r.chunk_id,
          documentId: r.document_id,
          path: r.path,
          title: r.title,
          content: r.content,
          startLine: r.start_line,
          endLine: r.end_line,
          mtime: r.mtime,
        }),
      );
    }
    return out;
  }

  // ── entities ─────────────────────────────────────────────────────────────

  /**
   * Replace a chunk's entity set (v0.13.0). Deletes any prior entries
   * for the chunk, then inserts the deduped list. Entities are expected
   * pre-normalised (lowercased) by the extractor.
   */
  replaceEntities(chunkId: number, entities: ReadonlyArray<string>): void {
    this.db.exec("BEGIN");
    try {
      this.db.run("DELETE FROM chunk_entities WHERE chunk_id = ?", [chunkId]);
      if (entities.length > 0) {
        const insert = this.db.prepare<undefined, [number, string]>(
          "INSERT OR IGNORE INTO chunk_entities(chunk_id, entity) VALUES (?, ?)",
        );
        for (const e of entities) insert.run(chunkId, e);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * For each candidate chunk, the count of distinct query entities it
   * also carries. Empty `queryEntities` yields an empty map (no work).
   * Pure read; used by the ranker to add a capped entity boost.
   */
  chunkEntityMatches(
    candidateChunkIds: ReadonlyArray<number>,
    queryEntities: ReadonlyArray<string>,
  ): Map<number, number> {
    const out = new Map<number, number>();
    if (candidateChunkIds.length === 0 || queryEntities.length === 0) return out;
    const chunkPlaceholders = candidateChunkIds.map(() => "?").join(",");
    const entityPlaceholders = queryEntities.map(() => "?").join(",");
    const rows = this.db
      .query<{ chunk_id: number; c: number }, (number | string)[]>(
        "SELECT chunk_id, COUNT(DISTINCT entity) AS c FROM chunk_entities " +
          `WHERE chunk_id IN (${chunkPlaceholders}) AND entity IN (${entityPlaceholders}) ` +
          "GROUP BY chunk_id",
      )
      .all(...(candidateChunkIds as number[]), ...(queryEntities as string[]));
    for (const r of rows) out.set(r.chunk_id, r.c);
    return out;
  }

  /**
   * For each chunk id, the set of tag link_text values associated with
   * its document. Two chunks "share a tag" iff their tag sets intersect.
   */
  tagsByChunkDocument(candidateChunkIds: ReadonlyArray<number>): Map<number, Set<string>> {
    const out = new Map<number, Set<string>>();
    if (candidateChunkIds.length === 0) return out;
    const placeholders = candidateChunkIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ chunk_id: number; tag: string }, number[]>(
        "SELECT c.id AS chunk_id, l.link_text AS tag " +
          `FROM chunks c JOIN links l ON l.source_document_id = c.document_id ` +
          `WHERE c.id IN (${placeholders}) AND l.link_type = 'tag' AND l.link_text IS NOT NULL`,
      )
      .all(...(candidateChunkIds as number[]));
    for (const r of rows) {
      let set = out.get(r.chunk_id);
      if (!set) {
        set = new Set();
        out.set(r.chunk_id, set);
      }
      set.add(r.tag);
    }
    return out;
  }

  // ── counts ─────────────────────────────────────────────────────────────────

  counts(): StoreCounts {
    const docs = this.db.query<{ c: number }, []>("SELECT count(*) AS c FROM documents").get();
    const chunks = this.db.query<{ c: number }, []>("SELECT count(*) AS c FROM chunks").get();
    const emb = this.db.query<{ c: number }, []>("SELECT count(*) AS c FROM embeddings").get();
    const stale = this.staleEmbeddings();
    return Object.freeze({
      documents: docs?.c ?? 0,
      chunks: chunks?.c ?? 0,
      embeddings: emb?.c ?? 0,
      staleEmbeddings: stale,
    });
  }

  private staleEmbeddings(): number {
    const model = this.config.semantic.model;
    const dimension = this.config.semantic.dimension;
    if (!model || !dimension) {
      // No baseline to compare against: 0 stale by convention.
      return 0;
    }
    const row = this.db
      .query<{ c: number }, [string, number]>(
        "SELECT count(*) AS c FROM embeddings WHERE model != ? OR dimension != ?",
      )
      .get(model, dimension);
    return row?.c ?? 0;
  }

  // ── direct accessors used by indexer/CLI/status ────────────────────────────

  /**
   * Chunks that have no row in `embeddings`. Used by the indexer to
   * populate vectors after a fresh index or after the model-change drop.
   */
  findChunksWithoutEmbeddings(): Array<{ chunkId: number; content: string }> {
    const rows = this.db
      .query<{ id: number; content: string }, []>(
        "SELECT c.id AS id, c.content AS content FROM chunks c " +
          "LEFT JOIN embeddings e ON e.chunk_id = c.id " +
          "WHERE e.chunk_id IS NULL ORDER BY c.id",
      )
      .all();
    return rows.map((r) => ({ chunkId: r.id, content: r.content }));
  }

  /** Escape hatch for status queries that don't fit the typed API. */
  rawQuery<T>(sql: string, params: ReadonlyArray<string | number | null> = []): T[] {
    return this.db
      .query<T, (string | number | null)[]>(sql)
      .all(...(params as (string | number | null)[]));
  }
}

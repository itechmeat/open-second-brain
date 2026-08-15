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
 * The statements themselves live one module per table or lane under
 * `store/`; this file is the connection's lifetime, the vec/lock state
 * those statements need, and the typed surface callers hold.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §5, §15.
 */

import { Database } from "bun:sqlite";

import { registerWriterDb, unregisterWriterDb } from "./store-exit.ts";

import { loadIntegrityConfigSafe } from "../brain/policy.ts";
import {
  checkStamp,
  compareStamps,
  STAMP_VERDICT,
  type StampMismatch,
} from "../integrity/stamp.ts";

import { SearchError } from "./types.ts";
import type { ResolvedSearchConfig } from "./types.ts";
import type { EventAnchor } from "./event-anchor.ts";
import { readSchemaVersion } from "./schema.ts";

import * as aliases from "./store/aliases.ts";
import * as chunkEntities from "./store/chunk-entities.ts";
import * as chunks from "./store/chunks.ts";
import * as census from "./store/counts.ts";
import * as documents from "./store/documents.ts";
import * as abi from "./store/embedding-abi.ts";
import * as keyword from "./store/keyword.ts";
import * as lifecycle from "./store/lifecycle.ts";
import * as links from "./store/links.ts";
import * as queryCache from "./store/query-cache-table.ts";
import * as relations from "./store/relations.ts";
import * as state from "./store/state.ts";
import * as tiers from "./store/tiers.ts";
import * as trigram from "./store/trigram.ts";
import * as vectors from "./store/vectors.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public surface re-exported from the per-concern modules
// ─────────────────────────────────────────────────────────────────────────────

export {
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_MODEL_STATE_KEY,
  EMBEDDING_PREFIX_PASSAGE_STATE_KEY,
  EMBEDDING_PREFIX_QUERY_STATE_KEY,
  EMBEDDING_VEC_VERSION_STATE_KEY,
  INDEX_REVISION_STATE_KEY,
  LAST_FULL_INDEX_AT_STATE_KEY,
  LAST_INDEXED_AT_STATE_KEY,
  peekCorpusGenerationSync,
  readCorpusGenerationSync,
} from "./store/state.ts";
export type { IndexPeek } from "./store/state.ts";

export {
  contradictedAbiFields,
  EMBEDDING_ABI_FIX_COMMAND,
  formatEmbeddingAbiDrift,
  readEmbeddingAbiSync,
  runtimeEmbeddingAbi,
} from "./store/embedding-abi.ts";

export {
  acquireWriterLock,
  WRITER_LOCK_HEARTBEAT_MS,
  WRITER_LOCK_STALE_MS,
} from "./store/writer-lock.ts";

export { normalizeAlias } from "./store/aliases.ts";

export type { DocumentInput, DocumentSummary } from "./store/documents.ts";
export type { EventAnchor } from "./event-anchor.ts";
export type { ChunkInput, ChunkRow, HydratedChunk } from "./store/chunks.ts";
export type { KeywordHit } from "./store/keyword.ts";
export type { DanglingLinkTarget, LinkInput, LinkResolutionCounts } from "./store/links.ts";
export type { EmbeddingPrefixPair, ModelChangeOutcome, SemanticHit } from "./store/vectors.ts";
export type { StoreCounts } from "./store/counts.ts";

export interface StoreOpenOptions {
  /** "read" never locks; "write" acquires an exclusive proper-lockfile. */
  readonly mode: "read" | "write";
  /** When false, the vec extension is not auto-loaded (used by tests). */
  readonly loadVec?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

export class Store {
  private db: Database;
  private readonly config: ResolvedSearchConfig;
  private readonly loadedVecVersion: string | null;
  private readonly vecExtensionLoaded: boolean;
  private readonly release: (() => Promise<void>) | null;
  private closed = false;
  /** Empty unless a gated read-mode open found ABI drift; see {@link embeddingAbiMismatches}. */
  private abiDrift: ReadonlyArray<StampMismatch> = Object.freeze([]);

  private constructor(
    db: Database,
    config: ResolvedSearchConfig,
    vecVersion: string | null,
    release: (() => Promise<void>) | null,
  ) {
    this.db = db;
    this.config = config;
    this.loadedVecVersion = vecVersion;
    // One source of truth: the version is present exactly when the
    // extension loaded, so "loaded" is derived rather than tracked twice.
    this.vecExtensionLoaded = vecVersion !== null;
    this.release = release;
  }

  static async open(config: ResolvedSearchConfig, opts: StoreOpenOptions): Promise<Store> {
    const loadVec = opts.loadVec !== false;

    // Crash recovery: if the main index is missing but `.bak` is present
    // from a failed `reindex` rename window, restore it. Lock-guarded so a
    // read opening during a live reindex's swap window cannot clobber the
    // freshly built index with the stale `.bak`. Stderr notice (not a thrown
    // error) so existing tooling keeps working.
    lifecycle.restoreFromBakIfMissing(config.dbPath);

    if (opts.mode === "read") {
      const opened = lifecycle.openReadDatabase(config, loadVec);
      try {
        const store = new Store(opened.db, config, opened.vecVersion, null);
        // The read path is where the silent-garbage window actually is:
        // `ensureEmbeddingModel` runs only on a write open, so every MCP
        // query reached `semanticTopK` - and a `chunk_vec` of unknown
        // declared width - with nothing having compared anything.
        store.resolveEmbeddingAbi();
        return store;
      } catch (e) {
        opened.db.close();
        throw e;
      }
    }

    const opened = await lifecycle.openWriteDatabase(config, loadVec);
    try {
      const store = new Store(opened.db, config, opened.vecVersion, opened.release);
      store.ensureEmbeddingModel(config.semantic.model, config.semantic.dimension, {
        query: config.semantic.queryPrefix ?? "",
        passage: config.semantic.passagePrefix ?? "",
      });
      // Belt-and-suspenders: consolidate this writer's WAL on a
      // bypassed close (process.exit / signal-driven exit).
      registerWriterDb(opened.db);
      return store;
    } catch (e) {
      await lifecycle.abandonWriteDatabase(opened.db, opened.release);
      throw e;
    }
  }

  vecLoaded(): boolean {
    return this.vecExtensionLoaded;
  }

  /** sqlite-vec version this connection loaded, or null when unavailable. */
  vecVersion(): string | null {
    return this.loadedVecVersion;
  }

  /**
   * Embedding-ABI fields whose recorded token no longer matches this
   * build (context-integrity-gates, Unit E).
   *
   * Empty when the stamps agree, when semantic search is disabled, and -
   * structurally - whenever `integrity.embedding_abi` is `off`, so a
   * consumer wired to this accessor cannot report anything while the
   * operator has the gate off. A mismatch whose recorded side is `null`
   * is an UNRECORDED field (a store predating the stamp), which is
   * reported but never refused: an absent marker cannot tell an old
   * store from a wrong one.
   */
  embeddingAbiMismatches(): ReadonlyArray<StampMismatch> {
    return this.abiDrift;
  }

  /**
   * Compare the recorded embedding ABI against this build's, under the
   * operator's gate. Called on the READ open, which is where nothing
   * checked before.
   *
   * Runs only when semantic search is enabled, because that is the only
   * configuration that can reach `semanticTopK`; with it disabled the
   * configured model and dimension are null and every comparison would
   * be against nothing.
   *
   * The pure comparison runs FIRST and short-circuits, so the
   * overwhelmingly common no-drift open never pays for a config read.
   * When there is drift, {@link checkStamp} re-runs it under the
   * resolved mode and remains the single authority on what `off`, `warn`
   * and `fail` mean.
   *
   * It reports and refuses; it never rebuilds. `vec_version()` is not
   * stable across environments, so two peers on different sqlite-vec
   * builds each see a mismatch - an automatic rebuild here would loop
   * across a synced vault, which is why the default is `warn` and why
   * the remediation is a command the operator runs.
   */
  private resolveEmbeddingAbi(): void {
    if (!this.config.semantic.enabled) return;
    const recorded = abi.recordedEmbeddingAbi((key) => this.getState(key));
    const runtime = abi.runtimeEmbeddingAbi(this.config, this.loadedVecVersion);
    if (compareStamps(recorded, runtime).length === 0) return;
    const mode = loadIntegrityConfigSafe(this.config.vault).embedding_abi;
    const check = checkStamp(recorded, runtime, mode);
    this.abiDrift = check.mismatches;
    if (check.verdict !== STAMP_VERDICT.fail) return;
    const drifted = abi.contradictedAbiFields(check.mismatches);
    if (drifted.length === 0) return;
    throw new SearchError("EMBEDDING_DIMENSION_MISMATCH", abi.formatEmbeddingAbiDrift(drifted));
  }

  schemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Orderly close owns consolidation below; drop the exit-hook entry.
    unregisterWriterDb(this.db);
    try {
      if (this.release) lifecycle.consolidateWal(this.db);
      this.db.close();
    } finally {
      if (this.release) await this.release();
    }
  }

  // ── index_state KV ─────────────────────────────────────────────────────────

  getState(key: string): string | null {
    return state.getState(this.db, key);
  }

  setState(key: string, value: string): void {
    state.setState(this.db, key, value);
  }

  deleteState(key: string): void {
    state.deleteState(this.db, key);
  }

  // ── index revision + corpus generation (v0.20.0) ─────────────────────────────

  /** Monotonic counter bumped on every index mutation; 0 if never set. */
  indexRevision(): number {
    return state.indexRevision(this.db);
  }

  /** Increment the index revision. Called after a mutating index run. */
  bumpIndexRevision(): void {
    state.bumpIndexRevision(this.db);
  }

  /**
   * Current corpus-generation fingerprint: embedding model + dimension +
   * schema version + index revision. The query cache gates on this so any
   * embedding change or content reindex invalidates cached results.
   */
  corpusGeneration(): string {
    return state.corpusGeneration(this.db);
  }

  // ── query cache (v0.20.0) ────────────────────────────────────────────────────

  queryCacheGet(key: string): { generation: string; payload: string; createdAt: number } | null {
    return queryCache.queryCacheGet(this.db, key);
  }

  queryCachePut(key: string, generation: string, payload: string, createdAtMs: number): void {
    queryCache.queryCachePut(this.db, key, generation, payload, createdAtMs);
  }

  /** Delete rows from a stale generation or created before the cutoff. */
  queryCacheSweep(currentGeneration: string, expiredBeforeMs: number): void {
    queryCache.queryCacheSweep(this.db, currentGeneration, expiredBeforeMs);
  }

  // ── documents ──────────────────────────────────────────────────────────────

  listDocuments(): Map<string, documents.DocumentSummary> {
    return documents.listDocuments(this.db);
  }

  getDocumentIdByPath(path: string): number | null {
    return documents.getDocumentIdByPath(this.db, path);
  }

  /**
   * The materialised event anchor of one path (v11), or null when the
   * document is absent or declared no readable date. The query-side
   * event-time resolver consults this instead of re-scanning the note's
   * body on every query.
   */
  eventAnchorForPath(path: string): EventAnchor | null {
    return documents.eventAnchorForPath(this.db, path);
  }

  /**
   * Vault-relative paths of documents no anchor-aware binary has ever
   * examined (v11) - the rows a pre-anchor index carried across the
   * migration, which are NOT the same as documents that declare no date.
   */
  unexaminedEventAnchorPaths(): string[] {
    return documents.unexaminedEventAnchorPaths(this.db);
  }

  /** How many documents no anchor-aware binary has ever examined (v11). */
  countUnexaminedEventAnchors(): number {
    return documents.countUnexaminedEventAnchors(this.db);
  }

  /**
   * Record one already-indexed document's event anchor and mark it
   * examined, touching nothing else on the row. The backfill's only write.
   */
  setEventAnchor(path: string, anchor: EventAnchor | null): void {
    documents.setEventAnchor(this.db, path, anchor);
  }

  upsertDocument(doc: documents.DocumentInput): number {
    return documents.upsertDocument(this.db, doc);
  }

  /**
   * Delete a document and everything that hangs off it. The vec rows
   * are removed first because the FK cascade does not reach the
   * `chunk_vec` virtual table.
   */
  deleteDocument(path: string): void {
    documents.deleteDocument(this.db, this.vecExtensionLoaded, path);
  }

  /**
   * Touch a document's mtime and size without changing its title,
   * hash, or triggering chunk replacement. Used by the indexer's
   * mtime-fastpath fallback to re-arm the stat cache after a
   * same-content touch.
   */
  touchDocument(path: string, mtime: number, size: number): void {
    documents.touchDocument(this.db, path, mtime, size);
  }

  /**
   * Document id -> { path, title } for every indexed document, reading
   * ONLY the `documents` table (never chunk bodies). The graph query
   * pre-pass uses this for its index-only short-circuit so it can rank and
   * answer from index metadata with zero note bodies hydrated.
   */
  documentTitles(): Map<number, { readonly path: string; readonly title: string | null }> {
    return documents.documentTitles(this.db);
  }

  // ── chunks ─────────────────────────────────────────────────────────────────

  getChunksByDocument(documentId: number): chunks.ChunkRow[] {
    return chunks.getChunksByDocument(this.db, documentId);
  }

  /**
   * Atomically replace every chunk for a document. Old vec rows are
   * removed first; FTS5 stays in sync via the chunks_ai/ad/au triggers.
   * Returns the new chunk ids in `chunkIndex` order.
   */
  replaceChunks(documentId: number, input: ReadonlyArray<chunks.ChunkInput>): number[] {
    return chunks.replaceChunks(this.db, this.vecExtensionLoaded, documentId, input);
  }

  /**
   * Delete a set of chunks by id. Vec rows removed first.
   */
  deleteChunks(chunkIds: ReadonlyArray<number>): void {
    chunks.deleteChunks(this.db, this.vecExtensionLoaded, chunkIds);
  }

  /** Ordered chunk ids for one document (surprisal, t_fddfe64a). */
  chunksForDocument(documentId: number): ReadonlyArray<{ id: number; chunkIndex: number }> {
    return chunks.chunksForDocument(this.db, documentId);
  }

  /** Total indexed chunk count - used to judge trigram-prefilter selectivity. */
  chunkCount(): number {
    return chunks.countChunks(this.db);
  }

  hydrateChunks(chunkIds: ReadonlyArray<number>): Map<number, chunks.HydratedChunk> {
    return chunks.hydrateChunks(this.db, chunkIds);
  }

  /**
   * One representative chunk per document - the lowest `chunk_index`,
   * which for markdown is the document head (title / opening section).
   * The traversal layer surfaces this when a linked document is not
   * already a relevance hit.
   */
  representativeChunks(documentIds: ReadonlyArray<number>): Map<number, chunks.HydratedChunk> {
    return chunks.representativeChunks(this.db, documentIds);
  }

  /**
   * Chunks that have no row in `embeddings`. Used by the indexer to
   * populate vectors after a fresh index or after the model-change drop.
   */
  findChunksWithoutEmbeddings(): Array<{ chunkId: number; content: string }> {
    return chunks.findChunksWithoutEmbeddings(this.db);
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
    vectors.vecUpsert(
      this.db,
      this.vecExtensionLoaded,
      chunkId,
      vector,
      model,
      dimension,
      embeddingHash,
    );
  }

  /**
   * The stored embedding for one chunk, or null when the vec layer is
   * unavailable or the chunk was never embedded (surprisal,
   * t_fddfe64a).
   */
  embeddingForChunk(chunkId: number): Float32Array | null {
    return vectors.embeddingForChunk(this.db, this.vecExtensionLoaded, chunkId);
  }

  getEmbeddingHash(chunkId: number): string | null {
    return vectors.getEmbeddingHash(this.db, chunkId);
  }

  /** Number of chunks with a stored embedding row. */
  countEmbeddings(): number {
    return vectors.countEmbeddings(this.db);
  }

  /**
   * Drop all embeddings + vec storage. Used when the configured model
   * or dimension changes. `chunks` and `chunk_fts` are preserved.
   */
  clearEmbeddings(): void {
    vectors.clearEmbeddings(this.db, this.vecExtensionLoaded);
  }

  /**
   * Compare the configured embedding model/dimension with what was
   * recorded in `index_state` on the last index run. If they differ
   * and both old + new are non-null, drop embeddings + vec table and
   * log one line per design §13. First-time set just records state.
   */
  ensureEmbeddingModel(
    model: string | null,
    dimension: number | null,
    prefixes?: vectors.EmbeddingPrefixPair,
  ): vectors.ModelChangeOutcome {
    return vectors.ensureEmbeddingModel(
      this.db,
      { loaded: this.vecExtensionLoaded, version: this.loadedVecVersion },
      model,
      dimension,
      prefixes,
    );
  }

  semanticTopK(
    queryVector: ReadonlyArray<number> | Float32Array,
    opts: { readonly limit: number; readonly pathPrefix?: string | null },
  ): vectors.SemanticHit[] {
    return vectors.semanticTopK(this.db, this.vecExtensionLoaded, queryVector, opts);
  }

  // ── links ──────────────────────────────────────────────────────────────────

  replaceLinks(sourceDocumentId: number, input: ReadonlyArray<links.LinkInput>): void {
    links.replaceLinks(this.db, sourceDocumentId, input);
  }

  resolveLinkTargets(): void {
    links.resolveLinkTargets(this.db);
  }

  /**
   * Vault-wide link-resolution census (context-integrity-gates, unit G).
   * `unresolved` counts the link rows that carry a target path and that
   * the read-time resolution ladder cannot resolve to any document -
   * broken links as a reader experiences them.
   */
  linkResolutionCounts(): links.LinkResolutionCounts {
    return links.linkResolutionCounts(this.db);
  }

  /**
   * The unresolved link targets themselves, grouped by target and capped
   * at `limit` targets. The same predicate {@link linkResolutionCounts}
   * counts, so the list and the number cannot disagree about which links
   * are broken. A caller must decide whether this index is resolved
   * enough to believe - an empty list from a partially-resolved index is
   * not the same answer as a vault with no dangling links.
   */
  listDangling(limit: number): ReadonlyArray<links.DanglingLinkTarget> {
    return links.listDangling(this.db, limit);
  }

  /**
   * Every link edge resolved to a (source, target) document-id pair,
   * deduplicated. Unresolvable edges are absent. Read-only; feeds bridge
   * discovery and community detection (link-recall-intelligence).
   */
  resolvedDocLinkPairs(): Array<{ readonly source: number; readonly target: number }> {
    return links.resolvedDocLinkPairs(this.db);
  }

  /**
   * For each chunk id, return the document ids that link TO that
   * chunk's document via wikilink or markdown_link. Pure data; the
   * ranker decides how to convert this into a boost.
   */
  inboundLinkSources(candidateChunkIds: ReadonlyArray<number>): Map<number, Set<number>> {
    return links.inboundLinkSources(this.db, candidateChunkIds);
  }

  /**
   * For each source document id, the list of resolved outbound link
   * target document ids (wikilink / markdown_link only; tags and
   * unresolved targets excluded; self-links dropped). Used by the
   * recall traversal layer to walk one or more hops out from a hit.
   */
  outboundLinkTargets(sourceDocumentIds: ReadonlyArray<number>): Map<number, number[]> {
    return links.outboundLinkTargets(this.db, sourceDocumentIds);
  }

  /**
   * For each chunk id, the set of tag link_text values associated with
   * its document. Two chunks "share a tag" iff their tag sets intersect.
   */
  tagsByChunkDocument(candidateChunkIds: ReadonlyArray<number>): Map<number, Set<string>> {
    return links.tagsByChunkDocument(this.db, candidateChunkIds);
  }

  // ── doc aliases (v7, link-recall-intelligence) ─────────────────────────────

  /**
   * Replace one document's frontmatter aliases. Values are normalised
   * via {@link normalizeAlias}; empties and duplicates are dropped.
   */
  replaceDocAliases(documentId: number, values: ReadonlyArray<string>): void {
    aliases.replaceDocAliases(this.db, documentId, values);
  }

  /** Normalised aliases of one document, sorted. */
  aliasesForDocument(documentId: number): ReadonlyArray<string> {
    return aliases.aliasesForDocument(this.db, documentId);
  }

  /**
   * Materialize `target_document_id` for unresolved, slash-free link
   * targets that match a declared alias. Runs AFTER
   * {@link resolveLinkTargets} so exact path matches always win.
   *
   * Returns the number of link rows resolved.
   */
  resolveAliasTargets(): number {
    return aliases.resolveAliasTargets(this.db);
  }

  // ── typed relations ────────────────────────────────────────────────────────

  /**
   * For each document id, the typed relation edges it declares
   * (v3 / typed graph semantics): rows whose `relation` is set, in
   * insertion order. The target is the edge's `target_path` as written.
   * Documents with no typed edges are absent from the returned map.
   */
  typedRelationsForDocuments(
    documentIds: ReadonlyArray<number>,
  ): Map<number, Array<{ relation: string; target: string }>> {
    return relations.typedRelationsForDocuments(this.db, documentIds);
  }

  /**
   * Typed relation edges declared by the given documents, with the
   * target resolved to a document id when possible (recall-trust-suite,
   * relation polarity).
   */
  typedRelationEdgesForDocuments(documentIds: ReadonlyArray<number>): Array<{
    readonly sourceDocumentId: number;
    readonly relation: string;
    readonly target: string;
    readonly targetDocumentId: number | null;
  }> {
    return relations.typedRelationEdgesForDocuments(this.db, documentIds);
  }

  /**
   * Recompute every typed edge's `relation_blocked` flag from the
   * current schema-pack constraints (write-time-integrity-governance).
   * Runs after `resolveLinkTargets` on every index pass, so removing a
   * constraint restores blocked edges on the next run without touching
   * files. Returns the rows that ended up blocked. With an empty
   * constraint map the pass only resets stale flags.
   */
  recomputeRelationConstraintFlags(
    constraints: Readonly<Record<string, ReadonlyArray<string>>>,
  ): Array<{
    readonly relation: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly sourceType: string;
    readonly targetType: string;
    readonly declared: ReadonlyArray<string>;
  }> {
    return relations.recomputeRelationConstraintFlags(this.db, constraints);
  }

  /**
   * The typed edges currently blocked by link constraints, for lint
   * surfacing. Read-only over the flags the last index pass computed.
   */
  blockedRelationRows(): Array<{
    readonly relation: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly sourceType: string | null;
    readonly targetType: string | null;
  }> {
    return relations.blockedRelationRows(this.db);
  }

  // ── tiered frontmatter (write-time-integrity-governance) ───────────────────

  /**
   * The tiered-frontmatter snapshot the last index pass recorded for a
   * document, or null when none exists.
   */
  getTierSnapshot(documentId: number): Record<string, unknown> | null {
    return tiers.getTierSnapshot(this.db, documentId);
  }

  setTierSnapshot(documentId: number, snapshot: Readonly<Record<string, unknown>>): void {
    tiers.setTierSnapshot(this.db, documentId, snapshot);
  }

  /** Stage one identity-field hand-edit; (document, field) upserts. */
  upsertTierDrift(input: {
    readonly documentId: number;
    readonly field: string;
    readonly expected: unknown;
    readonly actual: unknown;
    readonly detectedAt: string;
  }): void {
    tiers.upsertTierDrift(this.db, input);
  }

  clearTierDrift(documentId: number, field?: string): void {
    tiers.clearTierDrift(this.db, documentId, field);
  }

  /** Open identity-drift findings, oldest first, with document paths. */
  listTierDrift(): Array<{
    readonly documentId: number;
    readonly path: string;
    readonly field: string;
    readonly expected: unknown;
    readonly actual: unknown;
    readonly detectedAt: string;
  }> {
    return tiers.listTierDrift(this.db);
  }

  // ── search ─────────────────────────────────────────────────────────────────

  /**
   * Corpus document frequency per term (recall-trust-suite, coverage
   * engine): how many distinct documents match each term in FTS.
   */
  documentFrequencies(terms: ReadonlyArray<string>): Map<string, number> {
    return keyword.documentFrequencies(this.db, terms);
  }

  ftsIntegrityCounts(): { readonly chunks: number; readonly ftsRows: number } {
    return keyword.ftsIntegrityCounts(this.db);
  }

  rebuildFtsIndex(): void {
    keyword.rebuildFtsIndex(this.db);
  }

  rebuildFtsIndexWithWriterLock(): void {
    keyword.rebuildFtsIndexWithWriterLock(this.db, this.config.dbPath, this.release !== null);
  }

  /**
   * Top-K BM25 keyword hits. `fts5Query` is an already-escaped FTS5
   * MATCH expression; building it is fts.ts's job.
   */
  keywordTopK(
    fts5Query: string,
    opts: { readonly limit: number; readonly pathPrefix?: string | null },
  ): keyword.KeywordHit[] {
    return keyword.keywordTopK(this.db, fts5Query, opts);
  }

  /**
   * Trigram candidate lookup over the `chunk_trigram` FTS5 shadow (v9).
   * An opt-in candidate source that broadens large-vault keyword recall
   * with the substring / partial-token matches the word tokenizer misses.
   * Degrades to no candidates - silently when the optional table is
   * absent, with a warning for every other fault.
   */
  trigramCandidates(
    trigramQuery: string,
    opts: { readonly limit: number; readonly pathPrefix?: string | null },
  ): trigram.TrigramCandidateOutcome {
    return trigram.trigramCandidates(this.db, trigramQuery, opts);
  }

  // ── entities ─────────────────────────────────────────────────────────────

  /**
   * Replace a chunk's entity set (v0.13.0). Deletes any prior entries
   * for the chunk, then inserts the deduped list. Entities are expected
   * pre-normalised (lowercased) by the extractor.
   */
  replaceEntities(chunkId: number, entities: ReadonlyArray<string>): void {
    chunkEntities.replaceEntities(this.db, chunkId, entities);
  }

  /**
   * Distinct entities across one document's chunks, sorted
   * (link-recall-intelligence: shared-entity digest in cluster notes).
   */
  entitiesForDocument(documentId: number): ReadonlyArray<string> {
    return chunkEntities.entitiesForDocument(this.db, documentId);
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
    return chunkEntities.chunkEntityMatches(this.db, candidateChunkIds, queryEntities);
  }

  // ── counts ─────────────────────────────────────────────────────────────────

  counts(): census.StoreCounts {
    return census.counts(this.db, this.config.semantic.model, this.config.semantic.dimension);
  }

  /**
   * Indexed chunks split by what the oversize-chunk census can decide
   * about them against a model's declared input window: provably over,
   * and undecided by the estimate. One aggregate pass, no chunk bodies
   * read; see `store/counts.ts` for the unit and both bounds.
   *
   * `requestPrefix` is the instruction prefix the configured backend
   * prepends to every passage, because the provider counts it too.
   */
  chunkWindowTally(windowTokens: number, requestPrefix: string): census.ChunkWindowTally {
    return census.chunkWindowTally(this.db, windowTokens, requestPrefix);
  }

  /**
   * The provable half of {@link chunkWindowTally} for a backend that
   * prepends nothing.
   */
  chunksOverTokenWindow(windowTokens: number): number {
    return census.chunksOverTokenWindow(this.db, windowTokens);
  }

  // ── direct accessors used by indexer/CLI/status ────────────────────────────

  /** Escape hatch for status queries that don't fit the typed API. */
  rawQuery<T>(sql: string, params: ReadonlyArray<string | number | null> = []): T[] {
    return this.db
      .query<T, (string | number | null)[]>(sql)
      .all(...(params as (string | number | null)[]));
  }
}

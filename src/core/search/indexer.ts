/**
 * Index lifecycle orchestrator.
 *
 * `indexVault` is the incremental path: walk → diff against stored
 * documents → upsert/replace/delete. `reindexVault` is the atomic
 * rebuild: write to `brain.sqlite.new`, then a same-file rename swap
 * with `.bak` retention.
 *
 * `indexStatus`, `indexCheck` and `indexRootCoverage` are the read-side
 * diagnostics that power `o2b search status|check`, the MCP status
 * enrichment and the recall gate's coverage receipt.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §6, §8,
 * §13, §15.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname } from "node:path";

import {
  resolveSemanticCapability,
  SEMANTIC_CAPABILITY_CODE,
  SEMANTIC_CAPABILITY_TIER,
  semanticCapabilityIsBlocked,
  semanticCapabilityLabel,
  SEMANTIC_VECTOR_CODE,
} from "./capability-tier.ts";
import { sha256Hex } from "../integrity/digest.ts";
import { chunkMarkdown } from "./chunker.ts";
import { expandTextForCjkFts } from "./cjk-tokenizer.ts";
import { declaredInputWindowTokens, passagePrefixSentByProvider } from "./embeddings/presets.ts";
import { makeProvider } from "./embeddings/provider.ts";
import {
  embeddingSignature,
  estimateCostUsd,
  estimateTokens,
  evaluateCostGate,
  pricePerMillionTokens,
  LOCAL_EMBEDDING_MODEL,
} from "./embeddings/signature.ts";
import { resolveEventAnchor } from "./event-anchor.ts";
import { extractLinks } from "./links.ts";
import { extractFrontmatterRelations } from "../graph/frontmatter-relations.ts";
import { loadSchemaPack, type SchemaPack } from "../brain/schema-pack.ts";
import { tieredFieldsForKind } from "../brain/frontmatter-tiers.ts";
import { normalizeSchemaToken } from "../brain/schema-vocab.ts";
import type { DegradationNotice } from "../integrity/degradation.ts";
import { parseFrontmatterTextWithNotices } from "../vault.ts";
import { appendMetric } from "../brain/metrics.ts";
import { throwIfAborted } from "../brain/safeguard.ts";
import { extractEntities } from "./entities.ts";
import { compareStamps, formatStampMismatch, type StampMismatch } from "../integrity/stamp.ts";

import {
  acquireWriterLock,
  EMBEDDING_ABI_FIX_COMMAND,
  formatEmbeddingAbiDrift,
  readEmbeddingAbiSync,
  runtimeEmbeddingAbi,
  Store,
  EMBEDDING_PREFIX_QUERY_STATE_KEY,
  EMBEDDING_PREFIX_PASSAGE_STATE_KEY,
  LAST_FULL_INDEX_AT_STATE_KEY,
  LAST_INDEXED_AT_STATE_KEY,
} from "./store.ts";
import { LATEST_SCHEMA_VERSION } from "./schema.ts";
import { chunkWindowDiagnosticCode, SearchError } from "./types.ts";
import { walkVault } from "./walker.ts";
import { withTimeout } from "./with-timeout.ts";
import type { ChunkInput, LinkInput } from "./store.ts";
import type {
  ChunkWindowCensus,
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
  /**
   * Cooperative deadline (t_06784b8d): checkpointed once per walked
   * file, so a tripped guard aborts between files - never mid-write.
   */
  readonly safeguard?: import("../brain/safeguard.ts").Safeguard;
  /**
   * On-demand cancellation (Indexer Durability suite). Checked at the
   * same boundaries the deadline uses - between files and between embed
   * batches, never mid-write. An aborted signal throws
   * `SafeguardAbortError`; the deletion sweep runs only on full
   * completion, so an aborted run leaves a consistent partial index.
   */
  readonly signal?: AbortSignal;
}

/** Site recorded on the frontmatter notices an index run collects. */
const INDEX_FRONTMATTER_SITE = "search.indexVault";

interface MutableStats {
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  chunksTotal: number;
  embeddingsComputed: number;
  embeddingsRetries: number;
  errors: Array<{ readonly path: string; readonly message: string }>;
  frontmatterNotices: DegradationNotice[];
  relationViolations: IndexStats["relationViolations"];
  tierDrift: IndexStats["tierDrift"];
  aliasResolved: number;
  eventAnchorsPending: number;
  backend: IndexStats["backend"];
  deferredReason: IndexStats["deferredReason"];
  /** Null until the census runs, and null whenever it has nothing to report. */
  chunkWindow: ChunkWindowCensus | null;
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
    frontmatterNotices: [],
    relationViolations: [],
    tierDrift: [],
    aliasResolved: 0,
    // Counted at the end of the run, once every changed document has
    // been upserted: what is left is what this run did not reach.
    eventAnchorsPending: 0,
    // Resolved lazily at the end of the run, after content detection.
    // Defaults to the deterministic offline backend.
    backend: "offline",
    deferredReason: null,
    // Taken at the end of the run, over the index the run left behind.
    chunkWindow: null,
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
    frontmatterNotices: Object.freeze([...s.frontmatterNotices]),
    relationViolations: Object.freeze([...s.relationViolations]),
    tierDrift: Object.freeze([...s.tierDrift]),
    aliasResolved: s.aliasResolved,
    eventAnchorsPending: s.eventAnchorsPending,
    backend: s.backend,
    deferredReason: s.deferredReason,
    // Absent, not null, when the census has nothing to report: a run
    // with no oversize chunks and a declared window produces the exact
    // statistics object it produced before this field existed.
    ...(s.chunkWindow === null ? {} : { chunkWindow: s.chunkWindow }),
    durationMs,
  });
}

/**
 * Explain why the semantic backend was not engaged, inspecting only the
 * already-resolved config (never `process.env`).
 *
 * The sentence is the diagnostics registry's, resolved from a REGISTERED
 * code through the advisory rail (provenance-at-the-boundary, F1). It
 * used to be assembled here from four hand-written branches, which is the
 * one thing the v1.40.0 rail exists to stop.
 *
 * Two of those branches are now the shared capability tier. The third -
 * a fully configured vault that simply was not asked for embeddings this
 * run - is an INDEX state rather than a capability fault and carries its
 * own code, whose registered exit is the vector backfill verb. The
 * fourth was unreachable: the only call site passed a constant `false`
 * for `embeddingsRequested`, because the caller reaches this function
 * exclusively on the else-arm of `if (opts?.embeddings)`. The parameter
 * and the branch are gone rather than kept as a shape that could never
 * be observed.
 */
async function offlineDeferredReason(config: ResolvedSearchConfig): Promise<string> {
  const capability = resolveSemanticCapability(config.semantic);
  return semanticCapabilityLabel(
    semanticCapabilityIsBlocked(capability) ? capability.code : SEMANTIC_VECTOR_CODE.deferred,
  );
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

/**
 * The page's declared frontmatter `aliases` as raw strings (the store
 * normalises). Tolerant by design: a non-array value or non-string
 * entries never fail indexing, they are simply skipped.
 */
function aliasesFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter["aliases"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * The note's `authored_at` frontmatter instant as unix seconds, or null
 * when undeclared or unparseable (conversation chronology, S1). Tolerant
 * by design: a malformed value never fails indexing, it just leaves the
 * document with no turn instant so it ranks byte-identically. A value at
 * or before the Unix epoch is treated as absent (the import layer's "no
 * timestamp" sentinel), never a real authoring instant.
 */
function authoredAtFromFrontmatter(frontmatter: Record<string, unknown>): number | null {
  const raw = frontmatter["authored_at"];
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
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
      // Cooperative deadline: abort between files, never mid-write.
      // Per-file document upserts are transactional, so a tripped
      // guard leaves a consistent (partially refreshed) index.
      opts?.safeguard?.checkpoint();
      // On-demand cancellation, same boundary as the deadline.
      throwIfAborted(opts?.signal, "index");
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
        const contentHash = sha256Hex(content);

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
          minTokens: config.chunkMinSize,
          overlapTokens: config.chunkOverlap,
        });
        for (const w of chunkResult.warnings) {
          stats.errors.push({ path: file.relPath, message: w });
        }

        // The document's declared frontmatter `type` is persisted so
        // the link-constraint post-pass can join endpoint types
        // without re-reading files (v6).
        // Unit F: the scanner drops a line it cannot express instead of
        // failing, so a note keeps indexing while a field silently
        // vanishes. Collect what it dropped; the run reports it and
        // nothing about the indexing changes.
        const [frontmatter, body, fmNotices] = parseFrontmatterTextWithNotices(content, {
          site: INDEX_FRONTMATTER_SITE,
          path: file.relPath,
        });
        for (const n of fmNotices) stats.frontmatterNotices.push(n);
        const docId = store.upsertDocument({
          path: file.relPath,
          title: chunkResult.title,
          contentHash,
          mtime: mtimeSec,
          size: file.stat.size,
          pageType: pageTypeFromFrontmatter(frontmatter),
          authoredAt: authoredAtFromFrontmatter(frontmatter),
          // The event anchor is materialised HERE, on the same pass that
          // already holds the parsed frontmatter and the body, so the
          // query side never re-scans a candidate's body. It is a pure
          // function of this file's content, which is exactly what makes
          // it safe to store behind the two content-identity fastpaths
          // above: unchanged content can only ever resolve to the same
          // anchor, so declining to recompute it cannot stale it.
          eventAnchor: resolveEventAnchor(frontmatter, body),
        });
        // Framework-kind files feed the tier-guard post-pass: keep the
        // parsed frontmatter of this run's changed docs that declare a
        // `kind` (bounded - only Brain artifacts carry one).
        if (typeof frontmatter["kind"] === "string" && frontmatter["kind"].length > 0) {
          tieredDocs.push({ docId, relPath: file.relPath, frontmatter });
        }
        // Vault-wide alias resolution (v7): replace this document's
        // declared aliases so the post-pass can materialize alias
        // wikilink targets.
        store.replaceDocAliases(docId, aliasesFromFrontmatter(frontmatter));

        const chunkInputs: ChunkInput[] = chunkResult.chunks.map((c) => ({
          chunkIndex: c.chunkIndex,
          content: c.content,
          ftsContent: expandTextForCjkFts(c.content),
          contentHash: sha256Hex(c.content),
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
    // Alias post-pass (v7): exact path matches above always win; this
    // only fills still-unresolved slash-free targets from doc_aliases.
    stats.aliasResolved = store.resolveAliasTargets();

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
          // Deleting an identity field is as much a hand-edit as
          // changing it: `current === undefined` stages drift with a
          // null actual instead of silently dropping the snapshot.
          if (tier === "identity" && !tierValueEquals(expected, current)) {
            const actual = current === undefined ? null : current;
            store.upsertTierDrift({
              documentId: doc.docId,
              field,
              expected,
              actual,
              detectedAt,
            });
            stats.tierDrift = [...stats.tierDrift, { path: doc.relPath, field, expected, actual }];
            next[field] = expected; // the snapshot keeps the truth
            continue;
          }
          store.clearTierDrift(doc.docId, field);
          if (current !== undefined) next[field] = current;
        }
        store.setTierSnapshot(doc.docId, next);
      }
    }

    // Lazy backend resolution (offline code-only extraction, t_85252236).
    // The credential-gated embedding path runs only when explicitly
    // requested; reaching past populateEmbeddings without throwing means a
    // credential was resolved (or the local provider needs none), so the
    // semantic backend is genuinely active. Otherwise the run is offline
    // and we record why the semantic backend was deferred.
    if (opts?.embeddings) {
      await runEmbeddingPhase(store, config, stats, {
        forceCost: opts?.forceCost === true,
        ...(opts?.safeguard !== undefined ? { safeguard: opts.safeguard } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
      stats.backend = "semantic";
      stats.deferredReason = null;
    } else {
      stats.backend = "offline";
      stats.deferredReason = await offlineDeferredReason(config);
    }

    // Documents this run left with no event anchor RESOLVED - not
    // documents that declare no date. A schema bump migrates in place
    // and reindexes nothing, and both fastpaths above correctly decline
    // to recompute an anchor for content that did not change, so a
    // document carried over from a pre-anchor binary is never examined
    // by any number of index runs. Reported here because this run is the
    // surface an upgrading operator reaches first, and because a hard
    // `since` / `until` filter now depends on the answer.
    stats.eventAnchorsPending = store.countUnexaminedEventAnchors();

    // Oversize-chunk census. Taken here, over the index this run just
    // wrote, because the chunk boundaries the run produced are exactly
    // what the configured model's declared window has to hold - and the
    // configured chunk size is expressed in whitespace WORDS while a
    // window is expressed in tokens, so the two settings can only be
    // compared through what they actually produced. The stored model
    // fills in a config that leaves `embedding_model` unset.
    stats.chunkWindow = censusChunkWindow(store, config, store.getState("embedding_model"));

    const now = new Date().toISOString();
    store.setState(LAST_INDEXED_AT_STATE_KEY, now);
    // The SAME instant on a forced run: their equality is the
    // "this index resolved the whole vault" predicate the broken-link
    // ratchet verifies before it trusts a count (unit G).
    if (opts?.force) store.setState(LAST_FULL_INDEX_AT_STATE_KEY, now);

    // Bump the corpus-generation revision whenever the index actually
    // changed, so the persistent query cache (v0.20.0) is invalidated
    // after a content reindex even though the embedding model/dimension
    // and schema are unchanged.
    if (stats.added + stats.updated + stats.deleted > 0) {
      store.bumpIndexRevision();
      // Dashboard contract (link-recall-intelligence): one run-level
      // record per non-empty index run. Fail-soft - a metrics-layer
      // problem never fails the index.
      try {
        appendMetric(config.vault, {
          surface: "index",
          runAt: now,
          payload: {
            added: stats.added,
            updated: stats.updated,
            deleted: stats.deleted,
            alias_resolved: stats.aliasResolved,
            relation_violations: stats.relationViolations.length,
            tier_drift: stats.tierDrift.length,
          },
        });
      } catch {
        // Metrics are observability, not correctness.
      }
    }

    return freezeStats(stats, Date.now() - t0);
  } finally {
    if (ownsStore) await store.close();
  }
}

/**
 * The model an embedding request would name right now. The local
 * provider has an implicit model string; every other provider takes the
 * configured one, falling back to what the index recorded when the
 * config leaves it unset.
 */
function activeEmbeddingModel(
  config: ResolvedSearchConfig,
  storedModel: string | null = null,
): string | null {
  if (config.semantic.provider === "local") return LOCAL_EMBEDDING_MODEL;
  return config.semantic.model ?? storedModel;
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
  return embeddingSignature({
    provider: config.semantic.provider,
    model: activeEmbeddingModel(config, storedModel),
    dimension: config.semantic.dimension ?? storedDim,
  });
}

/**
 * The config key whose value produced the chunk boundaries under census.
 * Named once so the warning and any future surface cannot spell it
 * differently from `resolveSearchConfig`.
 */
const CHUNK_SIZE_CONFIG_KEY = "search_chunk_size";

/**
 * Take the oversize-chunk census over an open index.
 *
 * Returns `null` when there is nothing to report, which covers three
 * genuinely different silences, all of them states in which no chunk can
 * overflow a window:
 *
 *   - semantic search is off, so nothing is ever embedded;
 *   - the provider is the offline local embedder, which hashes n-gram
 *     features over the whole text - no encoder, no positional limit,
 *     nothing to truncate. A provably absent window, not an unknown one;
 *   - the census ran against a declared window and every chunk fits.
 *
 * The silences it does NOT produce are the two states the estimate
 * cannot back: a model with no declared window (`window-undeclared`),
 * and chunks the estimate cannot place on either side of a declared one
 * (`estimate-undecided`). A check that could not run and a check that
 * passed are not the same statement.
 */
function censusChunkWindow(
  store: Store,
  config: ResolvedSearchConfig,
  storedModel: string | null,
): ChunkWindowCensus | null {
  if (!config.semantic.enabled) return null;
  if (config.semantic.provider === "local") return null;
  const chunksMeasured = store.chunkCount();
  if (chunksMeasured === 0) return null;

  const model = activeEmbeddingModel(config, storedModel);
  const windowTokens = declaredInputWindowTokens(model);
  if (model === null || windowTokens === null) {
    return Object.freeze({ verdict: "window-undeclared" as const, model, chunksMeasured });
  }
  // The prefix the CONFIGURED backend prepends, not the one the config
  // asks for: only `openai-compat` implements the instruction-prefix
  // contract, and subtracting a prefix a backend never sends would
  // report an overflow nobody can hit.
  const tally = store.chunkWindowTally(
    windowTokens,
    passagePrefixSentByProvider(config.semantic.provider, config.semantic.passagePrefix),
  );
  if (tally.overWindow > 0) {
    return Object.freeze({
      verdict: "over-window" as const,
      model,
      windowTokens,
      chunksOverWindow: tally.overWindow,
      // Absent, never zero: an all-ASCII index has no undecided band and
      // carries the record it carried before this field existed.
      ...(tally.undecided > 0 ? { chunksUndecided: tally.undecided } : {}),
      chunksMeasured,
    });
  }
  if (tally.undecided > 0) {
    return Object.freeze({
      verdict: "estimate-undecided" as const,
      model,
      windowTokens,
      chunksUndecided: tally.undecided,
      chunksMeasured,
    });
  }
  return null;
}

/**
 * The operator-facing warning line for a census that MEASURED something
 * - chunks proved over the window, or chunks its estimate cannot place
 * inside one - ending in the command its REGISTERED diagnostic names.
 * The command is resolved from the registry rather than written here, so
 * this sentence cannot name an exit the registry does not hold; an
 * unregistered code throws at the point the sentence is built rather
 * than shipping a dead end.
 *
 * Typed to the two measured members, so the undeclared verdict cannot
 * reach the warning channel by accident - it is a snapshot field, and
 * the type is what enforces that rather than a branch nobody calls.
 *
 * The undecided line says in words that it is not a pass, because that
 * is the whole content of the state: the operator is being told the
 * check ran and could not clear these chunks, not that they are broken.
 */
async function formatChunkWindowMeasured(
  census: Extract<ChunkWindowCensus, { verdict: "over-window" | "estimate-undecided" }>,
): Promise<string> {
  const { requireNextStep } = await import("../brain/next-step.ts");
  const step = requireNextStep(chunkWindowDiagnosticCode(census));
  const remedy =
    `whatever does not fit is truncated by the provider, silently. ` +
    `Lower ${CHUNK_SIZE_CONFIG_KEY}, then run: ${step.nextCommand}`;
  if (census.verdict === "estimate-undecided") {
    return (
      `${census.chunksUndecided} of ${census.chunksMeasured} indexed chunk(s) cannot be ` +
      `placed inside the ${census.windowTokens}-token input window declared for ` +
      `${census.model}: the census estimates tokens from character counts, which does not ` +
      `bound a token window for non-Latin scripts, so this is not a pass - ${remedy}`
    );
  }
  const undecided =
    census.chunksUndecided === undefined
      ? ""
      : ` A further ${census.chunksUndecided} chunk(s) the estimate cannot place either way.`;
  return (
    `${census.chunksOverWindow} of ${census.chunksMeasured} indexed chunk(s) estimate above ` +
    `the ${census.windowTokens}-token input window declared for ${census.model}; ` +
    `${remedy}${undecided}`
  );
}

/**
 * The two counters the vector phase writes back. Declared as its own
 * shape so the phase can serve the index run's `MutableStats` and the
 * standalone vector backfill without either knowing about the other;
 * `MutableStats` satisfies it structurally.
 */
export interface EmbeddingPhaseTally {
  embeddingsComputed: number;
  embeddingsRetries: number;
}

export interface EmbeddingPhaseOptions {
  /** Bypass the configured spend ceiling for this run. */
  readonly forceCost?: boolean;
  readonly safeguard?: import("../brain/safeguard.ts").Safeguard;
  readonly signal?: AbortSignal;
}

/**
 * Compute and store a vector for every indexed chunk that has none.
 *
 * Exported (provenance-at-the-boundary, F) because it is the whole of
 * `o2b search vector-backfill --apply`: the population step is already
 * resumable by construction - the anti-join finds exactly the chunks
 * still missing a row and `vecUpsert` commits per chunk - so the backfill
 * verb is this phase run on its own, not a second implementation of it.
 *
 * Every refusal here is a SearchError, because reaching this function is
 * an attempt: the capability tier is what a caller reports when it
 * declines to attempt.
 */
export async function runEmbeddingPhase(
  store: Store,
  config: ResolvedSearchConfig,
  stats: EmbeddingPhaseTally,
  opts: EmbeddingPhaseOptions = {},
): Promise<void> {
  const forceCost = opts.forceCost === true;
  const safeguard = opts.safeguard;
  const signal = opts.signal;
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
  // Hand the provider a super-batch large enough to keep its internal
  // `embedding_concurrency` semaphore busy. Without this multiplier the
  // indexer's outer loop would serialise provider.embed() calls and the
  // configured concurrency would never kick in. It is an upper bound, not
  // an exact fill: when `embedding_batch_tokens` is set the provider closes
  // a batch on the token estimate as well as on the count, so a super-batch
  // may split into more - and therefore smaller - requests than
  // `embedding_concurrency`.
  const superBatch = batchSize * Math.max(1, config.semantic.concurrency);

  for (let i = 0; i < pending.length; i += superBatch) {
    // Cooperative deadline: embedding batches are the other long
    // phase of an index run - abort between batches, never mid-batch.
    safeguard?.checkpoint();
    throwIfAborted(signal, "index");
    const batch = pending.slice(i, i + superBatch);
    const texts = batch.map((p) => p.content);
    const vectors = await provider.embed(texts, "passage");
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
    store.ensureEmbeddingModel(model, dim, {
      query: config.semantic.queryPrefix ?? "",
      passage: config.semantic.passagePrefix ?? "",
    });
    for (let j = 0; j < batch.length; j++) {
      const chunkId = batch[j]!.chunkId;
      const vec = vectors[j]!;
      const embHash = sha256Hex(vec.map((x) => x.toFixed(8)).join(","));
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

  // Hold the writer lock on the LIVE index path for the whole rebuild +
  // swap. Keyed on `config.dbPath` (not the `.new` staging path), so a
  // second concurrent reindex — the double-reindex a schema-bump upgrade
  // triggers when CLI and the long-lived MCP server both self-heal at
  // once — waits-or-bails on the SAME lock instead of unlinking this run's
  // in-progress staging DB and then having its empty seed swapped over the
  // live index (INDEX_UNREADABLE, silent data loss). The staging-DB opens
  // below lock a different path (`.new`), so there is no self-deadlock.
  const release = await acquireWriterLock(config.dbPath);
  try {
    // Build into the temp file with an override config.
    const tempConfig: ResolvedSearchConfig = Object.freeze({
      ...config,
      dbPath: newPath,
    });

    // Resumable staging (opt-in). A compatible in-progress `.new` from an
    // interrupted run is resumed via the incremental fastpath instead of
    // rebuilt from scratch; an incompatible or unreadable one is
    // discarded. With the flag OFF, the temp file is always rebuilt fresh
    // and no staging marker is written or read - byte-identical to the
    // pre-suite path (no extra staging-DB open/close cycles).
    let resume = false;
    if (config.resumeReindex) {
      const signature = reindexStagingSignature(config, opts?.embeddings === true);
      if (existsSync(newPath)) {
        resume = await stagingSignatureMatches(tempConfig, signature);
      }
      if (!resume) tryUnlink(newPath);
      // Stamp the signature so an interruption leaves a build a later run
      // can recognise and resume.
      await withStagingStore(tempConfig, (store) =>
        store.setState(REINDEX_SIGNATURE_KEY, signature),
      );
    } else {
      tryUnlink(newPath);
    }

    // `force: false` on resume lets the fastpath skip the files the
    // partial build already committed; a fresh build forces every file.
    const stats = await indexVault(tempConfig, { ...opts, force: !resume });

    // Clear the marker so the swapped-in live index carries no staging
    // state. Only present when resume was enabled.
    if (config.resumeReindex) {
      await withStagingStore(tempConfig, (store) => store.deleteState(REINDEX_SIGNATURE_KEY));
    }

    // Same-directory rename swap. The two renames are each atomic on
    // POSIX; the gap between them is the only crash window. A read that
    // opens in that window is held off by this same lock (see
    // restoreFromBakIfMissing in store.ts), so it cannot restore the stale
    // `.bak` over the freshly built index; a genuine crash leaves the lock
    // stale and the .bak restore on the next Store.open recovers.
    tryUnlink(bakPath);
    tryRename(config.dbPath, bakPath); // no-op (ENOENT) on fresh reindex
    renameSync(newPath, config.dbPath); // must succeed — `newPath` was just built
    return stats;
  } finally {
    await release();
  }
}

/** index_state key carrying the staging-build compatibility signature. */
const REINDEX_SIGNATURE_KEY = "reindex_signature";

/**
 * Compatibility signature for a staging rebuild: a resume is safe only
 * when the schema version, chunk parameters, and (when embeddings are
 * computed) the active embedding signature all match the partial build.
 * Any drift invalidates the staging DB and forces a fresh rebuild.
 */
function reindexStagingSignature(config: ResolvedSearchConfig, embeddings: boolean): string {
  const embedding = embeddings ? (activeEmbeddingSignature(config) ?? "active") : "off";
  return JSON.stringify({
    schema: LATEST_SCHEMA_VERSION,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    chunkMinSize: config.chunkMinSize,
    embedding,
  });
}

/** Read the staging signature from an existing `.new`; false on any
 * read error (a corrupt or partial staging DB is rebuilt, not trusted). */
async function stagingSignatureMatches(
  tempConfig: ResolvedSearchConfig,
  signature: string,
): Promise<boolean> {
  try {
    const store = await Store.open(tempConfig, { mode: "write", loadVec: false });
    try {
      return store.getState(REINDEX_SIGNATURE_KEY) === signature;
    } finally {
      await store.close();
    }
  } catch {
    return false;
  }
}

/** Run a short write against the staging DB (set/clear the marker). */
async function withStagingStore(
  tempConfig: ResolvedSearchConfig,
  fn: (store: Store) => void,
): Promise<void> {
  const store = await Store.open(tempConfig, { mode: "write", loadVec: false });
  try {
    fn(store);
  } finally {
    await store.close();
  }
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
        embeddingAbi: Object.freeze([]),
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
    const last = store.getState(LAST_INDEXED_AT_STATE_KEY);
    const full = store.getState(LAST_FULL_INDEX_AT_STATE_KEY);

    const warnings: string[] = [];
    if (config.semantic.enabled && !store.vecLoaded()) {
      warnings.push("sqlite-vec unavailable; semantic search disabled this session");
    }
    // A FIFTH site that derived the credential fact for itself, in a
    // fourth spelling, and which the unit-F brief did not name. Routed
    // through the same resolver while the file is open: two of these
    // copies disagreed about whether the local provider needs a key.
    if (
      resolveSemanticCapability(config.semantic).tier === SEMANTIC_CAPABILITY_TIER.credentialMissing
    ) {
      warnings.push(await semanticCapabilityLabel(SEMANTIC_CAPABILITY_CODE.credentialMissing));
    }

    // Instruction-prefix drift (memory-write-path-integrity B2). Stored
    // vectors were embedded under the prefix pair recorded at index time; if
    // the configured pair now differs they are not comparable to prefixed
    // queries, so surface the reindex-required warning. A stored null is a
    // pre-feature (unprefixed) index, compared as the empty pair.
    if (config.semantic.enabled && counts.embeddings > 0) {
      const storedQuery = store.getState(EMBEDDING_PREFIX_QUERY_STATE_KEY) ?? "";
      const storedPassage = store.getState(EMBEDDING_PREFIX_PASSAGE_STATE_KEY) ?? "";
      const configuredQuery = config.semantic.queryPrefix ?? "";
      const configuredPassage = config.semantic.passagePrefix ?? "";
      if (storedQuery !== configuredQuery || storedPassage !== configuredPassage) {
        warnings.push(
          "embedding instruction prefixes changed since the last index run " +
            `(stored [${storedQuery}|${storedPassage}], configured ` +
            `[${configuredQuery}|${configuredPassage}]); run: o2b search reindex --embeddings`,
        );
      }
    }

    // Embedding-ABI drift (context-integrity-gates, Unit E). The read
    // open already ran the gated comparison, so this only surfaces what
    // it found: empty when the stamps agree AND whenever the operator
    // has `integrity.embedding_abi` off. Gated on stored vectors for the
    // same reason the prefix warning above is - an index with no
    // embeddings has nothing that could be incomparable.
    //
    // Reported twice, deliberately: as one operator-facing line here and
    // as the structured `embeddingAbi` field below. The MCP status block
    // carries both, so an agent can branch on the field instead of
    // matching on message text.
    const abiDrift =
      config.semantic.enabled && counts.embeddings > 0
        ? store.embeddingAbiMismatches()
        : Object.freeze([] as ReadonlyArray<StampMismatch>);
    if (abiDrift.length > 0) {
      warnings.push(formatEmbeddingAbiDrift(abiDrift));
    }

    // Oversize-chunk census (what-the-index-already-knew, task H). The
    // two reportable states leave by different doors, following the
    // convention the ABI drift beside them already sets: the warning
    // channel is for what an operator can act on, the structured field
    // for what is simply true.
    //
    //   - chunks past a DECLARED window is a measured fault with a
    //     command behind it, so it is a warning. So is the undecided
    //     band beside it: the census cannot rule the truncation out, the
    //     remedy is the same lever, and it fires only for chunks that
    //     actually carry non-ASCII text near the window - never on the
    //     all-Latin index, which is what keeps it from becoming noise;
    //   - a model with no declared window is a check that could not run.
    //     It has no command - nobody can declare a window for someone
    //     else's model - and it is the COMMON case, so a warning here
    //     would repeat forever on the majority of configurations and
    //     train operators to skip the channel. It rides the snapshot as
    //     its own field instead, which still distinguishes it from a
    //     pass.
    //
    // A census that cleared BOTH bounds is neither, so a status that had
    // no warning before this feature still has none.
    const chunkWindow = censusChunkWindow(store, config, model);
    const chunkWindowUndeclared = chunkWindow?.verdict === "window-undeclared" ? chunkWindow : null;
    if (
      chunkWindow !== null &&
      (chunkWindow.verdict === "over-window" || chunkWindow.verdict === "estimate-undecided")
    ) {
      warnings.push(await formatChunkWindowMeasured(chunkWindow));
    }

    // Best-effort spend estimate to bring stale/missing embeddings current.
    // Only scan chunk content when the active model is actually priced.
    const activeModel = activeEmbeddingModel(config, model);
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
      embeddingAbi: abiDrift,
      // Absent, not null, whenever the check could run - so a status
      // over a curated model serializes the bytes it always has.
      ...(chunkWindowUndeclared === null ? {} : { chunkWindowUndeclared }),
      warnings: Object.freeze(warnings),
    });
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// indexRootCoverage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which authorized note roots the index REACHED, and how far.
 *
 * The field names say presence rather than coverage on purpose. "Covered"
 * would claim the root was read out; what the index can show is that at
 * least one document under it was indexed, which is a strictly weaker
 * statement - see {@link indexRootCoverage}.
 */
export interface IndexRootCoverage {
  /** Roots carrying at least one indexed document. */
  readonly rootsWithDocuments: ReadonlyArray<string>;
  /** Roots the index holds no document under at all. */
  readonly rootsWithoutDocuments: ReadonlyArray<string>;
}

/**
 * Partition note roots by whether the index carries any document under
 * them (silence-is-not-an-answer, U2).
 *
 * `indexStatus` says how much was indexed in total; this says WHICH of
 * the folders the operator authorized were reached at all. A negative
 * recall needs both: the totals make the receipt, and the partition names
 * the roots that were never touched.
 *
 * The guarantee is deliberately named as presence, not coverage, and the
 * field names say so: a root lands in `rootsWithDocuments` on the
 * strength of ONE indexed document, so one note out of a thousand puts it
 * there. The index knows what it was given and never what it was not, so
 * it cannot tell that case from a folder that holds exactly one note;
 * deciding between them needs a filesystem census of the root, which is a
 * different measurement with a different cost. Until something needs that
 * census, the honest move is to promise only what this scan sees - the
 * document TOTAL rides on the receipt beside the root list, so a reader
 * weighing a negative is never left with the root list alone.
 *
 * Throws `SearchError` `INDEX_MISSING` when there is no index, rather
 * than reporting every root absent. The caller must establish that the
 * index exists first, and an all-absent answer over a missing index would
 * read like a measurement.
 *
 * Cost: one read-mode open and one full document-path scan. It runs only
 * on the recall gate's zero-result path, where a search has already
 * failed to produce anything, and the alternative - a per-root prefix
 * query - would buy microseconds for a new store surface.
 */
export async function indexRootCoverage(
  config: ResolvedSearchConfig,
  roots: ReadonlyArray<string>,
): Promise<IndexRootCoverage> {
  const store = await Store.open(config, { mode: "read" });
  try {
    const paths = [...store.listDocuments().keys()];
    const withDocuments: string[] = [];
    const withoutDocuments: string[] = [];
    for (const root of roots) {
      const reached = paths.some((path) => path === root || path.startsWith(`${root}/`));
      (reached ? withDocuments : withoutDocuments).push(root);
    }
    return Object.freeze({
      rootsWithDocuments: Object.freeze(withDocuments),
      rootsWithoutDocuments: Object.freeze(withoutDocuments),
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
  // One resolver for what the operator configured, shared with the index
  // run, the semantic lane and the readiness probe
  // (provenance-at-the-boundary, F1).
  const capability = resolveSemanticCapability(config.semantic);

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
  /** Runtime ABI token; captured from the probe rather than re-queried. */
  let vecVersion: string | null = null;
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
    // Probed whenever semantic search is switched on at all - including
    // while the credential is still missing, because the extension is a
    // machine fact the operator can fix independently of the key.
    if (capability.tier !== SEMANTIC_CAPABILITY_TIER.disabled) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vec = require("sqlite-vec") as { getLoadablePath(): string };
        db.loadExtension(vec.getLoadablePath());
        const row = db.query<{ v: string }, []>("SELECT vec_version() AS v").get();
        vecVersion = typeof row?.v === "string" ? row.v : null;
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

  // "The credential side of the configuration is satisfied" - which for
  // the offline local provider means it needed none. This used to read
  // `enabled && apiKey`, which reported a fully working local install as
  // key-less and then recommended setting a key it does not use.
  const embeddingKeyResolved = !semanticCapabilityIsBlocked(capability);
  if (capability.tier === SEMANTIC_CAPABILITY_TIER.credentialMissing) {
    warnings.push(await semanticCapabilityLabel(capability.code));
  }

  let providerReachable: boolean | null = null;
  let providerReason: string | null = null;
  if (embeddingKeyResolved) {
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

  // Stored-versus-runtime embedding ABI (context-integrity-gates, Unit
  // E). The probe above deliberately runs in memory and never touches
  // the real index, so the stored side is read explicitly here - without
  // it there is nothing to compare against.
  //
  // This is the DIAGNOSTIC surface, so it compares ungated: an operator
  // who ran `search check` asked to be told. The gate governs the read
  // path, which is where a comparison can refuse; a report cannot.
  const recordedAbi = config.semantic.enabled ? readEmbeddingAbiSync(config.dbPath) : null;
  const embeddingAbi =
    recordedAbi === null
      ? Object.freeze([] as ReadonlyArray<StampMismatch>)
      : compareStamps(recordedAbi, runtimeEmbeddingAbi(config, vecVersion));
  if (embeddingAbi.length > 0) warnings.push(formatEmbeddingAbiDrift(embeddingAbi));

  // §E.2 — Actionable hints derived from the check state.
  // Rules match the design doc table; agents and operators read the
  // list to know what command to run next without learning the
  // internals of OSB.
  const recommendations = buildRecommendations({
    config,
    embeddingKeyResolved,
    vecExtension,
    providerReachable,
    embeddingAbi,
  });

  return Object.freeze({
    vaultReadable,
    indexDirWritable,
    sqliteOk,
    fts5Ok,
    embeddingAbi,
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
  readonly embeddingAbi: ReadonlyArray<StampMismatch>;
}

function buildRecommendations(input: BuildRecommendationsInput): string[] {
  const recs: string[] = [];

  // Embedding-ABI drift is the one condition here whose remediation is a
  // single command, so it is named verbatim and copy-pasteable.
  if (input.embeddingAbi.length > 0) {
    recs.push(
      `Stored vectors were written under a different embedding ABI ` +
        `(${input.embeddingAbi.map(formatStampMismatch).join("; ")}). Run: ` +
        `${EMBEDDING_ABI_FIX_COMMAND}`,
    );
  }

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

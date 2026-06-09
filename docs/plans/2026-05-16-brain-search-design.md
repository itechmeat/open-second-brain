# Brain Search — Full-text Index over the Vault

Status: design
Target: Open Second Brain v0.10.0
Authors: Sergey Eroshenkov (product), Claude (drafting)

## 1. Overview

Open Second Brain stores every durable artifact as Markdown in an
Obsidian-compatible vault. The Brain layer adds preferences, signals, and a
daily log; Pay Memory adds an auditable trail of paid actions; AI Wiki and
Daily areas accumulate notes that may be either agent- or user-authored. Until
now, the only way to find anything inside the vault has been to read the file
the caller already names: `brain_query` resolves a known slug, `vault_health`
walks paths, the Read tool requires an absolute path. There is no lookup by
content.

This document specifies **Brain Search** — a deterministic, filesystem-first
search layer over the entire vault. Keyword retrieval is the contract; a
semantic layer is optional and pluggable. The implementation must hold to the
same invariants as the rest of the project: no daemon, no external service is
required to run search, Markdown files remain the source of truth, the index
is a fully rebuildable derived artifact.

This plan covers Tier-S item §2 of `Projects/OpenSecondBrain/Features/_summary`
and supersedes the more sketch-like `Projects/OpenSecondBrain/Features/search`
note. Items §9 (inline `@osb` markers), §12 (merge suggestions), §14 (HTML
explorer) are explicitly **not** included.

## 2. Scope of v0.10.0

In scope:

- New module `src/core/search/` with isolated responsibilities (walker,
  chunker, store, FTS, links, ranker, embedding providers).
- New CLI namespace `o2b search` with verbs `query` (default) / `index` /
  `reindex` / `status` / `check`.
- New MCP tool `brain_search` (read-only).
- Extension of the existing `second_brain_status` MCP tool with a
  `search.*` block.
- SQLite index at `<vault>/.open-second-brain/brain.sqlite` (overridable),
  WAL mode, schema versioned through `index_state.schema_version`.
- Optional semantic layer through `sqlite-vec` and any OpenAI-compatible
  `/v1/embeddings` endpoint (OpenRouter, OpenAI, Google's OpenAI-compat
  endpoint, Together, local Ollama, Hermes proxy when authenticated).
- Vault-wide indexing with a configurable ignore list (defaults: `.git`,
  `node_modules`, `.open-second-brain`, `.obsidian/cache`, `.trash`,
  `.stversions`).
- Incremental reindexing on file modification and removal.

Out of scope:

- Inline `@osb` marker parsing.
- Merge-suggestion detection in `brain_dream` or `brain_digest`.
- HTML/graph explorer.
- Long-running file watcher / daemon.
- LLM-based answer synthesis.
- Multi-vault aggregation.
- A non-OpenAI-shape embedding provider (e.g. Google's native
  `:embedContent` endpoint). Users route Google through OpenRouter or
  Google's OpenAI-compatible endpoint.

## 3. Architectural Principles

1. **Filesystem-first.** Markdown is the source of truth. The SQLite index
   is recoverable: drop the file, run `o2b search reindex`, recover.
2. **Single SQL boundary.** Only `src/core/search/store.ts` imports
   `bun:sqlite`. Every other module talks to the store through a typed
   surface. This keeps backend substitution feasible.
3. **No daemon, no watcher.** Index is updated by explicit commands. An
   opt-in `--auto-refresh` flag on `o2b search query` runs incremental
   indexing once before the read.
4. **Optional semantic, never silent.** Semantic search is off unless the
   user enables it. When enabled but unavailable (extension missing,
   provider unreachable, no compatible embeddings), the system emits an
   explicit `warnings` entry rather than degrading silently.
5. **Read/write asymmetry on MCP.** The MCP surface only exposes
   `brain_search` and a status enrichment. Index management is operator
   business, never agent business.
6. **No prompt-shaped fallbacks.** A misconfigured provider or a missing
   key produces a typed `SearchError`, not a heuristic re-route.

## 4. Module Layout

```
src/core/search/
  types.ts            // BrainSearchResult, IndexStats, SearchError, IndexCheckReport
  paths.ts            // resolveIndexPath(vault, override?)
  store.ts            // bun:sqlite wrapper; only file holding SQL
  schema.ts           // DDL + MIGRATIONS[]
  walker.ts           // vault traversal with ignore-paths
  chunker.ts          // Markdown → chunks { content, start_line, end_line }
  indexer.ts          // indexVault({...}) coordinating walker/chunker/store/embeddings
  fts.ts              // FTS5 query construction and BM25 retrieval
  links.ts            // wikilink / markdown-link / tag extraction
  ranker.ts           // pure: merge keyword + semantic + boosts
  embeddings/
    provider.ts       // EmbeddingProvider interface, makeProvider(config)
    openai-compat.ts  // OpenAICompatProvider
    null-provider.ts  // NullProvider (raises EmbeddingDisabledError)
  index.ts            // public re-exports for CLI and MCP

src/cli/search.ts     // verb dispatcher: query | index | reindex | status | check
src/mcp/search-tools.ts  // brain_search tool, second_brain_status enrichment
```

Dependency direction is strictly downward:

```
cli/mcp → indexer/search → fts/links/ranker/embeddings → store → schema
```

There are no cycles. `embeddings/*` does not import `store` — embeddings are
computed outside and passed in to `store.vecUpsert(...)`.

### Invariants

- `store.ts` is the only module importing `bun:sqlite`.
- `NullProvider.embed()` throws `SearchError("EMBEDDING_DISABLED", ...)` —
  not a no-op — so a caller that reaches it has a configuration bug.
- Search reads chunk content from SQLite, not from disk. The disk is only
  read by the indexer when refreshing.
- The existing `o2b index` (Markdown index generator at
  `AI Wiki/index.md`) is not modified.

## 5. SQLite Schema

Location: `<vault>/.open-second-brain/brain.sqlite`. Overridable through
`search_db_path` in config and `--db` CLI flag. Pragmas applied on open:
`journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`.

```sql
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  title         TEXT,
  content_hash  TEXT NOT NULL,
  mtime         INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  indexed_at    TEXT NOT NULL
);
CREATE INDEX idx_documents_path ON documents(path);
CREATE INDEX idx_documents_mtime ON documents(mtime);

CREATE TABLE chunks (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  token_count   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(document_id, chunk_index)
);
CREATE INDEX idx_chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
-- Triggers chunks_ai / chunks_ad / chunks_au keep chunk_fts in sync.
-- FTS holds only `content` (the single source column on `chunks`). Title
-- and path are not separate FTS columns; they reach the result set via
-- JOIN to `documents` at query time, and title text remains searchable
-- because §6's synthetic frontmatter chunk embeds it as part of the
-- chunk body.

CREATE TABLE embeddings (
  chunk_id        INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  dimension       INTEGER NOT NULL,
  embedding_hash  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_embeddings_model ON embeddings(model);

-- Only when sqlite-vec is loaded:
CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[<DIM>]);
CREATE TABLE chunk_vec_map (
  chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vec_rowid  INTEGER NOT NULL UNIQUE
);

CREATE TABLE links (
  id                  INTEGER PRIMARY KEY,
  source_document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_chunk_id     INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
  target_path         TEXT,
  target_document_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  link_text           TEXT,
  link_type           TEXT NOT NULL CHECK(link_type IN ('wikilink','markdown_link','tag')),
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_links_source ON links(source_document_id);
CREATE INDEX idx_links_target_doc ON links(target_document_id);
CREATE INDEX idx_links_target_path ON links(target_path);

CREATE TABLE index_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- Known keys: schema_version, embedding_model, embedding_dimension,
--             last_full_index_at, vec_extension_available.
```

### Decisions

- `documents.path` is vault-relative with POSIX separators. The walker
  normalises `\` to `/` on upsert. This keeps the schema portable across
  Syncthing peers.
- `content_hash` exists on two levels (document and chunk). File hash is
  the fast-path skip for incremental reindex; chunk hash is the skip key
  for recomputing embeddings.
- FTS5 uses `content='chunks'` (external content) so the chunk text is
  not duplicated. Standard `_ai/_ad/_au` triggers keep the FTS table in
  sync.
- Tokeniser is `unicode61 remove_diacritics 2`. This covers Latin and
  Cyrillic; stemming is not enabled because it would introduce a
  dependency and break determinism across machines.
- `sqlite-vec` is loaded via `Database.loadExtension(...)`. If it
  succeeds, the virtual table `chunk_vec` and its map are created.
  Dimension is fixed at first index and recorded in `index_state`.
  Changing the embedding model or dimension drops `embeddings`,
  `chunk_vec`, and `chunk_vec_map`; `chunks` and `chunk_fts` are
  preserved.
- **`chunk_vec` is a virtual `vec0` table; SQLite foreign-key cascade
  does not reach it.** Only `chunk_vec_map` cascades from `chunks`.
  Every `store` mutation that deletes chunks therefore takes the
  explicit two-step shape: first
  `DELETE FROM chunk_vec WHERE rowid IN (SELECT vec_rowid FROM chunk_vec_map WHERE chunk_id IN (...))`,
  then delete from `chunks` (which cascades to `chunk_vec_map` and via
  triggers removes the FTS rows). This contract is enforced by
  `store.deleteChunks(ids)` / `store.replaceChunks(documentId, ...)` /
  `store.deleteDocument(path)`; no caller talks to `chunk_vec`
  directly. `tests/core/search/store.vec.test.ts` verifies that
  deleting a document leaves zero rows in `chunk_vec` and
  `chunk_vec_map`.
- WAL mode lets readers (`o2b search query`) run while a writer
  (`o2b search index`) holds an exclusive lock. The writer lock is
  enforced through `proper-lockfile` on `brain.sqlite.lock`.

## 6. Chunking

Two passes.

**Pass 1 — structural split.** A single linewise traversal of the file
produces blocks. The block boundaries are:

- ATX heading (`^#{1,6}\s`) — starts a new block.
- Blank line separating non-empty content — paragraph boundary.
- Fenced code (`` ``` `` or `~~~`) — atomic block. An unclosed fence runs
  to EOF.
- YAML frontmatter (`---` … `---` at start of file) — atomic block.
- Bulleted or numbered list of one nesting level — atomic until first
  non-list line.
- Markdown table (line with `|` followed by a `|---` separator) — atomic
  until blank line.

**Pass 2 — pack blocks into chunks.** The packer accumulates blocks while
`tokens(chunk) + tokens(next_block) ≤ max_tokens`. Atomic blocks larger
than `max_tokens` become single chunks unmodified. A heading-only block
starts a new chunk only if the current chunk has a non-heading and
`tokens(chunk) ≥ min_tokens`; otherwise the heading attaches to the
current chunk. Each chunk begins with an overlap of the last
`overlap_tokens` lines from the previous chunk; `start_line`/`end_line`
are recorded from the first non-overlap line so line ranges remain
truthful.

Parameters for v0.10.0:

| Parameter         | Value | Rationale                            |
| ----------------- | ----: | ------------------------------------ |
| `max_tokens`      |   800 | mid of 500–1000 recommendation       |
| `min_tokens`      |   100 | smaller chunks return uninformative hits |
| `overlap_tokens`  |   100 | ~12.5% — preserves context cheaply   |

Tokens are approximated by whitespace-separated word count
(`text.split(/\s+/).filter(Boolean).length`). Deterministic, dependency-free.

### Title resolution

First non-empty wins: `title:` in YAML frontmatter → first H1 in body →
filename with `-`/`_` replaced by spaces.

### Frontmatter as synthetic chunk

If YAML frontmatter exists and is non-empty, it becomes `chunk_index=0`
with the raw frontmatter text as content. This makes `tags:` and other
frontmatter fields searchable through FTS5. Files without frontmatter
start at `chunk_index=0` from their first structural chunk. Malformed
frontmatter (unterminated block, broken syntax) does not abort the
file: it is omitted from chunking, the file is otherwise indexed
normally, and a warning is recorded in `IndexStats.errors` for the
operator to act on.

### Edge cases

- Empty file / whitespace-only: `documents` row is written for tracking,
  zero `chunks`.
- Non-UTF8 bytes: read fails fatally, file is logged as an error in
  `IndexStats.errors`, no `documents` row is written.
- Symlinks: followed only when the target is inside the vault (verified
  via `realpath`). External symlinks are skipped with a warning.

## 7. Ranking

Final score:

```
final_score = clamp01(
    keyword_weight  * keyword_score
  + semantic_weight * semantic_score
  + link_boost
  + recency_boost
)
```

Defaults: `keyword_weight = 0.6`, `semantic_weight = 0.4`. When semantic
is disabled the weights collapse to `1.0 / 0.0`. CLI/MCP/config may
override; the ranker validates that the sum is `≤ 1.0`.

**keyword_score** is min-max normalised BM25 within the query's result
set: `keyword_score = (bm25_raw - min) / (max - min)` over the top-K
keyword candidates; if `max == min`, every candidate gets `1.0`. This
removes the dependency on absolute BM25 magnitudes (which depend on
corpus size).

**semantic_score** is cosine similarity, computed via L2 on
unit-normalised vectors. Vectors are normalised to unit length at write
time, so `cosine_similarity = 1 - (l2_distance² / 2)`, mapped to
`[0, 1]` with `max(0, similarity)`.

**link_boost** ∈ `[0, 0.05]`. Per chunk: `+0.02` if another result in
the same query references it via `[[wikilink]]` (cap `0.03`); `+0.01` if
it shares a tag with another result (cap `0.02`).

**recency_boost** ∈ `[0, 0.05]`. Step function on `mtime`:
≤ 7d → `0.05`, ≤ 30d → `0.025`, ≤ 90d → `0.01`, older → `0`.

### Candidate sets

Keyword candidates: top `K_kw = limit * 3`. Semantic candidates: top
`K_sem = max(limit * 5, 50)`. The two sets are unioned by `chunk_id`;
absent scores are zero on the other side. Tie-break order on equal
`final_score`: `keyword_score desc`, `mtime desc`, `chunk_id asc`.

### `searchType`

Returned as diagnostic only:

- `"hybrid"` if the chunk came from both sets.
- `"keyword"` if only FTS5.
- `"semantic"` if only sqlite-vec.

### Semantic-unavailable behaviour

A semantic request is **explicit** when the caller actively asks for
semantic search: CLI `--semantic`, MCP `semantic: true`. Anything else
(`--keyword-only`, MCP `semantic: false`, the implicit default that
honours `search_semantic_enabled` from config) is **implicit**.

The rule:

- **Implicit + anything missing → warn + keyword-only fallback, exit 0.**
  The caller did not pin the search to semantic; degrading is safe.
- **Explicit + infrastructure missing → fail hard.** sqlite-vec did not
  load, or the embedding provider returned an error / timed out: the
  ranker cannot honour the request, so it surfaces a typed
  `SearchError`. CLI exit 1, MCP `INTERNAL_ERROR`.
- **Explicit + data state recoverable → warn + keyword-only fallback,
  exit 0.** The index simply has no embeddings yet for the current
  model. No infrastructure is broken; the user needs
  `o2b search index --embeddings`, not a panic.

Concretely:

| Trigger | Implicit | Explicit |
|---|---|---|
| `search_semantic_enabled=false` | keyword-only, no warning | n/a (config gate doesn't apply when explicit) |
| sqlite-vec failed to load | warn `"sqlite-vec unavailable, semantic disabled this session"`, exit 0 | `VEC_EXTENSION_UNAVAILABLE`, exit 1 |
| Embedding provider unreachable / timeout | warn `"embedding provider unavailable: <reason>"`, exit 0 | `EMBEDDING_PROVIDER_HTTP` / `_TIMEOUT`, exit 1 |
| Embedding key missing | warn `"embedding key not configured; semantic disabled"`, exit 0 | `EMBEDDING_KEY_MISSING`, exit 1 |
| Index has no compatible embeddings | warn `"no compatible embeddings; run: o2b search index --embeddings"`, exit 0 | same warning, exit 0 (data state, not infra) |

## 8. CLI

All verbs sit under `o2b search`. The default verb is `query`
(positional argument is the query string).

### `o2b search <query>`

Flags: `--vault`, `--db`, `--limit` (1..100, default 10), `--semantic`,
`--keyword-only`, `--path` (prefix filter), `--keyword-weight`,
`--semantic-weight`, `--auto-refresh`, `--json`, `--verbose`.

Human format:

```
[1] Brain/preferences/pref-russian-replies.md  •  0.81
    line 12-38  •  hybrid  •  mtime 2026-05-14
    Communication rules: always reply in the user's language, except when…
```

JSON format: object
`{ results: BrainSearchResult[]; warnings: string[]; total: number }`.
`results` is the array of ranked hits, `warnings` is empty when nothing
to report, `total` is `min(matched, limit)`.

Exit codes: `0` always for success including zero results, `1` for runtime
errors, `2` for bad flags.

### `o2b search index`

Incremental indexing. Flags: `--vault`, `--db`, `--embeddings`,
`--force` (recompute everything, do not delete file), `--concurrency`
(1..16, default 4), `--verbose`, `--json`.

The writer holds an exclusive lock through `proper-lockfile`. A
concurrent run fails fast with `INDEX_LOCKED`.

Output (human):

```
indexing vault: /root/vault
  added:    23 files, 187 chunks
  updated:   4 files, 31 chunks
  unchanged: 412 files
  deleted:   2 files (chunks purged)
  embeddings: 218/218 OK (4 retries)
done in 12.4s
```

JSON: `{stats: {...}, errors: [...], duration_ms}`.

### `o2b search reindex`

Full rebuild. Writes to `brain.sqlite.new`, then `rename(.new, .)`
atomically, then the old file is preserved as `.bak` until the next
successful reindex. On startup, an orphaned `.bak` is restored if the
main file is missing or unreadable.

### `o2b search status`

Read-only summary. Does not take the writer lock. Human and `--json`
forms. Reports index path, schema version, document/chunk/embedding
counts, embedding model and dimension, sqlite-vec status, embedding key
presence (not value), `last_indexed_at`, `last_full_index_at`,
`stale_embeddings` count, and warnings. With no index: prints
`index: not initialised. Run: o2b search index` and exits 0.

### `o2b search check`

Pre-flight diagnostic. Verifies vault readable, index directory writable,
`bun:sqlite` open and FTS5 supported, sqlite-vec loadable (if semantic
enabled), embedding key resolvable (config or env), and — if key is
present — performs a single `embed(["check"])` probe with a 5-second
timeout. Exits 0 unless a hard precondition fails (1/2/3); semantic
issues are reported as warnings, exit 0.

### Parity table

| Verb     | CLI                                  | MCP                       |
| -------- | ------------------------------------ | ------------------------- |
| query    | `o2b search "..."`                   | `brain_search`            |
| index    | `o2b search index [--embeddings]`    | —                         |
| reindex  | `o2b search reindex`                 | —                         |
| status   | `o2b search status`                  | `second_brain_status.search` |
| check    | `o2b search check`                   | —                         |

Mutating and HTTP-spending verbs are operator-only.

## 9. MCP

### `brain_search`

Input schema:

```json
{
  "type": "object",
  "properties": {
    "query":        { "type": "string",  "minLength": 1, "maxLength": 2000 },
    "limit":        { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
    "semantic":     { "type": "boolean", "default": null },
    "keyword_only": { "type": "boolean", "default": false },
    "path_prefix":  { "type": "string",  "maxLength": 256 }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

`semantic: null` uses the config default; `true` or `false` overrides for
the call. `path_prefix` is passed through `ensureInsideVault` to reject
escape attempts.

Output:

```json
{
  "results": [
    {
      "path": "Brain/preferences/pref-russian-replies.md",
      "title": "Russian replies",
      "content": "...",
      "score": 0.81,
      "startLine": 12,
      "endLine": 38,
      "searchType": "hybrid"
    }
  ],
  "warnings": [],
  "total": 1
}
```

`content` is truncated to 600 characters per chunk with `…` suffix on
overflow. The diagnostic score components (`keywordScore`,
`semanticScore`, `linkBoost`, `recencyBoost`) are intentionally absent —
they are noise for the agent and live in CLI `--verbose` only.

`limit` is capped at 50 (not 100 as for CLI) to keep the agent context
small.

### Error mapping

| Situation                                  | MCP code          | Message                                                              |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------- |
| missing/empty `query`                      | `INVALID_PARAMS`  | `missing required argument: query`                                   |
| `path_prefix` escapes vault                | `INVALID_PARAMS`  | `path_prefix escapes vault`                                          |
| index file missing                         | `INTERNAL_ERROR`  | `search index not initialised. Run: o2b search index`                |
| index file unreadable                      | `INTERNAL_ERROR`  | `search index unreadable: <reason>`                                  |
| explicit `semantic=true` without vec       | `INTERNAL_ERROR`  | `semantic search unavailable: sqlite-vec extension not loaded`       |
| explicit `semantic=true`, key missing      | `INTERNAL_ERROR`  | `embedding key not configured`                                       |
| explicit `semantic=true`, provider down    | `INTERNAL_ERROR`  | `embedding provider unavailable: <reason>`                           |
| operation > 10s                            | `INTERNAL_ERROR`  | `search timeout after 10000ms`                                       |

Implicit `semantic: null` never produces an error from any of the
infrastructure rows above — those become entries in the `warnings`
array per §7's table.

### `second_brain_status` enrichment

The existing tool gains a `search` block when `search_enabled !== false`:

```json
{
  "search": {
    "index_path": "/root/vault/.open-second-brain/brain.sqlite",
    "exists": true,
    "schema_version": 1,
    "documents": 441,
    "chunks": 1827,
    "embeddings": 1827,
    "stale_embeddings": 0,
    "embedding_model": "google/gemini-embedding-2-preview",
    "embedding_dimension": 768,
    "vec_extension": "loaded",
    "semantic_enabled": true,
    "embedding_key_present": true,
    "last_indexed_at": "2026-05-16T14:22:17Z",
    "last_full_index_at": "2026-05-10T09:01:03Z"
  }
}
```

`embedding_key_present` is a boolean; the key itself is redacted by the
existing `redactMapping` helper. When the index does not exist, the
block is `{ "exists": false, "hint": "run: o2b search index" }`.

## 10. Configuration

The existing config parser handles flat `key: value` YAML only. All new
keys use prefixes `search_*` and `embedding_*`:

```yaml
# Existing
vault: "/root/vault"
timezone: "Europe/Belgrade"
agent_name: "@claude-vps-agent"

# New (all optional)
search_enabled: "true"
search_db_path: ""                # blank → default <vault>/.open-second-brain/brain.sqlite
search_chunk_size: "800"
search_chunk_overlap: "100"
search_keyword_weight: "0.6"
search_semantic_weight: "0.4"
search_ignore_paths: ".git,node_modules,.open-second-brain,.obsidian/cache,.trash,.stversions"

search_semantic_enabled: "false"
embedding_provider: "openai-compat"
embedding_base_url: "https://openrouter.ai/api/v1"
embedding_model: "google/gemini-embedding-2-preview"
embedding_api_key: ""             # blank → check env; if env empty, semantic disabled
embedding_dimension: ""           # blank → autodetect from first response
embedding_timeout_ms: "10000"
embedding_concurrency: "4"
embedding_batch_size: "32"
```

ENV resolution order is `env → config → default` per key:

| Config key              | ENV                                          | Default                                          |
| ----------------------- | -------------------------------------------- | ------------------------------------------------ |
| `search_db_path`        | `OPEN_SECOND_BRAIN_SEARCH_DB`                | `<vault>/.open-second-brain/brain.sqlite`        |
| `search_semantic_enabled` | `OPEN_SECOND_BRAIN_SEARCH_SEMANTIC`        | `false`                                          |
| `embedding_provider`    | `OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER`       | `openai-compat`                                  |
| `embedding_base_url`    | `OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL`       | — (required if semantic on)                      |
| `embedding_model`       | `OPEN_SECOND_BRAIN_EMBEDDING_MODEL`          | — (required if semantic on)                      |
| `embedding_api_key`     | `OPEN_SECOND_BRAIN_EMBEDDING_KEY`            | — (required if semantic on)                      |
| `embedding_dimension`   | `OPEN_SECOND_BRAIN_EMBEDDING_DIM`            | autodetect                                       |

`search_ignore_paths` is comma-separated, exact directory-name match
(not glob). Numeric and boolean fields are parsed with explicit
validation; invalid values cause `INVALID_INPUT` (CLI exit 2) rather
than a silent fallback.

`embedding_api_key` falls under the existing `SECRET_KEY_PARTS = ["key",
"token", ...]` heuristic and is redacted to `[REDACTED]` by
`redactMapping`. The exact name is also added to the redactor's list as
belt-and-braces.

### `o2b init` instruction block

When `search_semantic_enabled` is `true` (in config or env) but no key
is resolvable, and when the user runs `o2b init`, the bootstrap output
appends:

```
Search is enabled (keyword-only).

To enable semantic search, set the following (config file path is
printed below; alternatively use the environment variables):

  search_semantic_enabled: "true"
  embedding_base_url:      "https://openrouter.ai/api/v1"
  embedding_model:         "google/gemini-embedding-2-preview"
  embedding_api_key:       "<your key>"

Config file:  ~/.config/open-second-brain/config.yaml
Or via env:   OPEN_SECOND_BRAIN_SEARCH_SEMANTIC=true
              OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL=...
              OPEN_SECOND_BRAIN_EMBEDDING_MODEL=...
              OPEN_SECOND_BRAIN_EMBEDDING_KEY=...

Then:
  o2b search check
  o2b search index --embeddings
```

The block prints once, only during `o2b init`. No nagging on every CLI
invocation. `o2b search check` is the dedicated diagnostic command.

## 11. Embedding Provider

```ts
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimension: number | null;
  embed(texts: readonly string[]): Promise<number[][]>;
  ping(): Promise<{ ok: true; dimension: number } | { ok: false; reason: string }>;
}

export function makeProvider(config: ResolvedEmbeddingConfig): EmbeddingProvider;
```

Two concrete implementations:

- `OpenAICompatProvider` for `embedding_provider: openai-compat`. Posts
  `{ model, input: texts, encoding_format: "float" }` to
  `${base_url}/embeddings` with `Authorization: Bearer <api_key>`.
  Batches `texts` into groups of `embedding_batch_size`. Concurrency is
  limited by a semaphore of width `embedding_concurrency`. Vectors are
  unit-normalised before being returned (so cosine works through L2 on
  `chunk_vec`). Retries on `429/500/502/503/504` and network errors
  with exponential backoff `1s/2s/4s + jitter`, three attempts total;
  other 4xx fail fast.
- `NullProvider` for `embedding_provider: disabled` and the implicit
  case when semantic is off. Its `embed()` throws
  `SearchError("EMBEDDING_DISABLED", ...)`; this exists to surface
  configuration bugs rather than silently no-op.

`makeProvider` throws `SearchError("INVALID_INPUT", ...)` synchronously
for an unknown `embedding_provider` value — eagerly at construction
time, not lazily on the first `embed()` call.

The single OpenAI-compatible class is intentional. OpenRouter, OpenAI,
Together, Mistral, Google's OpenAI-compat endpoint, local Ollama
(`http://localhost:11434/v1`), and a future authenticated Hermes proxy
all conform to this shape. Adding a Google-native `:embedContent`
adapter is deferred until a concrete user need surfaces; users can
already reach Google models through OpenRouter.

## 12. Public API

All public functions take a fully-resolved `ResolvedSearchConfig`.
Resolution happens once at the CLI/MCP boundary through
`resolveSearchConfig({...})`; the search module itself never reads
env or `config.yaml`. This keeps CLI / MCP / tests on a single
resolution path and isolates the search module from process-wide
state.

```ts
// types.ts
export interface ResolvedSearchConfig {
  readonly vault: string;
  readonly dbPath: string;
  readonly ignorePaths: ReadonlyArray<string>;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly keywordWeight: number;
  readonly semanticWeight: number;
  readonly semantic: {
    readonly enabled: boolean;
    readonly provider: "openai-compat" | "disabled";
    readonly baseUrl: string | null;
    readonly model: string | null;
    readonly apiKey: string | null;       // never logged; redactMapping handles display
    readonly dimension: number | null;    // null = autodetect at first call
    readonly timeoutMs: number;
    readonly concurrency: number;
    readonly batchSize: number;
  };
}

// index.ts
export function resolveSearchConfig(opts: {
  vault?: string;
  configPath?: string;
  overrides?: Partial<ResolvedSearchConfig>;   // CLI flag overrides go here
}): ResolvedSearchConfig;

export async function indexVault(
  config: ResolvedSearchConfig,
  opts?: {
    embeddings?: boolean;
    force?: boolean;
    onFile?: (event: {
      path: string;
      kind: "added" | "updated" | "unchanged" | "deleted" | "error";
      message?: string;
    }) => void;
  },
): Promise<IndexStats>;

export async function reindexVault(
  config: ResolvedSearchConfig,
  opts?: { embeddings?: boolean },
): Promise<IndexStats>;

export async function search(
  config: ResolvedSearchConfig,
  opts: SearchOptions,
): Promise<SearchOutcome>;

export async function indexStatus(
  config: ResolvedSearchConfig,
): Promise<IndexStatusSnapshot>;

export async function indexCheck(
  config: ResolvedSearchConfig,
): Promise<IndexCheckReport>;
```

`resolveSearchConfig` implements the env → config → default chain
documented in §10 and validates numeric/boolean shapes; an invalid
field raises `SearchError("INVALID_INPUT", ...)`. `overrides` is
how `o2b search query --keyword-weight 0.8` reaches the ranker
without redundant flag-parsing inside the search module.

Result types — `BrainSearchResult`, `IndexStats`, `IndexStatusSnapshot`,
`IndexCheckReport`, `SearchOutcome` — are exported from `types.ts` and
returned `Object.freeze`-d. The `onFile` callback is the sole progress
channel; CLI consumes it for `--verbose` output, tests intercept it for
assertions.

## 13. Migrations and Recovery

Schema version is tracked in `index_state.schema_version`. Migrations
are an array of `{ version, up(db) }` functions applied sequentially in
a transaction. v0.10.0 ships `version 1` only (the initial schema).
Future minor versions add migrations; major schema changes that cannot
be migrated raise `SCHEMA_MISMATCH` with a `o2b search reindex` hint.

Embedding-model or dimension changes do not go through the migration
list. On open, if `index_state.embedding_model` or `embedding_dimension`
mismatches the resolved config, the store drops `embeddings`,
`chunk_vec`, `chunk_vec_map`, logs one line `embedding model changed
from X to Y, embeddings cleared`, and updates `index_state`. `chunks`
and `chunk_fts` are preserved. The next `o2b search index --embeddings`
repopulates vectors.

`o2b search reindex` writes to `brain.sqlite.new`, atomically renames to
`brain.sqlite`, and keeps the previous file as `brain.sqlite.bak` until
the next successful reindex. If `brain.sqlite` is missing or unreadable
at open time and a `.bak` exists, the `.bak` is restored automatically
with a stderr notice.

## 14. Errors

```ts
export class SearchError extends Error {
  readonly code: SearchErrorCode;
}

export type SearchErrorCode =
  | "INDEX_MISSING"
  | "INDEX_UNREADABLE"
  | "SCHEMA_MISMATCH"
  | "VEC_EXTENSION_UNAVAILABLE"
  | "EMBEDDING_DISABLED"
  | "EMBEDDING_KEY_MISSING"
  | "EMBEDDING_PROVIDER_HTTP"
  | "EMBEDDING_PROVIDER_TIMEOUT"
  | "EMBEDDING_DIMENSION_MISMATCH"
  | "INDEX_LOCKED"
  | "INVALID_INPUT";
```

CLI mapping: `INVALID_INPUT → exit 2`, everything else → exit 1.

MCP mapping: `INVALID_INPUT → INVALID_PARAMS`, everything else →
`INTERNAL_ERROR`.

Non-`SearchError` exceptions (sqlite-vec DDL crashes, malformed
extensions) bubble up wrapped as `INDEX_UNREADABLE` with the original
message preserved.

## 15. Concurrency and Locking

- Writers (`index`, `reindex`) hold an exclusive `proper-lockfile` on
  `brain.sqlite.lock`. Retry policy: three attempts, 1s backoff. After
  exhaustion: `INDEX_LOCKED`.
- Readers do not take the lock; WAL is sufficient.
- A single search invocation uses one connection inside a `BEGIN`/
  `COMMIT` pair so keyword and semantic queries see a consistent
  snapshot.

## 16. Idempotency

- `o2b search index` repeated with no changes: `unchanged: N`,
  `added/updated/deleted = 0`, `embeddings_computed = 0`.
- `o2b search reindex` repeated: both runs succeed; the second `.bak`
  replaces the first.
- `documents.path` is unique; double-indexing a file replaces its row
  rather than duplicating.

## 17. Testing

Test framework: `bun test` (already the project standard). Helpers:

```
tests/helpers/
  search-fixtures.ts    // build temporary vaults with fixed content
  mock-embedding.ts     // MockEmbeddingProvider — deterministic sha256-derived vectors
  fake-http.ts          // local OpenAI-compatible server for provider tests
```

Test files:

| File                                          | Coverage                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `tests/core/search/walker.test.ts`            | ignore list, symlinks, hidden dirs, non-md files                                      |
| `tests/core/search/chunker.test.ts`           | empty file, single line, code fence > max, frontmatter + H1, heading without body, lists, tables, UTF-8 Cyrillic |
| `tests/core/search/store.test.ts`             | open/migrate, upsert/replace/delete, FTS triggers, schema-mismatch error, INDEX_LOCKED |
| `tests/core/search/store.vec.test.ts`         | when sqlite-vec loads: round-trip; when not: graceful skip                            |
| `tests/core/search/fts.test.ts`               | BM25 ordering, path-prefix filter, Cyrillic, escape of query special chars            |
| `tests/core/search/links.test.ts`             | wikilink, markdown link, tag; resolve `target_document_id` when target is indexed     |
| `tests/core/search/ranker.test.ts`            | union, weights, clamp, link/recency boost, tie-break, keyword-only fallback           |
| `tests/core/search/indexer.test.ts`           | E2E: index → incremental skip → modify → delete → reindex                             |
| `tests/core/search/indexer.embeddings.test.ts`| `onFile` events, embeddings computed for new/updated, not for unchanged, model-change clears embeddings |
| `tests/core/search/embeddings.test.ts`        | `OpenAICompatProvider` against fake-http: batching, sort by `index`, retry, timeout, dim-mismatch, 4xx fail-fast |
| `tests/core/search/search.test.ts`            | keyword / semantic / hybrid / keyword-only / path-filter; warning when vec unavailable |
| `tests/cli/search.test.ts`                    | every verb; flag parsing; exit codes 0/1/2; JSON output                               |
| `tests/mcp/search.test.ts`                    | `brain_search` happy path; `INVALID_PARAMS` cases; `INTERNAL_ERROR` cases; warning case |

### Performance bench (informative)

`tests/core/search/bench.test.ts` is opt-in (`bun test --filter="bench"`).
Baselines, captured in this document on first run:

- Indexing 1000 synthetic Markdown files: under 30s without embeddings;
  under 5 minutes with embeddings (network-bound).
- Keyword search across five representative queries: average under
  100 ms.
- Hybrid search with a mocked vector store: average under 200 ms.

CI does not run the bench.

## 18. Acceptance Criteria

A reviewer marks the PR ready to merge when all 20 items below are
verified, either by an automated test or by a documented manual check:

1. `o2b search index` creates `<vault>/.open-second-brain/brain.sqlite`
   with all tables and `schema_version=1`.
2. A second `o2b search index` with no file changes reports
   `unchanged: N`, `added/updated/deleted = 0`,
   `embeddings_computed = 0`.
3. Modifying a file's content and `mtime` produces an `updated` entry,
   deletes the old chunks, and indexes the new chunks.
4. Removing a file from disk produces a `deleted` entry on the next
   `index`; queries no longer return its content.
5. `o2b search "<Cyrillic>"` returns hits against a Cyrillic-content
   vault.
6. `o2b search reindex` rebuilds atomically; if killed mid-run, the next
   open restores from `.bak`.
7. `o2b search status` without an index prints `not initialised`; with
   an index prints accurate counts.
8. `o2b search check` without `embedding_api_key` prints MISSING and the
   key-setup instructions (exit 0); with an unreachable provider it
   prints the provider error (exit 0).
9. `o2b search index --embeddings` without a resolvable key fails with
   `EMBEDDING_KEY_MISSING` (exit 1).
10. With a working provider (`fake-http` in the test), `o2b search
    index --embeddings` writes vectors into `chunk_vec` and populates
    `embeddings.embedding_hash` correctly.
11. `o2b search "..." --semantic` with sqlite-vec loaded but empty
    `embeddings` returns a keyword-only result plus the
    `no compatible embeddings` warning, exit 0 (data-state case,
    treated identically for implicit and explicit per §7).
12. Implicit semantic (no `--semantic`, semantic enabled in config)
    with sqlite-vec unloaded → keyword-only result + warning, exit 0.
    Explicit `o2b search "..." --semantic` with sqlite-vec unloaded
    → exit 1, error code `VEC_EXTENSION_UNAVAILABLE`. Explicit
    `--semantic` with provider unreachable → exit 1, error code
    `EMBEDDING_PROVIDER_HTTP` or `_TIMEOUT`.
13. Changing `embedding_model` in config drops `embeddings`,
    `chunk_vec`, `chunk_vec_map`; logs one line; preserves FTS5 and
    `chunks`; next `index --embeddings` repopulates.
14. MCP `brain_search` returns results with `content ≤ 600` chars,
    without diagnostic score components, with `limit ≤ 50`.
15. Two concurrent `o2b search index` processes: the first succeeds,
    the second exits with `INDEX_LOCKED`.
16. The existing `o2b index` (Markdown index generator) continues to
    work unchanged; its tests remain green.
17. MCP `second_brain_status` exposes a `search.*` block with accurate
    counters.
18. Performance benchmark (informative, not a merge gate): keyword
    search across 1000 chunks below 100 ms; hybrid below 500 ms
    excluding the query-embedding round trip.
19. All new TypeScript files pass `tsc --noEmit` with the project's
    strict configuration.
20. `bun test` is green end to end; existing Brain, Pay Memory, and CLI
    suites do not regress.

## 19. Versioning and CHANGELOG

Release: `0.10.0` (minor bump — new feature, backwards compatible). One
CHANGELOG entry under `## 0.10.0`:

```
### Added
- Brain search: SQLite + FTS5 index over the entire vault with optional
  semantic layer via sqlite-vec and any OpenAI-compatible embeddings
  provider. CLI verbs `o2b search query|index|reindex|status|check`,
  MCP tool `brain_search`. See docs/plans/2026-05-16-brain-search-design.md.
```

No `[Unreleased]` section (project convention). The version is updated
in `package.json` and `pyproject.toml` as part of the merge through
`bun run sync-version`.

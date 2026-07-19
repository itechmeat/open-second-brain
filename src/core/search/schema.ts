/**
 * DDL and migrations for the search index. The SQLite database itself
 * is managed by `store.ts`; this module is data + pure functions over
 * a connection so future minor versions can append migrations without
 * touching the store class.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §5.
 */

import type { Database } from "bun:sqlite";

import { SearchError } from "./types.ts";

/**
 * Latest schema version this code understands. A DB with a value above
 * this raises `SCHEMA_MISMATCH` on open — the operator must reindex
 * with a newer binary.
 */
export const LATEST_SCHEMA_VERSION = 10;

/**
 * The wikilink-resolution basename of a stored document path: the final
 * `/`-segment with a trailing `.md` stripped. `notes/alpha.md` → `alpha`,
 * top-level `alpha.md` → `alpha`. Persisted in `documents.basename` so
 * dangling-link resolution can equality-join an index instead of
 * `SUBSTR`-scanning every path. Must stay in lockstep with the resolution
 * ladder in `store.ts` (`<target>.md` exact match, then basename suffix).
 */
export function documentBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return name.endsWith(".md") ? name.slice(0, -".md".length) : name;
}

/**
 * The historical, byte-stable FTS5 tokenizer clause. When no tokenizer
 * config is set, {@link buildFtsTokenize} returns exactly this string so
 * the generated `chunk_fts` schema is identical to every prior release.
 */
export const DEFAULT_FTS_TOKENIZE = "unicode61 remove_diacritics 2";

/** Allowed `remove_diacritics` values for the unicode61 base tokenizer. */
export const FTS_DIACRITICS_ALLOWED: ReadonlyArray<string> = Object.freeze(["0", "1", "2"]);

/** Allowed stemmer selectors layered over the unicode61 base tokenizer. */
export const FTS_STEMMER_ALLOWED: ReadonlyArray<string> = Object.freeze(["none", "porter"]);

/** Validated inputs for {@link buildFtsTokenize}. A null/absent value uses the default. */
export interface FtsTokenizerOptions {
  /** `remove_diacritics` rule: "0" | "1" | "2". Absent/null = "2". */
  readonly diacritics?: string | null;
  /** Language stemmer: "none" | "porter". Absent/null = "none". */
  readonly stemmer?: string | null;
}

/**
 * Assemble the FTS5 tokenizer clause from validated config options. The
 * clause is composed structurally from a fixed allow-list of FTS5
 * tokenizer options (never a natural-language word list), so an operator
 * can only ever produce a valid SQLite tokenizer directive; an
 * out-of-range value rejects with a typed `SearchError` listing the
 * allowed values rather than reaching the DDL.
 *
 * With no options set the return value is byte-identical to
 * {@link DEFAULT_FTS_TOKENIZE}. Changing it takes effect only on the next
 * `o2b search reindex`; there is no implicit reindex.
 */
export function buildFtsTokenize(opts: FtsTokenizerOptions): string {
  const diacritics = opts.diacritics ?? "2";
  if (!FTS_DIACRITICS_ALLOWED.includes(diacritics)) {
    throw new SearchError(
      "INVALID_INPUT",
      `search_fts_diacritics must be one of ${FTS_DIACRITICS_ALLOWED.join(", ")}; got '${diacritics}'`,
    );
  }
  const stemmer = opts.stemmer ?? "none";
  if (!FTS_STEMMER_ALLOWED.includes(stemmer)) {
    throw new SearchError(
      "INVALID_INPUT",
      `search_fts_stemmer must be one of ${FTS_STEMMER_ALLOWED.join(", ")}; got '${stemmer}'`,
    );
  }
  const base = `unicode61 remove_diacritics ${diacritics}`;
  // The porter stemmer WRAPS a base tokenizer in FTS5 syntax, so it
  // prefixes the unicode61 directive rather than replacing it.
  return stemmer === "porter" ? `porter ${base}` : base;
}

/** Context threaded into every migration's `up`. */
export interface MigrationContext {
  /** FTS5 tokenizer clause for the searchable `chunk_fts` table. */
  readonly ftsTokenize: string;
}

function ddlV1(ftsTokenize: string): string {
  return `
CREATE TABLE IF NOT EXISTS documents (
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
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_documents_mtime ON documents(mtime);

CREATE TABLE IF NOT EXISTS chunks (
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
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='${ftsTokenize}'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunk_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id        INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  dimension       INTEGER NOT NULL,
  embedding_hash  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);

CREATE TABLE IF NOT EXISTS chunk_vec_map (
  chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vec_rowid  INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS links (
  id                  INTEGER PRIMARY KEY,
  source_document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_chunk_id     INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
  target_path         TEXT,
  target_document_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  link_text           TEXT,
  link_type           TEXT NOT NULL CHECK(link_type IN ('wikilink','markdown_link','tag')),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_document_id);
CREATE INDEX IF NOT EXISTS idx_links_target_doc ON links(target_document_id);
CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);

CREATE TABLE IF NOT EXISTS index_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;
}

interface Migration {
  readonly version: number;
  readonly up: (db: Database, ctx: MigrationContext) => void;
}

/**
 * v2 (v0.13.0) - recall-quality backing store:
 *
 *   - parallel `chunk_entities` table feeding entity-boosted retrieval;
 *   - `chunks.heading_path` column plus a rebuilt two-column
 *     `chunk_fts` (content, heading_path) so a chunk's heading
 *     breadcrumb is searchable without polluting the display content.
 *
 * Existing rows carry no entities and an empty heading_path until a
 * reindex repopulates them, so those two layers contribute nothing to
 * scoring until then. (The MMR and traversal recall layers are enabled
 * by default and do change ordering versus prior versions - v0.13.0 is
 * a deliberate ranking change and requires `o2b search reindex`.) The
 * FTS rebuild reindexes whatever chunks already exist against the new
 * column layout.
 */
const DDL_V2_ENTITIES = `
CREATE TABLE IF NOT EXISTS chunk_entities (
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  entity     TEXT NOT NULL,
  PRIMARY KEY (chunk_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_chunk_entities_entity ON chunk_entities(entity);
`;

// FTS rebuild is split from the column add because `ALTER TABLE ADD
// COLUMN` is not idempotent; the column add is guarded in `up()`.
function ddlV2Fts(ftsTokenize: string): string {
  return `
DROP TRIGGER IF EXISTS chunks_ai;
DROP TRIGGER IF EXISTS chunks_ad;
DROP TRIGGER IF EXISTS chunks_au;
DROP TABLE IF EXISTS chunk_fts;

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  content,
  heading_path,
  content='chunks',
  content_rowid='id',
  tokenize='${ftsTokenize}'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, content, heading_path)
    VALUES (new.id, new.content, new.heading_path);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, content, heading_path)
    VALUES('delete', old.id, old.content, old.heading_path);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, content, heading_path)
    VALUES('delete', old.id, old.content, old.heading_path);
  INSERT INTO chunk_fts(rowid, content, heading_path)
    VALUES (new.id, new.content, new.heading_path);
END;

INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild');
`;
}

export const MIGRATIONS: ReadonlyArray<Migration> = Object.freeze([
  {
    version: 1,
    up(db, ctx) {
      db.exec(ddlV1(ctx.ftsTokenize));
    },
  },
  {
    version: 2,
    up(db, ctx) {
      db.exec(DDL_V2_ENTITIES);
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(chunks)").all();
      if (!cols.some((c) => c.name === "heading_path")) {
        db.exec("ALTER TABLE chunks ADD COLUMN heading_path TEXT NOT NULL DEFAULT ''");
      }
      db.exec(ddlV2Fts(ctx.ftsTokenize));
    },
  },
  {
    // v3 (typed graph semantics) - a nullable `relation` column on
    // `links` so an edge can carry a semantic relation type orthogonal
    // to its syntactic `link_type`. No CHECK constraint: the relation
    // vocabulary lives in the application layer
    // (src/core/graph/relation-vocab.ts), so adding a relation type is a
    // one-line change, never a migration. Existing rows keep a NULL
    // relation until a reindex repopulates frontmatter-derived edges.
    version: 3,
    up(db) {
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(links)").all();
      if (!cols.some((c) => c.name === "relation")) {
        db.exec("ALTER TABLE links ADD COLUMN relation TEXT");
      }
    },
  },
  {
    // v4 (v0.20.0) - persistent query cache. `query_cache` stores a
    // serialized search result keyed by a hash of the result-affecting
    // request, tagged with the corpus generation it was computed under
    // and a creation timestamp for TTL. The generation tag is what makes
    // the cache self-invalidating: a row whose generation no longer
    // matches the current one is never served and is swept. Additive and
    // reindex-safe; existing data is untouched.
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS query_cache (
          cache_key   TEXT PRIMARY KEY,
          generation  TEXT NOT NULL,
          payload     TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_query_cache_generation ON query_cache(generation);
      `);
    },
  },
  {
    // v5 (CJK search) - keep display content untouched while indexing
    // an expanded FTS shadow column. Existing rows default to their
    // current content until a reindex computes CJK token expansions.
    version: 5,
    up(db, ctx) {
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(chunks)").all();
      if (!cols.some((c) => c.name === "fts_content")) {
        db.exec("ALTER TABLE chunks ADD COLUMN fts_content TEXT NOT NULL DEFAULT ''");
        db.exec("UPDATE chunks SET fts_content = content WHERE fts_content = ''");
      }
      db.exec(`
        DROP TRIGGER IF EXISTS chunks_ai;
        DROP TRIGGER IF EXISTS chunks_ad;
        DROP TRIGGER IF EXISTS chunks_au;
        DROP TABLE IF EXISTS chunk_fts;

        CREATE VIRTUAL TABLE chunk_fts USING fts5(
          fts_content,
          heading_path,
          content='chunks',
          content_rowid='id',
          tokenize='${ctx.ftsTokenize}'
        );

        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunk_fts(rowid, fts_content, heading_path)
            VALUES (new.id, new.fts_content, new.heading_path);
        END;
        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunk_fts(chunk_fts, rowid, fts_content, heading_path)
            VALUES('delete', old.id, old.fts_content, old.heading_path);
        END;
        CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunk_fts(chunk_fts, rowid, fts_content, heading_path)
            VALUES('delete', old.id, old.fts_content, old.heading_path);
          INSERT INTO chunk_fts(rowid, fts_content, heading_path)
            VALUES (new.id, new.fts_content, new.heading_path);
        END;

        INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild');
      `);
    },
  },
  {
    // v6 (write-time-integrity-governance) - link-constraint enforcement
    // needs both endpoint page types at materialization time, so the
    // document's declared frontmatter `type` is persisted alongside it,
    // and a typed edge gains a `relation_blocked` flag the indexer's
    // post-pass recomputes from the current schema pack on every run.
    // The tier guard additionally snapshots a framework file's tiered
    // frontmatter fields (`tier_snapshot`) and stages identity-field
    // hand-edits in `tier_drift` for `o2b brain tiers check|restore`.
    // All additive and reindex-safe: existing rows default to NULL
    // page type (constraints cannot evaluate - allowed), unblocked
    // edges, and no snapshot (first reindex seeds it).
    version: 6,
    up(db) {
      const docCols = db.query<{ name: string }, []>("PRAGMA table_info(documents)").all();
      if (!docCols.some((c) => c.name === "page_type")) {
        db.exec("ALTER TABLE documents ADD COLUMN page_type TEXT");
      }
      if (!docCols.some((c) => c.name === "tier_snapshot")) {
        db.exec("ALTER TABLE documents ADD COLUMN tier_snapshot TEXT");
      }
      const linkCols = db.query<{ name: string }, []>("PRAGMA table_info(links)").all();
      if (!linkCols.some((c) => c.name === "relation_blocked")) {
        db.exec("ALTER TABLE links ADD COLUMN relation_blocked INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS tier_drift (
          id           INTEGER PRIMARY KEY,
          document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          field        TEXT NOT NULL,
          expected     TEXT NOT NULL,
          actual       TEXT NOT NULL,
          detected_at  TEXT NOT NULL,
          UNIQUE(document_id, field)
        );
        CREATE INDEX IF NOT EXISTS idx_tier_drift_document ON tier_drift(document_id);
      `);
    },
  },
  {
    // v7 (link-recall-intelligence) - vault-wide frontmatter alias
    // resolution at materialization time. The indexer extracts a
    // note's `aliases:` array (NFC-normalised, lower-cased) into
    // `doc_aliases`; `resolveAliasTargets` then materializes
    // `target_document_id` for unresolved slash-free wikilink
    // targets that match an alias. Additive and reindex-safe:
    // existing rows simply have no aliases until a reindex
    // repopulates them.
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS doc_aliases (
          document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          alias        TEXT NOT NULL,
          UNIQUE(document_id, alias)
        );
        CREATE INDEX IF NOT EXISTS idx_doc_aliases_alias ON doc_aliases(alias);
      `);
    },
  },
  {
    // v8 (hot-path-performance) - a persisted `documents.basename` column
    // (final path segment, `.md` stripped) with an index, so
    // dangling-wikilink resolution (`resolvedDocLinkPairs`,
    // `resolveAliasTargets`) can equality-join `idx_documents_basename`
    // instead of `SUBSTR`-scanning every `documents.path` twice per
    // unresolved link. The column is backfilled from the existing paths
    // in-place, so a migrated (not-yet-reindexed) index resolves links
    // identically at once; a full reindex repopulates it via
    // `upsertDocument`.
    version: 8,
    up(db) {
      const docCols = db.query<{ name: string }, []>("PRAGMA table_info(documents)").all();
      if (!docCols.some((c) => c.name === "basename")) {
        db.exec("ALTER TABLE documents ADD COLUMN basename TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_documents_basename ON documents(basename)");
      const rows = db
        .query<{ id: number; path: string }, []>(
          "SELECT id, path FROM documents WHERE basename IS NULL",
        )
        .all();
      const update = db.prepare<undefined, [string, number]>(
        "UPDATE documents SET basename = ? WHERE id = ?",
      );
      for (const row of rows) update.run(documentBasename(row.path), row.id);
    },
  },
  {
    // v9 (Retrieval & Ranking Quality) - opt-in trigram candidate index.
    // A second FTS5 shadow over the same `fts_content` column, tokenized
    // with the built-in `trigram` tokenizer, so a query can gather
    // substring / partial-token candidates that the `unicode61` word
    // tokenizer misses. Read only when `search_trigram_prefilter_enabled`
    // is on; otherwise it is inert extra index data and result ordering is
    // byte-identical. Additive and reindex-safe: `rebuild` populates it
    // from existing chunks in-place, and dedicated triggers keep it in
    // sync. No new dependency - the trigram tokenizer ships with SQLite.
    version: 9,
    up(db) {
      db.exec(`
        DROP TRIGGER IF EXISTS chunks_tri_ai;
        DROP TRIGGER IF EXISTS chunks_tri_ad;
        DROP TRIGGER IF EXISTS chunks_tri_au;
        DROP TABLE IF EXISTS chunk_trigram;

        CREATE VIRTUAL TABLE chunk_trigram USING fts5(
          fts_content,
          content='chunks',
          content_rowid='id',
          tokenize='trigram'
        );

        CREATE TRIGGER chunks_tri_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunk_trigram(rowid, fts_content) VALUES (new.id, new.fts_content);
        END;
        CREATE TRIGGER chunks_tri_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunk_trigram(chunk_trigram, rowid, fts_content)
            VALUES('delete', old.id, old.fts_content);
        END;
        CREATE TRIGGER chunks_tri_au AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunk_trigram(chunk_trigram, rowid, fts_content)
            VALUES('delete', old.id, old.fts_content);
          INSERT INTO chunk_trigram(rowid, fts_content) VALUES (new.id, new.fts_content);
        END;

        INSERT INTO chunk_trigram(chunk_trigram) VALUES('rebuild');
      `);
    },
  },
  {
    // v10 (conversation chronology, t_347e8224) - a nullable
    // `documents.authored_at` column (unix seconds) carrying the
    // transcript turn instant a session-imported note was authored at.
    // Surfaced on search results and used to break EXACT hybrid-score
    // ties toward more recent statements. Additive and reindex-safe:
    // existing rows default to NULL (no turn instant) until a reindex
    // repopulates it from the `authored_at` frontmatter field, so a vault
    // with no transcript-authored notes ranks byte-identically.
    version: 10,
    up(db) {
      const docCols = db.query<{ name: string }, []>("PRAGMA table_info(documents)").all();
      if (!docCols.some((c) => c.name === "authored_at")) {
        db.exec("ALTER TABLE documents ADD COLUMN authored_at INTEGER");
      }
    },
  },
]);

/** Read the current schema version from `index_state`. Returns 0 if not yet recorded. */
export function readSchemaVersion(db: Database): number {
  const row = db
    .query<{ value: string }, []>(
      "SELECT value FROM index_state WHERE key = 'schema_version' LIMIT 1",
    )
    .get();
  if (!row) return 0;
  const n = Number(row.value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new SearchError(
      "INDEX_UNREADABLE",
      `index_state.schema_version is not an integer: '${row.value}'`,
    );
  }
  return n;
}

function setSchemaVersion(db: Database, version: number): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO index_state(key, value, updated_at) VALUES('schema_version', ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [String(version), now],
  );
}

/** Options for {@link applyMigrations}. */
export interface ApplyMigrationsOptions {
  /**
   * FTS5 tokenizer clause for the searchable `chunk_fts` table. Absent =
   * {@link DEFAULT_FTS_TOKENIZE}, which keeps the generated schema
   * byte-identical to prior releases. Only takes effect on a fresh build
   * (reindex); an already-migrated index is not rewritten.
   */
  readonly ftsTokenize?: string;
}

/**
 * Apply every pending migration in a single transaction. On a fresh
 * database (no `index_state`), v1 creates the entire schema. On an
 * existing one we run only those with `version > current`.
 *
 * Returns the version after migration.
 */
export function applyMigrations(db: Database, opts: ApplyMigrationsOptions = {}): number {
  const ctx: MigrationContext = { ftsTokenize: opts.ftsTokenize ?? DEFAULT_FTS_TOKENIZE };
  const hasIndexState = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='index_state'",
    )
    .get();

  const current = hasIndexState ? readSchemaVersion(db) : 0;

  if (current > LATEST_SCHEMA_VERSION) {
    throw new SearchError(
      "SCHEMA_MISMATCH",
      `index schema version ${current} is newer than this binary supports (${LATEST_SCHEMA_VERSION}). ` +
        `Run: o2b search reindex`,
    );
  }

  if (current === LATEST_SCHEMA_VERSION) return current;

  db.exec("BEGIN");
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.up(db, ctx);
      setSchemaVersion(db, migration.version);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return LATEST_SCHEMA_VERSION;
}

/**
 * Create the `chunk_vec` virtual table at the given dimension. Caller
 * must have already loaded sqlite-vec; this only issues the DDL.
 *
 * No-op if the table already exists.
 */
export function ensureVecTable(db: Database, dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new SearchError(
      "INVALID_INPUT",
      `vec dimension must be a positive integer, got ${dimension}`,
    );
  }
  const exists = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_vec'",
    )
    .get();
  if (exists) return;
  db.exec(`CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[${dimension}])`);
}

/** Drop the `chunk_vec` virtual table if it exists. */
export function dropVecTable(db: Database): void {
  db.exec("DROP TABLE IF EXISTS chunk_vec");
}

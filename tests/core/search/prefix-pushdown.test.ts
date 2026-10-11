/**
 * Sargable path-prefix predicates (recall-quality, task C1).
 *
 * Every prefix predicate the store ran was `substr(d.path, 1, length(?)) = ?`,
 * which cannot use `idx_documents_path`: SQLite must evaluate the expression
 * per row. The range form `d.path >= ?1 AND d.path < ?2` is exact for the
 * same set of rows - `documents.path` is vault-relative POSIX + NFC under
 * BINARY collation, so strings compare as UTF-8 bytes - and the b-tree
 * answers it as a range scan.
 *
 * The bound (recall-quality review): `?2` is the prefix with its LAST code
 * point incremented by one, so every string starting with the prefix holds
 * the old code point where the bound holds the incremented one and sorts
 * strictly below it, while the bound itself does not start with the prefix
 * (tight). A `prefix || U+FFFF` bound is WRONG under byte ordering: an
 * astral continuation (emoji filenames, U+1F300+) encodes with a leading
 * byte above U+FFFF's 0xEF and sorts ABOVE the bound, dropping rows the
 * substr form matched. When the last code point is U+10FFFF and cannot
 * increment, the bound is null and the read runs lower-bound-only.
 *
 * This file pins three things:
 *
 *   1. the four prefixed reads (keyword lane, semantic lane, the prefix
 *      document census, the pending-vector census) return exactly the rows
 *      the historical `substr` form returns on the same fixture store -
 *      including astral-plane continuations and the no-increment fallback;
 *   2. the caller prefix passes through `canonicalNotePath`, so a win32
 *      backslash prefix now matches the stored POSIX paths it names;
 *   3. `assertSafePathPrefix` refusals are unchanged - the range form
 *      never widens what a caller may ask for.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { canonicalNotePath } from "../../../src/core/path-safety.ts";
import { applyMigrations, ensureVecTable } from "../../../src/core/search/schema.ts";
import { assertSafePathPrefix } from "../../../src/core/search/pipeline/request.ts";
import { countDocumentsUnderPrefix } from "../../../src/core/search/store/documents.ts";
import { pathPrefixRange } from "../../../src/core/search/store/path-prefix.ts";
import { keywordTopK, keywordTopKSql } from "../../../src/core/search/store/keyword.ts";
import { trigramCandidates } from "../../../src/core/search/store/trigram.ts";
import {
  countChunksWithoutEmbeddings,
  findChunksWithoutEmbeddings,
} from "../../../src/core/search/store/chunks.ts";
import { semanticTopK, vecUpsert } from "../../../src/core/search/store/vectors.ts";
import { SearchError } from "../../../src/core/search/types.ts";

const VEC_AVAILABLE = sqliteVecLoadable();

const NOW = "2026-10-11T00:00:00.000Z";

interface SeedDoc {
  readonly path: string;
  readonly chunkText: string;
}

const DOCS: ReadonlyArray<SeedDoc> = [
  { path: "notes/alpha.md", chunkText: "apple alpha rind" },
  { path: "notes/sub/beta.md", chunkText: "apple beta rind" },
  { path: "notes/alphabetic.md", chunkText: "apple alphabetic rind" },
  { path: "other/gamma.md", chunkText: "apple gamma rind" },
  // Astral-plane continuations (recall-quality review): an emoji directly
  // after the prefix sorts above any `prefix || U+FFFF` bound byte-wise,
  // and an emoji after an emoji does too. The U+10FFFF sentinel is the
  // no-increment case: its prefix has no incremented bound at all.
  { path: "notes/\u{1F680}-launch.md", chunkText: "apple launch rind" },
  { path: "notes/\u{1F680}\u{1F680}.md", chunkText: "apple twin rind" },
  { path: "notes/launch\u{10FFFF}.md", chunkText: "apple sentinel rind" },
];

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  if (VEC_AVAILABLE) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(vec.getLoadablePath());
    ensureVecTable(db, 4);
  }
  let chunkId = 0;
  for (const doc of DOCS) {
    const docId = db
      .query<{ id: number }, [string, string, number, number, string, string, string]>(
        "INSERT INTO documents(path, content_hash, mtime, size, created_at, updated_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(doc.path, `hash-${doc.path}`, 0, 0, NOW, NOW, NOW)!.id;
    const row = db
      .query<{ id: number }, [number, string, string, string, string, string]>(
        "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
          "VALUES (?, 0, ?, ?, ?, 1, 1, 3, ?, ?) RETURNING id",
      )
      .get(docId, doc.chunkText, doc.chunkText, `chash-${doc.path}`, NOW, NOW)!;
    if (VEC_AVAILABLE && doc.path !== "notes/sub/beta.md") {
      // beta stays pending, so the scoped pending-vector census below has
      // a nonzero population to scope.
      vecUpsert(
        db,
        true,
        row.id,
        unitVector(0.1 * (chunkId + 1)),
        "test-model",
        4,
        `ehash-${chunkId}`,
      );
    }
    chunkId++;
  }
});

afterEach(() => {
  db.close();
});

/** The keyword hit paths under the historical `substr` predicate, in lane order. */
function keywordPathsUnderSubstr(prefix: string): ReadonlyArray<string> {
  const rows = db
    .query<{ path: string }, [string, string, string, number]>(
      "SELECT d.path AS path FROM chunk_fts " +
        "JOIN chunks c ON c.id = chunk_fts.rowid " +
        "JOIN documents d ON d.id = c.document_id " +
        "WHERE chunk_fts MATCH ? AND substr(d.path, 1, length(?)) = ? " +
        "ORDER BY bm25(chunk_fts, 1.0, 0.3) ASC, c.id ASC LIMIT ?",
    )
    .all('"apple"', prefix, prefix, 50);
  return rows.map((r) => r.path);
}

function keywordPaths(prefix: string | null): ReadonlyArray<string> {
  return keywordTopK(db, '"apple"', { limit: 50, pathPrefix: prefix }).map((h) => {
    const path = db
      .query<{ path: string }, [number]>("SELECT path FROM documents WHERE id = ?")
      .get(h.documentId);
    return path!.path;
  });
}

describe("keyword lane prefix pushdown", () => {
  test("range form returns exactly the substr form's rows", () => {
    for (const prefix of ["notes", "notes/", "notes/sub", "notes/alpha.md", "other", "zzz"]) {
      expect(keywordPaths(prefix)).toEqual(keywordPathsUnderSubstr(prefix));
    }
  });

  test("a prefix equal to a full path matches that document only", () => {
    expect(keywordPaths("notes/alpha.md")).toEqual(["notes/alpha.md"]);
  });

  test("an emoji continuation is not dropped (differential vs substr)", () => {
    // The defect: `notes/` + U+FFFF sorts BELOW `notes/<emoji>` under
    // BINARY (UTF-8 byte) collation, so the launch note vanished while the
    // substr form matched it. Byte-identical row sets, and the row is there.
    for (const prefix of ["notes/", "notes/\u{1F680}", "notes/\u{1F680}-launch.md"]) {
      expect(keywordPaths(prefix)).toEqual(keywordPathsUnderSubstr(prefix));
    }
    expect(keywordPaths("notes/")).toContain("notes/\u{1F680}-launch.md");
  });

  test("an astral last-char prefix with an astral continuation (differential vs substr)", () => {
    // Prefix `notes/<emoji>`: the increment bound moves the emoji itself
    // (U+1F680 -> U+1F681), so the twin-emoji note - which the U+FFFF form
    // dropped - stays strictly below the bound.
    for (const prefix of ["notes/\u{1F680}", "notes/\u{1F680}\u{1F680}"]) {
      expect(keywordPaths(prefix)).toEqual(keywordPathsUnderSubstr(prefix));
    }
    expect(keywordPaths("notes/\u{1F680}")).toContain("notes/\u{1F680}\u{1F680}.md");
  });

  test("a U+10FFFF-final prefix bounds through the last incrementable code point", () => {
    // U+10FFFF cannot increment, but nothing sorts above it either, so the
    // bound steps back to the last incrementable code point and stays exact
    // AND tight - byte-identical to the substr form, not a wide scan.
    const prefix = "notes/launch\u{10FFFF}";
    expect(pathPrefixRange(prefix)).toEqual({ lo: prefix, hi: "notes/launci" });
    expect(keywordTopKSql({ pathPrefix: prefix })).toContain("d.path < ?");
    expect(keywordPaths(prefix)).toEqual(keywordPathsUnderSubstr(prefix));
    expect(keywordPaths(prefix)).toEqual(["notes/launch\u{10FFFF}.md"]);
  });

  test("an all-U+10FFFF prefix has no bound and runs lower-bound-only", () => {
    const prefix = "\u{10FFFF}\u{10FFFF}";
    expect(pathPrefixRange(prefix).hi).toBeNull();
    expect(keywordTopKSql({ pathPrefix: prefix })).not.toContain("d.path < ?");
    expect(keywordTopKSql({ pathPrefix: prefix })).toContain("d.path >= ?");
  });

  test("a win32 backslash prefix is canonicalized and matches", () => {
    expect(keywordPaths("notes\\sub")).toEqual(["notes/sub/beta.md"]);
  });

  test("absent prefix scans the whole vault as before", () => {
    expect(keywordPaths(null).length).toBe(DOCS.length);
  });
});

describe("trigram lane prefix pushdown", () => {
  test("an all-U+10FFFF prefix runs the lane lower-bound-only", () => {
    // Seed a document under the boundless prefix directly: its row is only
    // reachable through the lower-bound scan the null bound demands.
    const docId = db
      .query<{ id: number }, [string, string, number, number, string, string, string]>(
        "INSERT INTO documents(path, content_hash, mtime, size, created_at, updated_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get("\u{10FFFF}\u{10FFFF}sentinel.md", "hash-sentinel", 0, 0, NOW, NOW, NOW)!.id;
    db.query(
      "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
        "VALUES (?, 0, 'apple sentinel rind', 'apple sentinel rind', 'chash-sentinel', 1, 1, 3, ?, ?)",
    ).run(docId, NOW, NOW);

    expect(pathPrefixRange("\u{10FFFF}\u{10FFFF}").hi).toBeNull();
    const outcome = trigramCandidates(db, '"apple"', {
      limit: 50,
      pathPrefix: "\u{10FFFF}\u{10FFFF}",
    });
    // The defect: the lane bound `d.path < ?` unconditionally, so the
    // boundless prefix's null bound went into the scan as NULL and the
    // read answered an empty candidate list.
    expect(outcome.warnings).toEqual([]);
    expect(outcome.hits.length).toBe(1);
    expect(outcome.hits[0]!.documentId).toBe(docId);
  });

  test("a bounded prefix still binds both ends of the trigram range", () => {
    const seeded = keywordPaths("notes");
    expect(seeded.length).toBeGreaterThan(0);
    const outcome = trigramCandidates(db, '"apple"', { limit: 50, pathPrefix: "notes" });
    expect(outcome.warnings).toEqual([]);
    expect(outcome.hits.length).toBe(seeded.length);
  });
});

describe("prefix document census", () => {
  test("countDocumentsUnderPrefix agrees with the substr form", () => {
    const substrCount = (prefix: string): number =>
      db
        .query<{ c: number }, [string, string]>(
          "SELECT count(*) AS c FROM documents WHERE substr(path, 1, length(?)) = ?",
        )
        .get(prefix, prefix)!.c;
    for (const prefix of ["notes", "notes/sub", "other", "zzz"]) {
      expect(countDocumentsUnderPrefix(db, prefix)).toBe(substrCount(prefix));
    }
  });

  test("astral prefixes count the same rows the substr form counts", () => {
    const substrCount = (prefix: string): number =>
      db
        .query<{ c: number }, [string, string]>(
          "SELECT count(*) AS c FROM documents WHERE substr(path, 1, length(?)) = ?",
        )
        .get(prefix, prefix)!.c;
    for (const prefix of [
      "notes/",
      "notes/\u{1F680}",
      "notes/\u{1F680}\u{1F680}.md",
      "notes/launch\u{10FFFF}",
    ]) {
      expect(countDocumentsUnderPrefix(db, prefix)).toBe(substrCount(prefix));
    }
    expect(countDocumentsUnderPrefix(db, "notes/\u{1F680}")).toBe(2);
  });

  test("a win32 backslash prefix is canonicalized and matches", () => {
    expect(countDocumentsUnderPrefix(db, "notes\\sub")).toBe(1);
  });
});

describe("pending-vector census prefix scope", () => {
  test("the scoped anti-join agrees with the substr form", () => {
    const substrPending = (prefix: string): number =>
      db
        .query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) AS n FROM chunks c JOIN documents d ON d.id = c.document_id " +
            "LEFT JOIN embeddings e ON e.chunk_id = c.id " +
            "WHERE e.chunk_id IS NULL AND substr(d.path, 1, length(?)) = ?",
        )
        .get(prefix, prefix)!.n;
    for (const prefix of ["notes", "notes/sub", "other", "notes/\u{1F680}"]) {
      expect(countChunksWithoutEmbeddings(db, { pathPrefixes: [prefix] })).toBe(
        substrPending(prefix),
      );
      expect(findChunksWithoutEmbeddings(db, { pathPrefixes: [prefix] }).length).toBe(
        substrPending(prefix),
      );
    }
  });

  test("a win32 backslash prefix is canonicalized and matches", () => {
    expect(countChunksWithoutEmbeddings(db, { pathPrefixes: ["notes\\sub"] })).toBe(1);
  });

  test("an empty scope stays vault-wide", () => {
    // With sqlite-vec loaded every chunk but beta carries an embedding, so
    // exactly one is pending; without it, every chunk is.
    expect(countChunksWithoutEmbeddings(db)).toBe(VEC_AVAILABLE ? 1 : DOCS.length);
    expect(countChunksWithoutEmbeddings(db, { pathPrefixes: [] })).toBe(
      VEC_AVAILABLE ? 1 : DOCS.length,
    );
  });
});

describe.skipIf(!VEC_AVAILABLE)("semantic lane prefix pushdown", () => {
  test("range form returns exactly the substr form's rows", () => {
    const vector = unitVector(0.5);
    const substrPaths = semanticPathsUnderSubstr(vector, "notes");
    expect(substrPaths.length).toBeGreaterThan(0);
    expect(semanticPaths(vector, "notes")).toEqual(substrPaths);
    // beta carries no embedding (it keeps the pending census populated),
    // so the win32 case targets the alph* pair instead.
    expect(semanticPaths(vector, "notes\\alph")).toEqual(["notes/alphabetic.md", "notes/alpha.md"]);
  });

  test("an emoji continuation survives the prefixed KNN (differential vs substr)", () => {
    const vector = unitVector(0.5);
    expect(semanticPaths(vector, "notes/")).toEqual(semanticPathsUnderSubstr(vector, "notes/"));
    expect(semanticPaths(vector, "notes/")).toContain("notes/\u{1F680}-launch.md");
  });
});

function semanticPaths(vector: Float32Array, prefix: string): ReadonlyArray<string> {
  return semanticTopK(db, true, vector, { limit: 10, pathPrefix: prefix }).map((h) => {
    const path = db
      .query<{ path: string }, [number]>("SELECT path FROM documents WHERE id = ?")
      .get(h.documentId);
    return path!.path;
  });
}

function semanticPathsUnderSubstr(vector: Float32Array, prefix: string): ReadonlyArray<string> {
  const rows = db
    .query<{ path: string }, [Uint8Array, string, string]>(
      "SELECT d.path AS path FROM chunk_vec v " +
        "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid " +
        "JOIN chunks c ON c.id = m.chunk_id " +
        "JOIN documents d ON d.id = c.document_id " +
        "WHERE v.embedding MATCH ? AND k = 40 AND substr(d.path, 1, length(?)) = ? " +
        "ORDER BY v.distance ASC, m.chunk_id ASC",
    )
    .all(float32Blob(vector), prefix, prefix);
  return rows.map((r) => r.path);
}

describe("assertSafePathPrefix refusals are unchanged", () => {
  test("vault escapes are still refused verbatim", () => {
    for (const prefix of ["../escape", "notes/../..", "/absolute", "C:\\notes", "c:notes"]) {
      expect(() => assertSafePathPrefix(prefix)).toThrow(SearchError);
      expect(() => assertSafePathPrefix(prefix)).toThrow(
        new RegExp(
          `escapes vault: ${JSON.stringify(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    }
  });

  test("a safe prefix passes through untouched", () => {
    expect(assertSafePathPrefix("notes/sub")).toBe("notes/sub");
    expect(assertSafePathPrefix(undefined)).toBeUndefined();
  });
});

function unitVector(first: number): Float32Array {
  const v = new Float32Array(4).fill(0.1);
  v[0] = first;
  return v;
}

function float32Blob(values: Float32Array): Uint8Array {
  return new Uint8Array(
    values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength),
  );
}

// The NFC half of the canonicalization this feature relies on, pinned here
// so a change to `canonicalNotePath` cannot silently unmatch the cases
// above. The separator half is exercised through the store functions, whose
// prefix bound normalizes the caller's win32 separator convention before
// the canonical form.
test("canonicalNotePath normalizes NFC", () => {
  expect(canonicalNotePath("caf\u0065\u0301/notes")).toBe("caf\u00e9/notes");
});

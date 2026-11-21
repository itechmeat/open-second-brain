/**
 * What a full build of the search index is expected to take: its size on
 * disk and its wall time, from what it will hold.
 *
 * The basis is a measured one: a real-size brain store of 397,181 records
 * (200,162 indexed documents, 652 of them the vault's notes) built into
 * 514,236,416 bytes in 70 to 78 s (schema v18). Measured per table, the
 * `records` table and its indexes took 401 bytes per store record, and
 * everything else (documents, chunks, full-text and entity tables) 1,777
 * bytes per indexed document. The time splits into the store's ingest,
 * about 0.15 ms per record, and the walk over the vault's notes, about
 * 20 ms per note file on the same machine. The figures are an estimate:
 * long notes take more room than short records, and a slower disk or CPU
 * takes longer.
 */

import { existsSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";

import { closeDatabase } from "../sqlite-close.ts";
import { sqliteSiblingsPresent } from "../sqlite-file-set.ts";

/** Bytes per brain store record: its `records` row and that table's indexes. */
export const INDEX_BYTES_PER_STORE_RECORD = 401;

/** Bytes per indexed document: its document, chunk, full-text and entity rows. */
export const INDEX_BYTES_PER_DOCUMENT = 1_777;

/** Build time per brain store record, in milliseconds. */
export const INDEX_MS_PER_STORE_RECORD = 0.15;

/** Build time per vault note file, in milliseconds. */
export const INDEX_MS_PER_NOTE_FILE = 20;

/** What a build is expected to hold. */
export interface IndexEstimateInput {
  /** Brain store records (every one gets a `records` row). */
  readonly storeRecords: number;
  /** Documents the index will hold: store records indexed as text, and notes. */
  readonly documents: number;
  /** Note files of the vault the build walks; null when not counted (they come on top). */
  readonly noteFiles: number | null;
}

/** The expected size and wall time of a full build. */
export interface IndexEstimate {
  readonly bytes: number;
  readonly seconds: number;
}

export function estimateIndexBuild(input: IndexEstimateInput): IndexEstimate {
  const records = Math.max(0, input.storeRecords);
  const documents = Math.max(0, input.documents);
  const notes = Math.max(0, input.noteFiles ?? 0);
  return {
    bytes: Math.round(
      records * INDEX_BYTES_PER_STORE_RECORD + documents * INDEX_BYTES_PER_DOCUMENT,
    ),
    seconds:
      Math.round((records * INDEX_MS_PER_STORE_RECORD + notes * INDEX_MS_PER_NOTE_FILE) / 100) / 10,
  };
}

/** `514 MB`, `3.2 MB`, `12 KB`: decimal units, as the size on disk is usually read. */
export function formatEstimateBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** `about 1 min 15 s`, `about 8 s`, `under a second`. */
export function formatEstimateSeconds(seconds: number): string {
  if (seconds < 1) return "under a second";
  const whole = Math.round(seconds);
  if (whole < 60) return `about ${whole} s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `about ${minutes} min` : `about ${minutes} min ${rest} s`;
}

/** One line for the dry run and the status: size and time, with what they rest on. */
export function describeIndexEstimate(input: IndexEstimateInput): string {
  const estimate = estimateIndexBuild(input);
  return (
    `about ${formatEstimateBytes(estimate.bytes)}, built in ${formatEstimateSeconds(estimate.seconds)} ` +
    `(${input.storeRecords} brain store record(s), ${input.documents} document(s), ` +
    (input.noteFiles === null
      ? "the vault's notes not counted and coming on top)"
      : `${input.noteFiles} note file(s))`)
  );
}

/** What an existing index holds, for the estimate of its rebuild. */
export interface IndexCensus extends IndexEstimateInput {
  /** The index's size on disk: the main file and its journals. */
  readonly sizeOnDiskBytes: number;
}

/**
 * Read the counts of the index at `dbPath` (read-only); null when it is
 * absent or cannot be read. Cheap: three counts over indexed tables.
 */
export function readIndexCensus(dbPath: string): IndexCensus | null {
  if (!existsSync(dbPath)) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const count = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    const hasRecords =
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'records'",
        )
        .get()!.n === 1;
    let sizeOnDiskBytes = 0;
    for (const path of [dbPath, ...sqliteSiblingsPresent(dbPath)]) {
      try {
        sizeOnDiskBytes += statSync(path).size;
      } catch {
        // gone between the listing and the stat
      }
    }
    return {
      storeRecords: hasRecords ? count("SELECT COUNT(*) AS n FROM records") : 0,
      documents: count("SELECT COUNT(*) AS n FROM documents"),
      noteFiles: count(
        "SELECT COUNT(*) AS n FROM documents WHERE substr(path, 1, 13) <> '.brain-store/'",
      ),
      sizeOnDiskBytes,
    };
  } catch {
    return null;
  } finally {
    closeDatabase(db);
  }
}

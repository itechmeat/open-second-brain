/**
 * What the index RECORDS about its embedder against what it actually
 * HOLDS (nothing-writes-silently, unit G).
 *
 * Two comparisons already exist and neither answers this question.
 * `embedding-abi.ts` compares the recorded tokens against the tokens
 * THIS BUILD would produce; `staleEmbeddings` compares the stored rows
 * against the CONFIGURED model. Both take the record's word for what
 * the index contains. So an `index_state` row claiming dimension 8 over
 * 4-wide stored vectors was invisible to every surface: the record is
 * not drifted from anything, it is simply wrong, and a wrong record is
 * evidence of nothing rather than evidence of a gap.
 *
 * The audit is pure SQL and reads three facts:
 *
 *   - the dimension `index_state` records;
 *   - the DISTINCT widths the `embeddings` rows carry;
 *   - the width the `chunk_vec` virtual table declares, read out of
 *     `sqlite_master` rather than by querying the table, so no
 *     sqlite-vec extension has to load for the audit to run.
 *
 * It contacts no provider, costs nothing, and its verdict rides the
 * wave's shared reconciliation vocabulary so "the record contradicts the
 * data" is one named outcome rather than a sentence each surface spells
 * for itself.
 *
 * Scope, stated so a reader does not go looking for the other half: this
 * compares DIMENSIONS. `embeddings.model` versus the recorded model is a
 * separate comparison the wave did not take on - a row written by
 * another model is what `staleEmbeddings` already counts, against the
 * configured model rather than the recorded one - and the restamp verb
 * refuses a model disagreement rather than repairing it.
 */

import { Database } from "bun:sqlite";

import {
  buildReconciliationReport,
  deriveReconciliationOutcome,
  RECONCILIATION_OUTCOME,
} from "../../reconciliation-report.ts";
import type { EmbedderRecordCensus } from "../types.ts";
import { EMBEDDING_ABI_FIX_COMMAND } from "./embedding-abi.ts";
import { EMBEDDING_DIMENSION_STATE_KEY, peekReadonlyIndex } from "./state.ts";

/**
 * `CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[N])` - the
 * declaration `ensureVecTable` writes, read back for its N. A table
 * declared in a shape this pattern does not match contributes no
 * observation: an unreadable declaration cannot contradict anything,
 * the same rule an unrecorded ABI token already follows.
 */
const VEC0_DECLARED_WIDTH_RE = /float\s*\[\s*(\d+)\s*\]/i;

/** The distinct widths the `embeddings` rows carry, ascending. */
function storedDimensions(db: Database): ReadonlyArray<number> {
  return db
    .query<{ dimension: number }, []>(
      "SELECT DISTINCT dimension FROM embeddings ORDER BY dimension ASC",
    )
    .all()
    .map((r) => r.dimension);
}

/** The width `chunk_vec` declares, or null when there is no such table. */
function vecDeclaredWidth(db: Database): number | null {
  const row = db
    .query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vec'",
    )
    .get();
  if (row?.sql == null) return null;
  const match = VEC0_DECLARED_WIDTH_RE.exec(row.sql);
  return match === null ? null : Number(match[1]);
}

/** One thing the index holds, named as it will appear in `missing`. */
interface DimensionObservation {
  readonly key: string;
  readonly dimension: number;
}

/**
 * Audit one open index. `read` is the `index_state` accessor and `db`
 * the same connection, so both halves of the comparison come from one
 * instant.
 *
 * The UNRECORDED arm covers the three states that leave nothing to
 * compare - no recorded dimension, a recorded dimension that is not a
 * number, and an index holding neither vectors nor a vec table. None of
 * them is a contradiction and none is a clean audit; reporting either
 * would be a claim this query cannot back.
 */
export function auditEmbedderRecord(
  read: (key: string) => string | null,
  db: Database,
): EmbedderRecordCensus {
  const raw = read(EMBEDDING_DIMENSION_STATE_KEY);
  if (raw === null) {
    return Object.freeze({
      verdict: "unrecorded" as const,
      reason: `index_state records no ${EMBEDDING_DIMENSION_STATE_KEY}, so there is no claim to check`,
    });
  }
  const recordedDimension = Number(raw);
  if (!Number.isInteger(recordedDimension) || recordedDimension <= 0) {
    return Object.freeze({
      verdict: "unrecorded" as const,
      reason: `index_state records ${EMBEDDING_DIMENSION_STATE_KEY} as "${raw}", which is not a dimension`,
    });
  }

  const stored = storedDimensions(db);
  const declared = vecDeclaredWidth(db);
  const observations: ReadonlyArray<DimensionObservation> = [
    ...stored.map((dimension) => ({ key: `embeddings.dimension=${dimension}`, dimension })),
    ...(declared === null
      ? []
      : [{ key: `chunk_vec.embedding float[${declared}]`, dimension: declared }]),
  ];
  if (observations.length === 0) {
    return Object.freeze({
      verdict: "unrecorded" as const,
      reason: "the index holds no stored vectors and no vector table to compare the record against",
    });
  }

  const missing = observations.filter((o) => o.dimension !== recordedDimension).map((o) => o.key);
  const reconciliation = buildReconciliationReport({
    attempted: observations.length,
    found: observations.length - missing.length,
    missing,
  });
  // What the record ASSERTS about these same observations: that every
  // one of them was written at the dimension it names. Handing that
  // claim to the shared derivation is what makes a disagreement come
  // back as `contradicted` - the record is wrong - rather than as a
  // plain shortfall in what was found.
  const outcome = deriveReconciliationOutcome(reconciliation, {
    attempted: observations.length,
    found: observations.length,
  });

  return Object.freeze({
    verdict: "audited" as const,
    recordedDimension,
    storedDimensions: Object.freeze([...stored]),
    vecDeclaredWidth: declared,
    reconciliation,
    outcome,
  });
}

/**
 * {@link auditEmbedderRecord} for an index path, without opening a
 * `Store` - the same seam `readEmbeddingAbiSync` uses, and for the same
 * reason: `indexCheck` probes an in-memory database and never touches
 * the real index otherwise.
 *
 * An absent or unreadable index folds into the UNRECORDED arm with the
 * reason the open gave. It is not a clean audit: nothing was compared.
 */
export function readEmbedderRecordCensusSync(dbPath: string): EmbedderRecordCensus {
  const peek = peekReadonlyIndex(dbPath, auditEmbedderRecord);
  if (peek.kind === "read") return peek.value;
  return Object.freeze({
    verdict: "unrecorded" as const,
    reason:
      peek.kind === "absent"
        ? `no search index at ${dbPath}`
        : `${dbPath} did not open: ${peek.detail}`,
  });
}

/**
 * One operator-facing line for a record the data contradicts, or `null`
 * when the audit found no contradiction to describe. Shared by the
 * `search check` warning and its recommendation so the two cannot word
 * one finding differently or name different repairs.
 *
 * The repair is the full rebuild, not the restamp verb: a recorded
 * dimension the stored vectors disprove cannot be corrected by writing
 * a different number over it - the vectors would still be whatever
 * width they are, and the record would still be a claim nobody checked.
 */
export function formatEmbedderRecordContradiction(census: EmbedderRecordCensus): string | null {
  if (census.verdict !== "audited") return null;
  if (census.outcome !== RECONCILIATION_OUTCOME.contradicted) return null;
  return (
    `the index records embedding dimension ${census.recordedDimension}, and the vectors it ` +
    `holds contradicts that record (${census.reconciliation.missing.join("; ")}); the ` +
    `recorded identity is evidence of nothing about the stored vectors. Run: ` +
    `${EMBEDDING_ABI_FIX_COMMAND}`
  );
}

/**
 * Source documents whose chunks the active embedding configuration holds
 * back (chunk skip-and-hold, F2, task B4).
 *
 * A held chunk is deliberately invisible to every SURFACE THAT COUNTS
 * WORK: it leaves the pending-vector census, the refresh estimate and
 * the backfill, because the index does not owe it a vector. That is
 * right for spend and wrong for awareness - nothing told an operator
 * which source documents carry chunks the configured model provably
 * cannot take. This check is that telling, from the doctor pass an
 * operator already runs.
 *
 * ## One warning per affected document
 *
 * The chunk is where the hold lands but the DOCUMENT is where the repair
 * lands: the levers - narrower chunking, or leaving the page unembedded -
 * are decisions about a page, not about its twenty-third chunk. So the
 * finding aggregates per document, naming the count, the largest single
 * estimate and the window the proof ran against.
 *
 * ## What is silence here, and where the same state speaks instead
 *
 *   - nothing held under the ACTIVE key - the honest absence; rows whose
 *     key a config change released are decisions this configuration does
 *     not make;
 *   - a configuration that can hold nothing (no model, no declared
 *     window, a local provider) - there is no proof this model could
 *     have run;
 *   - an index that could not be read at all - the embeddings-health
 *     check beside this one already reports that file as census-
 *     unrecorded or unmeasured, and a second uncertain stream for the
 *     same read failure is what its docblock refuses.
 *
 * A page the caller may not read is not named and does not move a count
 * (`ctx.readable`, the contract every other counting check follows).
 *
 * The check is strictly read-only: one synchronous peek at the index
 * file, no provider contact.
 */

import { resolveSearchConfig } from "../../search/index.ts";
import { chunkHoldExclusion } from "../../search/embedding-spend.ts";
import {
  heldChunkDocCensus,
  type ChunkHoldExclusion,
  type HeldChunkDocRow,
} from "../../search/store/chunks.ts";
import { withReadonlyIndex } from "../../search/store/state.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";

/** Indexed documents carry chunks held back from embedding. */
export const CHUNK_HOLDS_ACTIVE_CODE = "chunk-holds-active";

export type { ChunkHoldExclusion, HeldChunkDocRow };

/**
 * The seam the check reads through: the documents holding chunks under
 * `hold`, or `null` when the index could not be read. A test injects any
 * snapshot without building an index.
 */
export type ChunkHoldsProbe = (
  dbPath: string,
  hold: ChunkHoldExclusion,
) => HeldChunkDocRow[] | null;

/** The default probe: one synchronous read-only peek at the index. */
function indexProbe(dbPath: string, hold: ChunkHoldExclusion): HeldChunkDocRow[] | null {
  return withReadonlyIndex(dbPath, (_read, db) => heldChunkDocCensus(db, hold));
}

function holdMessage(row: HeldChunkDocRow, hold: ChunkHoldExclusion): string {
  return (
    `${row.heldChunks} chunk(s) in this document are held back from embedding as provably ` +
    `over the declared input window of ${hold.model}: the largest single-chunk estimate is ` +
    `${row.maxEstimatedTokens} tokens against a ${hold.windowTokens}-token window. The page ` +
    "still searches lexically and is never sent to the embedding provider; narrowing the " +
    "chunking (search_chunk_size) or leaving the page unembedded are the ways to change the " +
    "outcome, both per-document decisions. `o2b search status` lists the held chunks."
  );
}

/**
 * Build the check against `probe`, following `makeEmbeddingsHealthCheck`:
 * the index facts are data the check reads rather than logic it owns.
 */
export function makeChunkHoldsCheck(probe: ChunkHoldsProbe = indexProbe): DoctorCheck {
  return {
    failSoft: true,
    run(ctx: DoctorCheckContext, out: DoctorFindings): void {
      let search;
      try {
        search = resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath });
      } catch {
        // The embeddings-health check resolves the same configuration
        // from the same context and reports its failure there, by name.
        // Naming the one condition twice would be two findings for it.
        return;
      }
      if (!search.semantic.enabled || search.semantic.provider === "disabled") return;

      // The index the pass was pointed at wins over the one the search
      // configuration names, so the probe reads the file the rest of the
      // pass speaks about.
      const dbPath = ctx.dbPath ?? search.dbPath;
      // Null when no chunk can be proved over anything - no model or no
      // declared window - and a configuration that could not hold is not
      // a configuration whose holds are missing.
      const hold = chunkHoldExclusion(search);
      if (hold === null) return;

      const docs = probe(dbPath, hold);
      if (docs === null) return;
      const readable =
        ctx.readable === undefined ? docs : docs.filter((doc) => ctx.readable!(doc.path));
      for (const doc of readable) {
        out.issues.push({
          severity: "warning",
          code: CHUNK_HOLDS_ACTIVE_CODE,
          path: doc.path,
          message: holdMessage(doc, hold),
        } satisfies DoctorIssue);
      }
    },
  };
}

/** The registered instance, reading the live index. */
export const chunkHoldsCheck: DoctorCheck = makeChunkHoldsCheck();

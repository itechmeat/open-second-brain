/**
 * Outcome assembly: the evidence pack and its terminal-state downrank,
 * the opt-in access recording, the opt-in trust metadata, the retrieval
 * trail, and the two surfaced shapes (full rows or
 * progressive-disclosure cards).
 *
 * The only place a `SearchOutcome` is constructed, so the optional fields
 * are omitted from exactly one set of rules - which is why the retrieval
 * trail is assembled here rather than at either surface.
 */

import { ACCESS_EVENT_PATHS_CAP, recordAccessEvent } from "../activation/store.ts";
import { toSearchCard } from "../cards.ts";
import { classifyNegativeRecall } from "../../brain/negative-recall.ts";
import { buildEvidencePack, downrankTerminalEvidenceResults } from "../evidence-pack.ts";
import { buildRetrievalTrail, corpusStatementFor } from "../retrieval-trail.ts";
import { buildEvidenceVerification } from "../evidence-verification.ts";
import { fnv1aHex } from "../feedback.ts";
import {
  attachTrustMetadata,
  buildTerminalPaths,
  type FrontmatterCache,
} from "../result-filters.ts";
import type {
  CoverageIndexSnapshot,
  CoverageScope,
  NegativeRecallVerdict,
} from "../../brain/negative-recall.ts";
import type { RetrievalCorpusStatement, RetrievalDegradation } from "../retrieval-trail.ts";
import type { TrustReceipts } from "./post-rank.ts";
import type { Store } from "../store.ts";
import type {
  BrainSearchResult,
  QuerySurface,
  ResolvedSearchConfig,
  SearchOptions,
  SearchOutcome,
} from "../types.ts";

const NO_RESULTS: ReadonlyArray<BrainSearchResult> = Object.freeze([]);

export interface EmptyOutcomeInput {
  readonly store: Store;
  readonly opts: SearchOptions;
  /** Residual query text. */
  readonly query: string;
  readonly pathPrefix: string | undefined;
  readonly warnings: ReadonlyArray<string>;
  readonly routedSurface: QuerySurface;
  /** Every narrowing the lanes recorded on the way to zero candidates. */
  readonly degraded: ReadonlyArray<RetrievalDegradation>;
  /**
   * The corpus statement, when the caller probed for one. Null when a
   * degradation already accounts for the empty, which is the only case
   * where the probe is skipped.
   */
  readonly corpus: RetrievalCorpusStatement | null;
}

/** The zero-candidate outcome: no pool to rank, filter or attribute. */
export function emptyOutcome(input: EmptyOutcomeInput): SearchOutcome {
  const evidencePack =
    input.opts.evidencePack === true
      ? buildEvidencePack(
          input.query,
          [],
          buildEvidenceVerification(input.store, input.query, [], input.pathPrefix),
        )
      : undefined;
  // A zero-candidate outcome is always attributable: either a lane
  // narrowed the query away, or the corpus statement answers for it.
  const retrievalTrail = buildRetrievalTrail({
    retrieved: 0,
    pool: 0,
    degraded: input.degraded,
    empty: input.corpus ?? undefined,
  });
  return Object.freeze({
    results: NO_RESULTS,
    warnings: Object.freeze(input.warnings),
    total: 0,
    ...(evidencePack !== undefined ? { evidencePack } : {}),
    ...(input.routedSurface === "summary" ? { surface: input.routedSurface } : {}),
    ...(retrievalTrail !== undefined ? { retrievalTrail } : {}),
  });
}

export interface OutcomeInput {
  readonly store: Store;
  readonly config: ResolvedSearchConfig;
  readonly opts: SearchOptions;
  /** Residual query text. */
  readonly query: string;
  readonly pathPrefix: string | undefined;
  readonly results: ReadonlyArray<BrainSearchResult>;
  /** Mutable: access recording appends its own failure warning. */
  readonly warnings: string[];
  readonly secondPass: SearchOutcome["secondPass"];
  readonly routedSurface: QuerySurface;
  readonly trustReceipts: TrustReceipts | null;
  readonly frontmatterCache: FrontmatterCache;
  /**
   * Size of the ranked pool the caller's `limit` sliced `results` out of
   * (what-the-index-already-knew, task F). Reported inline as `total`:
   * it is the only place the outcome says how many candidates were
   * ranked and then dropped, and it is a property of the answer rather
   * than a diagnostic, so no flag gates it. Always >= `results.length`,
   * because the results ARE its prefix.
   */
  readonly poolSize: number;
  /**
   * Typed degradations collected across the lanes, the counterpart of
   * `warnings`. Mutable because it is the same sink every lane pushed into
   * on the way here; nothing in THIS module appends to it.
   *
   * In particular the access-recording failure below stays a warning and
   * gets no code. The vocabulary names what narrowed a RETRIEVAL, and that
   * failure is a write on the recording side, after ranking, over rows the
   * caller already has: giving it a code would tell a reader their answer
   * was cut short when it is exactly the answer the index holds - and
   * `searchTelemetryGaps` would file it as a recall gap.
   */
  readonly degraded: RetrievalDegradation[];
  /**
   * The corpus statement behind a zero-result answer, probed by the
   * caller only when the window came back empty with nothing degraded.
   * Null otherwise - including on every non-empty answer, which is what
   * keeps that path free of the index reads the probe performs.
   */
  readonly corpus: RetrievalCorpusStatement | null;
}

export function buildSearchOutcome(input: OutcomeInput): SearchOutcome {
  const { config, opts, query, warnings } = input;
  // Terminal-state downrank (recall-trust-suite) is structural and
  // language-agnostic: a result is terminal when its frontmatter
  // `status:` field declares a terminal value (controlled vocabulary),
  // never because the note's prose happens to contain an English word
  // like "done". One cached frontmatter read per candidate path, only
  // in evidence-pack mode.
  const wantsEvidencePack = opts.evidencePack === true;
  const terminalPaths = wantsEvidencePack
    ? buildTerminalPaths(config.vault, input.results, input.frontmatterCache)
    : new Set<string>();
  const finalResults = wantsEvidencePack
    ? downrankTerminalEvidenceResults(input.results, terminalPaths)
    : input.results;
  const evidencePack = wantsEvidencePack
    ? buildEvidencePack(
        query,
        finalResults,
        buildEvidenceVerification(input.store, query, finalResults, input.pathPrefix),
        terminalPaths,
      )
    : undefined;

  // Access recording (Time-Aware Recall & Activation Suite): the
  // orchestrator edge opted in, so persist which documents this query
  // surfaced - AFTER ranking, so the current query is never affected
  // by its own recording. Cache hits return earlier and never reach
  // this point. Best-effort: a failed write never breaks the search.
  if (opts.recordAccess === true && config.recall.activationEnabled && finalResults.length > 0) {
    const surfacedPaths = Array.from(new Set(finalResults.map((r) => r.path))).slice(
      0,
      ACCESS_EVENT_PATHS_CAP,
    );
    const normalized = query.trim().replace(/\s+/gu, " ").toLowerCase();
    try {
      recordAccessEvent(config.vault, {
        ts: Date.now(),
        queryHash: fnv1aHex(normalized),
        paths: surfacedPaths,
      });
    } catch {
      warnings.push("activation: failed to record access event");
    }
  }

  // Inline trust metadata (Search & Recall Quality Suite): opt-in,
  // computed at read time from the document mtime and the surfaced
  // typed relations, never stored. Off by default keeps the result
  // shape byte-identical.
  const resultsOut =
    opts.trust === true ? attachTrustMetadata(config.vault, finalResults) : finalResults;

  const retrievalTrail = buildRetrievalTrail({
    retrieved: resultsOut.length,
    pool: input.poolSize,
    degraded: input.degraded,
    empty: input.corpus ?? undefined,
  });

  const tail = {
    ...(retrievalTrail !== undefined ? { retrievalTrail } : {}),
    ...(evidencePack !== undefined ? { evidencePack } : {}),
    ...(input.secondPass !== undefined ? { secondPass: input.secondPass } : {}),
    ...(input.routedSurface === "summary" ? { surface: input.routedSurface } : {}),
    ...input.trustReceipts,
  };

  // Progressive disclosure (D3): layer 1. When the caller opts into
  // `cards`, project the SAME ranked rows into token-cheap cards and
  // return them on `cards` with an empty `results`. The ranking,
  // filtering, and evidence pack are computed identically to full mode -
  // only the surfaced depth differs - so the contract stays
  // deterministic and the default `full` path is byte-identical.
  if ((opts.disclosure ?? "full") === "cards") {
    // The residual query text anchors each card's snippet window on the
    // match instead of the head of the chunk (task E).
    const cards = resultsOut.map((result) => toSearchCard(result, query));
    return Object.freeze({
      results: NO_RESULTS,
      cards: Object.freeze(cards),
      warnings: Object.freeze(warnings),
      total: input.poolSize,
      ...tail,
    });
  }

  return Object.freeze({
    results: Object.freeze(resultsOut),
    warnings: Object.freeze(warnings),
    total: input.poolSize,
    ...tail,
  });
}

/**
 * Both root sets unresolved. Handed to the classifier when the index facts
 * could not be read at all, which it reports as
 * `unknown`/`coverage-unavailable` - deliberately not as an absent index
 * and never as an exhaustively searched one.
 */
const UNRESOLVED_COVERAGE_SCOPE: CoverageScope = Object.freeze({
  authorizedRoots: Object.freeze([]),
  indexedRoots: Object.freeze([]),
});

/**
 * The corpus statement behind a zero-result retrieval.
 *
 * Gathers the two universes the verdict is judged against - what the index
 * holds and which authorized note roots it actually reached - and hands
 * them to the pure classifier in `brain/negative-recall.ts`, which has
 * implemented this contract since the silence-is-not-an-answer wave and
 * reached exactly one surface: the recall gate. Lifted here so the search
 * pipeline, and through it both the CLI and the MCP tool, can give the
 * same answer instead of an unexplained empty array.
 *
 * Every read is attempted before anything is committed to, so a failure
 * anywhere leaves BOTH inputs unresolved rather than half-resolved: a
 * partially gathered picture is exactly the material a misleading
 * `not_found` would be built from. The failure is not swallowed either -
 * it surfaces as the named `coverage-unavailable` reason.
 *
 * The config arrives as a thunk because its two callers hold it
 * differently: the pipeline already has the resolved, override-carrying
 * config for the index it just searched, while the recall gate has only a
 * vault and a config path and must resolve one. Resolving inside the guard
 * keeps a config failure reported the same way as every other read
 * failure, which is what a caller-side resolve would lose.
 *
 * The index reads are deferred imports: `indexer.ts` and the note walker
 * sit above this module in the graph, and the sanctioned cure for that in
 * this tree is an import evaluated at call time. It is called only on the
 * zero-result path, so the cost lands where the answer is owed.
 */
export async function probeRetrievalCorpus(
  resolveConfig: () => ResolvedSearchConfig,
): Promise<NegativeRecallVerdict> {
  let snapshot: CoverageIndexSnapshot | null = null;
  let scope: CoverageScope = UNRESOLVED_COVERAGE_SCOPE;
  try {
    const { indexRootCoverage, indexStatus } = await import("../indexer.ts");
    const { resolveNoteRoots } = await import("../../brain/notes/note-walk.ts");
    const config = resolveConfig();
    const status = await indexStatus(config);
    const authorizedRoots = resolveNoteRoots(config.vault);
    // Skip the second open when there is nothing it could answer: no
    // index to read, or no note root the operator authorized.
    const indexedRoots =
      status.exists && authorizedRoots.length > 0
        ? (await indexRootCoverage(config, authorizedRoots)).rootsWithDocuments
        : [];
    snapshot = status;
    scope = { authorizedRoots, indexedRoots };
  } catch {
    // Deliberately empty: the unresolved defaults above ARE the report.
  }
  return classifyNegativeRecall({ snapshot, scope });
}

/**
 * The corpus statement a zero-result window owes, or `null` when it owes
 * none. One decision point for both outcome shapes: a window with rows in
 * it has nothing to explain, and a window a degradation already accounts
 * for would be over-claiming if it also stated what the corpus holds.
 */
export async function corpusStatementForEmptyWindow(
  resolveConfig: () => ResolvedSearchConfig,
  retrieved: number,
  degraded: ReadonlyArray<RetrievalDegradation>,
): Promise<RetrievalCorpusStatement | null> {
  if (retrieved > 0 || degraded.length > 0) return null;
  return corpusStatementFor(await probeRetrievalCorpus(resolveConfig));
}

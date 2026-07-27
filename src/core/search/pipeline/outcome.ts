/**
 * Outcome assembly: the evidence pack and its terminal-state downrank,
 * the opt-in access recording, the opt-in trust metadata, and the two
 * surfaced shapes (full rows or progressive-disclosure cards).
 *
 * The only place a `SearchOutcome` is constructed, so the optional fields
 * are omitted from exactly one set of rules.
 */

import { ACCESS_EVENT_PATHS_CAP, recordAccessEvent } from "../activation/store.ts";
import { toSearchCard } from "../cards.ts";
import { buildEvidencePack, downrankTerminalEvidenceResults } from "../evidence-pack.ts";
import { buildEvidenceVerification } from "../evidence-verification.ts";
import { fnv1aHex } from "../feedback.ts";
import {
  attachTrustMetadata,
  buildTerminalPaths,
  type FrontmatterCache,
} from "../result-filters.ts";
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
  return Object.freeze({
    results: NO_RESULTS,
    warnings: Object.freeze(input.warnings),
    total: 0,
    ...(evidencePack !== undefined ? { evidencePack } : {}),
    ...(input.routedSurface === "summary" ? { surface: input.routedSurface } : {}),
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

  const tail = {
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
    const cards = resultsOut.map(toSearchCard);
    return Object.freeze({
      results: NO_RESULTS,
      cards: Object.freeze(cards),
      warnings: Object.freeze(warnings),
      total: cards.length,
      ...tail,
    });
  }

  return Object.freeze({
    results: Object.freeze(resultsOut),
    warnings: Object.freeze(warnings),
    total: resultsOut.length,
    ...tail,
  });
}

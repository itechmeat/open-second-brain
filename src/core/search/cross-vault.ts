/**
 * Cross-vault union search (Workspace Insight Suite, t_72a22658).
 *
 * Fans one query out over every search origin - the active vault,
 * registered profile vaults, and read-only recall sources - and merges
 * the per-origin outcomes into one result list ordered by score.
 * Every result carries its origin label both as an additive `origin`
 * field and as an `origin:<label>` entry riding the existing
 * `reasons[]` mechanism.
 *
 * Read-only invariants concentrate here:
 *   - non-active origins search with `selfHeal: false`, so a missing
 *     or stale index is NEVER rebuilt inside an external vault;
 *   - non-active origins search with the query cache disabled, so no
 *     cache rows are written into an external index;
 *   - a failing origin (no index, schema mismatch, unreadable store)
 *     contributes a `[label] ...` warning and one typed trail entry,
 *     never an error and never the failure's own message.
 *
 * Scores merge as-is: every origin runs the same ranking pipeline with
 * the same options, which keeps them comparable enough for a first
 * version; the origin label makes any skew diagnosable per result.
 */

import { resolve } from "node:path";

import { ORIGIN_REACH, ORIGIN_REACH_REASON } from "../brain/portability/origin-reach.ts";
import { listSearchOrigins } from "../brain/portability/origins.ts";
import { resolveSearchConfig } from "./index.ts";
import { RETRIEVAL_DEGRADATION, buildRetrievalTrail, noteDegradation } from "./retrieval-trail.ts";
import { search } from "./search.ts";
import { readActiveSessionFocus } from "./session-focus.ts";
import { SearchError } from "./types.ts";
import type {
  RetrievalCorpusStatement,
  RetrievalDegradation,
  RetrievalDegradationSink,
} from "./retrieval-trail.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchCard,
  SearchOptions,
  SearchOutcome,
} from "./types.ts";

function labelled(result: BrainSearchResult, label: string): BrainSearchResult {
  return Object.freeze({
    ...result,
    origin: label,
    reasons: Object.freeze([...result.reasons, `origin:${label}`]),
  });
}

/** Cards mirror results: same origin label, same `origin:<label>` reason. */
function labelledCard(card: SearchCard, label: string): SearchCard {
  return Object.freeze({
    ...card,
    origin: label,
    reasons: Object.freeze([...card.reasons, `origin:${label}`]),
  });
}

/**
 * What a union reports instead of an origin's own message.
 *
 * The message never crosses this boundary: it can name the external index
 * file and it travels verbatim into logs and MCP payloads - the rule
 * `store/trigram.ts` documents for the identical channel. What survives is
 * the part that diagnoses without disclosing: `SearchError.code`, which is
 * already a closed vocabulary, and one fix that is the same for every way
 * an external index can refuse to open.
 */
const ORIGIN_UNREACHABLE_UNCLASSIFIED = "unclassified";
const ORIGIN_UNREACHABLE_FIX = "run: o2b search check against that vault";

/**
 * The fix for an origin that was never opened at all. Deliberately not the
 * one above: `o2b search check` inspects an index, and there is no index to
 * inspect when the vault directory itself could not be read. The path stays
 * out of the sentence for the same reason it does everywhere on this
 * channel - the label is the actionable part and the reason says which
 * repair applies.
 */
const ORIGIN_UNREACHABLE_REGISTRY_FIX = "check the origin's registered vault path";

/** The fields the merge order reads - shared by results and cards. */
interface MergeKey {
  readonly score: number;
  readonly origin?: string;
  readonly path: string;
  readonly chunkId: number;
}

/** Deterministic merge order: score desc, then label, path, chunk id. */
function compareMerged(a: MergeKey, b: MergeKey): number {
  if (a.score !== b.score) return b.score - a.score;
  const al = a.origin ?? "";
  const bl = b.origin ?? "";
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.chunkId - b.chunkId;
}

export async function searchAcrossVaults(
  configPath: string,
  activeVault: string,
  opts: SearchOptions,
  /**
   * Caller-resolved config for the ACTIVE origin (preserves CLI
   * overrides like --db / --keyword-weight in global mode). Non-active
   * origins always resolve fresh: per-vault overrides such as a dbPath
   * would point at the wrong index there.
   */
  activeConfig?: ResolvedSearchConfig,
): Promise<SearchOutcome> {
  const origins = listSearchOrigins(configPath, activeVault);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
  // Cards mode (disclosure: "cards") puts each origin's hits on `outcome.cards`
  // and leaves `outcome.results` empty; full mode is the reverse. Merge the
  // collection this mode populates and mirror single-vault return semantics.
  const cardsMode = opts.disclosure === "cards";
  const merged: BrainSearchResult[] = [];
  const mergedCards: SearchCard[] = [];
  const warnings: string[] = [];
  const degraded: RetrievalDegradationSink = [];
  // Only the ACTIVE origin's corpus statement is adopted below: the union's
  // other origins are read-only sources whose index state is not the
  // question an operator asks when their own vault answers nothing.
  let activeCorpus: RetrievalCorpusStatement | null = null;
  let total = 0;
  // Match quality of the union, folded from the origins that answered.
  //
  // Starts at `null` - unmeasurable - and becomes a number the moment any
  // origin returns one. Not zero: zero is the claim "the union covered
  // nothing of the query", and before an origin has answered, and for a
  // query no origin could weigh at all, that claim has not been earned
  // either. A union in which every origin FAILED is a different thing
  // again, and it reads null too: nothing measured it. Reporting a full
  // cover for any of these would be the exact over-claim the confidence
  // thresholds downstream now depend on not making.
  let unionCoverage: number | null = null;

  // Session focus resolves ONCE in the active-vault context: otherwise
  // each origin would load ITS OWN persisted search-focus state and
  // filter its slice of the union differently.
  let sessionFocus = opts.sessionFocus;
  if (sessionFocus === undefined) {
    try {
      const focusConfig =
        activeConfig ?? resolveSearchConfig({ vault: resolve(activeVault), configPath });
      sessionFocus = readActiveSessionFocus(focusConfig, opts.focusSession, Date.now());
    } catch {
      sessionFocus = null;
    }
  }

  // Normalized-confidence chain-stop policy is an active-origin decision
  // (t_23c1b929): the active vault's resolved config governs whether and
  // when the union short-circuits. External origins resolve fresh and their
  // own knob never gates the union. Resolved once, before the loop.
  const activeRecall = (
    activeConfig ?? resolveSearchConfig({ vault: resolve(activeVault), configPath })
  ).recall;

  let chainStop: SearchOutcome["chainStop"];

  // Origins run sequentially: each opens its own SQLite store, and a
  // handful of local index reads gains nothing from interleaving.
  for (let i = 0; i < origins.length; i++) {
    const origin = origins[i]!;
    const isActive = origin.kind === "active";
    // An origin that could not be read is REPORTED, never dropped: it was
    // dropped one layer up until this release, which made a dead origin
    // indistinguishable from one that honestly held no match. `unreachable`
    // and `unknown` both land here, each carrying its own reason, because
    // "it is not there" and "I could not look" have different repairs.
    if (origin.reach !== ORIGIN_REACH.reachable) {
      const cause = origin.reason ?? ORIGIN_REACH_REASON.vaultUnreadable;
      warnings.push(
        `[${origin.label}] origin not searched [${cause}]: ${ORIGIN_UNREACHABLE_REGISTRY_FIX}`,
      );
      noteDegradation(degraded, RETRIEVAL_DEGRADATION.crossVaultOriginFailed, {
        origin: origin.label,
        cause,
      });
      continue;
    }
    try {
      const base =
        isActive && activeConfig !== undefined
          ? activeConfig
          : resolveSearchConfig({ vault: origin.vault, configPath });
      // Never write cache rows into a read-only external index.
      const config = isActive
        ? base
        : Object.freeze({
            ...base,
            recall: Object.freeze({ ...base.recall, cacheEnabled: false }),
          });
      // eslint-disable-next-line no-await-in-loop -- per-origin stores, sequential by design
      const outcome = await search(config, {
        ...opts,
        sessionFocus,
        limit,
        ...(isActive ? {} : { selfHeal: false }),
      });
      merged.push(...outcome.results.map((result) => labelled(result, origin.label)));
      if (outcome.cards !== undefined) {
        mergedCards.push(...outcome.cards.map((card) => labelledCard(card, origin.label)));
      }
      warnings.push(...outcome.warnings.map((warning) => `[${origin.label}] ${warning}`));
      mergeOriginDegradations(degraded, outcome.retrievalTrail?.degraded ?? []);
      if (isActive && outcome.retrievalTrail?.empty !== undefined) {
        activeCorpus = outcome.retrievalTrail.empty;
      }
      total += outcome.total;
      // The union's own match quality. Taking the MAX over the origins is
      // the conservative fold: the merged window is a superset of any one
      // origin's rows, so its true coverage is at least the best origin's
      // and never less. Summing or averaging would invent a number no
      // origin measured. An origin that could not measure the query
      // contributes nothing to the fold - it is skipped, not read as a
      // zero, because a zero would drag a max nowhere but would read as a
      // measurement if it were the only origin.
      const originCoverage = outcome.idfWeightedCoverage;
      if (originCoverage !== null) {
        unionCoverage =
          unionCoverage === null ? originCoverage : Math.max(unionCoverage, originCoverage);
      }
      // Chain-stop: if this origin answered the QUESTION - covered the
      // query's IDF mass to the configured share - and origins remain,
      // skip them.
      //
      // It used to read the origin's top result score, which meant two
      // different things under the two fusion modes and neither of them
      // "answered confidently": in `linear` mode the keyword lane's
      // min-max normalisation puts the top row of any origin with a
      // non-empty keyword lane at or above `keywordWeight`
      // (`DEFAULT_KEYWORD_WEIGHT`, plus whichever boost layers fired -
      // 0.65 measured on a freshly written keyword-only vault), so the
      // shipped 0.8 threshold was out of reach there and the chain never
      // stopped; in `rrf` mode the fused lane is min-max normalised to
      // exactly 1.0 at the top, so the same 0.8 was met by every
      // non-empty origin and the chain always stopped after the first.
      // `idfWeightedCoverage` measures the match rather than the pool's
      // shape, so the knob now means one thing in both modes - and 0.8 is
      // the share `COMPLETENESS_COMPLETE_THRESHOLD` already calls a
      // complete retrieval. Only recorded when origins were actually
      // skipped, keeping the single-origin and never-triggered paths
      // identical.
      //
      // An origin whose coverage is unmeasurable never stops the chain:
      // "I could not weigh this query" is not "I answered it", and
      // treating the two alike is what the old `totalIdf === 0 ? 1`
      // shortcut did - it would have stopped the chain on the FIRST
      // origin for every query the report could not weigh.
      const remaining = origins.slice(i + 1);
      // Gate on whichever collection THIS mode populates: in cards mode results
      // is empty, so reading it would never short-circuit (the latent bug).
      const hits: ReadonlyArray<{ readonly score: number }> = cardsMode
        ? (outcome.cards ?? [])
        : outcome.results;
      if (
        activeRecall.chainStopEnabled &&
        remaining.length > 0 &&
        hits.length > 0 &&
        originCoverage !== null &&
        originCoverage >= activeRecall.chainStopScore
      ) {
        chainStop = Object.freeze({
          triggered: true as const,
          stoppedAfter: origin.label,
          skipped: Object.freeze(remaining.map((o) => o.label)),
        });
        // Origins deliberately not searched are a narrowing of the answer,
        // whatever the reason: until now `chainStop` rode the outcome and
        // no surface read it.
        noteDegradation(degraded, RETRIEVAL_DEGRADATION.crossVaultChainStopped, {
          stoppedAfter: origin.label,
          skipped: remaining.length,
        });
        break;
      }
    } catch (exc) {
      // The failure's own message never crosses this boundary. It can name
      // the external index file and it is echoed verbatim into MCP
      // payloads and logs - the rule `store/trigram.ts` documents for the
      // identical channel. The origin label is the actionable part, and
      // the trail carries the same fact as a code. (`exc` was also cast to
      // `Error` unchecked, which a thrown string would have walked past.)
      const cause = exc instanceof SearchError ? exc.code : ORIGIN_UNREACHABLE_UNCLASSIFIED;
      warnings.push(`[${origin.label}] origin not searched [${cause}]: ${ORIGIN_UNREACHABLE_FIX}`);
      noteDegradation(degraded, RETRIEVAL_DEGRADATION.crossVaultOriginFailed, {
        origin: origin.label,
        cause,
      });
    }
  }

  merged.sort(compareMerged);
  mergedCards.sort(compareMerged);
  const surfaced = cardsMode ? Math.min(mergedCards.length, limit) : Math.min(merged.length, limit);
  const retrievalTrail = buildRetrievalTrail({
    retrieved: surfaced,
    pool: total,
    degraded,
    empty: activeCorpus ?? undefined,
  });
  return Object.freeze({
    // Cards mode mirrors single-vault semantics: hits ride `cards`, `results`
    // is empty. Full mode is byte-identical to before (no `cards` key).
    results: cardsMode ? Object.freeze([]) : Object.freeze(merged.slice(0, limit)),
    ...(cardsMode ? { cards: Object.freeze(mergedCards.slice(0, limit)) } : {}),
    warnings: Object.freeze(warnings),
    // Sum of per-origin totals - informational, mirrors single-vault
    // semantics where `total` can exceed the capped result/card length.
    total,
    idfWeightedCoverage: unionCoverage,
    ...(chainStop ? { chainStop } : {}),
    ...(retrievalTrail !== undefined ? { retrievalTrail } : {}),
  });
}

/**
 * Fold one origin's codes into the union's trail, at most once each.
 *
 * A union answers for many origins, and the same code repeated per origin
 * says nothing new about the union while its `detail` integers are
 * per-origin counts that do not sum. The first occurrence keeps its
 * detail, so the trail states what happened without inventing an
 * aggregate nobody measured.
 */
function mergeOriginDegradations(
  sink: RetrievalDegradationSink,
  originDegradations: ReadonlyArray<RetrievalDegradation>,
): void {
  const seen = new Set(sink.map((d) => d.code));
  for (const degradation of originDegradations) {
    if (seen.has(degradation.code)) continue;
    seen.add(degradation.code);
    sink.push(degradation);
  }
}

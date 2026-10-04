/**
 * Bounded, fail-closed, audited prompt-time recall (theme A, t_2ce46130).
 *
 * The pure decision core behind the opt-in UserPromptSubmit recall-inject
 * hook. Given a user prompt and a retriever, it decides whether to inject a
 * small bounded brief of relevance-matched vault notes, to abstain (the
 * prompt is empty, nothing matched, or the top match is below the
 * confidence floor), or to report an error (the retriever threw or blew the
 * fixed time budget). Every outcome is an EXPLICIT, audit-worthy decision -
 * an abstain is a deliberate, recorded choice, never a silent fallback.
 *
 * Deliberately I/O-free and retriever-agnostic: the caller supplies a
 * {@link RecallRetriever}, so the decision logic (caps, floor, time budget,
 * brief rendering) is unit-testable without a vault. {@link
 * defaultRecallRetriever} wires the existing cross-vault search (which
 * already consults every {@link RecallSource}); this module adds NO new
 * retriever. The brief's orientation line reuses {@link deriveRecallHint}
 * over {@link RecallHintInput}.
 */

import { deriveRecallHint, type RecallHintInput } from "../search/recall-hint.ts";
import { searchAcrossVaults } from "../search/cross-vault.ts";
import type { RecallSource } from "./portability/recall-sources.ts";
import { LOCAL_ORIGIN } from "./portability/origins.ts";
import { fenceUntrustedContent, neutralizeUntrustedText } from "./untrusted-source.ts";
import { RECALL_INJECT_ANY_MIN, RECALL_INJECT_NOTE_MIN } from "../decision-model/questions.ts";
import { estimateTokens } from "./text/tokenizer.ts";
import type { RecallSliceSpec } from "./types.ts";

/** `origin` label stamped on the recall brief's untrusted-content fence. */
const RECALL_FENCE_ORIGIN = "recall-inject";

/** Hard cap on notes carried in a single brief. */
export const RECALL_INJECT_MAX_NOTES = 4;

/** Hard cap on the rendered brief size, in characters. */
export const RECALL_INJECT_MAX_CHARS = 900;

/** Fixed wall-clock budget for the retrieval step, in milliseconds. */
export const RECALL_INJECT_TIME_BUDGET_MS = 2_500;

/**
 * Match-quality floor ([0,1]) below which the retrieved material is too
 * weak to be worth injecting, so the hook abstains.
 *
 * Compared against {@link RecallResultSet.idfWeightedCoverage} - the share
 * of the prompt's IDF mass the retrieved notes actually cover - and NOT
 * against a result score. A score cannot carry a floor here: the keyword
 * lane is min-max normalised within the candidate set, so whenever that
 * lane is non-empty the top row's score sits at or above the configured
 * `keywordWeight` (`DEFAULT_KEYWORD_WEIGHT`, 0.6; 0.65 measured on a
 * freshly written keyword-only vault) no matter how well it matched, and
 * the bottom row's at zero no matter how well IT matched.
 * Against that number this constant measured which rows the filter stack
 * had removed - it abstained hardest exactly when a visibility or owner
 * scope had just taken the pool's best row, which is the one moment the
 * survivors were still a genuine match.
 *
 * The value is unchanged at 0.35 because it is the quantity that was
 * wrong, not the bound: a brief is worth injecting once the notes cover
 * about a third of what was asked, which sits below
 * `COMPLETENESS_PARTIAL_THRESHOLD` (0.4) - this gate filters noise, it
 * does not demand a complete retrieval.
 */
export const RECALL_INJECT_CONFIDENCE_FLOOR = 0.35;

/** One relevance-matched note, narrowed to exactly what the brief needs. */
export interface RecallCandidate {
  readonly path: string;
  readonly title: string | null;
  /** Normalized recall score in [0,1]. */
  readonly score: number;
  readonly searchType: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Cross-vault origin label (a {@link RecallSource} alias), when present. */
  readonly origin?: RecallSource["alias"];
  /**
   * The matched chunk's text. Never rendered into the brief; read only by
   * the optional decision-model filter, which sends it (after the privacy
   * rules) when the `recall_inject` use is not `off`.
   */
  readonly content?: string;
}

/** A retriever's returned candidates plus the ranked pool they came from. */
export interface RecallResultSet {
  readonly candidates: ReadonlyArray<RecallCandidate>;
  readonly total: number;
  /**
   * Absolute match quality of this retrieval in `[0,1]`: the share of the
   * query's IDF mass the candidates cover
   * (`SearchOutcome.idfWeightedCoverage`). Required, so a retriever cannot
   * leave the floor with nothing to read and no consumer can fall back to
   * a rank position.
   *
   * `null` when the retrieval had no IDF mass to weigh - the prompt
   * carried no word characters, or the corpus is empty. Nullable rather
   * than optional for the same reason: an absent field would be a
   * retriever that forgot to report, and this is a retriever reporting
   * that there is nothing to report.
   */
  readonly idfWeightedCoverage: number | null;
}

/** Relevance retriever: maps a query to a candidate set. */
export type RecallRetriever = (query: string) => Promise<RecallResultSet>;

/** What one operator-declared slice narrows the default retrieval to. */
export interface RecallRetrieverFilter {
  readonly limit?: number;
  /** Vault-relative path prefix. */
  readonly pathPrefix?: string;
  /** Frontmatter `type` values; empty means no class filter. */
  readonly types?: ReadonlyArray<string>;
}

/** What one slice did in a sliced decision; names and counts only. */
export interface RecallSliceOutcome {
  readonly name: string;
  /**
   * `inject` means the slice's material cleared its floor and was not
   * already shown; `notes` can still be 0 when the global caps left it no
   * room. Any other value is the reason the slice was omitted.
   */
  readonly outcome: "inject" | RecallAbstainReason;
  readonly notes: number;
}

export interface RecallInjectOptions {
  readonly maxNotes?: number;
  readonly maxChars?: number;
  readonly timeBudgetMs?: number;
  readonly confidenceFloor?: number;
  /**
   * The optional decision-model filter (issue #213, Part 9). Absent (the
   * default, and whenever the `recall_inject` use is `off`) leaves every
   * decision exactly as it was. Consulted only on an `inject` decision,
   * inside what is left of {@link timeBudgetMs}.
   */
  readonly decisionFilter?: RecallInjectFilter;
  /**
   * Notes this session was already shown, as {@link recallInjectNoteKey} values
   * (origin, path and line span). Absent or empty filters nothing. Applied
   * after the floor check, so the set never moves a floor verdict.
   */
  readonly alreadyInjected?: ReadonlySet<string>;
  /**
   * Vault-relative paths the SessionStart digest actually emitted. Matched
   * on the path alone, any span, because the digest delivers whole notes,
   * and only for candidates from the active vault, the one the digest reads.
   */
  readonly activeDigestPaths?: ReadonlySet<string>;
  /**
   * Operator-declared slices, in declared order. Used only together with
   * {@link sliceRetriever}; absent or empty takes the single implicit
   * relevance slice through the `retriever` argument, byte for byte.
   */
  readonly slices?: ReadonlyArray<RecallSliceSpec>;
  /** Builds the retriever for one slice, asked for at most `limit` notes. */
  readonly sliceRetriever?: (slice: RecallSliceSpec, limit: number) => RecallRetriever;
  /** Clock for the time budget (tests). */
  readonly now?: () => number;
}

/** The two modes in which the decision-model filter runs at all. */
export type RecallInjectFilterMode = "shadow" | "enforce";

/** What the filter is asked: the prompt and the notes the brief carries. */
export interface RecallInjectFilterInput {
  readonly query: string;
  /** The notes actually rendered into today's brief, in brief order. */
  readonly notes: ReadonlyArray<RecallCandidate>;
  /**
   * What is left of the retrieval time budget. The filter spends at most
   * `min(decision_model_hook_budget_ms, remainingMs)`; the core also cuts
   * it off at `remainingMs`, so the total budget never grows.
   */
  readonly remainingMs: number;
}

/** The filter's answer for one brief; never a thrown error. */
export type RecallInjectFilterVerdict =
  /** Not active after all (e.g. no provider): no request, no field. */
  | { readonly status: "off" }
  /** Nothing could be sent (every note private or unresolvable). */
  | { readonly status: "not_sent"; readonly mode: RecallInjectFilterMode }
  | {
      readonly status: "ok";
      readonly mode: RecallInjectFilterMode;
      readonly latencyMs: number;
      /** `helps_<k>` per note in brief order; null when not sent or invalid. */
      readonly helps: ReadonlyArray<number | null>;
      /** Whether each note was sent at all. */
      readonly sent: ReadonlyArray<boolean>;
      /** `inject_any`; null when invalid. */
      readonly injectAny: number | null;
    }
  | {
      readonly status: "degraded";
      readonly mode: RecallInjectFilterMode;
      /** A decision-model degrade reason (closed set), for the local audit only. */
      readonly reason: string;
      readonly latencyMs: number;
    };

export interface RecallInjectFilter {
  readonly mode: RecallInjectFilterMode;
  run(input: RecallInjectFilterInput): Promise<RecallInjectFilterVerdict>;
}

/**
 * What the decision-model filter did to one decision. Numbers and closed
 * classifications only; never prompt or note text.
 */
export interface RecallInjectDecisionModelInfo {
  readonly mode: RecallInjectFilterMode;
  /** `ok` (an answer arrived), `not_sent`, or `degraded`. */
  readonly outcome: "ok" | "not_sent" | "degraded";
  /** The degrade reason; carried to the local audit line only. */
  readonly degradeReason?: string;
  /** Time the filter added to this prompt, in milliseconds. */
  readonly latencyMs: number;
  /** Notes removed from the brief (in shadow: notes enforce would remove). */
  readonly notesDropped: number;
  /** Whether the brief was withheld (in shadow: whether enforce would withhold it). */
  readonly abstained: boolean;
  /** Estimated brief tokens before and after enforcement; enforce only, when it changed. */
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  /** Brief characters removed in enforce; 0 otherwise. */
  readonly charsRemoved: number;
}

/**
 * Why the hook injected nothing.
 *
 * `unmeasurable_quality` is the fourth member and the one that is not a
 * judgement about the material: the floor reads a match quality, and for
 * a prompt with no IDF mass to weigh there is no quality to compare. The
 * hook abstains, because injecting on a measurement that did not happen
 * is the false fire the floor exists to prevent - but the reason says
 * which of the two it was, since the repairs differ (a weak match is a
 * corpus problem, an unmeasurable one is a prompt or an empty index).
 */
export type RecallAbstainReason =
  | "empty_prompt"
  | "no_matches"
  | "below_floor"
  | "unmeasurable_quality"
  /**
   * The optional decision-model filter, in enforce, judged that no note
   * would help (issue #213, Part 9). Only ever follows what would have
   * been an `inject`.
   */
  | "decision_model_abstain"
  /**
   * Every candidate that cleared the floor was already shown in this
   * session, by an earlier brief or by the SessionStart digest.
   */
  | "all_already_injected"
  /** Slices were declared and none of them placed a note in the brief. */
  | "all_slices_abstained";

/**
 * Why an attempt failed, as a closed vocabulary rather than as prose.
 *
 * The error decision used to carry the retriever's RAW `Error.message`,
 * and the hook copied it onto the recall-telemetry record - a synced
 * continuity payload that `brain_recall_telemetry` returns verbatim to a
 * model. A SQLite, store or config failure names the index file or the
 * config path, and the shared redactor strips secret-shaped tokens, not
 * paths. Every other producer in this tree already refuses exactly that:
 * the trigram lane classifies its fault to a code, cross-vault replaces
 * a failing origin's message with one, and the semantic phase carries a
 * category.
 *
 * Three members because three things can fail, and each has a different
 * repair: the corpus is too slow, the retriever is broken, or the host
 * killed the hook before either could answer. The message itself is not
 * discarded - it rides on {@link RecallInjectDecision.detail}, which
 * only the local audit file is allowed to read.
 */
export const RECALL_INJECT_FAULT = Object.freeze({
  /** Retrieval outlived {@link RECALL_INJECT_TIME_BUDGET_MS}. */
  timeout: "timeout",
  /** The retriever threw; `detail` carries what it said. */
  retrieverFailed: "retriever_failed",
  /** The hook's own self-watchdog fired before a decision was reached. */
  hookCeilingExceeded: "hook_ceiling_exceeded",
} as const);

/** Closed union over {@link RECALL_INJECT_FAULT}. */
export type RecallInjectFault = (typeof RECALL_INJECT_FAULT)[keyof typeof RECALL_INJECT_FAULT];

/** Membership list; every surface renders its vocabulary from this array. */
export const RECALL_INJECT_FAULTS: ReadonlyArray<RecallInjectFault> = Object.freeze([
  RECALL_INJECT_FAULT.timeout,
  RECALL_INJECT_FAULT.retrieverFailed,
  RECALL_INJECT_FAULT.hookCeilingExceeded,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isRecallInjectFault(value: unknown): value is RecallInjectFault {
  return (
    typeof value === "string" && (RECALL_INJECT_FAULTS as ReadonlyArray<string>).includes(value)
  );
}

export type RecallInjectDecision =
  | {
      readonly kind: "inject";
      readonly brief: string;
      readonly noteCount: number;
      readonly topScore: number;
      /** The quantity the floor was compared against; see the floor's docblock. */
      readonly matchQuality: number;
      /**
       * Exactly the notes rendered into {@link brief}, in brief order:
       * after the char-budget fit and after the decision-model filter. The
       * hook records these, so a note that was cut is never suppressed
       * without having been shown.
       */
      readonly injectedNotes: ReadonlyArray<RecallInjectedNote>;
      /** Per-slice outcomes, in declared order; present only when slices ran. */
      readonly slices?: ReadonlyArray<RecallSliceOutcome>;
      /** Present only when the decision-model filter ran (use not `off`). */
      readonly decisionModel?: RecallInjectDecisionModelInfo;
    }
  | {
      readonly kind: "abstain";
      readonly reason: RecallAbstainReason;
      readonly topScore: number;
      /**
       * The quantity the floor was compared against; see the floor's
       * docblock. `null` on the abstains where there was no comparison to
       * make - `unmeasurable_quality` always, and the earlier
       * short-circuits when the retrieval could not weigh the prompt.
       */
      readonly matchQuality: number | null;
      /** Per-slice outcomes, in declared order; present only when slices ran. */
      readonly slices?: ReadonlyArray<RecallSliceOutcome>;
      /** Present only on a `decision_model_abstain`. */
      readonly decisionModel?: RecallInjectDecisionModelInfo;
    }
  | {
      readonly kind: "error";
      readonly fault: RecallInjectFault;
      /**
       * The originating message, for the LOCAL audit file only. Named
       * `detail` rather than `reason` so the split is structural: a
       * consumer reaching for a classification cannot reach this by
       * accident, which is how the raw message got onto a synced payload
       * in the first place.
       */
      readonly detail?: string;
    };

/** The identity of one rendered brief bullet. */
export interface RecallInjectedNote {
  readonly path: string;
  readonly origin?: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * The per-session dedupe key of one note: origin label (`local` for the
 * active vault through the default retriever; empty when a retriever sets
 * no origin), vault-relative path and line span. The one source of
 * the key: the hook records these values and this core filters on them.
 */
export function recallInjectNoteKey(note: RecallInjectedNote): string {
  return `${note.origin ?? ""}:${note.path}#L${note.startLine}-L${note.endLine}`;
}

/** Narrow rendered candidates to the identity the ledger records. */
function injectedNotesOf(notes: ReadonlyArray<RecallCandidate>): ReadonlyArray<RecallInjectedNote> {
  return Object.freeze(
    notes.map((n) =>
      Object.freeze({
        path: n.path,
        ...(n.origin !== undefined ? { origin: n.origin } : {}),
        startLine: n.startLine,
        endLine: n.endLine,
      }),
    ),
  );
}

/**
 * Drop candidates this session was already shown. Runs after the floor
 * check and before the `maxNotes` slice; with neither set given it returns
 * the input unchanged.
 */
function withoutDelivered(
  ranked: ReadonlyArray<RecallCandidate>,
  options: RecallInjectOptions,
): ReadonlyArray<RecallCandidate> {
  const injected = options.alreadyInjected;
  const digest = options.activeDigestPaths;
  if (
    (injected === undefined || injected.size === 0) &&
    (digest === undefined || digest.size === 0)
  ) {
    return ranked;
  }
  return ranked.filter(
    (c) =>
      !(injected?.has(recallInjectNoteKey(c)) ?? false) &&
      !(fromActiveVault(c) && (digest?.has(c.path) ?? false)),
  );
}

/**
 * Whether a candidate comes from the active vault. The SessionStart digest
 * delivers the active vault's notes only, so a profile or recall source
 * note on the same vault-relative path was never shown and stays eligible.
 */
function fromActiveVault(candidate: RecallCandidate): boolean {
  return candidate.origin === undefined || candidate.origin === LOCAL_ORIGIN;
}

/** Typed error for a retrieval that exceeded the fixed time budget. */
export class RecallInjectTimeoutError extends Error {
  constructor(public readonly budgetMs: number) {
    super(`recall retrieval exceeded the ${budgetMs}ms time budget`);
    this.name = "RecallInjectTimeoutError";
  }
}

/**
 * Decide whether to inject, abstain, or error for one prompt. Never throws:
 * a retriever failure or timeout is caught and surfaced as an explicit
 * `error` decision so the hook can audit and inject nothing.
 */
export async function decideRecallInject(
  prompt: string,
  retriever: RecallRetriever,
  options: RecallInjectOptions = {},
): Promise<RecallInjectDecision> {
  const clock = options.now ?? Date.now;
  const started = clock();
  const query = prompt.trim();
  if (query.length === 0) {
    return Object.freeze({ kind: "abstain", reason: "empty_prompt", topScore: 0, matchQuality: 0 });
  }
  const maxNotes = options.maxNotes ?? RECALL_INJECT_MAX_NOTES;
  const maxChars = options.maxChars ?? RECALL_INJECT_MAX_CHARS;
  const timeBudgetMs = options.timeBudgetMs ?? RECALL_INJECT_TIME_BUDGET_MS;
  const floor = options.confidenceFloor ?? RECALL_INJECT_CONFIDENCE_FLOOR;
  const caps: ResolvedCaps = { maxNotes, maxChars, timeBudgetMs, floor };
  if (
    options.slices !== undefined &&
    options.slices.length > 0 &&
    options.sliceRetriever !== undefined
  ) {
    return decideSliced(query, options.slices, options.sliceRetriever, caps, options, started);
  }

  let resultSet: RecallResultSet;
  try {
    resultSet = await withTimeBudget(retriever(query), timeBudgetMs);
  } catch (exc) {
    return retrievalError(exc);
  }

  const ranked = rankCandidates(resultSet.candidates);
  const matchQuality = resultSet.idfWeightedCoverage;
  if (ranked.length === 0) {
    return Object.freeze({ kind: "abstain", reason: "no_matches", topScore: 0, matchQuality });
  }
  const topScore = ranked[0]!.score;
  // The floor reads match quality, never the rank position `topScore`
  // reports. `topScore` is still carried on the decision because it is
  // what the brief's bullets show and what the audit line records - it is
  // simply no longer allowed to decide anything.
  //
  // No quality means no comparison. Abstaining is the explicit choice
  // this branch makes rather than a fallback: the alternative was the
  // producer's old `1`, which put every unweighable prompt above every
  // floor and injected on it.
  if (matchQuality === null) {
    return Object.freeze({
      kind: "abstain",
      reason: "unmeasurable_quality",
      topScore,
      matchQuality,
    });
  }
  if (matchQuality < floor) {
    return Object.freeze({ kind: "abstain", reason: "below_floor", topScore, matchQuality });
  }

  // Dedupe sits after the floor, which read the unfiltered retrieval, and
  // before the cap. There is no over-fetch: the coverage the floor read is
  // measured over the retrieved rows, so refilling would move verdicts.
  const fresh = withoutDelivered(ranked, options);
  if (fresh.length === 0) {
    return Object.freeze({
      kind: "abstain",
      reason: "all_already_injected",
      topScore,
      matchQuality,
    });
  }

  const chosen = fresh.slice(0, maxNotes);
  const { brief, noteCount } = renderRecallBrief(chosen, resultSet.total, maxChars);
  const today: Extract<RecallInjectDecision, { kind: "inject" }> = Object.freeze({
    kind: "inject",
    brief,
    noteCount,
    topScore,
    matchQuality,
    injectedNotes: injectedNotesOf(chosen.slice(0, noteCount)),
  });
  const filter = options.decisionFilter;
  if (filter === undefined || noteCount === 0) return today;
  return applyDecisionFilter(filter, today, {
    query,
    rendered: chosen.slice(0, noteCount),
    render: (kept) => {
      const out = renderRecallBrief(kept, resultSet.total, maxChars);
      return { ...out, injectedNotes: injectedNotesOf(kept.slice(0, out.noteCount)) };
    },
    remainingMs: timeBudgetMs - (clock() - started),
    clock,
  });
}

interface ResolvedCaps {
  readonly maxNotes: number;
  readonly maxChars: number;
  readonly timeBudgetMs: number;
  readonly floor: number;
}

/** A failed or timed-out retrieval as an explicit `error` decision. */
function retrievalError(exc: unknown): RecallInjectDecision {
  if (exc instanceof RecallInjectTimeoutError) {
    return Object.freeze({ kind: "error", fault: RECALL_INJECT_FAULT.timeout });
  }
  return Object.freeze({
    kind: "error",
    fault: RECALL_INJECT_FAULT.retrieverFailed,
    detail: errorDetail(exc),
  });
}

/** Score descending, then path, so equal scores render in a stable order. */
function rankCandidates(
  candidates: ReadonlyArray<RecallCandidate>,
): ReadonlyArray<RecallCandidate> {
  return candidates.toSorted(
    (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

/** One slice's retrieval judged against the floor on its own rows. */
interface SliceVerdict {
  readonly spec: RecallSliceSpec;
  readonly outcome: "inject" | RecallAbstainReason;
  readonly ranked: ReadonlyArray<RecallCandidate>;
  readonly total: number;
  readonly topScore: number;
  readonly matchQuality: number | null;
}

function judgeSlice(spec: RecallSliceSpec, set: RecallResultSet, floor: number): SliceVerdict {
  const ranked = rankCandidates(set.candidates);
  const matchQuality = set.idfWeightedCoverage;
  const topScore = ranked[0]?.score ?? 0;
  const base = { spec, ranked, total: set.total, topScore, matchQuality };
  if (ranked.length === 0) return { ...base, outcome: "no_matches" };
  if (matchQuality === null) return { ...base, outcome: "unmeasurable_quality" };
  if (matchQuality < floor) return { ...base, outcome: "below_floor" };
  return { ...base, outcome: "inject" };
}

/**
 * The slice path: every slice retrieves in parallel under the one shared
 * time budget, each is judged against the floor on its own retrieval, and
 * the survivors are laid out in declared order inside one fence, with the
 * global caps bounding the sum. A slow slice fails the whole decision the
 * way a slow single retrieval does; there is no partial inject.
 */
async function decideSliced(
  query: string,
  slices: ReadonlyArray<RecallSliceSpec>,
  sliceRetriever: (slice: RecallSliceSpec, limit: number) => RecallRetriever,
  caps: ResolvedCaps,
  options: RecallInjectOptions,
  started: number,
): Promise<RecallInjectDecision> {
  const clock = options.now ?? Date.now;
  let sets: ReadonlyArray<RecallResultSet>;
  try {
    sets = await withTimeBudget(
      Promise.all(
        slices.map((spec) =>
          sliceRetriever(spec, Math.min(spec.limit ?? caps.maxNotes, caps.maxNotes))(query),
        ),
      ),
      caps.timeBudgetMs,
    );
  } catch (exc) {
    return retrievalError(exc);
  }
  const verdicts = slices.map((spec, i) => judgeSlice(spec, sets[i]!, caps.floor));
  const total = sets.reduce((sum, set) => sum + set.total, 0);
  const groups = verdicts.map((v) =>
    v.outcome === "inject" ? withoutDelivered(v.ranked, options) : [],
  );
  // Fixed before any layout: a slice the session had already seen in full.
  const shownBefore = verdicts.map((v, i) => v.outcome === "inject" && groups[i]!.length === 0);

  const layout = (pools: ReadonlyArray<ReadonlyArray<RecallCandidate>>) => {
    const out = renderSlicedBrief(verdicts, pools, total, caps);
    const outcomes = verdicts.map((v, i): RecallSliceOutcome => {
      const placed = out.placed[i]!.length;
      if (v.outcome !== "inject") return { name: v.spec.name, outcome: v.outcome, notes: 0 };
      if (shownBefore[i] === true || out.onlyRepeats[i] === true) {
        return { name: v.spec.name, outcome: "all_already_injected", notes: 0 };
      }
      return { name: v.spec.name, outcome: "inject", notes: placed };
    });
    return { ...out, slices: Object.freeze(outcomes.map((o) => Object.freeze(o))) };
  };

  const first = layout(groups);
  const placedVerdicts = verdicts.filter((_, i) => first.placed[i]!.length > 0);
  if (placedVerdicts.length === 0) {
    const qualities = verdicts.flatMap((v) => (v.matchQuality === null ? [] : [v.matchQuality]));
    return Object.freeze({
      kind: "abstain",
      reason: "all_slices_abstained",
      topScore: Math.max(0, ...verdicts.map((v) => v.topScore)),
      matchQuality: qualities.length > 0 ? Math.max(...qualities) : null,
      slices: first.slices,
    });
  }
  const rendered = first.placed.flat();
  const today: Extract<RecallInjectDecision, { kind: "inject" }> = Object.freeze({
    kind: "inject",
    brief: first.brief,
    noteCount: rendered.length,
    topScore: Math.max(...placedVerdicts.map((v) => v.topScore)),
    matchQuality: Math.max(...placedVerdicts.map((v) => v.matchQuality ?? 0)),
    injectedNotes: injectedNotesOf(rendered),
    slices: first.slices,
  });
  const filter = options.decisionFilter;
  if (filter === undefined) return today;
  return applyDecisionFilter(filter, today, {
    query,
    rendered,
    render: (kept) => {
      const keep = new Set(kept.map(recallInjectNoteKey));
      const out = layout(
        first.placed.map((pool) => pool.filter((c) => keep.has(recallInjectNoteKey(c)))),
      );
      const notes = out.placed.flat();
      return {
        brief: out.brief,
        noteCount: notes.length,
        injectedNotes: injectedNotesOf(notes),
        slices: out.slices,
      };
    },
    remainingMs: caps.timeBudgetMs - (clock() - started),
    clock,
  });
}

/**
 * Which notes survive an answer, and whether the brief is withheld. Pure,
 * so a shadow record can carry what enforce would do.
 *
 *   - `inject_any` below {@link RECALL_INJECT_ANY_MIN} withholds the brief,
 *     but only when every note was sent: a note the model never saw
 *     cannot be judged useless by it;
 *   - otherwise a sent note whose `helps_<k>` is below
 *     {@link RECALL_INJECT_NOTE_MIN} is dropped; a note that was not sent,
 *     or whose answer is invalid, stays;
 *   - no note left withholds the brief.
 *
 * The result only removes notes; it never adds one.
 */
export function recallInjectFilterOutcome(
  helps: ReadonlyArray<number | null>,
  sent: ReadonlyArray<boolean>,
  injectAny: number | null,
): { readonly abstain: boolean; readonly keep: ReadonlyArray<boolean> } {
  const keep = helps.map((p, i) => !(sent[i] === true && p !== null && p < RECALL_INJECT_NOTE_MIN));
  const allSent = sent.length === helps.length && sent.every(Boolean);
  const abstain =
    (injectAny !== null && injectAny < RECALL_INJECT_ANY_MIN && allSent) || !keep.some(Boolean);
  return { abstain, keep };
}

/** A brief laid out again over the notes the filter kept. */
interface RenderedBrief {
  readonly brief: string;
  readonly noteCount: number;
  readonly injectedNotes: ReadonlyArray<RecallInjectedNote>;
  readonly slices?: ReadonlyArray<RecallSliceOutcome>;
}

interface FilterContext {
  readonly query: string;
  readonly rendered: ReadonlyArray<RecallCandidate>;
  /** The same renderer and caps that produced today's brief. */
  readonly render: (kept: ReadonlyArray<RecallCandidate>) => RenderedBrief;
  readonly remainingMs: number;
  readonly clock: () => number;
}

/**
 * Run the decision-model filter over today's `inject` decision. Never
 * throws and never extends the time budget: with nothing left the filter
 * is not asked at all, and a filter still running when the budget ends
 * is abandoned as a `timeout`. Every failure keeps today's decision.
 */
async function applyDecisionFilter(
  filter: RecallInjectFilter,
  today: Extract<RecallInjectDecision, { kind: "inject" }>,
  ctx: FilterContext,
): Promise<RecallInjectDecision> {
  const t0 = ctx.clock();
  const degraded = (reason: string): RecallInjectDecision =>
    Object.freeze({
      ...today,
      decisionModel: Object.freeze({
        mode: filter.mode,
        outcome: "degraded",
        degradeReason: reason,
        latencyMs: Math.max(0, ctx.clock() - t0),
        notesDropped: 0,
        abstained: false,
        charsRemoved: 0,
      }),
    });
  if (ctx.remainingMs <= 0) return degraded("timeout");

  let verdict: RecallInjectFilterVerdict;
  try {
    verdict = await withTimeBudget(
      filter.run({ query: ctx.query, notes: ctx.rendered, remainingMs: ctx.remainingMs }),
      ctx.remainingMs,
    );
  } catch (exc) {
    return degraded(exc instanceof RecallInjectTimeoutError ? "timeout" : "network");
  }
  if (verdict.status === "off") return today;
  if (verdict.status === "degraded") {
    return Object.freeze({
      ...today,
      decisionModel: Object.freeze({
        mode: verdict.mode,
        outcome: "degraded",
        degradeReason: verdict.reason,
        latencyMs: verdict.latencyMs,
        notesDropped: 0,
        abstained: false,
        charsRemoved: 0,
      }),
    });
  }
  if (verdict.status === "not_sent") {
    return Object.freeze({
      ...today,
      decisionModel: Object.freeze({
        mode: verdict.mode,
        outcome: "not_sent",
        latencyMs: Math.max(0, ctx.clock() - t0),
        notesDropped: 0,
        abstained: false,
        charsRemoved: 0,
      }),
    });
  }

  const { abstain, keep } = recallInjectFilterOutcome(
    verdict.helps,
    verdict.sent,
    verdict.injectAny,
  );
  const kept = ctx.rendered.filter((_, i) => keep[i] === true);
  const notesDropped = abstain ? ctx.rendered.length : ctx.rendered.length - kept.length;
  const info = {
    mode: verdict.mode,
    outcome: "ok" as const,
    latencyMs: verdict.latencyMs,
    notesDropped,
    abstained: abstain,
    charsRemoved: 0,
  };
  // Shadow: recorded, and today's brief goes out unchanged.
  if (verdict.mode === "shadow" || notesDropped === 0) {
    return Object.freeze({ ...today, decisionModel: Object.freeze(info) });
  }
  const tokensBefore = estimateTokens(today.brief);
  const withheld = (): RecallInjectDecision =>
    Object.freeze({
      kind: "abstain",
      reason: "decision_model_abstain",
      topScore: today.topScore,
      matchQuality: today.matchQuality,
      ...(today.slices !== undefined ? { slices: today.slices } : {}),
      decisionModel: Object.freeze({
        ...info,
        abstained: true,
        notesDropped: ctx.rendered.length,
        tokensBefore,
        tokensAfter: 0,
        charsRemoved: today.brief.length,
      }),
    });
  if (abstain) return withheld();
  // The existing renderer and caps over the surviving notes only.
  const { brief, noteCount, injectedNotes, slices } = ctx.render(kept);
  if (noteCount === 0) return withheld();
  return Object.freeze({
    kind: "inject",
    brief,
    noteCount,
    topScore: today.topScore,
    matchQuality: today.matchQuality,
    injectedNotes,
    ...(slices !== undefined ? { slices } : {}),
    decisionModel: Object.freeze({
      ...info,
      tokensBefore,
      tokensAfter: estimateTokens(brief),
      charsRemoved: Math.max(0, today.brief.length - brief.length),
    }),
  });
}

/**
 * Render the bounded brief: a fixed header, the shared recall-hint
 * orientation line, then one bullet per note added only while the whole
 * brief stays within `maxChars`. Returns the count of notes actually
 * rendered so the audit reflects the delivered brief.
 *
 * Note titles are untrusted vault content, so every title is neutralized
 * (see {@link neutralizeTitle}) BEFORE it reaches either the recall-hint line
 * or a note bullet, and the finished brief is fenced as untrusted content
 * ({@link fenceUntrustedContent}). The fence delimiter overhead is charged
 * against `maxChars` - the whole fenced brief, not just its inner body, stays
 * within the cap - so the hard char bound the audit relies on still holds.
 */
function renderRecallBrief(
  chosen: ReadonlyArray<RecallCandidate>,
  total: number,
  maxChars: number,
): { readonly brief: string; readonly noteCount: number } {
  const safe = chosen.map((c) => ({ ...c, title: neutralizeTitle(c.title) }));
  const hintInputs: ReadonlyArray<RecallHintInput> = safe.map((c) => ({
    searchType: c.searchType,
    score: c.score,
    title: c.title,
  }));
  const hint = deriveRecallHint(hintInputs, total);
  // Charge the fence delimiter overhead against the cap so the FENCED brief
  // (not merely its inner body) is what stays within `maxChars`.
  const innerBudget = Math.max(0, maxChars - fenceOverhead());
  // Seed the header only when it fits the inner budget; a caller-supplied
  // tiny `maxChars` must never be exceeded just to carry the header.
  const header = RECALL_BRIEF_HEADER;
  const lines: string[] = header.length <= innerBudget ? [header] : [];
  // The hint is orientation, not a pointer: keep it only while it fits, so a
  // tight budget spends its characters on the actual note pointers instead.
  if (hint !== null && [...lines, hint].join("\n").length <= innerBudget) lines.push(hint);
  let noteCount = 0;
  for (const note of safe) {
    const line = renderNoteLine(note);
    if ([...lines, line].join("\n").length > innerBudget) break;
    lines.push(line);
    noteCount += 1;
  }
  return { brief: fenceUntrustedContent(lines.join("\n"), RECALL_FENCE_ORIGIN), noteCount };
}

const RECALL_BRIEF_HEADER = "Recalled vault context (relevance-matched to this prompt):";

/**
 * The sectioned variant of {@link renderRecallBrief}: the same header,
 * fence, neutralisers and bullet format, with each slice's notes under a
 * `## <heading>` line. Slices are laid out in declared order; each takes
 * `min(slice.limit, notes left)` notes and `min(slice.maxChars, chars
 * left)` of heading plus bullets, so the global caps, fence included,
 * bound the sum and a later slice is the one clamped. A note already
 * placed by an earlier slice is not repeated, and a slice that places no
 * note gets no heading. The recall-hint line is orientation, so it goes in
 * after the notes and only while it still fits.
 */
function renderSlicedBrief(
  verdicts: ReadonlyArray<SliceVerdict>,
  pools: ReadonlyArray<ReadonlyArray<RecallCandidate>>,
  total: number,
  caps: Pick<ResolvedCaps, "maxNotes" | "maxChars">,
): {
  readonly brief: string;
  readonly placed: ReadonlyArray<ReadonlyArray<RecallCandidate>>;
  /** Per slice: its pool was not empty, and an earlier slice placed every note of it. */
  readonly onlyRepeats: ReadonlyArray<boolean>;
} {
  const innerBudget = Math.max(0, caps.maxChars - fenceOverhead());
  const lines: string[] = RECALL_BRIEF_HEADER.length <= innerBudget ? [RECALL_BRIEF_HEADER] : [];
  const seen = new Set<string>();
  const placed: RecallCandidate[][] = [];
  const onlyRepeats: boolean[] = [];
  for (const [i, verdict] of verdicts.entries()) {
    const fresh = (pools[i] ?? []).filter((c) => !seen.has(recallInjectNoteKey(c)));
    onlyRepeats.push((pools[i] ?? []).length > 0 && fresh.length === 0);
    const notesLeft = caps.maxNotes - seen.size;
    const take = Math.min(verdict.spec.limit ?? notesLeft, notesLeft);
    const sliceChars = verdict.spec.maxChars ?? Number.POSITIVE_INFINITY;
    const heading = `## ${neutralizeHeading(verdict.spec)}`;
    const section: string[] = [];
    const chosen: RecallCandidate[] = [];
    for (const note of fresh) {
      if (chosen.length >= take) break;
      const line = renderNoteLine({ ...note, title: neutralizeTitle(note.title) });
      const next = [heading, ...section, line];
      if (next.join("\n").length > sliceChars) break;
      if ([...lines, ...next].join("\n").length > innerBudget) break;
      section.push(line);
      chosen.push(note);
    }
    if (chosen.length > 0) lines.push(heading, ...section);
    for (const note of chosen) seen.add(recallInjectNoteKey(note));
    placed.push(chosen);
  }
  const hint = deriveRecallHint(
    placed.flat().map((c) => ({
      searchType: c.searchType,
      score: c.score,
      title: neutralizeTitle(c.title),
    })),
    total,
  );
  const at = lines[0] === RECALL_BRIEF_HEADER ? 1 : 0;
  if (hint !== null) {
    const withHint = lines.toSpliced(at, 0, hint);
    if (withHint.join("\n").length <= innerBudget) lines.splice(at, 0, hint);
  }
  return {
    brief: fenceUntrustedContent(lines.join("\n"), RECALL_FENCE_ORIGIN),
    placed,
    onlyRepeats,
  };
}

/** A slice heading is operator text: neutralised like a title, never empty. */
function neutralizeHeading(spec: RecallSliceSpec): string {
  const clean = neutralizeSingleLine(spec.heading).trim();
  return clean.length > 0 ? clean : spec.name;
}

/** Character cost of the untrusted-content fence around an empty body. */
function fenceOverhead(): number {
  return fenceUntrustedContent("", RECALL_FENCE_ORIGIN).length;
}

/**
 * Neutralize one untrusted vault title for single-line use in the brief.
 * Reuses the structural neutralizer (control/bidi/zero-width strip plus
 * delimiter escape), then collapses any surviving newline/tab run to one
 * space so the title can never break the brief's line structure or smuggle a
 * forged delimiter past review.
 */
function neutralizeTitle(title: string | null): string {
  if (title === null || title.length === 0) return "(untitled)";
  const clean = neutralizeSingleLine(title);
  return clean.length > 0 ? clean : "(untitled)";
}

/**
 * Structural single-line neutralizer for untrusted vault strings: strip
 * control/bidi/zero-width and escape delimiters ({@link
 * neutralizeUntrustedText}), then collapse any surviving newline/tab run to
 * one space so the value can never break the brief's one-per-line structure.
 */
function neutralizeSingleLine(text: string): string {
  return neutralizeUntrustedText(text).replace(/[\n\t]+/g, " ");
}

function renderNoteLine(note: { readonly title: string } & Omit<RecallCandidate, "title">): string {
  // The path is untrusted vault content too: neutralize it the same way as a
  // title so a newline/control char in a path cannot break the line format.
  const pointer = `${neutralizeSingleLine(note.path)}:L${note.startLine}-L${note.endLine}`;
  const origin = note.origin !== undefined ? ` [${note.origin}]` : "";
  return `- "${note.title}" (${pointer}, ${note.searchType} ${note.score.toFixed(2)})${origin}`;
}

/**
 * The originating message, for the local audit file. Never reaches a
 * telemetry payload - see {@link recallInjectTelemetryMetadata}.
 */
function errorDetail(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

/**
 * One decision as the metadata of a recall-telemetry record.
 *
 * Classifications and bounded numbers ONLY. This payload is appended to
 * the continuity log, which syncs, and `brain_recall_telemetry` returns
 * it verbatim to a model - so nothing shaped like a filesystem path or a
 * provider sentence may appear here. Both the abstain reason and the
 * error fault are members of closed vocabularies, which is what makes
 * that rule checkable rather than a matter of care at each call site.
 */
export function recallInjectTelemetryMetadata(
  decision: RecallInjectDecision,
): Readonly<Record<string, unknown>> {
  if (decision.kind === "inject") {
    return Object.freeze({
      decision: "inject",
      note_count: decision.noteCount,
      top_score: decision.topScore,
      match_quality: decision.matchQuality,
      ...decisionModelTelemetry(decision.decisionModel),
    });
  }
  if (decision.kind === "abstain") {
    return Object.freeze({
      decision: "abstain",
      reason: decision.reason,
      top_score: decision.topScore,
      match_quality: decision.matchQuality,
      ...decisionModelTelemetry(decision.decisionModel),
    });
  }
  return Object.freeze({ decision: "error", fault: decision.fault });
}

/**
 * The same decision as a hook-audit line: everything the telemetry
 * record carries, plus the originating message when there is one.
 *
 * The audit file is local, unsynced operational evidence under
 * `<vault>/.open-second-brain/hook-audit/`, and the message is exactly
 * what an operator debugging a broken retriever needs, so it stays HERE
 * and only here. Derived from the telemetry projection rather than
 * written out a second time: two hand-maintained shapes are how the
 * message reached the synced payload to begin with.
 */
export function recallInjectAuditDetails(
  decision: RecallInjectDecision,
): Readonly<Record<string, unknown>> {
  const safe = recallInjectTelemetryMetadata(decision);
  if (decision.kind !== "error") {
    // Slice names are operator vocabulary, local to this vault's policy:
    // they ride the audit line only, never the synced telemetry record.
    const sliced =
      decision.slices === undefined ? safe : Object.freeze({ ...safe, slices: decision.slices });
    // The decision-model degrade reason is local operational evidence,
    // like a retriever's message: it rides this line only.
    const reason = decision.decisionModel?.degradeReason;
    if (reason === undefined) return sliced;
    return Object.freeze({
      ...sliced,
      decision_model: Object.freeze({
        ...(safe["decision_model"] as Readonly<Record<string, unknown>>),
        degrade_reason: reason,
      }),
    });
  }
  if (decision.detail === undefined) return safe;
  return Object.freeze({ ...safe, detail: decision.detail });
}

/**
 * The decision-model fields of a telemetry record: mode, a coarse outcome,
 * the added latency, notes dropped and whether the brief was withheld.
 * Absent when the filter did not run, so an install without the feature
 * writes exactly the record it wrote before.
 */
function decisionModelTelemetry(
  info: RecallInjectDecisionModelInfo | undefined,
): Readonly<Record<string, unknown>> {
  if (info === undefined) return {};
  return {
    decision_model: Object.freeze({
      mode: info.mode,
      outcome: info.outcome,
      latency_ms: Math.max(0, Math.round(info.latencyMs)),
      notes_dropped: info.notesDropped,
      abstained: info.abstained,
    }),
  };
}

/**
 * Resolve `promise`, or reject with a {@link RecallInjectTimeoutError} once
 * `budgetMs` elapses. The timer is cleared on settle so it never keeps the
 * process alive past the real work.
 */
async function withTimeBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RecallInjectTimeoutError(budgetMs)), budgetMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The default retriever: the existing cross-vault search over the active
 * vault and its read-only recall sources. No new retriever is introduced -
 * this only adapts {@link searchAcrossVaults} results into the narrow
 * {@link RecallCandidate} shape the decision core consumes.
 */
export function defaultRecallRetriever(
  configPath: string,
  vault: string,
  limitOrFilter: number | RecallRetrieverFilter = RECALL_INJECT_MAX_NOTES,
): RecallRetriever {
  const filter: RecallRetrieverFilter =
    typeof limitOrFilter === "number" ? { limit: limitOrFilter } : limitOrFilter;
  const limit = filter.limit ?? RECALL_INJECT_MAX_NOTES;
  const types = filter.types ?? [];
  return async (query) => {
    // The decision-model rerank kind is skipped here: a decision request
    // (its timeout plus a retry) does not fit the hook's retrieval budget,
    // and a hook fires on every prompt. The heuristic order is used.
    const outcome = await searchAcrossVaults(configPath, vault, {
      query,
      limit,
      skipDecisionModelRerank: true,
      ...(filter.pathPrefix !== undefined ? { pathPrefix: filter.pathPrefix } : {}),
      ...(types.length > 0 ? { properties: new Map([["type", types]]) } : {}),
    });
    const candidates = outcome.results.map((result) =>
      Object.freeze({
        path: result.path,
        title: result.title,
        score: result.score,
        searchType: result.searchType,
        startLine: result.startLine,
        endLine: result.endLine,
        ...(result.origin !== undefined ? { origin: result.origin } : {}),
        content: result.content,
      }),
    );
    return Object.freeze({
      candidates: Object.freeze(candidates),
      total: outcome.total,
      idfWeightedCoverage: outcome.idfWeightedCoverage,
    });
  };
}

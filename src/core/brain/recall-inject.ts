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

/** Hard cap on notes carried in a single brief. */
export const RECALL_INJECT_MAX_NOTES = 4;

/** Hard cap on the rendered brief size, in characters. */
export const RECALL_INJECT_MAX_CHARS = 900;

/** Fixed wall-clock budget for the retrieval step, in milliseconds. */
export const RECALL_INJECT_TIME_BUDGET_MS = 2_500;

/**
 * Normalized-score floor ([0,1]) below which the top match is too weak to be
 * worth injecting, so the hook abstains. Sits well below the cross-vault
 * chain-stop "confident" threshold: this gate only filters out noise.
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
}

/** A retriever's ranked candidate set plus the corpus match total. */
export interface RecallResultSet {
  readonly candidates: ReadonlyArray<RecallCandidate>;
  readonly total: number;
}

/** Relevance retriever: maps a query to a candidate set. */
export type RecallRetriever = (query: string) => Promise<RecallResultSet>;

export interface RecallInjectOptions {
  readonly maxNotes?: number;
  readonly maxChars?: number;
  readonly timeBudgetMs?: number;
  readonly confidenceFloor?: number;
}

export type RecallAbstainReason = "empty_prompt" | "no_matches" | "below_floor";

export type RecallInjectDecision =
  | {
      readonly kind: "inject";
      readonly brief: string;
      readonly noteCount: number;
      readonly topScore: number;
    }
  | { readonly kind: "abstain"; readonly reason: RecallAbstainReason; readonly topScore: number }
  | { readonly kind: "error"; readonly reason: string };

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
  const query = prompt.trim();
  if (query.length === 0) {
    return Object.freeze({ kind: "abstain", reason: "empty_prompt", topScore: 0 });
  }
  const maxNotes = options.maxNotes ?? RECALL_INJECT_MAX_NOTES;
  const maxChars = options.maxChars ?? RECALL_INJECT_MAX_CHARS;
  const timeBudgetMs = options.timeBudgetMs ?? RECALL_INJECT_TIME_BUDGET_MS;
  const floor = options.confidenceFloor ?? RECALL_INJECT_CONFIDENCE_FLOOR;

  let resultSet: RecallResultSet;
  try {
    resultSet = await withTimeBudget(retriever(query), timeBudgetMs);
  } catch (exc) {
    return Object.freeze({
      kind: "error",
      reason: exc instanceof RecallInjectTimeoutError ? "timeout" : errorReason(exc),
    });
  }

  const ranked = resultSet.candidates.toSorted(
    (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  if (ranked.length === 0) {
    return Object.freeze({ kind: "abstain", reason: "no_matches", topScore: 0 });
  }
  const topScore = ranked[0]!.score;
  if (topScore < floor) {
    return Object.freeze({ kind: "abstain", reason: "below_floor", topScore });
  }

  const chosen = ranked.slice(0, maxNotes);
  const { brief, noteCount } = renderRecallBrief(chosen, resultSet.total, maxChars);
  return Object.freeze({ kind: "inject", brief, noteCount, topScore });
}

/**
 * Render the bounded brief: a fixed header, the shared recall-hint
 * orientation line, then one bullet per note added only while the whole
 * brief stays within `maxChars`. Returns the count of notes actually
 * rendered so the audit reflects the delivered brief.
 */
function renderRecallBrief(
  chosen: ReadonlyArray<RecallCandidate>,
  total: number,
  maxChars: number,
): { readonly brief: string; readonly noteCount: number } {
  const hintInputs: ReadonlyArray<RecallHintInput> = chosen.map((c) => ({
    searchType: c.searchType,
    score: c.score,
    title: c.title,
  }));
  const hint = deriveRecallHint(hintInputs, total);
  const lines: string[] = ["Recalled vault context (relevance-matched to this prompt):"];
  if (hint !== null) lines.push(hint);
  let noteCount = 0;
  for (const note of chosen) {
    const line = renderNoteLine(note);
    if ([...lines, line].join("\n").length > maxChars) break;
    lines.push(line);
    noteCount += 1;
  }
  return { brief: lines.join("\n"), noteCount };
}

function renderNoteLine(note: RecallCandidate): string {
  const title = note.title !== null && note.title.length > 0 ? note.title : "(untitled)";
  const pointer = `${note.path}:L${note.startLine}-L${note.endLine}`;
  const origin = note.origin !== undefined ? ` [${note.origin}]` : "";
  return `- "${title}" (${pointer}, ${note.searchType} ${note.score.toFixed(2)})${origin}`;
}

function errorReason(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
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
  limit: number = RECALL_INJECT_MAX_NOTES,
): RecallRetriever {
  return async (query) => {
    const outcome = await searchAcrossVaults(configPath, vault, { query, limit });
    const candidates = outcome.results.map((result) =>
      Object.freeze({
        path: result.path,
        title: result.title,
        score: result.score,
        searchType: result.searchType,
        startLine: result.startLine,
        endLine: result.endLine,
        ...(result.origin !== undefined ? { origin: result.origin } : {}),
      }),
    );
    return Object.freeze({ candidates: Object.freeze(candidates), total: outcome.total });
  };
}

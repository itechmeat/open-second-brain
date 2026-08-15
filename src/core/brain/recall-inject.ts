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
import { fenceUntrustedContent, neutralizeUntrustedText } from "./untrusted-source.ts";

/** `origin` label stamped on the recall brief's untrusted-content fence. */
const RECALL_FENCE_ORIGIN = "recall-inject";

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

/** A retriever's returned candidates plus the ranked pool they came from. */
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
    }
  | { readonly kind: "abstain"; readonly reason: RecallAbstainReason; readonly topScore: number }
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
    if (exc instanceof RecallInjectTimeoutError) {
      return Object.freeze({ kind: "error", fault: RECALL_INJECT_FAULT.timeout });
    }
    return Object.freeze({
      kind: "error",
      fault: RECALL_INJECT_FAULT.retrieverFailed,
      detail: errorDetail(exc),
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
  const header = "Recalled vault context (relevance-matched to this prompt):";
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
    });
  }
  if (decision.kind === "abstain") {
    return Object.freeze({
      decision: "abstain",
      reason: decision.reason,
      top_score: decision.topScore,
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
  if (decision.kind !== "error" || decision.detail === undefined) return safe;
  return Object.freeze({ ...safe, detail: decision.detail });
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

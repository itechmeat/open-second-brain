/**
 * Decision-model filter for the recall-inject hook (issue #213, Part 9).
 *
 * Runs only when {@link decideRecallInject} would inject: abstentions and
 * errors never reach it, so they stay free. One request per prompt: the
 * state is the (clipped) prompt plus the notes the brief carries, masked
 * as `N0..Nn`; the questions are one `helps_<k>` noul per note and one
 * `inject_any` noul over all of them. Question texts and thresholds live
 * in `decision-model/questions.ts`.
 *
 * Modes come from `decision_model_uses` `recall_inject`:
 *   - `off`, or any configuration that is not active: no filter is built
 *     at all ({@link createRecallInjectDecisionFilter} returns null), so
 *     the hook behaves exactly as without the feature;
 *   - `shadow`: the request is sent and recorded, today's brief goes out;
 *   - `enforce`: the core drops notes or withholds the brief, never adds.
 *
 * Budget: `min(decision_model_hook_budget_ms, remaining retrieval budget)`,
 * passed to {@link runDecision} as `timeoutMs` and enforced here as well,
 * so a provider that ignores its timeout still cannot hold the hook.
 *
 * Privacy: a note leaves the machine only when it is a page of the active
 * vault whose visibility resolves without the reserved `private` token and
 * whose text carries no part of a `<private>` region (the shared state
 * builder). Notes from other origins are never sent. The prompt has its
 * `<private>` regions stripped and is clipped; the adapter redacts the
 * whole body. The record carries note paths (withheld ones masked) and
 * probabilities, never the prompt or note text.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decisionModelModeFor } from "../decision-model/config.ts";
import type { ResolvedDecisionModelConfig } from "../decision-model/config.ts";
import type { DecisionProvider, DecisionResponse } from "../decision-model/contract.ts";
import { RECALL_INJECT_QUESTIONS } from "../decision-model/questions.ts";
import { runDecision } from "../decision-model/run.ts";
import { buildCandidateState, mayLeaveMachine } from "../decision-model/state.ts";
import { pageVisibility } from "../graph/visibility.ts";
import { privateRegionTexts, stripPrivateRegions } from "../redactor.ts";
import { readCachedFrontmatterEntry, type FrontmatterCache } from "../search/result-filters.ts";
import {
  recallInjectFilterOutcome,
  type RecallCandidate,
  type RecallInjectFilter,
  type RecallInjectFilterMode,
  type RecallInjectFilterVerdict,
} from "./recall-inject.ts";

/** The active vault's origin label in cross-vault results. */
const ACTIVE_ORIGIN_LABEL = "local";

/** Stands in for a note that may not be named in a synced record. */
const WITHHELD_PATH = "(withheld)";

export interface RecallInjectDecisionFilterOptions {
  readonly config: ResolvedDecisionModelConfig | null | undefined;
  /** The active vault; notes are resolved against it. */
  readonly vault: string;
  /** Injected provider (tests). */
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Resolves a note's visibility tokens and `<private>` regions. Defaults
   * to reading the page from the active vault; null when it cannot be
   * read (the note is then not sent).
   */
  readonly resolvePage?: (note: RecallCandidate) => {
    readonly visibility: ReadonlyArray<string> | null;
    readonly privateRegions: ReadonlyArray<string> | null;
  };
}

interface FilterContext {
  /** `included[k]` is the brief index of mask `N<k>`. */
  readonly included: ReadonlyArray<number>;
  readonly withheld: number;
  readonly dropped: number;
}

function clipChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function isActiveVaultNote(note: RecallCandidate): boolean {
  return note.origin === undefined || note.origin === ACTIVE_ORIGIN_LABEL;
}

function defaultResolvePage(
  vault: string,
): NonNullable<RecallInjectDecisionFilterOptions["resolvePage"]> {
  const cache: FrontmatterCache = new Map();
  return (note) => {
    if (!isActiveVaultNote(note)) return { visibility: null, privateRegions: null };
    const entry = readCachedFrontmatterEntry(cache, vault, note.path);
    const visibility = entry.unreadable ? null : pageVisibility(entry.meta);
    if (!mayLeaveMachine(visibility)) return { visibility, privateRegions: null };
    let privateRegions: ReadonlyArray<string> | null;
    try {
      privateRegions = privateRegionTexts(readFileSync(join(vault, note.path), "utf8"));
    } catch {
      privateRegions = null;
    }
    return { visibility, privateRegions };
  };
}

/**
 * The filter for this configuration, or null when the `recall_inject` use
 * is `off` (the default) or the feature is not active: then nothing is
 * built, sent or recorded.
 */
export function createRecallInjectDecisionFilter(
  opts: RecallInjectDecisionFilterOptions,
): RecallInjectFilter | null {
  const cfg = opts.config;
  const configured = decisionModelModeFor(cfg, "recall_inject");
  if (configured === "off" || cfg === null || cfg === undefined) return null;
  const mode: RecallInjectFilterMode = configured;
  const resolvePage = opts.resolvePage ?? defaultResolvePage(opts.vault);

  return {
    mode,
    async run(input): Promise<RecallInjectFilterVerdict> {
      const notes = input.notes;
      const n = notes.length;
      const budgetMs = Math.max(0, Math.min(cfg.hookBudgetMs, input.remainingMs));
      if (budgetMs <= 0) return { status: "degraded", mode, reason: "timeout", latencyMs: 0 };
      const pages = notes.map((note) =>
        note.content === undefined ? { visibility: null, privateRegions: null } : resolvePage(note),
      );
      const prompt = clipChars(
        stripPrivateRegions(input.query),
        RECALL_INJECT_QUESTIONS.promptClipChars,
      );
      const answersFor = (
        response: DecisionResponse,
        context: FilterContext,
      ): { helps: (number | null)[]; sent: boolean[]; injectAny: number | null } => {
        const helps: (number | null)[] = Array.from({ length: n }, () => null);
        const sent: boolean[] = Array.from({ length: n }, () => false);
        context.included.forEach((briefIndex, k) => {
          sent[briefIndex] = true;
          const a = response.answers[RECALL_INJECT_QUESTIONS.helpsId(k)];
          if (a?.valid === true && typeof a.value === "number") helps[briefIndex] = a.value;
        });
        const any = response.answers[RECALL_INJECT_QUESTIONS.injectAnyId];
        const injectAny = any?.valid === true && typeof any.value === "number" ? any.value : null;
        return { helps, sent, injectAny };
      };

      const started = Date.now();
      const request = runDecision<FilterContext>(
        "recall_inject",
        () => {
          const built = buildCandidateState({
            candidates: notes.map((note, i) => ({
              text: note.content ?? "",
              visibility: pages[i]!.visibility,
              privateRegions: pages[i]!.privateRegions,
            })),
            prefix: RECALL_INJECT_QUESTIONS.prefix,
            clipChars: RECALL_INJECT_QUESTIONS.clipChars,
            maxStateTokens: cfg.maxStateTokens,
            frame: (texts) => ({ prompt, notes: texts }),
          });
          if (built.kind !== "ok") return built;
          return {
            kind: "ok",
            state: built.state,
            candidateCount: built.included.length,
            context: {
              included: built.included,
              withheld: built.withheld.length,
              dropped: built.dropped.length,
            },
          };
        },
        (built) => {
          const questions: Record<string, ReturnType<typeof RECALL_INJECT_QUESTIONS.helps>> = {};
          for (let k = 0; k < built.context.included.length; k++) {
            questions[RECALL_INJECT_QUESTIONS.helpsId(k)] = RECALL_INJECT_QUESTIONS.helps(k);
          }
          questions[RECALL_INJECT_QUESTIONS.injectAnyId] = RECALL_INJECT_QUESTIONS.injectAny();
          return questions;
        },
        {
          config: cfg,
          timeoutMs: budgetMs,
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
          recordDetails: (response, context) => {
            // Paths of notes that may leave the machine, the rest masked:
            // continuity records sync and can be read raw.
            const details: Record<string, unknown> = {
              note_paths: notes.map((note, i) =>
                isActiveVaultNote(note) && mayLeaveMachine(pages[i]!.visibility)
                  ? note.path
                  : WITHHELD_PATH,
              ),
              budget_ms: budgetMs,
            };
            if (response === null || context === null) return details;
            const { helps, sent, injectAny } = answersFor(response, context);
            const { abstain, keep } = recallInjectFilterOutcome(helps, sent, injectAny);
            details["helps"] = helps;
            details["inject_any"] = injectAny;
            details["abstained"] = abstain;
            details["notes_dropped"] = abstain ? n : keep.filter((k) => !k).length;
            details["withheld_count"] = context.withheld;
            details["budget_dropped_count"] = context.dropped;
            return details;
          },
        },
      );
      // A provider that outlives its own timeout must not hold the hook.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cutoff = new Promise<"cutoff">((resolve) => {
        timer = setTimeout(() => resolve("cutoff"), budgetMs);
      });
      let result: Awaited<typeof request> | "cutoff";
      try {
        result = await Promise.race([request, cutoff]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const latencyMs = Date.now() - started;
      if (result === "cutoff") return { status: "degraded", mode, reason: "timeout", latencyMs };
      if (result.status === "off") return { status: "off" };
      if (result.status === "empty") return { status: "not_sent", mode };
      if (result.status === "degraded") {
        return { status: "degraded", mode, reason: result.reason, latencyMs };
      }
      const { helps, sent, injectAny } = answersFor(result.response, result.context);
      return { status: "ok", mode, latencyMs: result.latencyMs, helps, sent, injectAny };
    },
  };
}

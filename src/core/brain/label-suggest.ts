/**
 * `brain_labels suggest` (issue #213, Part 6, use `labels`): advisory
 * label suggestions over the schema pack's declared vocabulary.
 *
 * One decision request per note. The state is the note's title and body
 * (private regions stripped, clipped; the adapter redacts the whole
 * body), and each requested dimension is one `choice` question `dim_<i>`
 * over its declared values plus `none`.
 *
 *   - `suggest` never assigns and never writes; assignment stays the
 *     explicit, fail-closed `assign`.
 *   - A note whose visibility carries `private` is refused with an error
 *     and nothing is sent.
 *   - `off` or no active config: `{ available: false, reason:
 *     "decision_model_off" }`, not an error.
 *   - `shadow`: sent and recorded, and every suggestion is null, so the
 *     host is not steered before the use has been evaluated.
 *   - `enforce`: the chosen value, unless it is `none` or its confidence
 *     is below the threshold in `questions.ts`, which gives null.
 *   - degrade: `{ available: false, reason }`.
 *   - A dimension with more values than one question can carry is
 *     skipped with a reason.
 */

import { basename } from "node:path";

import {
  advisoryDecisionConfig,
  advisoryUseActive,
  type AdvisoryDecisionOptions,
} from "../decision-model/advisory.ts";
import { CHOICE_MAX_OPTIONS } from "../decision-model/answers.ts";
import { decisionModelModeFor } from "../decision-model/config.ts";
import type { DecisionAnswer, DecisionChoiceQuestion } from "../decision-model/contract.ts";
import { LABELS_QUESTIONS } from "../decision-model/questions.ts";
import { runDecision } from "../decision-model/run.ts";
import { estimateTokens, mayLeaveMachine } from "../decision-model/state.ts";
import { pageVisibility } from "../graph/visibility.ts";
import { stripPrivateRegions } from "../redactor.ts";
import { parseFrontmatter } from "../vault.ts";
import { LabelVocabularyError, readLabels } from "./labels.ts";
import { resolveNotePath } from "./note-path.ts";
import type { SchemaPack } from "./schema-pack.ts";
import { normalizeSchemaToken } from "./schema-vocab.ts";

/** Refusal of a note that may not leave the machine. */
export class LabelSuggestPrivateNoteError extends Error {
  constructor(path: string) {
    super(
      `note ${path} has private visibility; label suggestions never send private notes ` +
        "to a decision model",
    );
    this.name = "LabelSuggestPrivateNoteError";
  }
}

export interface LabelSuggestion {
  readonly dimension: string;
  readonly suggestion: string | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly confidence: number | null;
  readonly current: string | null;
  readonly model: string;
  readonly calibrated: boolean;
}

export interface LabelSuggestSkipped {
  readonly dimension: string;
  readonly reason: "too_many_values" | "no_values";
}

export type LabelSuggestResult =
  | { readonly available: false; readonly reason: string; readonly path: string }
  | {
      readonly available: true;
      readonly mode: "shadow" | "enforce";
      readonly path: string;
      readonly dimensions: ReadonlyArray<LabelSuggestion>;
      readonly skipped: ReadonlyArray<LabelSuggestSkipped>;
    };

export interface SuggestNoteLabelsOptions extends AdvisoryDecisionOptions {
  readonly pack: SchemaPack;
  /** Dimensions to ask about; default every declared dimension. */
  readonly dimensions?: ReadonlyArray<string>;
}

interface AskedDimension {
  readonly dimension: string;
  readonly values: ReadonlyArray<string>;
  readonly noneKey: string;
  readonly current: string | null;
}

function currentValue(labels: ReadonlyArray<string>, dimension: string): string | null {
  const prefix = `${dimension}/`;
  const token = labels.find((t) => t.startsWith(prefix));
  return token === undefined ? null : token.slice(prefix.length);
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function requestedDimensions(pack: SchemaPack, requested: ReadonlyArray<string> | undefined) {
  const declared = Object.keys(pack.labels);
  if (declared.length === 0) {
    throw new LabelVocabularyError("", [], "no label dimensions are declared in the schema pack");
  }
  if (requested === undefined || requested.length === 0) return declared;
  const out: string[] = [];
  for (const raw of requested) {
    const dimension = normalizeSchemaToken(raw);
    if (pack.labels[dimension] === undefined) {
      throw new LabelVocabularyError(
        dimension,
        declared,
        `unknown label dimension "${dimension}" - declared dimensions: ${declared.join(", ")}`,
      );
    }
    if (!out.includes(dimension)) out.push(dimension);
  }
  return out;
}

/** Per-dimension answer: the would-be suggestion and its numbers. */
function readAnswer(
  answer: DecisionAnswer | undefined,
  asked: AskedDimension,
): {
  readonly suggestion: string | null;
  readonly chosen: string | null;
  readonly probabilities: Record<string, number> | null;
  readonly confidence: number | null;
} {
  if (answer === undefined || !answer.valid || answer.type !== "choice") {
    return { suggestion: null, chosen: null, probabilities: null, confidence: null };
  }
  const chosenKey = typeof answer.value === "string" ? answer.value : null;
  if (chosenKey === null || (chosenKey !== asked.noneKey && !asked.values.includes(chosenKey))) {
    return { suggestion: null, chosen: null, probabilities: null, confidence: null };
  }
  const probabilities: Record<string, number> = {};
  for (const [key, p] of Object.entries(answer.probabilities ?? {})) {
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    // The none option keeps its own key: renamed (`_none`) when the
    // vocabulary declares a real value `none`, so the two never merge.
    if (key === asked.noneKey || asked.values.includes(key)) probabilities[key] = p;
  }
  const confidence =
    typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
      ? answer.confidence
      : null;
  const chosen = chosenKey;
  const suggestion =
    chosenKey !== asked.noneKey && confidence !== null && confidence >= LABELS_QUESTIONS.suggestMin
      ? chosenKey
      : null;
  return { suggestion, chosen, probabilities, confidence };
}

/**
 * Suggest labels for the note at `relPath`. Throws on a bad path, an
 * unknown dimension or a private note; never writes.
 */
export async function suggestNoteLabels(
  vault: string,
  relPath: string,
  opts: SuggestNoteLabelsOptions,
): Promise<LabelSuggestResult> {
  const abs = resolveNotePath(vault, relPath);
  const [meta, body] = parseFrontmatter(abs);
  const cfg = advisoryDecisionConfig(vault, opts);
  if (!advisoryUseActive(cfg, "labels")) {
    return { available: false, reason: "decision_model_off", path: relPath };
  }
  const mode = decisionModelModeFor(cfg, "labels") as "shadow" | "enforce";

  const dimensions = requestedDimensions(opts.pack, opts.dimensions);
  if (!mayLeaveMachine(pageVisibility(meta))) throw new LabelSuggestPrivateNoteError(relPath);

  const labels = readLabels(meta);
  const asked: AskedDimension[] = [];
  const skipped: LabelSuggestSkipped[] = [];
  for (const dimension of dimensions) {
    const values = opts.pack.labels[dimension] ?? [];
    if (values.length === 0) {
      skipped.push({ dimension, reason: "no_values" });
      continue;
    }
    // `none` is one more option; the route's own limit may be lower.
    if (
      values.length > LABELS_QUESTIONS.maxValues ||
      values.length + 1 > (cfg!.maxChoiceOptions ?? CHOICE_MAX_OPTIONS)
    ) {
      skipped.push({ dimension, reason: "too_many_values" });
      continue;
    }
    let noneKey: string = LABELS_QUESTIONS.noneOption;
    while (values.includes(noneKey)) noneKey = `_${noneKey}`;
    asked.push({ dimension, values, noneKey, current: currentValue(labels, dimension) });
  }
  if (asked.length === 0) {
    return { available: true, mode, path: relPath, dimensions: [], skipped };
  }

  const rawTitle = meta["title"];
  const title =
    typeof rawTitle === "string" && rawTitle.trim() !== ""
      ? rawTitle.trim()
      : basename(relPath).replace(/\.md$/u, "");
  const state = {
    title: clip(stripPrivateRegions(title), LABELS_QUESTIONS.titleClipChars),
    body: clip(stripPrivateRegions(body), LABELS_QUESTIONS.bodyClipChars),
  };
  const questions: Record<string, DecisionChoiceQuestion> = {};
  asked.forEach((a, i) => {
    const criteria: Record<string, string | null> = {};
    for (const value of a.values) criteria[value] = null;
    questions[LABELS_QUESTIONS.questionId(i)] = LABELS_QUESTIONS.question(
      a.dimension,
      criteria,
      a.noneKey,
    );
  });

  const result = await runDecision<null>(
    "labels",
    () =>
      estimateTokens({ state, questions }) > cfg!.maxStateTokens
        ? { kind: "budget" }
        : { kind: "ok", state, candidateCount: asked.length, context: null },
    () => questions,
    {
      config: cfg,
      secretsVault: vault,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      recordDetails: (response) => ({
        note_path: relPath,
        skipped_count: skipped.length,
        dimensions: asked.map((a, i) => {
          const r =
            response === null
              ? null
              : readAnswer(response.answers[LABELS_QUESTIONS.questionId(i)], a);
          return {
            dimension: a.dimension,
            current: a.current,
            chosen: r?.chosen ?? null,
            suggested: r?.suggestion ?? null,
            confidence: r?.confidence ?? null,
            probability:
              r === null || r.chosen === null || r.probabilities === null
                ? null
                : (r.probabilities[r.chosen] ?? null),
          };
        }),
      }),
    },
  );
  if (result.status === "off") {
    return { available: false, reason: "decision_model_off", path: relPath };
  }
  if (result.status === "degraded") {
    return { available: false, reason: result.reason, path: relPath };
  }
  if (result.status !== "ok") {
    return { available: true, mode, path: relPath, dimensions: [], skipped };
  }
  const response = result.response;
  const out: LabelSuggestion[] = asked.map((a, i) => {
    const r =
      mode === "shadow" ? null : readAnswer(response.answers[LABELS_QUESTIONS.questionId(i)], a);
    return {
      dimension: a.dimension,
      suggestion: r?.suggestion ?? null,
      probabilities: r?.probabilities ?? null,
      confidence: r?.confidence ?? null,
      current: a.current,
      model: response.model,
      calibrated: response.calibrated,
    };
  });
  return { available: true, mode, path: relPath, dimensions: out, skipped };
}

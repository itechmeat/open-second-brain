/**
 * `choice`-question test doubles for the advisory decision-model uses
 * (issue #213, Parts 5 and 6). The shared fake provider scripts a bare
 * value per question; the advisory uses also need the probability
 * distribution a real reply carries, so these build one.
 *
 * Not shipped in `src/`. Never touches the network.
 */

import {
  DecisionProviderError,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionChoiceQuestion,
  type DecisionDegradeReason,
  type DecisionPingResult,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from "../../src/core/decision-model/contract.ts";
import type { SystemOneRequestLog } from "./fake-decision-provider.ts";

/** One scripted choice: the chosen key and its probability (rest spread evenly). */
export interface ScriptedChoice {
  readonly choice: string;
  readonly p: number;
}

export type ChoiceScript = (
  id: string,
  options: ReadonlyArray<string>,
  req: DecisionRequest | null,
) => ScriptedChoice | "invalid" | undefined;

/** A distribution with `p` on `choice` and the rest spread over the other options. */
export function distribution(
  options: ReadonlyArray<string>,
  pick: ScriptedChoice,
): Record<string, number> {
  const rest = options.length > 1 ? (1 - pick.p) / (options.length - 1) : 0;
  return Object.fromEntries(options.map((o) => [o, o === pick.choice ? pick.p : rest]));
}

export class FakeChoiceProvider implements DecisionProvider {
  readonly name = "fake-choice";
  readonly model: string;
  readonly calibrated = true;
  readonly requests: DecisionRequest[] = [];
  private readonly script: ChoiceScript;
  private readonly fail: DecisionDegradeReason | undefined;

  constructor(script: ChoiceScript, opts: { model?: string; fail?: DecisionDegradeReason } = {}) {
    this.script = script;
    this.model = opts.model ?? "fake-choice-1";
    this.fail = opts.fail;
  }

  async decide(req: DecisionRequest, _opts: DecideOptions): Promise<DecisionResponse> {
    this.requests.push(req);
    if (this.fail !== undefined) throw new DecisionProviderError(this.fail, `fake ${this.fail}`);
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (q.type !== "choice") continue;
      const options = Object.keys((q as DecisionChoiceQuestion).criteria);
      const pick = this.script(id, options, req);
      if (pick === undefined) continue;
      if (pick === "invalid") {
        answers[id] = { type: "choice", value: "", valid: false };
        continue;
      }
      const probabilities = distribution(options, pick);
      const n = options.length;
      answers[id] = {
        type: "choice",
        value: pick.choice,
        probabilities,
        confidence: n < 2 ? 1 : (n * pick.p - 1) / (n - 1),
        valid: true,
      };
    }
    return {
      model: this.model,
      answers,
      usage: { inputTokens: 50, outputTokens: 1 },
      calibrated: true,
      stateHash: "0".repeat(64),
    };
  }

  async ping(): Promise<DecisionPingResult> {
    return { ok: true, model: this.model, latencyMs: 1 };
  }
}

/** A `/v1/systemone` reply body answering every choice question by `script`. */
export function choiceReply(
  req: SystemOneRequestLog,
  script: ChoiceScript,
  model = "fake-model-1.0",
): Record<string, unknown> {
  const questions = req.body["questions"] as Record<
    string,
    { type: string; criteria?: Record<string, unknown> }
  >;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type !== "choice") continue;
    const options = Object.keys(q.criteria ?? {});
    const pick = script(id, options, null);
    if (pick === undefined || pick === "invalid") continue;
    answers[id] = {
      type: "choice",
      choice: pick.choice,
      probabilities: distribution(options, pick),
    };
  }
  return { model, answers, usage: { input_tokens: 123, output_tokens: 3 } };
}

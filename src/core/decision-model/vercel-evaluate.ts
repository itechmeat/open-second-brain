/**
 * `vercel-evaluate` adapter: the Vercel AI Gateway's provider-neutral
 * `POST <base_url>/v1/evaluate` (base `https://ai-gateway.vercel.sh`,
 * model `typesafe-ai/jev`).
 *
 * The route carries the same judgment as `/v1/systemone` with renamed
 * fields, mapped both ways here:
 *
 *   request   a `noul` question is sent as type `boolean`; `choice` and
 *             `score` keep their names and criteria shapes;
 *   response  a `boolean` answer carries its P(yes) as `probability` and
 *             is read back as a `noul` answer; `choice` and `score`
 *             answers may omit `confidence`, which is then recomputed;
 *             usage is camelCase (`inputTokens`, `outputTokens`); the
 *             gateway's cost arrives as a decimal string in
 *             `providerMetadata.gateway.cost` and is recorded as reported;
 *   errors    `{message, error_type}` bodies are never read: the status
 *             alone decides, as on every other route.
 *
 * No `providerOptions` are sent. The gateway's evaluation fallbacks can
 * rerun a request on a generative model, which would silently make the
 * answers uncalibrated, so this adapter never configures them.
 *
 * Transport, redaction, retries and limits are the `systemone` adapter's:
 * this class only renames fields, and the request leaves through that
 * module's `fetch` and egress guard call.
 */

import type { DecisionQuestion, DecisionUsage } from "./contract.ts";
import { SystemOneDecisionProvider } from "./systemone.ts";
import { finiteNonNegative, isRecord } from "./transport.ts";

/** The wire name of a question type on this route. */
function toEvaluateType(type: DecisionQuestion["type"]): string {
  return type === "noul" ? "boolean" : type;
}

/**
 * One `/v1/evaluate` answer in the `systemone` answer shape, so the shared
 * validator applies unchanged. Anything unrecognised passes through and
 * fails validation there.
 */
function fromEvaluateAnswer(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw["type"] !== "boolean") return raw;
  const { type: _type, probability, ...rest } = raw;
  return { ...rest, type: "noul", noul: probability };
}

/** Usage and gateway cost of an `/v1/evaluate` reply. */
function readEvaluateUsage(json: Record<string, unknown>): DecisionUsage {
  const usage = isRecord(json["usage"]) ? json["usage"] : {};
  const inputTokens = finiteNonNegative(usage["inputTokens"]);
  const outputTokens = finiteNonNegative(usage["outputTokens"]);
  const meta = isRecord(json["providerMetadata"]) ? json["providerMetadata"] : {};
  const gateway = isRecord(meta["gateway"]) ? meta["gateway"] : {};
  const rawCost = gateway["cost"];
  const parsed =
    typeof rawCost === "string" && /^\d+(\.\d+)?$/.test(rawCost.trim()) ? Number(rawCost) : rawCost;
  const costUsd = finiteNonNegative(parsed);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export class VercelEvaluateDecisionProvider extends SystemOneDecisionProvider {
  protected override path(): string {
    return "/v1/evaluate";
  }

  protected override wireQuestions(
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      out[id] = { ...q, type: toEvaluateType(q.type) };
    }
    return out;
  }

  protected override canonicalAnswer(raw: unknown): unknown {
    return fromEvaluateAnswer(raw);
  }

  protected override readUsage(json: Record<string, unknown>): DecisionUsage {
    return readEvaluateUsage(json);
  }
}

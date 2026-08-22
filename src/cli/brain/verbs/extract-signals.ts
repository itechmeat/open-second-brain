/**
 * `o2b brain extract-signals <session-ref>` (t_1dace26d): mine durable
 * taste signals out of an already-imported session's user turns.
 *
 * Two phases through one verb. Without a payload the verb is read-only and
 * prints the mining plan plus the single needs-llm-step envelope the
 * calling agent answers. With `--payload` / `--payload-file` it validates
 * that answer and writes the accepted items as speculative inbox signals.
 * OSB runs no model on either path.
 *
 * Exit codes: 0 on success, 1 on an operational failure or a refused
 * payload, 2 on usage errors.
 */

import { readFileSync } from "node:fs";

import {
  commitExtractedSignals,
  ExtractSignalsError,
  planExtractSignals,
} from "../../../core/brain/extract-signals.ts";
import { ResponseCheckError } from "../../../core/brain/response-checks.ts";
import { ResponseShapeError } from "../../../core/brain/response-shape.ts";
import {
  brainVerbContext,
  fail,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
  usageError,
} from "../helpers.ts";

const USAGE =
  "usage: o2b brain extract-signals <session-ref> [--payload <json> | --payload-file <path>] " +
  "[--agent <name>] [--vault <path>] [--json]";

/** Refusals the operator caused, reported without a stack. */
const NAMED_REFUSALS = [ExtractSignalsError, ResponseShapeError, ResponseCheckError] as const;

function isNamedRefusal(err: unknown): err is Error {
  return NAMED_REFUSALS.some((type) => err instanceof type);
}

export async function cmdBrainExtractSignals(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    payload: { type: "string" },
    "payload-file": { type: "string" },
    json: { type: "boolean" },
  });
  const sessionRef = positional[0];
  if (!sessionRef || sessionRef.trim() === "") return usageError(USAGE);
  const asJson = flags["json"] === true;

  try {
    const { config, vault } = brainVerbContext(flags);
    const rawPayload =
      typeof flags["payload"] === "string"
        ? (flags["payload"] as string)
        : typeof flags["payload-file"] === "string"
          ? readFileSync(flags["payload-file"] as string, "utf8")
          : null;

    if (rawPayload === null) {
      const plan = planExtractSignals(vault, sessionRef, { now: new Date() });
      if (asJson) {
        okJson({
          ok: true,
          session_id: plan.sessionId,
          generated_at: plan.generatedAt,
          boundary_decision: plan.boundaryDecision,
          turns_scanned: plan.turnsScanned,
          turns_mined: plan.turnsMined.map((t) => ({ turn_id: t.turnId, text: t.text })),
          cap: plan.cap,
          confidence_floor: plan.confidenceFloor,
          llm_step: plan.llmStep,
        });
        return 0;
      }
      ok(`session: ${plan.sessionId} (${plan.turnsScanned} imported turn(s))`);
      ok(`mining ${plan.turnsMined.length} user turn(s)`);
      ok(`limits: at most ${plan.cap} items, confidence >= ${plan.confidenceFloor}`);
      ok(`needs-llm-step: ${plan.llmStep.step} -> ${plan.llmStep.target_path}`);
      return 0;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      // Reported here rather than by the ingress: at this point the mistake
      // is the JSON the operator typed, and a path inside a payload the CLI
      // never parsed would not tell them what to fix.
      const message = "payload must be valid JSON";
      if (!asJson) return fail(message);
      okJson({ ok: false, message });
      return 1;
    }
    const res = commitExtractedSignals(vault, sessionRef, payload, {
      agent: resolveBrainAgent(flags, config),
      now: new Date(),
    });
    if (asJson) {
      okJson({
        ok: true,
        session_id: res.sessionId,
        written: res.written.map((w) => ({ id: w.id, path: w.path, topic: w.topic })),
        staged: res.staged,
        deduped: res.deduped,
        durability_rejected: res.durabilityRejected,
        rejected: res.rejected.map((r) => ({ topic: r.topic, reason: r.reason })),
      });
      return 0;
    }
    ok(
      `wrote ${res.written.length} signal(s)` +
        (res.staged > 0 ? ` (staged for approval)` : "") +
        `, deduped ${res.deduped}, durability-rejected ${res.durabilityRejected}`,
    );
    for (const r of res.rejected) ok(`rejected: ${r.topic} (${r.reason})`);
    return 0;
  } catch (err) {
    const message = isNamedRefusal(err)
      ? err.message
      : `extract-signals failed: ${(err as Error).message ?? String(err)}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

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
import { loadDedupIndex } from "../../../core/brain/dedup-hash.ts";

import {
  commitExtractedSignals,
  ExtractSignalsError,
} from "../../../core/brain/extract-signals.ts";
import {
  planExtractSignalsPrefiltered,
  recordExtractPrefilterCommit,
  resolveExtractPrefilterConfig,
} from "../../../core/brain/extract-signals-prefilter.ts";
import { resolveTokenImpactLedgerEnabled } from "../../../core/config.ts";
import { ResponseCheckError } from "../../../core/brain/response-checks.ts";
import { ResponseShapeError } from "../../../core/brain/response-shape.ts";
import {
  parsePayloadJson,
  PayloadJsonError,
  payloadStripNote,
  type PayloadStrip,
} from "../../../core/brain/payload-json.ts";
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

    const decisionModel = resolveExtractPrefilterConfig(vault, config);
    if (rawPayload === null) {
      const plan = await planExtractSignalsPrefiltered(vault, sessionRef, {
        now: new Date(),
        decisionModel,
        tokenImpactEnabled: decisionModel !== null && resolveTokenImpactLedgerEnabled(config),
      });
      if (asJson) {
        okJson({
          ok: true,
          session_id: plan.sessionId,
          generated_at: plan.generatedAt,
          boundary_decision: plan.boundaryDecision,
          turns_scanned: plan.turnsScanned,
          turns_mined: plan.turnsMined.map((t) => ({
            turn_id: t.turnId,
            text: t.text,
            timestamp: t.timestamp,
          })),
          cap: plan.cap,
          confidence_floor: plan.confidenceFloor,
          llm_step: plan.llmStep,
          // Present only while the decision-model turn pre-filter is on.
          ...(plan.turnsDropped !== undefined ? { turns_dropped: plan.turnsDropped } : {}),
          ...(plan.skipped !== undefined
            ? {
                skipped: {
                  reason: plan.skipped.reason,
                  turns_dropped: plan.skipped.turnsDropped,
                },
              }
            : {}),
          ...(plan.decisionModel !== undefined
            ? { decision_model: { degraded: plan.decisionModel.degraded } }
            : {}),
        });
        return 0;
      }
      ok(`session: ${plan.sessionId} (${plan.turnsScanned} imported turn(s))`);
      if (plan.skipped !== undefined) {
        ok(
          `nothing to mine: the decision-model pre-filter dropped all ` +
            `${plan.skipped.turnsDropped} user turn(s)`,
        );
        return 0;
      }
      ok(`mining ${plan.turnsMined.length} user turn(s)`);
      if (plan.turnsDropped !== undefined && plan.turnsDropped.length > 0) {
        ok(`dropped by the decision-model pre-filter: ${plan.turnsDropped.length} turn(s)`);
      }
      ok(`limits: at most ${plan.cap} items, confidence >= ${plan.confidenceFloor}`);
      if (plan.llmStep !== null) {
        ok(`needs-llm-step: ${plan.llmStep.step} -> ${plan.llmStep.target_path}`);
      }
      return 0;
    }

    let payload: unknown;
    let strip: PayloadStrip | undefined;
    try {
      const parsed = parsePayloadJson(rawPayload);
      payload = parsed.payload;
      strip = parsed.strip;
    } catch (error) {
      // Reported here rather than by the ingress: at this point the mistake
      // is the JSON the operator typed, and a path inside a payload the CLI
      // never parsed would not tell them what to fix. A refusal after a
      // strip attempt names the attempt (t_dac8bf7e).
      if (error instanceof PayloadJsonError) {
        if (!asJson) return fail(error.message);
        okJson({ ok: false, message: error.message });
        return 1;
      }
      throw error;
    }
    const now = new Date();
    const res = commitExtractedSignals(vault, sessionRef, payload, {
      agent: resolveBrainAgent(flags, config),
      now,
      // Loaded with parallel I/O here, where the caller can await it; the
      // commit's own fallback is the synchronous walk.
      dedup: await loadDedupIndex(vault),
    });
    recordExtractPrefilterCommit(vault, decisionModel, res, now);
    if (asJson) {
      okJson({
        ok: true,
        session_id: res.sessionId,
        written: res.written.map((w) => ({ id: w.id, path: w.path, topic: w.topic })),
        staged: res.staged,
        deduped: res.deduped,
        durability_rejected: res.durabilityRejected,
        rejected: res.rejected.map((r) => ({ topic: r.topic, reason: r.reason })),
        // Present only when a leading <think> block was stripped (t_dac8bf7e).
        ...(strip !== undefined ? { note: payloadStripNote(strip) } : {}),
      });
      return 0;
    }
    ok(
      `wrote ${res.written.length} signal(s)` +
        (res.staged > 0 ? ` (staged for approval)` : "") +
        `, deduped ${res.deduped}, durability-rejected ${res.durabilityRejected}`,
    );
    if (strip !== undefined) ok(payloadStripNote(strip));
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

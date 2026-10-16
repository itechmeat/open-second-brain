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
 * Every commit records its outcome in the session mining ledger over the
 * session's current mined turns. The plan records the hash of the turns it
 * offered as a pending survey, so a barren commit leaves the zero-yield
 * tombstone without any relay - but only while the session still holds
 * the surveyed turns; turns imported after the plan withhold it, and the
 * commit says so. `--surveyed-turns-hash` optionally passes the answered
 * plan's `surveyed_turns_hash` back as a check: a malformed value refuses
 * the commit, and a value the session no longer matches writes the
 * signals but no mining record, and says so.
 *
 * A session already mined at its current content that yielded nothing
 * accepted carries a tombstone in the session mining ledger; its plan phase
 * returns the recorded breakdown instead of an envelope (reason
 * `mining_tombstone`), and `--force` bypasses that gate for the one plan
 * call it is given to. A commit that succeeds but cannot record its
 * zero-yield tombstone still succeeds, and names the ledger failure.
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
  EXTRACT_MINING_TOMBSTONE_SKIP_REASON,
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
  normalizeFlagString,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
  usageError,
} from "../helpers.ts";

const USAGE =
  "usage: o2b brain extract-signals <session-ref> [--payload <json> | --payload-file <path>] " +
  "[--surveyed-turns-hash <sha256>] [--force] [--agent <name>] [--vault <path>] [--json]";

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
    "surveyed-turns-hash": { type: "string" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const sessionRef = positional[0];
  if (!sessionRef || sessionRef.trim() === "") return usageError(USAGE);
  const asJson = flags["json"] === true;
  const surveyedTurnsHashRaw = normalizeFlagString(flags["surveyed-turns-hash"]);
  if (flags["surveyed-turns-hash"] !== undefined && surveyedTurnsHashRaw === null) {
    return usageError(
      `${USAGE}\nerror: --surveyed-turns-hash must be a non-empty string when provided`,
    );
  }

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
        // The re-mine escape: bypass the zero-yield tombstone for this one
        // plan call (no payload here, so this IS the plan call).
        force: flags["force"] === true,
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
          // The hash of the material this plan offered; a commit may pass it
          // back with --surveyed-turns-hash to check the session did not
          // change in between.
          surveyed_turns_hash: plan.surveyedTurnsHash,
          cap: plan.cap,
          confidence_floor: plan.confidenceFloor,
          llm_step: plan.llmStep,
          // Present only while the decision-model turn pre-filter is on.
          ...(plan.turnsDropped !== undefined ? { turns_dropped: plan.turnsDropped } : {}),
          ...(plan.skipped !== undefined
            ? {
                skipped: {
                  reason: plan.skipped.reason,
                  ...(plan.skipped.turnsDropped !== undefined
                    ? { turns_dropped: plan.skipped.turnsDropped }
                    : {}),
                  ...(plan.skipped.miningOutcome !== undefined
                    ? {
                        mining_outcome: {
                          written: plan.skipped.miningOutcome.written,
                          staged: plan.skipped.miningOutcome.staged,
                          deduped: plan.skipped.miningOutcome.deduped,
                          durability_rejected: plan.skipped.miningOutcome.durabilityRejected,
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(plan.decisionModel !== undefined
            ? { decision_model: { degraded: plan.decisionModel.degraded } }
            : {}),
          // Present only when the plan could not record its survey; a
          // barren commit then needs --surveyed-turns-hash to tombstone.
          ...(plan.surveyRecordFailure !== undefined
            ? { survey_record_failure: plan.surveyRecordFailure }
            : {}),
        });
        return 0;
      }
      ok(`session: ${plan.sessionId} (${plan.turnsScanned} imported turn(s))`);
      if (plan.skipped !== undefined) {
        if (plan.skipped.reason === EXTRACT_MINING_TOMBSTONE_SKIP_REASON) {
          const outcome = plan.skipped.miningOutcome!;
          // The recorded breakdown is the evidence, so every field is
          // rendered from the record, never asserted from a hardcoded
          // zero: a hand-restored or future-written entry must read the
          // same in text as the --json surface prints it.
          ok(
            `nothing to mine: this session was already mined at its current content and ` +
              `yielded nothing (written ${outcome.written}, staged ${outcome.staged}, ` +
              `deduped ${outcome.deduped}, ` +
              `durability-rejected ${outcome.durabilityRejected}); ` +
              `re-run with --force to re-mine it`,
          );
          return 0;
        }
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
        ok(`surveyed turns hash: ${plan.surveyedTurnsHash}`);
        if (plan.surveyRecordFailure !== undefined) {
          ok(
            `survey not recorded (${plan.surveyRecordFailure}); pass --surveyed-turns-hash ` +
              `with the commit so a barren answer still records its tombstone`,
          );
        }
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
      // The answered plan's surveyed hash, when relayed: a check that the
      // session did not change since the plan. Absent, the commit checks
      // the survey the plan recorded instead.
      ...(surveyedTurnsHashRaw !== null ? { surveyedTurnsHash: surveyedTurnsHashRaw } : {}),
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
        // Present only when the commit succeeded but the zero-yield
        // tombstone could not be recorded.
        ...(res.miningLedgerFailure !== undefined
          ? { mining_ledger_failure: res.miningLedgerFailure }
          : {}),
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
    if (res.miningLedgerFailure !== undefined) {
      ok(`mining ledger not updated: ${res.miningLedgerFailure}`);
    }
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

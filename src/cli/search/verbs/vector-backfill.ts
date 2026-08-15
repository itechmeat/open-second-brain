/**
 * `o2b search vector-backfill` — run the vector phase on its own
 * (provenance-at-the-boundary, unit F).
 *
 * Indexing does not compute vectors unless it is asked to: no automatic
 * `indexVault` call site requests embeddings, and only the explicit
 * `--embeddings` flag on `search index` / `search reindex` reaches a
 * provider. A vault therefore accumulates chunks with no `embeddings`
 * row perfectly normally, and until now the only way to fill them was to
 * re-index the whole vault. This verb fills them and nothing else.
 *
 * Dry-run is the DEFAULT; `--apply` is the only path that contacts a
 * provider or writes a vector. The shape follows
 * `brain/verbs/authored-at-backfill.ts` line for line, including the log
 * append whose failure is reported on stderr rather than swallowed.
 *
 * ## Where the interrupt can and cannot land
 *
 * This verb holds a real cancellation handle, and it is the only one of
 * the long verbs whose answer needed checking rather than assuming.
 * `interruptIsObservable` answers per OPERATION, and this pass runs under
 * `OPERATION.reindex`, which the table marks observable - but the table's
 * reason is about the index BUILDERS, so it has to hold here on its own
 * terms. It does, for the half of the run that is long:
 * `runEmbeddingPhase` awaits a provider round trip per super-batch and
 * calls `throwIfAborted` at every batch boundary, which is real I/O and
 * therefore a real yield to the event loop.
 *
 * It does NOT hold for the plan: counting vectorless chunks is a
 * synchronous SQLite query between two awaits, so a keystroke landing
 * inside it is not observed at a checkpoint. That is not a hole this verb
 * papers over - it is exactly what `release()` is for. An interrupt that
 * arrived and that nothing acknowledged is re-raised there, so the run
 * ends the way the un-suppressed keystroke would have, rather than
 * returning 0 for a pass the operator stopped. The plan is milliseconds;
 * the embedding phase is the part an operator would ever want to stop.
 */

import { appendLogEvent } from "../../../core/brain/log.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
  SafeguardAbortError,
} from "../../../core/brain/safeguard.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { resolveAgentName } from "../../../core/config.ts";
import {
  semanticCapabilityIsBlocked,
  semanticCapabilityLabel,
  SEMANTIC_VECTOR_CODE,
} from "../../../core/search/capability-tier.ts";
import {
  planVectorBackfill,
  type VectorBackfillResult,
} from "../../../core/search/vector-backfill.ts";
import { emitNextStep } from "../../advisory-rail.ts";
import { onInterrupt, reportInterrupted } from "../../interrupt.ts";
import { info, ok } from "../../output.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import {
  flagBoolean,
  flagString,
  parseFlags,
  resolveConfig,
  resolveConfigPath,
  searchAdvisoryStream,
  VAULT_FLAGS,
} from "../helpers.ts";

/**
 * The state this verb leaves an operator in when work remains: an index
 * holding chunks with no vector. Its registered exit is this same verb
 * under `--apply`, which is the whole point of naming it.
 */
const VECTORS_PENDING = SEMANTIC_VECTOR_CODE.pending;

/** JSON payload shape. Snake case, matching every other search verb. */
function jsonForResult(result: VectorBackfillResult): Record<string, unknown> {
  return {
    dry_run: !result.applied,
    capability_tier: result.capability.tier,
    capability_code: result.capability.code,
    chunks_total: result.chunksTotal,
    pending: result.pending,
    embedded: result.embedded,
    retries: result.retries,
    // Absent rather than zero when the model carries no known price: a
    // missing price is not a free run.
    ...(result.costKnown ? { estimated_cost_usd: result.estimatedCostUsd } : {}),
  };
}

async function renderHuman(result: VectorBackfillResult): Promise<void> {
  if (result.applied) {
    ok(`vector-backfill: wrote ${result.embedded} of ${result.pending} pending vector(s)`);
  } else {
    ok(
      `vector-backfill dry-run: ${result.pending} of ${result.chunksTotal} chunk(s) have no vector`,
    );
  }
  if (result.costKnown && result.pending > 0) {
    info(`  estimated cost: $${result.estimatedCostUsd.toFixed(4)}`);
  }
  if (result.retries > 0) info(`  provider retries: ${result.retries}`);
  // What the operator CONFIGURED, resolved from the registry - never a
  // sentence built here.
  if (semanticCapabilityIsBlocked(result.capability)) {
    info(`  semantic capability: ${await semanticCapabilityLabel(result.capability.code)}`);
  }
}

export async function cmdSearchVectorBackfill(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    apply: { type: "boolean" },
    "force-cost": { type: "boolean" },
    progress: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const apply = flagBoolean(flags, "apply");
  const jsonRequested = flagBoolean(flags, "json");

  // Opt-in, for the reason the index builders give: attaching a sink by
  // default would change the stderr of every existing invocation.
  const observation = flagBoolean(flags, "progress")
    ? attachProgress({ command: "search", argv: ["vector-backfill"], jsonRequested })
    : null;
  reportProgressRefusal(observation);

  // Everything that can throw happens BEFORE the handle exists: `release`
  // removes process-global listeners and settles a signal nobody acted
  // on, and a throw between `onInterrupt()` and the `try` would skip it.
  const interrupt = onInterrupt(OPERATION.reindex);
  let result: VectorBackfillResult;
  try {
    result = await planVectorBackfill(cfg, {
      apply,
      forceCost: flagBoolean(flags, "force-cost"),
      // The three seams this module declared and nothing produced until
      // now. The deadline is the `reindex` budget off the same ladder the
      // builders read, because this pass IS that run's embedding phase on
      // its own - a second key for one phase would let the two disagree.
      safeguard: createSafeguard({
        operation: OPERATION.reindex,
        timeoutMs: resolveSafeguardTimeoutMs(OPERATION.reindex, flagString(flags, "config")),
      }),
      signal: interrupt.signal,
      ...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
    });
  } catch (err) {
    if (err instanceof SafeguardAbortError) return reportInterrupted(interrupt, err, jsonRequested);
    throw err;
  } finally {
    interrupt.release();
  }

  if (apply && result.embedded > 0) {
    try {
      appendLogEvent(cfg.vault, {
        timestamp: isoSecond(new Date()),
        eventType: BRAIN_LOG_EVENT_KIND.vectorBackfill,
        body: {
          agent: resolveAgentName(resolveConfigPath(flags)),
          embedded: String(result.embedded),
          pending: String(result.pending),
          chunks_total: String(result.chunksTotal),
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append vector-backfill log failed: ${(err as Error).message}\n`,
      );
    }
  }

  // Work remains exactly when the run did not consume it.
  const pendingAfter = result.pending - result.embedded;
  // WHICH exit, though, depends on what is in the operator's way. Naming
  // `--apply` while the credential is missing would advise a command that
  // cannot succeed, so a blocked tier names the tier's own exit instead.
  const exitCode = semanticCapabilityIsBlocked(result.capability)
    ? result.capability.code
    : VECTORS_PENDING;

  if (jsonRequested) {
    process.stdout.write(
      JSON.stringify({
        ...jsonForResult(result),
        ...(pendingAfter > 0 ? nextCommandField(exitCode) : {}),
      }) + "\n",
    );
  } else {
    await renderHuman(result);
  }
  if (pendingAfter > 0) {
    emitNextStep(exitCode, searchAdvisoryStream(argv, jsonRequested));
  }
  return 0;
}

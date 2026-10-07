/**
 * `o2b search vector-backfill` — run the vector phase on its own
 * (provenance-at-the-boundary, unit F).
 *
 * Indexing does not compute vectors unless it is asked to: no automatic
 * `indexVault` call site requests embeddings, and only the explicit
 * `--embeddings` flag on `search index` / `search reindex` reaches a
 * provider - with ONE deliberate exception: the quiet-window maintenance
 * lane asks for the embedding phase whenever the resolved config can
 * reach a provider (t_9d155d0e), announcing the predicted spend before
 * the pass and receipting the actual spend after it, leashed by the
 * embedding cost gate unless force is set. A vault therefore still
 * accumulates chunks with no `embeddings` row perfectly normally outside
 * that lane, and the only way to fill them without re-indexing the whole
 * vault is this verb. It fills them and nothing else.
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

import {
  COST_GATE_KEY,
  EMBEDDING_GATE_REASON,
  FORCE_COST_FLAG,
  formatEstimatedUsd,
  type EmbeddingGateReason,
} from "../../../core/search/embedding-spend.ts";
import {
  EMBEDDING_PRICE_MODEL_KEY,
  EMBEDDING_PRICE_RATE_KEY,
} from "../../../core/search/embeddings/pricing.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { NEXT_COMMAND_KEY, resolveNextStep } from "../../../core/brain/next-step.ts";
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
import { advisoryIsLegal, emitNextStep, type AdvisoryStream } from "../../advisory-rail.ts";
import { shellQuote } from "../../cron-recipe.ts";
import { onInterrupt, reportInterrupted } from "../../interrupt.ts";
import { info, ok } from "../../output.ts";
import { attachProgress, reportProgressRefusal } from "../../progress-rail.ts";
import {
  flagBoolean,
  flagString,
  flagStrings,
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

/** The repeatable flag that limits the run to a vault-relative path prefix. */
const PATH_FLAG = "path";

/** A prefix that needs no shell quoting when echoed in a command. */
const PLAIN_SHELL_WORD = /^[A-Za-z0-9_./-]+$/u;

/**
 * `command` with one `--path <prefix>` per prefix, quoted only when
 * needed. Null on Windows when a prefix needs quoting: the quoting is
 * POSIX, which neither cmd.exe nor PowerShell reads back as the same
 * word, so the caller prints {@link RERUN_WITH_SCOPE_LINE}, which names
 * no command, instead of advising one that would not run as printed or
 * would run unscoped.
 */
export function scopedNextCommand(
  command: string,
  pathPrefixes: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const plain = (prefix: string) => PLAIN_SHELL_WORD.test(prefix);
  if (platform === "win32" && !pathPrefixes.every(plain)) return null;
  return [
    command,
    ...pathPrefixes.map(
      (prefix) => `--${PATH_FLAG} ${plain(prefix) ? prefix : shellQuote(prefix)}`,
    ),
  ].join(" ");
}

/**
 * The line that replaces a scoped next step Windows cannot run as
 * printed. Deliberately not a command: a scope-free `--apply` copied as
 * printed would widen the spend to the whole vault.
 */
export const RERUN_WITH_SCOPE_LINE = `next: rerun this command with --apply and the same --${PATH_FLAG} flags`;

/** The next step a backfill run advises, resolved before anything prints. */
export interface BackfillNextStep {
  /** The registered exit the advice names. */
  readonly exitCode: string;
  /**
   * The runnable command, also the `next_command` JSON value. Absent
   * when the code has no command or when the scope cannot be quoted on
   * this platform.
   */
  readonly command: string | undefined;
  /** True when a scope was dropped because the platform cannot quote it. */
  readonly scopeDropped: boolean;
}

/**
 * Resolve the advice for `result`. A scoped run repeats its scope: the
 * registered `--apply` alone would widen the spend to the whole vault.
 * The command stays UNFORCED even when the gate would refuse it: the
 * gate is the operator's decision, so `--force-cost` is named only in
 * the human remedy line, never in a command a machine reader runs.
 */
export function backfillNextStep(
  result: Pick<VectorBackfillResult, "capability" | "pathPrefixes">,
  platform: NodeJS.Platform = process.platform,
): BackfillNextStep {
  // WHICH exit depends on what is in the operator's way. Naming
  // `--apply` while the credential is missing would advise a command that
  // cannot succeed, so a blocked tier names the tier's own exit instead.
  const exitCode = semanticCapabilityIsBlocked(result.capability)
    ? result.capability.code
    : VECTORS_PENDING;
  const registered = resolveNextStep(exitCode)?.nextCommand;
  if (registered === undefined || exitCode !== VECTORS_PENDING) {
    return { exitCode, command: registered, scopeDropped: false };
  }
  const scoped = scopedNextCommand(registered, result.pathPrefixes, platform);
  return scoped === null
    ? { exitCode, command: undefined, scopeDropped: true }
    : { exitCode, command: scoped, scopeDropped: false };
}

/**
 * Print `advice` on a human stream: the command, or, for a dropped
 * scope, the one rerun line that names no runnable command.
 */
export function emitBackfillNextStep(advice: BackfillNextStep, stream: AdvisoryStream): void {
  if (!advice.scopeDropped) {
    emitNextStep(advice.exitCode, stream, advice.command);
    return;
  }
  if (resolveNextStep(advice.exitCode) !== null && advisoryIsLegal(stream)) {
    info(RERUN_WITH_SCOPE_LINE);
  }
}

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
    // Null rather than zero when the model carries no known price: a
    // missing price is not a free run.
    estimated_cost_usd: result.estimatedCostUsd,
    price_source: result.priceSource,
    // Present only for a scoped run, so an unscoped payload is unchanged.
    ...(result.pathPrefixes.length > 0 ? { path_prefixes: result.pathPrefixes } : {}),
    ...(result.unmatchedPathPrefixes.length > 0
      ? { unmatched_path_prefixes: result.unmatchedPathPrefixes }
      : {}),
    // Present only when the unforced gate would refuse, and only for a
    // run that reached the provider, so an unblocked payload is unchanged.
    ...(result.blocked ? { gate_blocked: true, gate_reason: result.reason } : {}),
    ...(result.spend !== null
      ? {
          spend: {
            model: result.spend.model,
            tokens: result.spend.tokens,
            estimated_usd: result.spend.estimatedUsd,
            price_source: result.spend.priceSource,
            forced: result.spend.forced,
          },
        }
      : {}),
  };
}

/** What lifts a gate refusal besides `--force-cost`, per reason. */
function gateRemedy(reason: EmbeddingGateReason | null): string {
  return reason === EMBEDDING_GATE_REASON.unpriced
    ? `set ${EMBEDDING_PRICE_MODEL_KEY} and ${EMBEDDING_PRICE_RATE_KEY}`
    : `raise ${COST_GATE_KEY}`;
}

async function renderHuman(result: VectorBackfillResult): Promise<void> {
  if (result.applied) {
    ok(`vector-backfill: wrote ${result.embedded} of ${result.pending} pending vector(s)`);
  } else {
    ok(
      `vector-backfill dry-run: ${result.pending} of ${result.chunksTotal} chunk(s) have no vector`,
    );
  }
  if (result.pathPrefixes.length > 0) info(`  scope: ${result.pathPrefixes.join(", ")}`);
  if (result.pending > 0) info(`  estimated cost: ${formatEstimatedUsd(result.estimatedCostUsd)}`);
  if (!result.applied && result.blocked) {
    info(
      `  cost gate: would refuse (${result.reason}); add ${FORCE_COST_FLAG} or ${gateRemedy(result.reason)}`,
    );
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
    // Spelled out, not `[PATH_FLAG]`: the flag census reads literal keys.
    path: { type: "string-array" },
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
      pathPrefixes: flagStrings(flags, PATH_FLAG),
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

  const advice = backfillNextStep(result);
  const pendingAfter = result.pending - result.embedded;

  // A typo'd scope has nothing pending and would otherwise read like a
  // fully embedded one; stderr, so the JSON on stdout stays parseable.
  for (const prefix of result.unmatchedPathPrefixes) {
    process.stderr.write(`warning: scope ${prefix} matches no indexed document\n`);
  }
  if (jsonRequested) {
    process.stdout.write(
      JSON.stringify({
        ...jsonForResult(result),
        ...(pendingAfter > 0 && advice.command !== undefined
          ? { [NEXT_COMMAND_KEY]: advice.command }
          : {}),
      }) + "\n",
    );
  } else {
    await renderHuman(result);
  }
  if (pendingAfter > 0) emitBackfillNextStep(advice, searchAdvisoryStream(argv, jsonRequested));
  return 0;
}

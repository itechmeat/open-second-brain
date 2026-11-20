#!/usr/bin/env -S bun
/**
 * SessionStart / PostCompact hook: inject the current `Brain/active.md`
 * digest as `additionalContext` so the agent sees the live set of
 * confirmed and quarantined preferences without explicitly calling
 * `brain_query` first.
 *
 * Three lanes share the surface, and the order between them is the point.
 * `Brain/standing-rules.md` is operator-authored and goes FIRST, read
 * outside the fail-open memory load so it survives a memory-layer
 * failure and never enters the inject cache. The scoped operator rules
 * for this session's project and this device
 * (`Brain/standing-rules/{project,host}/<key>.md`) come next, also read
 * outside the boundary and never cached - the cache key is vault-wide, so
 * a cached block could replay one project's rules in another - but
 * charged against the injection budget. Everything after them - runtime
 * notices, `active.md`, `lessons.md` - is what the agent learned about
 * itself, assembled inside the fail-open boundary and charged against
 * what is left of the configured injection budget.
 *
 * One ceiling over all of it: the host takes at most 10,000 characters of
 * context from one hook and replaces a longer value with a file path and
 * a preview, so the whole payload of one run - every lane above, the
 * notices, the framing and the separators - is sized to
 * `HOST_CONTEXT_CEILING_CHARS` (`hooks/lib/host-context-ceiling.ts`).
 * The memory bodies share what the lanes ahead of them leave; a payload
 * the operator's caps still push past it is cut there with the usual
 * truncation notice. Only a payload the re-delivery lane splits is sized
 * per part instead.
 *
 * Contract (identical for Claude Code and Codex):
 *   stdin: hook payload JSON. The vault path is resolved from the
 *     persisted Open Second Brain config (env `VAULT_DIR` → config
 *     `vault:` field), not from the payload — both runtimes route the
 *     hook through the same `o2b-hook` PATH-shim, so this stays
 *     runtime-agnostic.
 *   stdout: JSON of the shape
 *     {
 *       "hookSpecificOutput": {
 *         "hookEventName": "SessionStart" | "PostCompact",
 *         "additionalContext": "<standing-rules block, the scoped rules
 *                               block, then the budgeted memory context:
 *                               runtime notices, the rendered
 *                               Brain/active.md body, lessons>"
 *       }
 *     }
 *
 * Quiet on the failure modes that leave it with nothing to say (no config,
 * no vault, malformed payload): the hook exits 0 with no output and the
 * runtime proceeds as if it never ran. A SessionStart that silently fails
 * is far less harmful than one that aborts the session with a stderr
 * trace. The agent simply does not get the per-session preferences nudge —
 * exactly the v0.9.0 behaviour.
 *
 * A missing `Brain/active.md` is NOT one of those modes any more, and
 * neither is a memory layer that threw. The standing-rules lane is read
 * outside the fail-open boundary, so a vault whose operator wrote rules
 * still emits them with an empty memory context behind them; a rules file
 * that exists and cannot be read emits the block that says so. The empty
 * exit is reached only when there are NEITHER standing rules NOR memory,
 * and `tests/hooks/active-inject.test.ts` asserts it.
 */

import { resolveAnswerQuoteCheckModes } from "../src/core/brain/quote-check-modes.ts";
import {
  resolveQuoteCheckEnabled,
  resolveRecallInjectEnabled,
  resolveRegroundPartChars,
  resolveRegroundPartsEnabled,
} from "../src/core/config.ts";
import { healCliSymlinks } from "../src/cli/install-cli.ts";
import { ensureVaultCurrent } from "../src/core/maintenance/ensure-current.ts";
import { hookAuditDir } from "../src/core/brain/paths.ts";
import { loadInjectContextFailOpen } from "../src/core/brain/inject-failopen.ts";
import { armProcessCeiling, decisionWaitMs, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { asHookPayload, readHookInput, type HookPayloadBase } from "./lib/stdin.ts";
import { beginInjectionEpoch, digestNotePaths, isRealSessionId } from "./lib/injection-ledger.ts";
import { LANE_BUDGETED, renderStandingBlock, type InjectionMeter } from "./lib/standing-block.ts";
import { buildAgentContextBlocks } from "./lib/agent-context-blocks.ts";
import {
  assembleActiveContext,
  BLOCK_SEPARATOR,
  createInjectionMeter,
  joinBlocks,
  MEMORY_SOURCES,
  renderScopedBlock,
  resolveInjectionLimits,
  scopedSectionCap,
  SOURCE_ACTIVE_BODY,
  SOURCE_LESSONS_BODY,
  type InjectionLimits,
} from "./lib/active-context.ts";
import { pruneHookStateFiles } from "./lib/session-state.ts";
import { detectHookRuntime } from "./lib/detect.ts";
import { splitRegroundParts } from "../src/core/brain/reground-parts.ts";
import { isContextEventName } from "./lib/context-events.ts";
import { emitContextReceipt } from "../src/core/brain/context-receipts.ts";
import { estimateTokens } from "../src/core/brain/text/tokenizer.ts";
import type { InjectContextSource } from "../src/core/brain/inject-failopen.ts";
import { resolveHookTarget } from "./lib/hook-vault.ts";
import { fitHostContext, HOST_CONTEXT_CEILING_CHARS } from "./lib/host-context-ceiling.ts";

/**
 * Best-effort hook audit line. Never throws: a failure to record must never
 * disturb the fail-soft hook contract, and a hung filesystem is exactly when
 * this runs, so it is wrapped defensively.
 */
function auditHook(vault: string | null, action: string, details: Record<string, unknown>): void {
  if (vault === null) return;
  try {
    appendAuditRecord(hookAuditDir(vault), {
      timestamp: new Date().toISOString(),
      actor: "active-inject",
      action,
      target: "SessionStart",
      ok: false,
      details,
    });
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const hookStartedAtMs = Date.now();
  // Arm the process self-watchdog first so a hang anywhere below (vault
  // resolution, a stalled read, an overrunning assembly) still self-terminates
  // at the ceiling with a clean exit instead of orphaning the hook process.
  let auditVault: string | null = null;
  const disarm = armProcessCeiling({
    ceilingMs: resolveHookCeilingMs(),
    onExpire: () => auditHook(auditVault, "hook_ceiling_exceeded", { hook: "active-inject" }),
  });
  try {
    let payload;
    try {
      payload = asHookPayload(await readHookInput());
    } catch {
      return;
    }

    // The hook is registered separately for each event; the payload's
    // `hook_event_name` tells us which one fired. Default to
    // `SessionStart` only when the field is missing entirely (e.g. an
    // empty stdin payload, or a runtime that doesn't populate the name).
    const hookEventName =
      typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0
        ? payload.hook_event_name
        : "SessionStart";

    // Default-closed allowlist: only event names whose output schema
    // accepts `additionalContext` may produce stdout. Emitting under
    // any other name (PostCompact included) is rejected by the runtime
    // and echoes the full payload back as a validation error - the
    // post-compaction path is the SessionStart `compact` matcher.
    if (!isContextEventName(hookEventName)) return;

    // Self-heal the ~/.local/bin CLI symlinks on SessionStart only: a plugin
    // update can leave them dangling or pointing at an old version. Runs from
    // the current checkout (resolved via $CLAUDE_PLUGIN_ROOT); strictly
    // best-effort, and gated to SessionStart so PostCompact does not trigger
    // avoidable filesystem side effects. Never affects the injection below.
    if (hookEventName === "SessionStart") {
      try {
        healCliSymlinks();
      } catch {
        // ignore — opportunistic; must never disrupt the session
      }
    }

    // With no vault the hook injects what the store's folds render and
    // skips the vault's own maintenance (design D14, task 2.10).
    const target = resolveHookTarget();
    if (target === null) return;
    const { vault, hasVault } = target;
    auditVault = vault;

    // Hands-off post-upgrade maintenance on SessionStart: migrate a stale
    // _brain.yaml/_BRAIN.md and rebuild a stale/missing search index (the
    // reindex runs detached so it survives this short-lived hook). Best-effort,
    // never blocks injection. In background mode the synchronous part (brain
    // upgrade + spawning the reindex) completes before this awaits.
    if (hookEventName === "SessionStart" && hasVault) {
      // Fire-and-forget: never put maintenance on the hook's critical path.
      // background:true spawns the reindex detached; we do not await the result.
      void ensureVaultCurrent(vault, { background: true }).catch(() => {
        // opportunistic; must never disrupt the session
      });
    }

    const limits = resolveInjectionLimits(vault);
    const meter = createInjectionMeter(limits.injectBudgetChars);

    // The operator's standing rules, read BEFORE and OUTSIDE the fail-open
    // load below. That single placement buys three properties at once:
    // the block never reaches the budgeter, so the configured injection
    // budget cannot shrink it; a throw inside memory assembly cannot take
    // it down with it; and it is never written to the inject cache, so a
    // stale constitution can never be served from that cache while the
    // live one is unreadable. With `reground_parts_enabled` on, the tail of
    // a split payload (this block included, when it spills past part 1) is
    // queued in the per-session hook-state file for re-grounding, until the
    // next SessionStart replaces the queue.
    const standingBlock = renderStandingBlock(vault, limits.standingRulesMaxChars, meter);

    // The scoped operator rules for the project this session runs in (the
    // payload's `cwd`, else this process's) and for this device. Outside
    // the fail-open boundary and never cached, like the constitution; but
    // CHARGED: its length comes off the budget the memory body gets, and
    // the whole block - header and notices included - fits that budget:
    // the cap over its sections is what is left once they are reserved.
    const workspaceDir =
      typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
    const scopedBlock = renderScopedBlock(vault, workspaceDir, scopedSectionCap(limits), meter);
    // The topic heads and pinned context of this session (task 4.2): both
    // charged against the injection budget, between the scoped rules and
    // the memory context. Fail-open: without a store, a project, topics
    // or pinned context the digest is byte-identical to before.
    // The head_select wait ends at half the ceiling, so the memory
    // context and the output still fit before the ceiling exits.
    const remainingMs = decisionWaitMs(resolveHookCeilingMs(), Date.now() - hookStartedAtMs);
    // The host takes at most HOST_CONTEXT_CEILING_CHARS of context from one
    // hook (hooks/lib/host-context-ceiling.ts), so everything this run
    // emits - the operator's rules, the topic heads, the pinned context,
    // the notices and both memory bodies - shares that one ceiling. Only a
    // payload the re-delivery lane will split may run past it: each part
    // fits its own ceiling there.
    const startsEpoch = hookEventName === "SessionStart";
    const splits = startsEpoch && regroundSplitApplies(payload);
    const hostRoom = splits
      ? null
      : Math.max(0, HOST_CONTEXT_CEILING_CHARS - separated(standingBlock.length));
    const agentBlocks = await buildAgentContextBlocks({
      vault,
      workspaceDir,
      limits: agentContextLimits(limits, scopedBlock.length, hostRoom),
      meter,
      remainingMs,
    });
    const headsBlock = agentBlocks.headsBlock;
    const pinnedBlock = agentBlocks.pinnedBlock;
    const memoryBudget = Math.max(
      0,
      limits.injectBudgetChars - scopedBlock.length - headsBlock.length - pinnedBlock.length,
    );
    // What the blocks ahead of the memory context leave of the ceiling.
    const memoryRoom =
      hostRoom === null
        ? undefined
        : Math.max(
            0,
            HOST_CONTEXT_CEILING_CHARS -
              separated(joinBlocks([standingBlock, scopedBlock, headsBlock, pinnedBlock]).length),
          );

    // Fail-open context load: assemble the injected body inside a guard that
    // degrades to the last-good cache (or empty) on any error, never emitting
    // a partial or poisoned payload. A successful non-empty body refreshes the
    // last-good snapshot.
    const { context: memoryContext, source } = await loadInjectContextFailOpen({
      vault,
      key: "active",
      assemble: () =>
        assembleActiveContext(vault, memoryBudget, meter, {
          startsSession: hookEventName === "SessionStart",
          ...(memoryRoom !== undefined ? { roomChars: memoryRoom } : {}),
        }),
      audit: (degradedSource) =>
        auditHook(vault, "inject_failopen_degraded", {
          hook: "active-inject",
          source: degradedSource,
        }),
    });
    // The early return now fires only when there are NEITHER standing rules
    // NOR memory - a vault with rules and a broken memory layer still speaks.
    const blocks = [standingBlock, scopedBlock, headsBlock, pinnedBlock, memoryContext];
    const context = joinBlocks(blocks);

    // Only a SessionStart starts an injection epoch: the same hook run on
    // another context event (an operator-registered UserPromptSubmit) must
    // neither clear the recall set nor replace the re-delivery queue, so it
    // injects unsplit and leaves the ledger alone.
    const epochInput: RecordInjectionEpochInput = {
      sessionId: payload.session_id,
      startSource: payload.source,
      loaderSource: source,
      memoryContext,
      meter,
    };
    if (context.length === 0) {
      // Nothing to emit, but the earlier context is gone all the same: the
      // epoch still clears the recall set and any stale re-delivery queue.
      if (startsEpoch) {
        recordInjectionEpoch(vault, epochInput, {
          parts: [""],
          partsDropped: 0,
          droppedChars: 0,
          partCeilingChars: 0,
          meter: null,
        });
      }
      return;
    }

    // Chunked re-delivery (off by default). A split payload is committed
    // to the ledger BEFORE stdout: if the queue cannot be written, parts
    // 2..n would be lost, so the hook emits the whole payload instead.
    let delivery: Delivery = fitDelivery(
      startsEpoch
        ? planDelivery(payload, blocks, context)
        : { parts: [context], partsDropped: 0, droppedChars: 0, partCeilingChars: 0, meter: null },
      context,
    );
    let ledgerWritten: boolean | null = null;
    if (delivery.parts.length > 1) {
      ledgerWritten = recordInjectionEpoch(vault, epochInput, delivery);
      if (!ledgerWritten) delivery = fitDelivery(unsplitDelivery(delivery, context), context);
    }

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: delivery.parts[0]!,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");

    // After stdout, like the meter: the ledger serves later hooks in this
    // session and must never delay or alter what was injected. A split
    // whose queue could not be written went out whole; retrying the epoch
    // with that unsplit delivery (no queue) still clears the previous
    // epoch's queue and recall set when the failure was transient.
    if (startsEpoch && ledgerWritten !== true) {
      ledgerWritten = recordInjectionEpoch(vault, epochInput, delivery);
    }
    if (ledgerWritten === true && startSourceOf(payload.source) === "startup") {
      pruneHookStateFilesSafe(vault);
    }

    // Measure LAST, so the injected context is already on stdout before the
    // meter can spend a millisecond of the ceiling. See recordInjectionSize.
    recordInjectionSize(vault, {
      hookEventName,
      loaderSource: source,
      // What went out: the payload cut to the host's ceiling when it was
      // cut, the whole context when it was split.
      context: delivery.parts.length === 1 ? delivery.parts[0]! : context,
      meter,
      reground: delivery.meter,
      sessionId: isRealSessionId(payload.session_id) ? payload.session_id : undefined,
    });
  } finally {
    disarm();
  }
}

// ----- injection ledger (recall-injection-lifecycle) -----------------------

interface RecordInjectionEpochInput {
  readonly sessionId: unknown;
  /** The SessionStart `source` (startup, resume, clear, compact), when sent. */
  readonly startSource: unknown;
  readonly loaderSource: InjectContextSource;
  readonly memoryContext: string;
  readonly meter: InjectionMeter;
}

/**
 * Start a new injection epoch in the per-session ledger: record the note
 * paths this injection committed for delivery - the emitted part and the
 * queued parts, never the parts the splitter dropped past its cap -
 * clear the recall-inject set and replace the re-delivery queue, so the
 * recall brief neither repeats the digest nor carries dedupe state across
 * a compaction or a clear.
 *
 * Written only when a consumer exists (`recall_inject_enabled`,
 * `reground_parts_enabled`, or the answer-time quote check with its
 * `active` phase not `off` - on by default, so a default install writes
 * it) and the host sent a real session id. Returns whether it was written.
 *
 * FAIL-SOFT. Never throws; nothing here can change the exit code.
 */
function recordInjectionEpoch(
  vault: string,
  input: RecordInjectionEpochInput,
  delivery: Delivery,
): boolean {
  try {
    if (!isRealSessionId(input.sessionId)) return false;
    if (!ledgerHasConsumer(vault)) return false;
    const startSource = startSourceOf(input.startSource);
    const committed = delivery.parts.join(BLOCK_SEPARATOR);
    return beginInjectionEpoch(vault, input.sessionId, {
      epoch: `${startSource}:${Date.now()}`,
      emittedPaths: digestNotePaths({
        emittedText: committed,
        activeBodyEmitted: bodyEmitted(input, SOURCE_ACTIVE_BODY, delivery),
        lessonsBodyEmitted: bodyEmitted(input, SOURCE_LESSONS_BODY, delivery),
      }),
      regroundParts: delivery.parts.slice(1),
      partCeilingChars: delivery.partCeilingChars,
    });
  } catch {
    // The ledger is an optimisation for later hooks. A failure to record
    // must never disturb an injection.
    return false;
  }
}

/**
 * Whether a later hook of this session reads the injection ledger: the
 * recall brief (its dedupe), the re-delivery carrier (its queue), or the
 * Stop hook's quote check, whose `active` phase takes its candidate notes
 * from the emitted paths and has none without them. Settings that cannot
 * be read count as a consumer: the quote check raises on them by name, and
 * a missing ledger would only add a silent second failure.
 */
function ledgerHasConsumer(vault: string): boolean {
  if (resolveRecallInjectEnabled() || resolveRegroundPartsEnabled()) return true;
  if (!resolveQuoteCheckEnabled()) return false;
  try {
    return resolveAnswerQuoteCheckModes(vault).active !== "off";
  } catch {
    return true;
  }
}

/** The SessionStart `source` values the host documents. */
const START_SOURCES = new Set(["startup", "resume", "clear", "compact"]);

/**
 * The payload's SessionStart `source`, mapped to the closed set the host
 * documents and `unknown` for anything else, so a host-supplied string
 * never reaches the ledger epoch, the marker or the audit lines unbounded.
 */
function startSourceOf(source: unknown): string {
  return typeof source === "string" && START_SOURCES.has(source) ? source : "unknown";
}

/**
 * Drop scope files of long-gone sessions. Called on a `startup` that just
 * wrote the ledger, so the sweep is paid once per new session and only by
 * installs that use the ledger.
 */
function pruneHookStateFilesSafe(vault: string): void {
  try {
    pruneHookStateFiles(vault);
  } catch {
    // best-effort housekeeping
  }
}

/**
 * Whether a memory sub-body reached the payload. A fresh assembly says so
 * through the meter; a body served from the last-good cache cannot be
 * attributed, so any non-empty cached memory counts as delivered - the
 * conservative side for dedupe, which only ever suppresses a repeat.
 *
 * When the split dropped parts past its cap, the dropped tail is the end of
 * the payload, and the memory context is the payload's last block. A body
 * counts only when it ends before that tail, measured by its position: a
 * body cut short was not delivered whole, even when its last line repeats
 * a line that was.
 *
 * The two truncation paths differ on purpose. A body cut by the injection
 * budget (`budgetActiveBody`) still counts whole when no part was dropped,
 * so a recall candidate on a span past the budget cut is filtered as
 * already shown. The cost is small: preference paths come only from the
 * preference bullets actually emitted, so a preference past the cut stays
 * eligible; only the `Brain/active.md` and `Brain/lessons.md` paths
 * themselves are over-suppressed for the epoch.
 */
function bodyEmitted(input: RecordInjectionEpochInput, name: string, delivery: Delivery): boolean {
  const end = bodyEndInMemory(input, name);
  if (end === null) return false;
  return input.memoryContext.length - end >= delivery.droppedChars;
}

/**
 * Where the named sub-body ends in the memory context, or `null` when it
 * did not reach it. A cached memory context cannot be attributed, so it
 * ends where the memory context ends. A fresh one is the meter's memory
 * sub-bodies joined in order; a body that is not where that join puts it
 * is not attributed.
 */
function bodyEndInMemory(input: RecordInjectionEpochInput, name: string): number | null {
  const memory = input.memoryContext;
  if (input.loaderSource !== "fresh") return memory.length > 0 ? memory.length : null;
  let end = 0;
  for (const source of input.meter.sources) {
    if (!MEMORY_SOURCES.has(source.name) || source.text.length === 0) continue;
    const start = end === 0 ? 0 : end + BLOCK_SEPARATOR.length;
    end = start + source.text.length;
    if (source.name === name) return memory.slice(start, end) === source.text ? end : null;
  }
  return null;
}

// ----- chunked re-delivery (recall-injection-lifecycle) --------------------

/** Receipt fields for the re-delivery lane, under `extra.injection`. */
interface RegroundMeter {
  readonly utf16_chars: number;
  /** `null` on a runtime without the `reground-deliver` carrier. */
  readonly part_ceiling_chars: number | null;
  readonly parts_total: number;
  readonly parts_dropped: number;
  readonly over_budget: boolean;
  /**
   * Set only when a planned split fell back to the whole payload because its
   * queue could not be written, so that case reads apart from a plain
   * over-ceiling payload.
   */
  readonly reground_fallback?: typeof REGROUND_FALLBACK_LEDGER_WRITE_FAILED;
  /**
   * Set only when a part-ceiling key held a value out of range or not an
   * integer: the rejected config keys, so the ceiling that ran is explained.
   */
  readonly config_invalid?: ReadonlyArray<string>;
}

/** {@link RegroundMeter.reground_fallback} value for a failed queue write. */
const REGROUND_FALLBACK_LEDGER_WRITE_FAILED = "ledger_write_failed";

interface Delivery {
  /** parts[0] goes to stdout now; the rest are queued for `reground-deliver`. */
  readonly parts: ReadonlyArray<string>;
  /** Parts the splitter cut past its cap: neither emitted nor queued. */
  readonly partsDropped: number;
  /** Length of the joined context's tail those parts held; 0 when none were dropped. */
  readonly droppedChars: number;
  /** The ceiling the parts were cut to; 0 when no split applies. */
  readonly partCeilingChars: number;
  /** `null` while `reground_parts_enabled` is off, so the receipt keeps its shape. */
  readonly meter: RegroundMeter | null;
}

/**
 * Decide how the joined context is delivered. Only Claude Code and Codex
 * have the carrier registered, so only they are split; every other
 * runtime, and any payload that fits the ceiling, gets the single
 * payload exactly as without this lane. A host that sends no session id
 * cannot have a queue, so it is never split either.
 */
function planDelivery(
  payload: HookPayloadBase,
  blocks: ReadonlyArray<string>,
  context: string,
): Delivery {
  const single: Delivery = {
    parts: [context],
    partsDropped: 0,
    droppedChars: 0,
    partCeilingChars: 0,
    meter: null,
  };
  try {
    if (!resolveRegroundPartsEnabled()) return single;
    const runtime = detectHookRuntime(payload);
    if ((runtime !== "claudecode" && runtime !== "codex") || !isRealSessionId(payload.session_id)) {
      return {
        ...single,
        meter: {
          utf16_chars: context.length,
          part_ceiling_chars: null,
          parts_total: 1,
          parts_dropped: 0,
          over_budget: false,
        },
      };
    }
    // A configured part ceiling above the host's takes the host's: a part
    // longer than it would reach the model as a file path and a preview
    // (part 1 here, the queued parts in reground-deliver, whose last guard
    // would cut the tail off). A smaller configured ceiling stands.
    const resolved = resolveRegroundPartChars(runtime);
    const ceiling = Math.min(resolved.chars, HOST_CONTEXT_CEILING_CHARS);
    const invalid = resolved.invalid;
    const split = splitRegroundParts(blocks, ceiling, joinBlocks, BLOCK_SEPARATOR);
    return {
      parts: split.parts,
      partsDropped: split.partsDropped,
      droppedChars: split.droppedChars,
      partCeilingChars: ceiling,
      meter: {
        utf16_chars: split.utf16Chars,
        part_ceiling_chars: ceiling,
        parts_total: split.parts.length,
        parts_dropped: split.partsDropped,
        over_budget: split.overBudget,
        ...(invalid.length > 0 ? { config_invalid: invalid } : {}),
      },
    };
  } catch {
    return single;
  }
}

/**
 * Whether the re-delivery lane will split this payload when it runs past
 * the part ceiling: the lane is on, the host is one with the carrier
 * registered, and it sent a session id. The same test `planDelivery`
 * makes, asked before the assembly so the blocks are sized for it.
 */
function regroundSplitApplies(payload: HookPayloadBase): boolean {
  try {
    if (!resolveRegroundPartsEnabled()) return false;
    const runtime = detectHookRuntime(payload);
    return (runtime === "claudecode" || runtime === "codex") && isRealSessionId(payload.session_id);
  } catch {
    return false;
  }
}

/** `chars` plus the separator that joins one more block after them, when there are any. */
function separated(chars: number): number {
  return chars > 0 ? chars + BLOCK_SEPARATOR.length : 0;
}

/** Where the notice of a payload cut to the host's ceiling points. */
const HOST_CUT_POINTER = " Call `brain_context` for the full preference set.";

/**
 * The last guard: a single payload that still runs past the host's
 * ceiling (an operator's caps set larger than it holds) is cut to it,
 * with the notice, and the cut tail counts as not delivered - as the
 * parts the splitter drops do. A split delivery is left as it is.
 */
function fitDelivery(delivery: Delivery, context: string): Delivery {
  if (delivery.parts.length !== 1) return delivery;
  const part = delivery.parts[0]!;
  const fitted = fitHostContext(part, HOST_CUT_POINTER);
  if (fitted === part) return delivery;
  const kept = fitted.slice(0, fitted.lastIndexOf("\n\n"));
  return {
    ...delivery,
    parts: [fitted],
    droppedChars: Math.max(delivery.droppedChars, context.length - kept.length),
  };
}

/** The whole payload in one part, for a split whose queue could not be written. */
function unsplitDelivery(delivery: Delivery, context: string): Delivery {
  return {
    parts: [context],
    partsDropped: 0,
    droppedChars: 0,
    partCeilingChars: delivery.partCeilingChars,
    meter:
      delivery.meter === null
        ? null
        : {
            ...delivery.meter,
            parts_total: 1,
            parts_dropped: 0,
            over_budget: true,
            reground_fallback: REGROUND_FALLBACK_LEDGER_WRITE_FAILED,
          },
  };
}

// ----- injection-size meter (context-integrity-gates, Unit H) --------------

/**
 * Where the payload assembly lives. The lane vocabulary moved to
 * hooks/lib/standing-block.ts with the standing renderer, and the
 * assembly itself - the limits, the scoped block, the budgeted active
 * and lessons bodies with the runtime notices - moved to
 * hooks/lib/active-context.ts, which the subagent carrier imports to
 * compose the same payload. This file keeps only the metering and
 * receipt layer; the sub-body identifiers and the join helper it names
 * in its records are re-used from the assembly module.
 */

const UTF8 = new TextEncoder();

function byteLength(text: string): number {
  return UTF8.encode(text).length;
}

interface RecordInjectionSizeInput {
  readonly hookEventName: string;
  readonly loaderSource: InjectContextSource;
  readonly context: string;
  readonly meter: InjectionMeter;
  readonly reground: RegroundMeter | null;
  /**
   * The hook payload's session id, already validated by the caller -
   * the join key the receipt's `session_id` payload member carries
   * (t_f8510c55), so the read surface can join this receipt to the
   * session's `reply_presence` records by exact key. `undefined` when
   * the host sent nothing real; the key then stays absent, never
   * invented.
   */
  readonly sessionId: string | undefined;
}

/**
 * Record what this hook actually injected: total bytes and tokens, plus
 * per-source attribution when the assembly is what got emitted.
 *
 * SCOPE. This measures THIS hook only. `gap-agenda`, `recall-inject`, and
 * `nav-inject` are separate processes with their own `additionalContext`,
 * so the session preamble as a whole is larger than any figure recorded
 * here and cannot be assembled from inside this process.
 *
 * ATTRIBUTION. The measurement is taken after the fail-open loader
 * returns, so it describes the emitted bytes rather than the attempted
 * ones. When the loader degraded to its last-good cache the ASSEMBLED
 * sub-bodies in `meter` were never emitted (assembly threw), so the
 * record says `sources_measured: false` and drops them - a per-source
 * breakdown of a body that was replaced by a cached one would be a
 * finding that never happened. The sources produced outside the boundary
 * (the standing and scoped rules) are kept in that case, because they did
 * reach the payload; omitting them would understate an injection that
 * really happened.
 *
 * FAIL-SOFT. The whole body sits in one try/catch. The receipt sink takes
 * a continuity-store lock and writes to disk; contention, a read-only
 * vault, or a directory that is really a file must not become a new
 * failure surface on the SessionStart path. Nothing here can change the
 * hook's exit code, and the injected context is already on stdout by the
 * time this runs.
 */
function recordInjectionSize(vault: string, input: RecordInjectionSizeInput): void {
  try {
    const measured = input.loaderSource === "fresh";
    const totalBytes = byteLength(input.context);
    emitContextReceipt(vault, {
      options: {
        host: "hook",
        trigger: "session_inject",
        // The receipt-to-presence join key (t_f8510c55): recorded when the
        // host named a session, absent otherwise.
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      },
      items: input.meter.sources
        .filter((source) => measured || source.outsideBoundary)
        .map((source) => ({
          id: source.name,
          bytes: byteLength(source.text),
          tokens: estimateTokens(source.text),
        })),
      finalText: input.context,
      ...(input.meter.budgetChars !== null && measured
        ? {
            budget: {
              // The CONFIGURED ceiling, unchanged by the scoped block.
              inject_budget_chars: input.meter.budgetChars,
              // The active and lessons bodies are each charged against
              // `inject_budget_chars - scoped_rules_chars`; the scoped
              // block itself is counted here when it rendered.
              budgeted_source_count: budgetedSourceCount(input.meter),
              scoped_rules_chars: input.meter.scopedRulesChars,
            },
          }
        : {}),
      extra: {
        injection: {
          hook_event: input.hookEventName,
          loader_source: input.loaderSource,
          sources_measured: measured,
          total_bytes: totalBytes,
          total_tokens: estimateTokens(input.context),
          ...input.reground,
        },
      },
    });
  } catch {
    // The meter is diagnostics. A failure to record must never disturb an
    // injection that already succeeded.
  }
}

/** How many recorded sources were charged against `inject_budget_chars`. */
function budgetedSourceCount(meter: InjectionMeter): number {
  return meter.sources.filter((source) => source.lane === LANE_BUDGETED).length;
}

main().catch(() => {
  // Never crash the runtime; the session start should proceed
  // regardless of any hook misbehaviour.
});

/**
 * The heads and pinned caps inside the injection budget: together they
 * take at most half of what the budget leaves after the scoped rules, so
 * the confirmed preferences keep the other half. When the two caps
 * together exceed that half, both shrink in proportion (each block fits
 * its cap whole, fence and cut line included). At the default budget the
 * caps stay as configured while the scoped rules take at most 2400
 * characters. Under the host's ceiling (`hostRoom`, what the standing
 * rules leave of it; `null` when the payload will be split) the budget is
 * the smaller of the two, so large standing rules shrink the heads and
 * the pinned context before they crowd out the preferences.
 */
function agentContextLimits(
  limits: InjectionLimits,
  scopedChars: number,
  hostRoom: number | null,
): InjectionLimits {
  // Under the host's ceiling the budget is what the standing rules leave
  // of it, when that is less than the configured injection budget.
  const budget =
    hostRoom === null ? limits.injectBudgetChars : Math.min(limits.injectBudgetChars, hostRoom);
  const room = Math.floor(Math.max(0, budget - scopedChars) / 2);
  const wanted = limits.topicHeadsMaxChars + limits.pinnedMaxChars;
  if (wanted <= room) return limits;
  const share = (cap: number): number => Math.floor((cap * room) / wanted);
  return {
    ...limits,
    topicHeadsMaxChars: share(limits.topicHeadsMaxChars),
    pinnedMaxChars: share(limits.pinnedMaxChars),
  };
}

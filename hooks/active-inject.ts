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

import { existsSync, readFileSync } from "node:fs";

import {
  resolveRecallInjectEnabled,
  resolveRegroundPartChars,
  resolveRegroundPartsEnabled,
  resolveVault,
} from "../src/core/config.ts";
import { parseFrontmatterText } from "../src/core/vault.ts";
import {
  brainActivePath,
  brainLessonsPath,
  brainStandingRulesPath,
  hookAuditDir,
} from "../src/core/brain/paths.ts";
import { budgetActiveBody } from "../src/core/brain/active-budget.ts";
import {
  INJECT_BUDGET_CHARS_DEFAULT,
  loadBrainConfig,
  resolveScopedRulesMaxChars,
  resolveStandingRulesMaxChars,
} from "../src/core/brain/policy.ts";
import {
  readScopedRules,
  SCOPED_RULES_HEADER,
  SCOPED_RULES_NOTICE_RESERVE,
} from "../src/core/brain/scoped-rules.ts";
import { resolveHostScope, resolveProjectScope } from "../src/core/brain/scope-identity.ts";
import {
  readStandingRules,
  renderStandingRules,
  renderStandingRulesFailure,
} from "../src/core/brain/standing-rules.ts";
import { healCliSymlinks } from "../src/cli/install-cli.ts";
import { ensureVaultCurrent } from "../src/core/maintenance/ensure-current.ts";
import { armProcessCeiling, resolveHookCeilingMs } from "./lib/process-ceiling.ts";
import { appendAuditRecord } from "../src/core/reliability/audit.ts";
import { loadInjectContextFailOpen } from "../src/core/brain/inject-failopen.ts";
import { collectRuntimeNotices, renderRuntimeNotices } from "../src/core/brain/runtime-notices.ts";
import { asHookPayload, readHookInput, type HookPayloadBase } from "./lib/stdin.ts";
import { beginInjectionEpoch, digestNotePaths, isRealSessionId } from "./lib/injection-ledger.ts";
import { pruneHookStateFiles } from "./lib/session-state.ts";
import { detectHookRuntime } from "./lib/detect.ts";
import { splitRegroundParts } from "../src/core/brain/reground-parts.ts";
import { isContextEventName } from "./lib/context-events.ts";
import {
  emitContextReceipt,
  RECEIPT_ITEM_ACTIVE_BODY,
  RECEIPT_ITEM_LESSONS_BODY,
  RECEIPT_ITEM_SCOPED_RULES,
  RECEIPT_ITEM_STANDING_RULES,
} from "../src/core/brain/context-receipts.ts";
import { estimateTokens } from "../src/core/brain/text/tokenizer.ts";
import type { InjectContextSource } from "../src/core/brain/inject-failopen.ts";
import type { BrainConfig } from "../src/core/brain/types.ts";

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

    const vault = resolveVault();
    if (vault === null) return;
    auditVault = vault;

    // Hands-off post-upgrade maintenance on SessionStart: migrate a stale
    // _brain.yaml/_BRAIN.md and rebuild a stale/missing search index (the
    // reindex runs detached so it survives this short-lived hook). Best-effort,
    // never blocks injection. In background mode the synchronous part (brain
    // upgrade + spawning the reindex) completes before this awaits.
    if (hookEventName === "SessionStart") {
      // Fire-and-forget: never put maintenance on the hook's critical path.
      // background:true spawns the reindex detached; we do not await the result.
      void ensureVaultCurrent(vault, { background: true }).catch(() => {
        // opportunistic; must never disrupt the session
      });
    }

    const limits = resolveInjectionLimits(vault);
    const meter: InjectionMeter = {
      sources: [],
      configuredBudgetChars: limits.injectBudgetChars,
      budgetChars: null,
      scopedRulesChars: 0,
    };

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
    const memoryBudget = Math.max(0, limits.injectBudgetChars - scopedBlock.length);

    // Fail-open context load: assemble the injected body inside a guard that
    // degrades to the last-good cache (or empty) on any error, never emitting
    // a partial or poisoned payload. A successful non-empty body refreshes the
    // last-good snapshot.
    const { context: memoryContext, source } = await loadInjectContextFailOpen({
      vault,
      key: "active",
      assemble: () => assembleActiveContext(vault, memoryBudget, meter),
      audit: (degradedSource) =>
        auditHook(vault, "inject_failopen_degraded", {
          hook: "active-inject",
          source: degradedSource,
        }),
    });
    // The early return now fires only when there are NEITHER standing rules
    // NOR memory - a vault with rules and a broken memory layer still speaks.
    const blocks = [standingBlock, scopedBlock, memoryContext];
    const context = joinBlocks(blocks);

    // Only a SessionStart starts an injection epoch: the same hook run on
    // another context event (an operator-registered UserPromptSubmit) must
    // neither clear the recall set nor replace the re-delivery queue, so it
    // injects unsplit and leaves the ledger alone.
    const startsEpoch = hookEventName === "SessionStart";
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
    let delivery: Delivery = startsEpoch
      ? planDelivery(payload, blocks, context)
      : { parts: [context], partsDropped: 0, droppedChars: 0, partCeilingChars: 0, meter: null };
    let ledgerWritten: boolean | null = null;
    if (delivery.parts.length > 1) {
      ledgerWritten = recordInjectionEpoch(vault, epochInput, delivery);
      if (!ledgerWritten) delivery = unsplitDelivery(delivery, context);
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
      context,
      meter,
      reground: delivery.meter,
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
 * Written only when a consumer exists (`recall_inject_enabled` or
 * `reground_parts_enabled`) and the host sent a real session id, so a
 * default install gets no new disk write. Returns whether it was written.
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
    if (!resolveRecallInjectEnabled() && !resolveRegroundPartsEnabled()) return false;
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
    const { chars: ceiling, invalid } = resolveRegroundPartChars(runtime);
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
 * Which ceiling a sub-body was charged against, and whether it was
 * emitted at all when the memory assembly failed.
 *
 *   - EXEMPT: produced outside the fail-open boundary. Charged against
 *     its own cap, not `inject_budget_chars`, and emitted whatever the
 *     memory layer does - so it is the one lane still real in a
 *     degraded injection.
 *   - BUDGETED: charged against `inject_budget_chars`. The scoped rules
 *     are charged first and their length is subtracted; the active and
 *     lessons bodies are each charged against what is left, which is why
 *     the receipt records the count and the scoped length.
 *   - UNBUDGETED: assembled inside the boundary but not charged (the
 *     runtime notices, which are bounded by the number of conditions
 *     that can hold rather than by a character count).
 */
const LANE_EXEMPT = "exempt";
const LANE_BUDGETED = "budgeted";
const LANE_UNBUDGETED = "unbudgeted";

type InjectionLane = typeof LANE_EXEMPT | typeof LANE_BUDGETED | typeof LANE_UNBUDGETED;

/**
 * One injected sub-body, captured while it is still a separate string.
 *
 * The parts are joined into one string before emission, so this is the
 * only point at which per-source attribution exists at all. The name is
 * a stable structural identifier, never derived from content.
 */
interface InjectionSource {
  readonly name: string;
  readonly text: string;
  readonly lane: InjectionLane;
  /**
   * Produced outside the fail-open boundary (the standing and scoped
   * rules), so it reached the payload even when the memory body was
   * replaced by the cache, and stays in a degraded receipt.
   */
  readonly outsideBoundary: boolean;
}

/** Mutable accumulator threaded through the assembly, read after it returns. */
interface InjectionMeter {
  readonly sources: InjectionSource[];
  /** The configured `inject_budget_chars`, before the scoped rules are charged. */
  readonly configuredBudgetChars: number;
  /**
   * The configured `inject_budget_chars` once a budgeted body was measured
   * under it; `null` while nothing was.
   */
  budgetChars: number | null;
  /** Length of the rendered scoped-rules block, subtracted from the budget; 0 when absent. */
  scopedRulesChars: number;
}

/** Sub-body identifiers recorded per injection. Structural, not content-derived. */
const SOURCE_STANDING_RULES = RECEIPT_ITEM_STANDING_RULES;
const SOURCE_SCOPED_RULES = RECEIPT_ITEM_SCOPED_RULES;
const SOURCE_RUNTIME_NOTICES = "runtime-notices";
const SOURCE_ACTIVE_BODY = RECEIPT_ITEM_ACTIVE_BODY;
const SOURCE_LESSONS_BODY = RECEIPT_ITEM_LESSONS_BODY;

/** The memory sub-bodies, in the order `assembleActiveContext` joins them. */
const MEMORY_SOURCES: ReadonlySet<string> = new Set([
  SOURCE_RUNTIME_NOTICES,
  SOURCE_ACTIVE_BODY,
  SOURCE_LESSONS_BODY,
]);

/** Blank line between two injected blocks. */
const BLOCK_SEPARATOR = "\n\n";

/** Join the non-empty blocks in order; an all-empty list yields "". */
function joinBlocks(blocks: ReadonlyArray<string>): string {
  return blocks.filter((block) => block.length > 0).join(BLOCK_SEPARATOR);
}

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
      options: { host: "hook", trigger: "session_inject" },
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

/**
 * The two character ceilings this hook applies, resolved once.
 *
 * They are separate numbers because they govern separate lanes: the
 * injection budget rations what the agent recalled about itself, the
 * standing-rules cap bounds what the operator wrote. Reading them
 * together is only an efficiency - one config open instead of two.
 */
interface InjectionLimits {
  readonly injectBudgetChars: number;
  readonly standingRulesMaxChars: number;
  readonly scopedRulesMaxChars: number;
}

/**
 * The cap over the scoped block's sections: the configured cap, clamped
 * to what the injection budget leaves once the block's header and the
 * room for its notices are reserved, floor 0. With it the whole block -
 * not only its sections - fits the budget it is charged against.
 */
function scopedSectionCap(limits: InjectionLimits): number {
  return Math.max(
    0,
    Math.min(
      limits.scopedRulesMaxChars,
      limits.injectBudgetChars - SCOPED_RULES_HEADER.length - SCOPED_RULES_NOTICE_RESERVE,
    ),
  );
}

/**
 * Resolve both ceilings, falling back to their documented defaults when
 * `_brain.yaml` cannot be read.
 *
 * Both `_brain.yaml` failures - ABSENT and PRESENT BUT UNREADABLE -
 * resolve to the defaults here, and the unreadable one is not silent for
 * it: the runtime-notice channel runs inside the assembly below and puts
 * `brain_config_unreadable` immediately after the standing-rules block
 * and ahead of every budgeted body, naming the file and the parse
 * failure. It no longer heads the payload - the operator's own rules do -
 * but it still precedes everything these ceilings are applied to, which
 * is the property the argument rests on. The split the `load*ConfigSafe`
 * readers make is already made on this surface; making it a second time
 * here would be a second channel saying the same thing.
 *
 * Raising instead would report less, not more. A throw on this line
 * would escape the hook entirely and emit nothing at all, so the
 * condition would go from stated to invisible.
 *
 * The one quiet path left is `OPEN_SECOND_BRAIN_RUNTIME_NOTICES=false`,
 * which is the operator switching the channel off by name.
 */
function resolveInjectionLimits(vault: string): InjectionLimits {
  let cfg: BrainConfig | null = null;
  try {
    cfg = loadBrainConfig(vault);
  } catch {
    // absorbed deliberately - see the note above
  }
  return {
    injectBudgetChars: cfg?.active?.inject_budget_chars ?? INJECT_BUDGET_CHARS_DEFAULT,
    standingRulesMaxChars: resolveStandingRulesMaxChars(cfg),
    scopedRulesMaxChars: resolveScopedRulesMaxChars(cfg),
  };
}

/**
 * Render the operator's standing-rules block, or the explicit statement
 * that it is unavailable.
 *
 * An absent or empty file yields "" and the lane simply does not appear.
 * A read that FAILED yields a block naming the path and the reason: the
 * agent must never be able to mistake "the operator wrote no rules" for
 * "the rules could not be read", and this is the surface where that
 * distinction has to be made, because there is no second channel the
 * operator would see.
 */
function renderStandingBlock(vault: string, maxChars: number, meter: InjectionMeter): string {
  const path = brainStandingRulesPath(vault);
  let block: string;
  try {
    const rules = readStandingRules(vault, { maxChars });
    if (rules === null) return "";
    block = renderStandingRules(rules);
  } catch (err) {
    block = renderStandingRulesFailure(path, err);
  }
  meter.sources.push({
    name: SOURCE_STANDING_RULES,
    text: block,
    lane: LANE_EXEMPT,
    outsideBoundary: true,
  });
  return block;
}

/**
 * Render the scoped operator rules for this session's project and this
 * device, or "" when none applies.
 *
 * Project and host only: a harness file renders on the MCP surfaces,
 * where the harness comes from the packaged `--harness`. This hook is
 * shared by Claude Code and Codex through one `o2b-hook` shim and has no
 * harness signal of its own, so it resolves the harness to nothing and
 * matches no harness file.
 *
 * Never throws: a failure to resolve the scope or read the directory
 * must not take the constitution and the memory context down with it.
 */
function renderScopedBlock(
  vault: string,
  workspaceDir: string,
  maxChars: number,
  meter: InjectionMeter,
): string {
  let block: string;
  try {
    let host: { readonly host: string | null; readonly unreadable: boolean };
    try {
      host = resolveHostScope(undefined);
    } catch {
      host = { host: null, unreadable: true };
    }
    block = readScopedRules(
      vault,
      { project: resolveProjectScope(workspaceDir, vault), harness: null, host: host.host },
      { maxChars, hostUnreadable: host.unreadable },
    ).text;
  } catch {
    return "";
  }
  if (block.length === 0) return "";
  meter.sources.push({
    name: SOURCE_SCOPED_RULES,
    text: block,
    lane: LANE_BUDGETED,
    outsideBoundary: true,
  });
  meter.scopedRulesChars = block.length;
  // A budgeted source was measured under the configured ceiling, so the
  // receipt carries the budget block even when no memory body follows.
  meter.budgetChars = meter.configuredBudgetChars;
  return block;
}

/**
 * Assemble the injected context body. Returns an empty string when there is
 * legitimately nothing to inject (no active.md, empty body); throws on a
 * genuine read error so the fail-open loader degrades to the last-good cache.
 *
 * Every non-empty sub-body is recorded into `meter` as it is produced -
 * the join below is where per-source attribution stops existing.
 */
function assembleActiveContext(vault: string, budget: number, meter: InjectionMeter): string {
  // Runtime-state notices ride the same injection surface as active.md so the
  // agent is proactively aware of a degraded/transient condition (semantic
  // search fell back to lexical, index missing/rebuilding, read-only vault)
  // without a diagnostic round-trip. Best-effort and computed with no network;
  // an empty list keeps the injected body byte-identical to before.
  const noticesBlock = renderRuntimeNotices(collectRuntimeNotices(vault));
  if (noticesBlock.length > 0) {
    meter.sources.push({
      name: SOURCE_RUNTIME_NOTICES,
      text: noticesBlock,
      lane: LANE_UNBUDGETED,
      outsideBoundary: false,
    });
  }

  const activePath = brainActivePath(vault);
  const activeBody = existsSync(activePath) ? readActiveBody(vault, activePath, budget, meter) : "";

  return joinBlocks([noticesBlock, activeBody]);
}

/**
 * Read + budget the active.md / lessons.md body. Returns an empty string when
 * the body is empty; throws on a genuine read error (permissions, fs stall) so
 * the fail-open loader degrades to the last-good cache.
 */
function readActiveBody(
  vault: string,
  activePath: string,
  budget: number,
  meter: InjectionMeter,
): string {
  const body = readFileSync(activePath, "utf8");

  // Drop the `kind: brain-active / generated_at` frontmatter - it
  // carries no signal for the agent, only provenance for tooling.
  const [, fmBody] = parseFrontmatterText(body);
  const trimmed = fmBody.trim();
  if (trimmed.length === 0) return "";

  // Injection budget (token-diet): a large preference set must not flood
  // the session preamble. Resolved once in `resolveInjectionLimits`,
  // which also carries the reasoning for why a config failure lands on
  // the default here rather than raising. Recorded on the meter only at
  // this point, because a vault with no `active.md` charged nothing
  // against it and a receipt naming a budget nothing was measured under
  // would be a number with no measurement behind it. The CONFIGURED
  // ceiling is recorded, not the `budget` argument: that is what is left
  // after the scoped rules were charged, and the receipt reports the two
  // separately (`inject_budget_chars`, `scoped_rules_chars`).
  meter.budgetChars = meter.configuredBudgetChars;

  // Auto-load the lessons digest alongside active.md so the agent gets
  // the unified, signed, recency-scored corpus (preferences + dead-ends)
  // on the same SessionStart surface. Fail-soft and budgeted separately:
  // a missing / unreadable / oversized lessons file must never disturb
  // the active-preferences injection above.
  const lessonsBody = readLessonsBody(brainLessonsPath(vault), budget);

  const budgetedActive = budgetActiveBody(trimmed, budget);
  meter.sources.push({
    name: SOURCE_ACTIVE_BODY,
    text: budgetedActive,
    lane: LANE_BUDGETED,
    outsideBoundary: false,
  });
  if (lessonsBody !== null) {
    meter.sources.push({
      name: SOURCE_LESSONS_BODY,
      text: lessonsBody,
      lane: LANE_BUDGETED,
      outsideBoundary: false,
    });
  }

  return lessonsBody === null ? budgetedActive : joinBlocks([budgetedActive, lessonsBody]);
}

/**
 * Read and budget the `Brain/lessons.md` body for injection. Returns
 * `null` on any failure mode (missing file, unreadable, empty body) so
 * the caller falls back to injecting active.md alone.
 */
function readLessonsBody(lessonsPath: string, budget: number): string | null {
  if (!existsSync(lessonsPath)) return null;
  try {
    const raw = readFileSync(lessonsPath, "utf8");
    const [, body] = parseFrontmatterText(raw);
    const trimmed = body.trim();
    if (trimmed.length === 0) return null;
    return budgetActiveBody(trimmed, budget);
  } catch {
    return null;
  }
}

main().catch(() => {
  // Never crash the runtime; the session start should proceed
  // regardless of any hook misbehaviour.
});

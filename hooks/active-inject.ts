#!/usr/bin/env -S bun
/**
 * SessionStart / PostCompact hook: inject the current `Brain/active.md`
 * digest as `additionalContext` so the agent sees the live set of
 * confirmed and quarantined preferences without explicitly calling
 * `brain_query` first.
 *
 * Two lanes share the surface, and the order between them is the point.
 * `Brain/standing-rules.md` is operator-authored and goes FIRST, read
 * outside the fail-open memory load so it survives a memory-layer
 * failure and never enters the inject cache. Everything after it -
 * runtime notices, `active.md`, `lessons.md` - is what the agent learned
 * about itself, assembled inside the fail-open boundary and charged
 * against the configured injection budget.
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
 *         "additionalContext": "<standing-rules block, then the budgeted
 *                               memory context: runtime notices, the
 *                               rendered Brain/active.md body, lessons>"
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
import { join } from "node:path";

import { resolveVault } from "../src/core/config.ts";
import { parseFrontmatterText } from "../src/core/vault.ts";
import {
  brainActivePath,
  brainLessonsPath,
  brainStandingRulesPath,
} from "../src/core/brain/paths.ts";
import { budgetActiveBody } from "../src/core/brain/active-budget.ts";
import {
  INJECT_BUDGET_CHARS_DEFAULT,
  loadBrainConfig,
  resolveStandingRulesMaxChars,
} from "../src/core/brain/policy.ts";
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
import { asHookPayload, readHookInput } from "./lib/stdin.ts";
import { isContextEventName } from "./lib/context-events.ts";
import { emitContextReceipt } from "../src/core/brain/context-receipts.ts";
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
    appendAuditRecord(join(vault, ".open-second-brain", "hook-audit"), {
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

    const meter: InjectionMeter = { sources: [], budgetChars: null };
    const limits = resolveInjectionLimits(vault);

    // The operator's standing rules, read BEFORE and OUTSIDE the fail-open
    // load below. That single placement buys three properties at once:
    // the block never reaches the budgeter, so the configured injection
    // budget cannot shrink it; a throw inside memory assembly cannot take
    // it down with it; and it is never written to the inject cache, so a
    // stale constitution can never be served from disk while the live one
    // is unreadable.
    const standingBlock = renderStandingBlock(vault, limits.standingRulesMaxChars, meter);

    // Fail-open context load: assemble the injected body inside a guard that
    // degrades to the last-good cache (or empty) on any error, never emitting
    // a partial or poisoned payload. A successful non-empty body refreshes the
    // last-good snapshot.
    const { context: memoryContext, source } = await loadInjectContextFailOpen({
      vault,
      key: "active",
      assemble: () => assembleActiveContext(vault, limits.injectBudgetChars, meter),
      audit: (degradedSource) =>
        auditHook(vault, "inject_failopen_degraded", {
          hook: "active-inject",
          source: degradedSource,
        }),
    });
    // The early return now fires only when there are NEITHER standing rules
    // NOR memory - a vault with rules and a broken memory layer still speaks.
    const context = joinBlocks([standingBlock, memoryContext]);
    if (context.length === 0) return;

    const out = {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: context,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");

    // Measure LAST, so the injected context is already on stdout before the
    // meter can spend a millisecond of the ceiling. See recordInjectionSize.
    recordInjectionSize(vault, { hookEventName, loaderSource: source, context, meter });
  } finally {
    disarm();
  }
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
 *   - BUDGETED: charged against `inject_budget_chars`. Two of these
 *     exist today and each is charged against the FULL configured
 *     ceiling, which is why the receipt records their count.
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
}

/** Mutable accumulator threaded through the assembly, read after it returns. */
interface InjectionMeter {
  readonly sources: InjectionSource[];
  /** The `inject_budget_chars` the budgeted sub-bodies were charged against. */
  budgetChars: number | null;
}

/** Sub-body identifiers recorded per injection. Structural, not content-derived. */
const SOURCE_STANDING_RULES = "standing-rules";
const SOURCE_RUNTIME_NOTICES = "runtime-notices";
const SOURCE_ACTIVE_BODY = "active-body";
const SOURCE_LESSONS_BODY = "lessons-body";

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
 * finding that never happened. The exempt lane is kept in that case,
 * because it is produced outside the boundary and did reach the payload;
 * omitting it would understate an injection that really happened.
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
        .filter((source) => measured || source.lane === LANE_EXEMPT)
        .map((source) => ({
          id: source.name,
          bytes: byteLength(source.text),
          tokens: estimateTokens(source.text),
        })),
      finalText: input.context,
      ...(input.meter.budgetChars !== null && measured
        ? {
            budget: {
              inject_budget_chars: input.meter.budgetChars,
              // Both budgeted sub-bodies are charged against the SAME
              // configured ceiling, so the effective ceiling is this
              // count times `inject_budget_chars`. Recorded as two
              // numbers rather than implied by one.
              budgeted_source_count: budgetedSourceCount(input.meter),
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
  meter.sources.push({ name: SOURCE_STANDING_RULES, text: block, lane: LANE_EXEMPT });
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
  // would be a number with no measurement behind it.
  meter.budgetChars = budget;

  // Auto-load the lessons digest alongside active.md so the agent gets
  // the unified, signed, recency-scored corpus (preferences + dead-ends)
  // on the same SessionStart surface. Fail-soft and budgeted separately:
  // a missing / unreadable / oversized lessons file must never disturb
  // the active-preferences injection above.
  const lessonsBody = readLessonsBody(brainLessonsPath(vault), budget);

  const budgetedActive = budgetActiveBody(trimmed, budget);
  meter.sources.push({ name: SOURCE_ACTIVE_BODY, text: budgetedActive, lane: LANE_BUDGETED });
  if (lessonsBody !== null) {
    meter.sources.push({ name: SOURCE_LESSONS_BODY, text: lessonsBody, lane: LANE_BUDGETED });
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

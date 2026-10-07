/**
 * The budgeted active-context assembly shared by both injection lanes
 * (context-injection-pipeline).
 *
 * hooks/active-inject.ts puts the lanes together into the session-start
 * preamble; hooks/subagent-inject.ts composes the same three lanes into
 * the subagent carrier's payload. This module is the single code path
 * behind both: the injection limits (the injection budget and the two
 * rules caps), the scoped operator rules for this project and device,
 * and the budgeted `Brain/active.md` + `Brain/lessons.md` body with the
 * runtime notices ahead of it. One assembly means the carrier's payload
 * and the session-start digest can never disagree about what the
 * operator's context says or how it was rationed.
 *
 * The {@link InjectionMeter} (hooks/lib/standing-block.ts) threads
 * through every producer here: per-source attribution stops existing at
 * the join, so each sub-body is recorded while it is still a separate
 * string. The session-start lane reads the meter for its context
 * receipt; the carrier passes one because the assembly requires it and
 * never reads it back.
 *
 * ABSENCE, FAILURE AND BUDGET stay where active-inject.ts put them. An
 * absent file contributes nothing; a genuine read error THROWS so the
 * session-start lane's fail-open loader can degrade to its last-good
 * cache - the carrier, which has no cache, catches and degrades to an
 * empty memory lane. The budget core's tier ladder degrades oversized
 * sections automatically.
 */

import { existsSync, readFileSync } from "node:fs";

import { parseFrontmatterText } from "../../src/core/vault.ts";
import { brainActivePath, brainLessonsPath } from "../../src/core/brain/paths.ts";
import { budgetActiveBody } from "../../src/core/brain/active-budget.ts";
import {
  INJECT_BUDGET_CHARS_DEFAULT,
  loadBrainConfig,
  resolveScopedRulesMaxChars,
  resolveStandingRulesMaxChars,
} from "../../src/core/brain/policy.ts";
import {
  readScopedRules,
  SCOPED_RULES_HEADER,
  SCOPED_RULES_NOTICE_RESERVE,
} from "../../src/core/brain/scoped-rules.ts";
import { resolveHostScope, resolveProjectScope } from "../../src/core/brain/scope-identity.ts";
import {
  collectRuntimeNotices,
  renderRuntimeNotices,
} from "../../src/core/brain/runtime-notices.ts";
import { LANE_BUDGETED, LANE_UNBUDGETED, type InjectionMeter } from "./standing-block.ts";
import {
  RECEIPT_ITEM_ACTIVE_BODY,
  RECEIPT_ITEM_LESSONS_BODY,
  RECEIPT_ITEM_SCOPED_RULES,
} from "../../src/core/brain/context-receipts.ts";
import type { BrainConfig } from "../../src/core/brain/types.ts";

/** Sub-body identifiers recorded per injection. Structural, not content-derived. */
export const SOURCE_SCOPED_RULES = RECEIPT_ITEM_SCOPED_RULES;
export const SOURCE_RUNTIME_NOTICES = "runtime-notices";
export const SOURCE_ACTIVE_BODY = RECEIPT_ITEM_ACTIVE_BODY;
export const SOURCE_LESSONS_BODY = RECEIPT_ITEM_LESSONS_BODY;

/** The memory sub-bodies, in the order `assembleActiveContext` joins them. */
export const MEMORY_SOURCES: ReadonlySet<string> = new Set([
  SOURCE_RUNTIME_NOTICES,
  SOURCE_ACTIVE_BODY,
  SOURCE_LESSONS_BODY,
]);

/** Blank line between two injected blocks. */
export const BLOCK_SEPARATOR = "\n\n";

/** Join the non-empty blocks in order; an all-empty list yields "". */
export function joinBlocks(blocks: ReadonlyArray<string>): string {
  return blocks.filter((block) => block.length > 0).join(BLOCK_SEPARATOR);
}

/** A fresh, empty meter for one assembly run. */
export function createInjectionMeter(configuredBudgetChars: number): InjectionMeter {
  return {
    sources: [],
    configuredBudgetChars,
    budgetChars: null,
    scopedRulesChars: 0,
  };
}

/**
 * The two character ceilings this hook applies, resolved once.
 *
 * They are separate numbers because they govern separate lanes: the
 * injection budget rations what the agent recalled about itself, the
 * standing-rules cap bounds what the operator wrote. Reading them
 * together is only an efficiency - one config open instead of two.
 */
export interface InjectionLimits {
  readonly injectBudgetChars: number;
  readonly standingRulesMaxChars: number;
  readonly scopedRulesMaxChars: number;
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
export function resolveInjectionLimits(vault: string): InjectionLimits {
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
 * The cap over the scoped block's sections: the configured cap, clamped
 * to what the injection budget leaves once the block's header and the
 * room for its notices are reserved, floor 0. With it the whole block -
 * not only its sections - fits the budget it is charged against.
 */
export function scopedSectionCap(limits: InjectionLimits): number {
  return Math.max(
    0,
    Math.min(
      limits.scopedRulesMaxChars,
      limits.injectBudgetChars - SCOPED_RULES_HEADER.length - SCOPED_RULES_NOTICE_RESERVE,
    ),
  );
}

/**
 * Render the scoped operator rules for this session's project and this
 * device, or "" when none applies.
 *
 * Project and host only: a harness file renders on the MCP surfaces,
 * where the harness comes from the packaged `--harness`. Both injection
 * lanes are shared by Claude Code and Codex through one `o2b-hook` shim
 * and have no harness signal of their own, so the harness resolves to
 * nothing and matches no harness file.
 *
 * Never throws: a failure to resolve the scope or read the directory
 * must not take the constitution and the memory context down with it.
 */
export function renderScopedBlock(
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
export function assembleActiveContext(
  vault: string,
  budget: number,
  meter: InjectionMeter,
): string {
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

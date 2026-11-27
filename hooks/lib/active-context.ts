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
import { activeDigestPathForRead } from "../../src/core/brain/active.ts";
import { lessonsDigestPathForRead } from "../../src/core/brain/lessons.ts";
import {
  budgetActiveBodyContent,
  type BudgetedBody,
  wholeBodyCut,
} from "../../src/core/brain/active-budget.ts";
import {
  neutralizeUntrustedText,
  untrustedBindingFramingHeader,
} from "../../src/core/brain/untrusted-source.ts";
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
  consumeAutoMigrationNotice,
  readAutoMigrationNotice,
  recoverClaimedAutoMigrationNotices,
} from "../../src/core/store-migration/auto-state.ts";

/** The runtime notice code of the store migration's one-time success notice. */
const STORE_MIGRATION_DONE_NOTICE = "store_migration_done";
import {
  RECEIPT_ITEM_ACTIVE_BODY,
  RECEIPT_ITEM_LESSONS_BODY,
  RECEIPT_ITEM_SCOPED_RULES,
} from "../../src/core/brain/context-receipts.ts";
import type { BrainConfig } from "../../src/core/brain/types.ts";

/** Sub-body identifiers recorded per injection. Structural, not content-derived. */
export const SOURCE_SCOPED_RULES = RECEIPT_ITEM_SCOPED_RULES;
export const SOURCE_RUNTIME_NOTICES = "runtime-notices";
/**
 * The session start's own notices block: the pending dream digest and the
 * dream day note. It rides the payload OUTSIDE the memory context, so it
 * carries its own id: the memory sub-bodies are the ones named in
 * {@link MEMORY_SOURCES}, and a second block under that name would count
 * as one of them, shifting the join the injection ledger's attribution
 * reads - the session would show its digests and record none of them.
 */
export const SOURCE_SESSION_NOTICES = "session-notices";
/** The one truncation note a cut payload ends in. */
export const SOURCE_DIGEST_CUT_NOTE = "digest-cut-note";
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

/**
 * Set one budgeted memory body under the light untrusted framing header:
 * the header line, then the body. A full fence is deliberately not used
 * here - the wrapper pair would be charged to `inject_budget_chars` and
 * the tier ladder would answer by evicting sections - so the provenance
 * rides as the shared one-line header instead. The clause is the MEMORY
 * lanes' binding clause, not the foreign lanes' records-not-instructions
 * disclaimer: these bodies ARE the product's rules lane, and a preamble
 * telling the model to read them as data would have it ignore the
 * preferences the lane exists to deliver. The header line IS part of the
 * metered source, so per-source attribution names the guarded bytes.
 */
function frameMemoryBody(origin: string, body: string): string {
  return `${untrustedBindingFramingHeader(origin)}\n${body}`;
}

/**
 * The characters one framed body costs beyond its inner body: the header
 * line plus the newline that carries the body. Charged against the
 * injection budget before the tier ladder runs (the recall-inject
 * fenceOverhead precedent), so the ladder never evicts a section merely
 * to pay for the framing.
 */
function framingOverhead(origin: string): number {
  return untrustedBindingFramingHeader(origin).length + 1;
}

/** A fresh, empty meter for one assembly run. */
export function createInjectionMeter(configuredBudgetChars: number): InjectionMeter {
  return {
    sources: [],
    configuredBudgetChars,
    budgetChars: null,
    scopedRulesChars: 0,
    cuts: [],
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
/** Defaults of the session-start digest's topic and pinned lanes (task 4.2). */
export const TOPIC_HEADS_MAX_DEFAULT = 12;
export const TOPIC_HEADS_MAX_CHARS_DEFAULT = 1600;
export const PINNED_MAX_CHARS_DEFAULT = 1200;

export interface InjectionLimits {
  readonly injectBudgetChars: number;
  readonly standingRulesMaxChars: number;
  readonly scopedRulesMaxChars: number;
  /** Most topic heads the session start digest shows (task 4.2). */
  readonly topicHeadsMax: number;
  /** Characters for the whole topic heads block. */
  readonly topicHeadsMaxChars: number;
  /** Characters for the pinned context block. */
  readonly pinnedMaxChars: number;
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
    topicHeadsMax: cfg?.active?.topic_heads_max ?? TOPIC_HEADS_MAX_DEFAULT,
    topicHeadsMaxChars: cfg?.active?.topic_heads_max_chars ?? TOPIC_HEADS_MAX_CHARS_DEFAULT,
    pinnedMaxChars: cfg?.active?.pinned_max_chars ?? PINNED_MAX_CHARS_DEFAULT,
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
  opts: {
    readonly startsSession?: boolean;
    /**
     * The most characters the whole memory context may take - the runtime
     * notices, the active body and the lessons body with the separators
     * between them - so the payload it joins stays under the host's
     * per-hook context cap. Each body still answers to `budget` too, and
     * the two bodies share this room instead of each taking `budget`.
     * Absent: each body takes `budget` on its own, as before.
     */
    readonly roomChars?: number;
    /**
     * How `roomChars` is measured: the host's unit. UTF-16 code units by
     * default; UTF-8 bytes for Codex, whose hook context cap counts bytes.
     * The configured budget stays in characters.
     */
    readonly measure?: (text: string) => number;
    /**
     * The configured vault's folder is not there, on a machine that has not
     * switched: the notice rides the runtime notices, so the session is
     * told the brain is not a fresh installation before anything else says
     * what an empty vault looks like.
     */
    readonly missing?: { readonly vault: string; readonly notice: string };
  } = {},
): string {
  const measure = opts.measure ?? ((text: string) => text.length);
  // Runtime-state notices ride the same injection surface as active.md so the
  // agent is proactively aware of a degraded/transient condition (semantic
  // search fell back to lexical, index missing/rebuilding, read-only vault)
  // without a diagnostic round-trip. Best-effort and computed with no network;
  // an empty list keeps the injected body byte-identical to before.
  // A session start also carries the one-time notices (the store
  // migration's success notice) and clears them once rendered: shown once,
  // then gone. A subagent's context neither shows nor clears them.
  const startsSession = opts.startsSession === true;
  // The notice this start may show, read before the notices are rendered:
  // the session consumes exactly that one below.
  // A session that died while it consumed the notice gave nothing back:
  // what it claimed is put back first, so this start shows it.
  if (startsSession) recoverClaimedAutoMigrationNotices(vault);
  const pending = startsSession ? readAutoMigrationNotice(vault) : null;
  const notices = collectRuntimeNotices(vault, {
    oneTime: startsSession,
    ...(opts.missing !== undefined ? { missing: opts.missing } : {}),
  });

  // `Brain/active.md` on an unswitched machine; on a store-only one the
  // digest rendered on demand into the device-local cache (D14 item 7).
  const activePath = activeDigestPathForRead(vault);
  // The room the two bodies share: what the notices leave of the memory
  // context's room. The notices rendered here are every notice this start
  // may show, so the ones shown below take no more.
  let bodyRoom: number | undefined;
  if (opts.roomChars !== undefined) {
    const noticesChars = measure(renderRuntimeNotices(notices));
    bodyRoom = Math.max(
      0,
      opts.roomChars - noticesChars - (noticesChars > 0 ? BLOCK_SEPARATOR.length : 0),
    );
  }
  const activeBody = existsSync(activePath)
    ? readActiveBody(vault, activePath, budget, meter, measure, bodyRoom)
    : "";

  // Consumed only once the body is assembled: a read that throws sends the
  // session the last-good cache, which never held this notice, so the
  // notice stays for the next start. The session whose consumption
  // succeeds shows it; another start that rendered it at the same moment
  // drops it from its text, so it is shown once.
  let shown = notices;
  if (startsSession && notices.some((n) => n.code === STORE_MIGRATION_DONE_NOTICE)) {
    const consumed = pending !== null && consumeAutoMigrationNotice(vault, pending.at);
    if (!consumed) shown = notices.filter((n) => n.code !== STORE_MIGRATION_DONE_NOTICE);
  }
  const noticesBlock = renderRuntimeNotices(shown);
  if (noticesBlock.length > 0) {
    // First among the sources, where the notices sit in the text.
    meter.sources.unshift({
      name: SOURCE_RUNTIME_NOTICES,
      text: noticesBlock,
      lane: LANE_UNBUDGETED,
      outsideBoundary: false,
    });
  }
  return joinBlocks([noticesBlock, activeBody]);
}

/**
 * Budget one memory body to `innerBudget` characters, and, when the
 * payload shares a room measured in the host's unit, to the largest
 * character budget whose framed body fits that room too. With the UTF-16
 * measure the first pass already fits (the inner budget is at most the
 * room less the header); with Codex's byte measure a non-ASCII body costs
 * more bytes than characters, so a binary search finds the largest
 * character budget that fits the bytes. Pure: only the budgeter runs
 * again, never the reads or the one-time notices around it.
 */
function fitFramedBody(
  origin: string,
  neutral: string,
  innerBudget: number,
  room: number | undefined,
  measure: (text: string) => number,
): BudgetedBody {
  const fits = (budgeted: BudgetedBody): boolean =>
    room === undefined ||
    budgeted.content.length === 0 ||
    measure(frameMemoryBody(origin, budgeted.content)) <= room;
  const first = budgetActiveBodyContent(neutral, innerBudget);
  if (fits(first)) return first;
  // `low` always fits (a zero budget keeps nothing), `high` never does.
  let low = 0;
  let best = budgetActiveBodyContent(neutral, 0);
  let high = innerBudget;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const tried = budgetActiveBodyContent(neutral, mid);
    if (fits(tried)) {
      low = mid;
      best = tried;
    } else {
      high = mid;
    }
  }
  return best;
}

/**
 * Read + budget the active.md / lessons.md body. Returns an empty string when
 * the body is empty; throws on a genuine read error (permissions, fs stall) so
 * the fail-open loader degrades to the last-good cache.
 */
function readActiveBody(
  vault: string,
  activePath: string,
  configuredBudget: number,
  meter: InjectionMeter,
  measure: (text: string) => number,
  room?: number,
): string {
  // With a shared room the active body takes at most the room, and the
  // lessons body what the active body leaves of it.
  const budget = room === undefined ? configuredBudget : Math.min(configuredBudget, room);
  const body = readFileSync(activePath, "utf8");

  // Drop the `kind: brain-active / generated_at` frontmatter - it
  // carries no signal for the agent, only provenance for tooling.
  const [, fmBody] = parseFrontmatterText(body);
  const trimmed = fmBody.trim();
  if (trimmed.length === 0) return "";

  // Injection budget (token-diet): a large preference set must not flood
  // the session preamble. Resolved once in `resolveInjectionLimits`,
  // which also carries the reasoning for why a config failure lands on
  // the default here rather than raising. Recorded on the meter only
  // once a body emitted, because a vault with no `active.md` charged
  // nothing against it and a receipt naming a budget nothing was
  // measured under would be a number with no measurement behind it. The
  // CONFIGURED ceiling is recorded, not the `budget` argument: that is
  // what is left after the scoped rules were charged, and the receipt
  // reports the two separately (`inject_budget_chars`,
  // `scoped_rules_chars`).
  //
  // The lessons digest is auto-loaded alongside active.md so the agent
  // gets the unified, signed, recency-scored corpus (preferences +
  // dead-ends) on the same SessionStart surface. Fail-soft and budgeted
  // separately: a missing / unreadable / oversized lessons file must
  // never disturb the active-preferences injection.
  //
  // Untrusted vault content: neutralize (control/bidi/zero-width strip,
  // tag-like token escape) BEFORE budgeting, and set under the light
  // framing header. The header's overhead comes out of this body's budget
  // first, so the tier ladder works on the room that is actually left and
  // the framed whole stays within the budget it is charged against.
  //
  // The body carries no truncation note of its own: what the budget cut
  // is recorded on the meter, and the payload ends in ONE note for every
  // lane it cut (src/core/agent-context/digest-cut-note.ts). The content
  // alone fits the budget, so no byte of it goes to a note, and a payload
  // sized to the host's limit is never cut a second time for one.
  //
  // A budget that cannot hold even the framing header skips the source
  // whole (a bare header would name bytes that never reached the
  // payload), and the skip is recorded as a cut of the whole body. The
  // lessons body still gets its own chance below.
  const neutral = neutralizeUntrustedText(trimmed);
  const overhead = framingOverhead(SOURCE_ACTIVE_BODY);
  let activeBlock = "";
  if (budget > overhead) {
    const budgeted = fitFramedBody(SOURCE_ACTIVE_BODY, neutral, budget - overhead, room, measure);
    if (budgeted.cut !== null) meter.cuts.push({ source: SOURCE_ACTIVE_BODY, ...budgeted.cut });
    if (budgeted.content.length > 0) {
      activeBlock = frameMemoryBody(SOURCE_ACTIVE_BODY, budgeted.content);
    }
  } else {
    meter.cuts.push({ source: SOURCE_ACTIVE_BODY, ...wholeBodyCut(neutral) });
  }
  // The room the active body leaves the lessons body, in the host's measure.
  const lessonsRoom =
    room === undefined
      ? undefined
      : room - measure(activeBlock) - (activeBlock.length > 0 ? BLOCK_SEPARATOR.length : 0);
  const lessonsBudget =
    lessonsRoom === undefined ? configuredBudget : Math.min(configuredBudget, lessonsRoom);
  const lessonsBody = readLessonsBody(vault, lessonsBudget, meter, measure, lessonsRoom);
  if (activeBlock.length > 0) {
    meter.sources.push({
      name: SOURCE_ACTIVE_BODY,
      text: activeBlock,
      lane: LANE_BUDGETED,
      outsideBoundary: false,
    });
  }
  if (lessonsBody !== null) {
    meter.sources.push({
      name: SOURCE_LESSONS_BODY,
      text: lessonsBody,
      lane: LANE_BUDGETED,
      outsideBoundary: false,
    });
  }
  // A budgeted source was measured under the configured ceiling, so the
  // receipt carries the budget block whenever any memory body emitted -
  // a lessons-only assembly measured itself against the same number.
  if (activeBlock.length > 0 || lessonsBody !== null) {
    meter.budgetChars = meter.configuredBudgetChars;
  }
  return joinBlocks([activeBlock, lessonsBody ?? ""]);
}

/**
 * Read and budget the `Brain/lessons.md` body for injection. Returns
 * `null` on any failure mode (missing file, unreadable, empty body) so
 * the caller falls back to injecting active.md alone. The body is
 * neutralized and framed like the active body, with the same
 * budget-charged header overhead.
 */
function readLessonsBody(
  vault: string,
  budget: number,
  meter: InjectionMeter,
  measure: (text: string) => number,
  room: number | undefined,
): string | null {
  try {
    // Rendered on demand on a store-only machine; a failure is the same
    // fail-soft skip as an unreadable file.
    const lessonsPath = lessonsDigestPathForRead(vault);
    if (!existsSync(lessonsPath)) return null;
    const raw = readFileSync(lessonsPath, "utf8");
    const [, body] = parseFrontmatterText(raw);
    const trimmed = body.trim();
    if (trimmed.length === 0) return null;
    const neutral = neutralizeUntrustedText(trimmed);
    // The active body's floor, applied to this header: a body whose
    // framing cannot fit, or whose budgeted remainder is empty, is
    // skipped rather than emitted over budget, and the skip is recorded
    // as a cut for the digest's one note.
    const overhead = framingOverhead(SOURCE_LESSONS_BODY);
    if (budget <= overhead) {
      meter.cuts.push({
        source: SOURCE_LESSONS_BODY,
        ...wholeBodyCut(neutral),
      });
      return null;
    }
    const budgeted = fitFramedBody(SOURCE_LESSONS_BODY, neutral, budget - overhead, room, measure);
    if (budgeted.content.length === 0) {
      meter.cuts.push({
        source: SOURCE_LESSONS_BODY,
        ...wholeBodyCut(neutral),
      });
      return null;
    }
    if (budgeted.cut !== null) meter.cuts.push({ source: SOURCE_LESSONS_BODY, ...budgeted.cut });
    return frameMemoryBody(SOURCE_LESSONS_BODY, budgeted.content);
  } catch {
    return null;
  }
}

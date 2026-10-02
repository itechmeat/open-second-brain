/**
 * Pre-compress injection pack (v0.20.0).
 *
 * A read-only bundle of the highest-confidence confirmed preferences plus
 * the head of `active.md`, rendered as a compact system-prompt addendum.
 * An external runtime (e.g. a host agent's pre-compression hook) can
 * inject it just before a context-compression event so the brain's
 * highest-salience constraints survive context rotation without the agent
 * having to remember to query. OSB ships only this builder and the MCP
 * tool around it; the host-runtime wiring is an out-of-scope recipe.
 *
 * It reuses the shared recall-budget primitive (the same per-entry and
 * total character caps as `brain_context_pack`) so one oversized
 * preference cannot dominate the addendum. Deterministic given the vault:
 * the only ordering inputs are confidence, creation time, and id.
 */

import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

import { readerNarrowsActive, renderActiveForReader, type ActiveReaderOptions } from "./active.ts";
import { BRAIN_PREFERENCES_REL } from "./path-constants.ts";
import { brainActivePath, brainDirs } from "./paths.ts";
import { brainConfigUnreadableReport } from "./policy.ts";
import {
  collectPreferences,
  resolveOwnerScopeDelivery,
  type OwnerScopeDelivery,
} from "./preferences-collect.ts";
import { applyCharBudget, type CharBudgetDegradationMode } from "./recall-budget.ts";
import { emitContextReceipt, type ContextReceiptOptions } from "./context-receipts.ts";
import { emitGatedTelemetry } from "./continuity/emit.ts";
import {
  emitRecallTelemetry,
  recallTelemetryEnvelope,
  type RecallTelemetryOptions,
} from "./recall-telemetry.ts";
import {
  contextSafetyReport,
  guardBrainContextSnippet,
  type ContextSafetyReport,
} from "./safety/context-guard.ts";
import { BRAIN_PREFERENCE_STATUS } from "./types.ts";

/** Sentinel item id for the active-head entry inside the budget pass. */
const ACTIVE_ID = "__active__";

export interface PreCompressItem {
  readonly id: string;
  /** Preference principle text after any per-entry trim. */
  readonly principle: string;
  /** True when `principle` was truncated by `maxCharsPerMemory`. */
  readonly trimmed: boolean;
  /** Present when the surfaced principle was filtered or explicitly trusted. */
  readonly safety?: ContextSafetyReport;
}

export interface PreCompressPack {
  /** Rendered system-prompt addendum (empty string when nothing fits). */
  readonly text: string;
  readonly items: ReadonlyArray<PreCompressItem>;
  readonly activeHeadIncluded: boolean;
  readonly activeHeadSafety?: ContextSafetyReport;
  readonly receiptId?: string;
  readonly telemetryId?: string;
  readonly totalChars: number;
  /**
   * Delivery reports that are not pack content: currently only the
   * unreadable-config degradation below. Same key and same
   * absent-when-empty rule as `ContextPackReport.warnings`, so the two
   * pack builders answer "what should the caller know about this
   * result" in one shape. A healthy vault carries no key at all.
   */
  readonly warnings?: ReadonlyArray<string>;
}

export interface PreCompressOptions {
  /** Maximum number of preferences to consider (highest-confidence first). */
  readonly topK: number;
  /** Per-entry character cap (code points); <= 0 / undefined disables. */
  readonly maxCharsPerMemory?: number;
  /** Total character cap across the bundle; <= 0 / undefined disables. */
  readonly maxTotalChars?: number;
  /**
   * Per-entry trim strategy (continuity-hygiene-freshness suite):
   * `staged` degrades an over-budget entry at structural boundaries
   * instead of cutting mid-sentence. Default keeps the hard cut.
   */
  readonly degradation?: CharBudgetDegradationMode;
  /** Opt-in audit receipt for the final emitted addendum. */
  readonly receipt?: ContextReceiptOptions;
  /** Opt-in telemetry for recall coverage and gap diagnostics. */
  readonly telemetry?: RecallTelemetryOptions;
  /**
   * Owner scope for delivery isolation (context-integrity-gates, Unit
   * A). Enforced only when `integrity.owner_scope_delivery` is `fail`;
   * omitted, or under the default `off`, nothing is filtered and the
   * output is byte-identical to a vault without the gate.
   */
  readonly agentScope?: string;
  /**
   * May the caller see the record at this vault-relative path? A
   * preference it may not is absent from the top-K walk and from the
   * active head, exactly as if the file did not exist. Omitted, nothing
   * is filtered and the output is byte-identical to a build without it.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * The caller arrived below local reach: its active head is always the
   * in-memory render, never the shared file (see
   * {@link ActiveReaderOptions.restricted}).
   */
  readonly restricted?: boolean;
}

interface ConfirmedPref {
  readonly id: string;
  readonly principle: string;
  readonly confidence: number;
  readonly createdAt: string;
}

function collectConfirmed(
  vault: string,
  ownerScope: OwnerScopeDelivery,
  readable: ((rel: string) => boolean) | undefined,
): ConfirmedPref[] {
  const dir = brainDirs(vault).preferences;
  const out: ConfirmedPref[] = [];
  // Listing and parse come from the shared delivery-path walk
  // (context-integrity-gates, Unit A); the confirmed-status filter is
  // this surface's own and stays here.
  for (const { name, pref } of collectPreferences(dir, { ownerScope }).entries) {
    if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
    if (readable !== undefined && !readable(posix.join(BRAIN_PREFERENCES_REL, name))) continue;
    out.push({
      id: pref.id,
      principle: pref.principle,
      confidence: pref.confidence_value ?? Number.NEGATIVE_INFINITY,
      createdAt: pref.created_at,
    });
  }
  return out;
}

/** The active head this caller may see, and why it may be missing. */
interface ActiveHead {
  /** Head text, or `null` when there is none to deliver. */
  readonly text: string | null;
  /** Operator-facing reason the head was withheld, or `null`. */
  readonly warning: string | null;
}

/** Nothing to deliver, nothing to report. */
const NO_ACTIVE_HEAD: ActiveHead = Object.freeze({ text: null, warning: null });

/** An active head that is present, with nothing to report about it. */
function deliveredHead(text: string): ActiveHead {
  return text.length > 0 ? Object.freeze({ text, warning: null }) : NO_ACTIVE_HEAD;
}

/**
 * The active-digest head this caller may see.
 *
 * `active.md` is ONE file shared by every agent, so under an enforcing
 * owner-scope gate the file's own bytes are the wrong answer: they carry
 * every owner's memories, and a caller at remote reach must not be
 * handed a preference it cannot read there. Such a caller gets an
 * in-memory {@link renderActiveForReader} instead, which is where the
 * ownership and reach predicates attach. Narrowing the FILE to make this read correct is what
 * `brain_context` used to do, and it made a shared write follow a
 * per-request filter (context-integrity-gates, A3).
 *
 * A caller below local reach always gets that render too, whatever is
 * withheld from it, so a stale file is never the tell that a record it
 * cannot read exists. A local caller with no enforced scope - the
 * shipped `off` default - reads the file verbatim, stamp and all.
 *
 * ## Why an unreadable config is checked here rather than caught
 *
 * The two halves of the gate compose into a failure neither designed
 * for. `loadIntegrityConfigSafe` deliberately RESOLVES on an unreadable
 * `_brain.yaml`, to its strict fallback, so the gate closes rather than
 * opens - which hands this caller an `enforcedScope`. {@link
 * renderActiveForReader} then reads the guardrail block through a loader that
 * RAISES on the same file. One bad line therefore cost a scoped agent
 * its entire pre-compaction pack while an unscoped one still got a pack.
 *
 * So the condition is a precondition of the scoped render, tested by the
 * same predicate the loader splits on, and the head is withheld with the
 * reason named. It is not a `catch`: any other failure inside
 * the reader render still propagates, and a `catch` here would re-absorb
 * exactly the silence the split removed.
 *
 * Withheld, never substituted. The file's bytes are not a fallback for a
 * scoped render - serving them under an enforcing gate is the leak A3
 * exists to prevent - and the strict fallback is what makes withholding
 * safe: an unreadable config can only close this gate, never open it.
 */
function readActiveHead(
  vault: string,
  enforcedScope: string | null,
  opts: Pick<PreCompressOptions, "readable" | "restricted">,
): ActiveHead {
  const reader: ActiveReaderOptions = {
    ...(enforcedScope !== null ? { agentScope: enforcedScope } : {}),
    ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    ...(opts.restricted === true ? { restricted: true } : {}),
  };
  const path = brainActivePath(vault);
  // A vault whose digest was never generated has no head for an unscoped
  // reader, whatever its reach and whatever is withheld from it.
  if (enforcedScope === null && !existsSync(path)) return NO_ACTIVE_HEAD;
  if (readerNarrowsActive(vault, reader)) {
    const unreadableConfig = brainConfigUnreadableReport(vault);
    if (unreadableConfig !== null) return Object.freeze({ text: null, warning: unreadableConfig });
    return deliveredHead(renderActiveForReader(vault, reader).document.trim());
  }
  try {
    return deliveredHead(readFileSync(path, "utf8").trim());
  } catch {
    return NO_ACTIVE_HEAD;
  }
}

/**
 * Build the pre-compress addendum for a vault. Confirmed preferences are
 * ranked by confidence (desc), then recency (desc), then id; the top
 * `topK` plus the active head are bounded by the shared char budget.
 */
export function buildPreCompressPack(vault: string, opts: PreCompressOptions): PreCompressPack {
  const startedAtMs = Date.now();
  // One gate verdict for the whole build. The preference walk and the
  // active head must agree on it, and resolving it twice also read
  // `_brain.yaml` twice per pack.
  const ownerScope = resolveOwnerScopeDelivery(vault, opts.agentScope);
  const ranked = collectConfirmed(vault, ownerScope, opts.readable).toSorted((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const top = ranked.slice(0, Math.max(0, opts.topK));

  const activeHead = readActiveHead(vault, ownerScope.enforcedScope, opts);
  const safetyById = new Map<string, ContextSafetyReport>();
  const entries: Array<{ item: string; text: string }> = [];
  if (activeHead.text !== null) {
    const guarded = guardBrainContextSnippet(activeHead.text, {
      source: { id: ACTIVE_ID, path: brainActivePath(vault) },
    });
    const safety = contextSafetyReport(guarded);
    if (safety) safetyById.set(ACTIVE_ID, safety);
    entries.push({ item: ACTIVE_ID, text: guarded.safeText });
  }
  for (const p of top) {
    const guarded = guardBrainContextSnippet(p.principle, {
      source: { id: p.id },
    });
    const safety = contextSafetyReport(guarded);
    if (safety) safetyById.set(p.id, safety);
    entries.push({ item: p.id, text: guarded.safeText });
  }

  const budgeted = applyCharBudget(entries, {
    maxCharsPerEntry: opts.maxCharsPerMemory,
    maxTotalChars: opts.maxTotalChars,
    ...(opts.degradation !== undefined ? { degradation: opts.degradation } : {}),
  });

  let activeText: string | null = null;
  const items: PreCompressItem[] = [];
  for (const kept of budgeted.kept) {
    if (kept.item === ACTIVE_ID) {
      activeText = kept.text;
      continue;
    }
    const safety = safetyById.get(kept.item);
    items.push({
      id: kept.item,
      principle: kept.text,
      trimmed: kept.trimmed,
      ...(safety ? { safety } : {}),
    });
  }

  const sections: string[] = [];
  if (activeText !== null) sections.push(`# Active brain context\n\n${activeText}`);
  if (items.length > 0) {
    sections.push(["Preferences:", ...items.map((i) => `- ${i.principle}`)].join("\n"));
  }

  const text = sections.join("\n\n");
  // Gated emissions route through the lazy emit kernel (t_5d7aa7c5):
  // option absent means the thunk never runs; a broken continuity
  // store can no longer fail the pack (fail-open).
  const receipt = emitGatedTelemetry(opts.receipt, (receiptOptions) =>
    emitContextReceipt(vault, {
      options: receiptOptions,
      items: [
        ...(activeText !== null
          ? [
              {
                id: ACTIVE_ID,
                path: brainActivePath(vault),
                text: activeText,
              },
            ]
          : []),
        ...items.map((item) => ({
          id: item.id,
          text: item.principle,
          trimmed: item.trimmed,
          safetyFiltered: item.safety?.filtered,
        })),
      ],
      finalText: text,
      budget: {
        top_k: opts.topK,
        ...(opts.maxCharsPerMemory !== undefined
          ? { max_chars_per_memory: opts.maxCharsPerMemory }
          : {}),
        ...(opts.maxTotalChars !== undefined ? { max_total_chars: opts.maxTotalChars } : {}),
      },
      extra: { active_head_included: activeText !== null },
    }),
  );

  const telemetry = emitGatedTelemetry(opts.telemetry, (telemetryOptions) =>
    emitRecallTelemetry(vault, {
      ...recallTelemetryEnvelope(telemetryOptions),
      mode: "pre_compress",
      status: activeText !== null || items.length > 0 ? "ok" : "empty",
      durationMs: Date.now() - startedAtMs,
      resultCount: items.length + (activeText !== null ? 1 : 0),
      topArtifacts: [
        ...(activeText !== null ? [{ id: ACTIVE_ID, path: brainActivePath(vault) }] : []),
        ...items.slice(0, 10).map((item) => ({ id: item.id })),
      ],
      gaps: activeText === null && items.length === 0 ? ["no_matching_context"] : [],
      metadata: {
        ...telemetryOptions.metadata,
        top_k: opts.topK,
        total_chars: budgeted.totalChars,
        active_head_included: activeText !== null,
        ...(opts.maxCharsPerMemory !== undefined
          ? { max_chars_per_memory: opts.maxCharsPerMemory }
          : {}),
        ...(opts.maxTotalChars !== undefined ? { max_total_chars: opts.maxTotalChars } : {}),
        ...(receipt ? { receipt_id: receipt.id } : {}),
      },
    }),
  );

  return Object.freeze({
    text,
    items: Object.freeze(items),
    activeHeadIncluded: activeText !== null,
    ...(safetyById.get(ACTIVE_ID) ? { activeHeadSafety: safetyById.get(ACTIVE_ID) } : {}),
    ...(receipt ? { receiptId: receipt.id } : {}),
    ...(telemetry ? { telemetryId: telemetry.id } : {}),
    totalChars: budgeted.totalChars,
    ...(activeHead.warning !== null ? { warnings: Object.freeze([activeHead.warning]) } : {}),
  });
}

/**
 * `Brain/active.md` — the auto-generated active-preferences digest.
 *
 * The file is a derived view of `Brain/preferences/` (status `confirmed`
 * and `quarantine`) plus the three most recent entries in
 * `Brain/retired/`. It is regenerated at the tail of every `dream`
 * pass and after CLI verbs that mutate preferences directly (pin,
 * unpin, future reject). It is read by:
 *
 *   - the SessionStart / PostCompact hook → injected as
 *     `additionalContext` so the agent sees current rules at the start
 *     of every session and after `/compact`;
 *   - the MCP resource `osb://preferences/active` so MCP-capable hosts
 *     can pull it on demand.
 *
 * Properties:
 *
 *   - **Pure derivation.** No LLM, no network, no clock-dependent
 *     content beyond the `generated_at` stamp. Identical inputs
 *     produce identical *bodies* — the function only varies the
 *     frontmatter timestamp.
 *   - **Idempotent write.** The body (everything below the
 *     frontmatter) is compared against the existing file's body
 *     before writing. When equal, the file is left untouched so a
 *     no-op `dream` rerun does not bump mtime or cause Obsidian to
 *     re-render the open tab.
 *   - **Atomic write.** Uses `atomicWriteFileSync` so a crash
 *     mid-render leaves the previous version intact.
 *
 * Anchored in the v0.9.1 plan ("Brain/active.md + SessionStart /
 * PostCompact hook + MCP resources") which closes BRAIN-FUT-006.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { computeMostApplied, type MostAppliedEntry } from "./most-applied.ts";
import {
  MOST_APPLIED_LIMIT_DEFAULT,
  MOST_APPLIED_WINDOW_DAYS_DEFAULT,
  loadBrainConfig,
  loadGuardrailsConfigSafe,
} from "./policy.ts";
import { isPreferenceVisible } from "./owner-scoped-facts.ts";
import { parseRetired } from "./preference.ts";
import { collectPreferences, resolveOwnerScopeDelivery } from "./preferences-collect.ts";
import { BRAIN_TOMBSTONE_STATUS } from "./types.ts";
import { brainActivePath, brainDirsForWrite } from "./paths.ts";
import { isoSecond } from "./time.ts";
import { sortByProvenanceTrust } from "./provenance/trust-order.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainPreference, type BrainRetired } from "./types.ts";

const RECENTLY_RETIRED_COUNT = 3;

const FRONTMATTER_KIND = "brain-active";

export interface RegenerateActiveOptions {
  /** Wall clock for `generated_at`. Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Options for the RENDER, which — unlike the write — may be narrowed to a
 * single agent's view.
 */
export interface RenderActiveOptions extends RegenerateActiveOptions {
  /**
   * Owner scope for delivery isolation (context-integrity-gates, Unit
   * A). Enforced only when `integrity.owner_scope_delivery` is `fail`;
   * omitted, or under the default `off`, nothing is filtered and the
   * output is byte-identical to a vault without the gate.
   *
   * Deliberately absent from {@link RegenerateActiveOptions}: `active.md`
   * is ONE file shared by every agent on the vault, injected into every
   * SessionStart by `hooks/active-inject.ts` and regenerated unscoped by
   * the `osb://preferences/active` MCP resource. A per-request visibility
   * filter that reached the write would make the file thrash between
   * narrowed and complete, and an agent could lose its OWN memories from
   * session start because another agent read the vault last.
   */
  readonly agentScope?: string;
  /**
   * `generated_at` stamp for the rendered frontmatter. Defaults to
   * {@link isoSecond} of `now`. A read-time render passes the stamp
   * already on disk so its document describes the same generation the
   * shared file does.
   */
  readonly generatedAt?: string;
}

/** A rendered digest that has NOT been written anywhere. */
export interface ActiveRender {
  /** Body only, no frontmatter — what the idempotency check compares. */
  readonly body: string;
  /** Frontmatter + body: exactly the bytes a write would store. */
  readonly document: string;
  readonly counts: RegenerateActiveResult["counts"];
}

export interface RegenerateActiveResult {
  /** Absolute path of the written file. */
  readonly path: string;
  /** Whether the rendered body differed from the previous file content. */
  readonly changed: boolean;
  readonly counts: {
    readonly confirmed: number;
    readonly quarantine: number;
    readonly retired_recent: number;
    /**
     * Length of the `Most-applied (30d)` section in this render
     * pass. Zero when no `apply-evidence (result: applied)` events
     * lie inside the trailing 30-day window or no preference still
     * maps to one. `brain_context` echoes this through to MCP
     * clients so they can render a counts ribbon without parsing
     * the markdown body.
     */
    readonly most_applied_30d: number;
  };
}

/**
 * Render the active digest WITHOUT writing it.
 *
 * The read-time half of this module. `active.md` is a single file shared
 * by every agent on the vault, so a scope-narrowed view has to be
 * produced here and delivered to the one caller that asked for it —
 * never persisted. {@link regenerateActive} is the write, and it never
 * takes a scope.
 *
 * Errors thrown by individual preference / retired parsers are caught
 * and the offending file is omitted from the render. This does not raise
 * on parse failures because a single corrupted frontmatter must not break
 * the agent's view of every healthy rule. Corruption is the domain of
 * `brain_doctor`; this render's job is to surface what is knowable.
 */
export function renderActive(vault: string, opts: RenderActiveOptions = {}): ActiveRender {
  const now = opts.now ?? new Date();

  const preferences = readActivePreferences(vault, opts.agentScope);
  const retiredRecent = readRecentlyRetired(vault, RECENTLY_RETIRED_COUNT, opts.agentScope);

  // Confirmed prefs sort by confidence then id. When provenance trust
  // ordering is on, re-rank stated > deduced > inferred as the primary key
  // (stable, so the confidence order is preserved within a trust band). Off
  // by default -> byte-identical.
  const confirmedByConfidence = preferences
    .filter((p) => p.status === BRAIN_PREFERENCE_STATUS.confirmed)
    .toSorted(sortByConfidenceThenId);
  const confirmed = sortByProvenanceTrust(
    confirmedByConfidence,
    loadGuardrailsConfigSafe(vault).provenance_trust_ordering,
  );
  const quarantine = preferences
    .filter((p) => p.status === BRAIN_PREFERENCE_STATUS.quarantine)
    .toSorted(sortByIdAscending);

  // Read window/limit from `_brain.yaml:active.most_applied_*`. The
  // loader throws on a malformed `_brain.yaml`; we fall back to
  // defaults so a corrupted config never blocks the active digest.
  let windowDays = MOST_APPLIED_WINDOW_DAYS_DEFAULT;
  let limit = MOST_APPLIED_LIMIT_DEFAULT;
  try {
    const cfg = loadBrainConfig(vault);
    if (cfg.active?.most_applied) {
      windowDays = cfg.active.most_applied.window_days;
      limit = cfg.active.most_applied.limit;
    }
  } catch {
    // intentional fallback — config error is doctor's job to surface
  }

  // Most-applied draws from the active candidates (confirmed +
  // quarantine) only — retired preferences are reported in their own
  // section below and never resurrected through the hot list.
  const mostApplied = computeMostApplied(vault, [...confirmed, ...quarantine], {
    now,
    windowDays,
    limit,
  });

  const body = renderBody({
    confirmed,
    quarantine,
    retiredRecent,
    mostApplied,
    windowDays,
  });

  return {
    body,
    document: renderDocument(body, opts.generatedAt ?? isoSecond(now)),
    counts: {
      confirmed: confirmed.length,
      quarantine: quarantine.length,
      retired_recent: retiredRecent.length,
      most_applied_30d: mostApplied.length,
    },
  };
}

/**
 * Regenerate `<vault>/Brain/active.md`. Returns whether the body
 * actually changed (callers don't need to skip the call themselves —
 * the function makes the right decision internally).
 *
 * The write is ALWAYS unscoped: see {@link RenderActiveOptions.agentScope}
 * for why a per-request visibility filter must not reach this file.
 */
export function regenerateActive(
  vault: string,
  opts: RegenerateActiveOptions = {},
): RegenerateActiveResult {
  const now = opts.now ?? new Date();
  const path = brainActivePath(vault);
  const rendered = renderActive(vault, { now });

  // `readExistingBody` returns the trimmed body (parseFrontmatter
  // trims internally), so compare against the trimmed render for an
  // apples-to-apples byte check.
  const existingBody = readExistingBody(path);
  const changed = existingBody === null || existingBody !== rendered.body.trim();
  if (changed) {
    atomicWriteFileSync(path, rendered.document);
  }

  return { path, changed, counts: rendered.counts };
}

/**
 * Wrapper around {@link regenerateActive} that swallows failures with a
 * stderr warning. Used by `dream` and `setPinned` — both treat the
 * digest as a derived view: when its write fails (disk full,
 * permissions, etc.), the real state-changing work is still valid
 * and the next call will retry. We don't want a missing summary file
 * to mask the success of the underlying operation.
 *
 * Exported as the single source of truth for fire-and-warn semantics
 * so the same swallow shape isn't copy-pasted at each call site.
 */
export function regenerateActiveQuiet(vault: string, opts: RegenerateActiveOptions = {}): void {
  try {
    regenerateActive(vault, opts);
  } catch (err) {
    process.stderr.write(`warning: regenerate active.md failed: ${(err as Error).message}\n`);
  }
}

// ----- Scan helpers --------------------------------------------------------

function readActivePreferences(vault: string, agentScope: string | undefined): BrainPreference[] {
  const dirs = brainDirsForWrite(vault);
  // The shared delivery-path walk (context-integrity-gates, Unit A) owns
  // the listing and the parse; a corrupted or status/folder-mismatched
  // file is omitted there, and `brain_doctor` is the surface that flags
  // it. See the module docblock for the rationale.
  const out: BrainPreference[] = [];
  for (const { pref } of collectPreferences(dirs.preferences, {
    ownerScope: resolveOwnerScopeDelivery(vault, agentScope),
  }).entries) {
    // Belief lifecycle suite (t_7d5a3589): a tombstoned (incl.
    // superseded-non-tip) preference remains on disk for audit but
    // never appears in the active-preferences digest.
    if ((pref.status as string) === BRAIN_TOMBSTONE_STATUS) continue;
    out.push(pref);
  }
  return out;
}

/**
 * Retirement KEEPS ownership (context-integrity-gates, A7): a retired
 * memory is withdrawn from the active set, never published. The gate
 * verdict is resolved exactly as it is for the active preferences, so a
 * vault with the gate off - or a caller with no scope - sees the same
 * list it always did.
 */
function readRecentlyRetired(
  vault: string,
  limit: number,
  agentScope: string | undefined,
): BrainRetired[] {
  const dirs = brainDirsForWrite(vault);
  if (!existsSync(dirs.retired)) return [];
  const scope = resolveOwnerScopeDelivery(vault, agentScope).enforcedScope;
  const out: BrainRetired[] = [];
  for (const name of readdirSync(dirs.retired)) {
    if (!name.endsWith(".md")) continue;
    const full = join(dirs.retired, name);
    try {
      const retired = parseRetired(full);
      if (scope !== null && !isPreferenceVisible(retired, scope)) continue;
      out.push(retired);
    } catch {
      // Same rationale as readActivePreferences.
    }
  }
  out.sort((a, b) => {
    const ta = Date.parse(a.retired_at);
    const tb = Date.parse(b.retired_at);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return tb - ta; // newest first
  });
  return out.slice(0, limit);
}

// ----- Render helpers ------------------------------------------------------

interface RenderInput {
  readonly confirmed: ReadonlyArray<BrainPreference>;
  readonly quarantine: ReadonlyArray<BrainPreference>;
  readonly retiredRecent: ReadonlyArray<BrainRetired>;
  readonly mostApplied: ReadonlyArray<MostAppliedEntry>;
  readonly windowDays: number;
}

function renderBody(input: RenderInput): string {
  const out: string[] = [];
  out.push("# Active Brain Preferences");
  out.push("");
  out.push("Auto-generated by `dream`. Do not edit — changes will be overwritten.");
  out.push("");

  out.push(`## Confirmed (${input.confirmed.length})`);
  out.push("");
  if (input.confirmed.length === 0) {
    out.push("_No confirmed preferences yet._");
  } else {
    for (const p of input.confirmed) out.push(renderConfirmedLine(p));
  }
  out.push("");

  if (input.mostApplied.length > 0) {
    out.push(`## Most-applied (${input.windowDays}d) (${input.mostApplied.length})`);
    out.push("");
    for (const m of input.mostApplied) out.push(renderMostAppliedLine(m));
    out.push("");
  }

  if (input.quarantine.length > 0) {
    out.push(`## Quarantine (${input.quarantine.length})`);
    out.push("");
    out.push(
      "_Probationary rules — still active, but recent evidence is dominantly negative. One further `violated` evidence event retires the rule._",
    );
    out.push("");
    for (const p of input.quarantine) out.push(renderQuarantineLine(p));
    out.push("");
  }

  if (input.retiredRecent.length > 0) {
    out.push(`## Recently retired (last ${input.retiredRecent.length})`);
    out.push("");
    for (const r of input.retiredRecent) out.push(renderRetiredLine(r));
    out.push("");
  }

  // Trim trailing blank line so consecutive renders compare cleanly.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function renderConfirmedLine(p: BrainPreference): string {
  const tags: string[] = [];
  if (p.scope) tags.push(`scope: ${p.scope}`);
  tags.push(`confidence: ${p.confidence}${formatConfidenceValueTail(p)}`);
  if (p.pinned) tags.push("pinned");
  return `- \`${p.id}\` (${tags.join(", ")}) — ${p.principle}`;
}

function renderMostAppliedLine(m: MostAppliedEntry): string {
  const p = m.preference;
  const tags: string[] = [];
  if (p.scope) tags.push(`scope: ${p.scope}`);
  // Display label is window-agnostic; the actual window length is in the
  // `## Most-applied (Nd)` section header. The struct field
  // (`MostAppliedEntry.applied_30d`) keeps its v0.10.10 name so internal
  // consumers (MCP counts, e2e tests) don't break.
  tags.push(`applied_in_window: ${m.applied_30d}`);
  // One-liner by design (token-diet): every most-applied preference is
  // confirmed or quarantined, so its principle text is already rendered
  // verbatim in the section above - repeating it here duplicated ~31%
  // of the injected bytes on a real vault.
  return `- \`${p.id}\` (${tags.join(", ")})`;
}

function renderQuarantineLine(p: BrainPreference): string {
  const tags: string[] = [];
  if (p.scope) tags.push(`scope: ${p.scope}`);
  tags.push(`applied: ${p.applied_count} / violated: ${p.violated_count}`);
  if (p.confidence_value !== null) {
    tags.push(`conf: ${p.confidence_value.toFixed(2)}`);
  }
  if (p.pinned) tags.push("pinned");
  return `- \`${p.id}\` (${tags.join(", ")}) — ${p.principle}`;
}

/**
 * Tail rendered next to the confidence band in the `confidence:`
 * metadata. When a commitment tier is set (Belief lifecycle suite, B3),
 * the tier label is rendered in place of the raw confidence float; the
 * band itself is unchanged. When no tier is set, the numeric
 * `confidence_value` is rendered as before (empty when it is `null`, e.g.
 * a legacy preference written before v0.10.3). Unset commitment therefore
 * keeps the output byte-identical to today.
 */
function formatConfidenceValueTail(p: BrainPreference): string {
  if (p.commitment !== undefined) return ` (${p.commitment})`;
  if (p.confidence_value === null) return "";
  return ` (${p.confidence_value.toFixed(2)})`;
}

function renderRetiredLine(r: BrainRetired): string {
  const date = r.retired_at.slice(0, 10);
  return `- \`${r.id}\` — ${r.retired_reason} on ${date}`;
}

function renderDocument(body: string, generatedAt: string): string {
  const lines: string[] = [
    "---",
    `kind: ${FRONTMATTER_KIND}`,
    `generated_at: ${generatedAt}`,
    "---",
    "",
    body.trimEnd(),
    "",
  ];
  return lines.join("\n");
}

function readExistingBody(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const [, body] = parseFrontmatter(path);
    // `parseFrontmatter` returns the body already stripped of the
    // frontmatter block and leading separator newline. We compare
    // against `renderBody`'s output, which also lacks frontmatter —
    // both sides go through the same trim semantics so the
    // idempotency check is byte-correct without bespoke regex work.
    return body;
  } catch {
    return null;
  }
}

function sortByConfidenceThenId(a: BrainPreference, b: BrainPreference): number {
  const order = { high: 0, medium: 1, low: 2 } as const;
  const ca = order[a.confidence];
  const cb = order[b.confidence];
  if (ca !== cb) return ca - cb;
  return a.id.localeCompare(b.id);
}

function sortByIdAscending(a: BrainPreference, b: BrainPreference): number {
  return a.id.localeCompare(b.id);
}

/**
 * Brain digest (design doc §8).
 *
 * Read-only renderer over Brain/log/ + Brain/preferences/ +
 * Brain/retired/. Default window: the last 24 hours, ending at
 * `opts.until ?? now`. Both Markdown and JSON outputs are supported;
 * the JSON form follows §8.2 verbatim so downstream consumers (Hermes
 * cron, CI scripts) can parse it without surprises.
 *
 * Sections, each rendered only when non-empty:
 *
 *   1. **New (unconfirmed, in trial)** — preferences with `status:
 *      unconfirmed` and `created_at` inside the window.
 *   2. **Confirmed** — preferences with `confirmed_at` inside the
 *      window.
 *   3. **Retired** — retired entries with `retired_at` inside the
 *      window.
 *   4. **Confidence shifts** — preferences whose confidence changed
 *      inside the window. The current Brain state does not carry an
 *      explicit `confidence_history`; the design accepts a graceful
 *      degradation here. We read `dream` log events: when their
 *      payload exposes a `confidence_shifts` (singular bullet) or
 *      `confidence_changes` sub-list, we parse those. If the payload
 *      is absent, the section is empty.
 *   5. **Contradictions** — events of kind `contradicted` or `dream`
 *      events emitting a `contradictions` sub-list. Same graceful
 *      degradation: empty when the payload is not produced.
 *
 * Empty window → one-line Markdown `Brain digest — <date>: no changes`
 * (or JSON with `summary.empty: true`). The function returns both the
 * rendered string and an `empty` flag so the CLI can implement
 * `--silent-if-empty` (exit 2) without re-parsing.
 *
 * The function is pure read. It does not mutate signals, preferences,
 * retired entries, the log, or the snapshots.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { LinkOutputFormat } from "../config.ts";

import { backlinkCount, buildBacklinkIndex, type BacklinkIndex } from "./backlinks.ts";
import { computeAgentSummary, type AgentSummaryEntry } from "./digest-agent-summary.ts";
import { findMergeCandidates } from "./merge-candidates.ts";
import { computeMostApplied } from "./most-applied.ts";
import { brainDirs, vaultRelative } from "./paths.ts";
import type { TrustVerdict } from "./doctor.ts";
import { collectMaintenanceActions } from "./maintenance/collect.ts";
import type { ActionItem } from "./maintenance/action-scorer.ts";
import {
  MOST_APPLIED_LIMIT_DEFAULT,
  MOST_APPLIED_WINDOW_DAYS_DEFAULT,
  loadBrainConfig,
} from "./policy.ts";
import { normaliseWikilinkTarget, renderPrefLink } from "./wikilink.ts";
import { parsePreference, parseRetired } from "./preference.ts";
import type { BrainLogEntry } from "./log.ts";
import { listLogDates, readLogDay } from "./log-jsonl.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
} from "./types.ts";
import type { BrainConfidence, BrainPreference, BrainRetired } from "./types.ts";

// ----- Public types ---------------------------------------------------------

export type DigestFormat = "markdown" | "json";

export interface RenderDigestOptions {
  /** Inclusive lower bound. Defaults to `until - 24h`. */
  readonly since?: Date;
  /** Exclusive upper bound. Defaults to `new Date()`. */
  readonly until?: Date;
  /** Output format. Defaults to `markdown`. */
  readonly format?: DigestFormat;
  /** Presentation link format for Markdown output. Defaults to Obsidian wikilinks. */
  readonly linkOutputFormat?: LinkOutputFormat;
  /**
   * Injection seam for deterministic tests: defaults the generated_at
   * timestamp. Production callers do not pass this — the renderer
   * picks `new Date()` itself.
   */
  readonly now?: Date;
  /**
   * Optional doctor result (v0.10.16). When supplied, `trust_verdict`
   * lands in the JSON payload and a `## Trust` section renders in
   * markdown.
   */
  readonly doctorResult?: import("./doctor.ts").RunDoctorResult;
  /**
   * Optional dream summary (v0.10.16). When supplied,
   * `uncertain_count` and `quarantined_count` reflect the
   * counterparts on the summary instead of defaulting to zero.
   */
  readonly dreamSummary?: import("./dream.ts").DreamRunSummary;
}

export interface RenderDigestResult {
  /** Rendered Markdown (default) or JSON body. */
  readonly content: string;
  /** True when every section is empty (single-line output / `summary.empty`). */
  readonly empty: boolean;
}

// ----- JSON shape (mirrors §8.2) -------------------------------------------

export interface DigestJsonNewUnconfirmed {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly signal_count: number;
  readonly unconfirmed_until: string;
  readonly path: string;
}

export interface DigestJsonConfirmed {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly confirmed_at: string;
  readonly first_applied_artifact: string | null;
}

export interface DigestJsonRetired {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly retired_at: string;
  readonly reason: string;
  readonly days_stale: number | null;
}

export interface DigestJsonConfidenceShift {
  readonly id: string;
  /**
   * Human-readable title sourced from the referenced pref or retired's
   * `principle` field. Empty string when the id does not resolve to a
   * known artifact (the markdown renderer falls back to bare `[[id]]`).
   */
  readonly principle: string;
  readonly from: BrainConfidence | string;
  readonly to: BrainConfidence | string;
  readonly applied_count: number | null;
  readonly violated_count: number | null;
}

export interface DigestJsonContradiction {
  readonly id: string;
  /** See {@link DigestJsonConfidenceShift.principle}. */
  readonly principle: string;
  readonly topic: string | null;
  readonly description: string;
}

/**
 * "Hot" preference by lifetime evidence-application count. Reflects
 * the rules carrying real weight right now, regardless of whether
 * anything about them changed in the window. Source: current state
 * of `Brain/preferences/` (confirmed + quarantine).
 */
export interface DigestJsonTopApplied {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly confidence: BrainConfidence | string;
  readonly status: string;
}

/**
 * Preference with the most inbound wikilink references in the vault.
 * Source: the lifetime backlink index over preferences/retired/log.
 * Higher count → the rule is mentioned in more contexts.
 */
export interface DigestJsonTopReferenced {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly backlink_count: number;
}

/**
 * Most-applied entry: one preference + its applied-in-window count.
 * Drives the `Most-applied (Nd)` section in `brain_digest` Markdown
 * and the mirrored block in the JSON output. The window length and
 * limit come from `_brain.yaml:active.most_applied_*`.
 */
export interface DigestJsonMostAppliedEntry {
  readonly id: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly applied_in_window: number;
}

export interface DigestJsonMostApplied {
  readonly window_days: number;
  readonly limit: number;
  readonly entries: ReadonlyArray<DigestJsonMostAppliedEntry>;
}

export interface DigestJsonAgentSummary {
  readonly agent: string;
  readonly total_events: number;
  readonly feedback_count: number;
  readonly apply_evidence_count: number;
  readonly note_count: number;
  readonly confirmed_attributed: number;
  readonly retired_attributed: number;
}

/**
 * Near-duplicate pair surfaced for operator review. Detected by
 * `findMergeCandidates`. Reflects current vault state, not windowed
 * change — does not gate the `isEmpty` predicate.
 */
export interface DigestJsonMergeSuggestion {
  readonly a: string;
  readonly b: string;
  readonly principle_a: string;
  readonly principle_b: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly jaccard: number;
}

/**
 * Vault-level connection-density health metric (v0.10.14).
 * Surfaces the ratio of linked notes to total notes, orphan count,
 * and backlink distribution — answering whether the vault grows as a
 * network of ideas or as an "organized graveyard".
 */
export interface DigestJsonConnectionHealth {
  readonly total_nodes: number;
  readonly linked_nodes: number;
  readonly orphan_nodes: number;
  readonly mean_backlinks: number;
  readonly median_backlinks: number;
  readonly link_density: number;
}

export interface DigestJson {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly window: { readonly since: string; readonly until: string };
  readonly summary: {
    readonly new_unconfirmed_count: number;
    readonly confirmed_count: number;
    readonly retired_count: number;
    readonly confidence_shift_count: number;
    readonly contradiction_count: number;
    readonly empty: boolean;
  };
  readonly new_unconfirmed: ReadonlyArray<DigestJsonNewUnconfirmed>;
  readonly confirmed: ReadonlyArray<DigestJsonConfirmed>;
  readonly retired: ReadonlyArray<DigestJsonRetired>;
  readonly confidence_shifts: ReadonlyArray<DigestJsonConfidenceShift>;
  readonly contradictions: ReadonlyArray<DigestJsonContradiction>;
  readonly top_applied: ReadonlyArray<DigestJsonTopApplied>;
  readonly top_referenced: ReadonlyArray<DigestJsonTopReferenced>;
  readonly merge_suggestions: ReadonlyArray<DigestJsonMergeSuggestion>;
  readonly agent_summary: ReadonlyArray<DigestJsonAgentSummary>;
  /**
   * Window-scoped most-applied list (v0.10.11). Mirrors the
   * `Most-applied (Nd)` section of `Brain/active.md` and uses the
   * same `_brain.yaml:active.most_applied_*` settings.
   */
  readonly most_applied: DigestJsonMostApplied;
  /**
   * Vault-level connection-density health metric (v0.10.14).
   * Independent of the window — reflects current vault state.
   */
  readonly connection_health: DigestJsonConnectionHealth;
  /**
   * Ranked maintenance actions (v0.10.15). Aggregates page-dedup
   * candidates, lint demotions / merged-link rewrites, and token
   * footprint excess; deterministic ordering. Empty when nothing
   * needs doing. Independent of the window.
   */
  readonly actions: ReadonlyArray<ActionItem>;
  /**
   * Aggregate vault trust verdict (v0.10.16). Absent when no
   * doctor input was threaded into the digest call; consumers that
   * only need the legacy preference-and-signal sections can ignore
   * the field.
   */
  readonly trust_verdict?: TrustVerdict;
  /**
   * Count of dream-pass uncertain entries in the most recent run
   * (v0.10.16). Zero when no dream input was provided.
   */
  readonly uncertain_count: number;
  /**
   * Count of dream-pass signal clusters held back by the
   * self-approval guardrail in the most recent run (v0.10.16).
   * Zero when no dream input was provided.
   */
  readonly quarantined_count: number;
}

/**
 * How many entries to keep in each "hot" digest section. Small fixed
 * value — the digest is meant to be skimmable, not exhaustive.
 */
const HOT_SECTION_LIMIT = 5;

// ----- Entry point ----------------------------------------------------------

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function renderDigest(vault: string, opts: RenderDigestOptions = {}): RenderDigestResult {
  const format = opts.format ?? "markdown";
  const now = opts.now ?? new Date();
  const until = opts.until ?? now;
  const since = opts.since ?? new Date(until.getTime() - ONE_DAY_MS);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    throw new TypeError("renderDigest: `since` and `until` must be valid Dates");
  }
  if (since.getTime() > until.getTime()) {
    throw new RangeError(
      `renderDigest: since (${since.toISOString()}) is after until (${until.toISOString()})`,
    );
  }

  const data = collectDigestData(vault, since, until);
  const empty = isEmpty(data);

  if (format === "json") {
    const payload: DigestJson = {
      schema_version: 1,
      generated_at: now.toISOString(),
      window: { since: since.toISOString(), until: until.toISOString() },
      summary: {
        new_unconfirmed_count: data.new_unconfirmed.length,
        confirmed_count: data.confirmed.length,
        retired_count: data.retired.length,
        confidence_shift_count: data.confidence_shifts.length,
        contradiction_count: data.contradictions.length,
        empty,
      },
      new_unconfirmed: data.new_unconfirmed,
      confirmed: data.confirmed,
      retired: data.retired,
      confidence_shifts: data.confidence_shifts,
      contradictions: data.contradictions,
      top_applied: data.top_applied,
      top_referenced: data.top_referenced,
      merge_suggestions: data.merge_suggestions,
      agent_summary: data.agent_summary,
      most_applied: data.most_applied,
      connection_health: data.connection_health,
      actions: data.actions,
      // Guarded: dreamSummary may arrive from an untyped JSON-RPC
      // boundary (or from a future caller that has not populated
      // every array). Optional-chain the inner length read.
      uncertain_count: opts.dreamSummary?.uncertain?.length ?? 0,
      quarantined_count: opts.dreamSummary?.quarantined?.length ?? 0,
      ...(opts.doctorResult?.trust_verdict !== undefined
        ? { trust_verdict: opts.doctorResult.trust_verdict }
        : {}),
    };
    return Object.freeze({
      content: JSON.stringify(payload, null, 2) + "\n",
      empty,
    });
  }

  // Markdown.
  const linkOutputFormat = opts.linkOutputFormat ?? "wikilink";
  const baseMd = empty
    ? renderEmptyMarkdown(until)
    : renderMarkdown(data, since, until, linkOutputFormat);
  const trustSection = renderTrustSection(opts.doctorResult, opts.dreamSummary);
  const content = trustSection ? `${baseMd}\n${trustSection}` : baseMd;
  return Object.freeze({ content, empty });
}

/**
 * Markdown `## Trust` section (v0.10.16). Rendered only when either
 * a doctor result or a dream summary is threaded through the digest
 * options - otherwise legacy output stays bit-identical.
 */
function renderTrustSection(
  doctor?: import("./doctor.ts").RunDoctorResult,
  dream?: import("./dream.ts").DreamRunSummary,
): string {
  if (doctor === undefined && dream === undefined) return "";
  const lines: string[] = ["## Trust", ""];
  if (doctor?.trust_verdict !== undefined) {
    lines.push(`- Verdict: **${doctor.trust_verdict}**`);
  }
  if (dream !== undefined) {
    lines.push(`- Uncertain: ${dream.uncertain.length}`);
    lines.push(`- Quarantined: ${dream.quarantined.length}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ----- Data collection ------------------------------------------------------

interface DigestData {
  readonly new_unconfirmed: ReadonlyArray<DigestJsonNewUnconfirmed>;
  readonly confirmed: ReadonlyArray<DigestJsonConfirmed>;
  readonly retired: ReadonlyArray<DigestJsonRetired>;
  readonly confidence_shifts: ReadonlyArray<DigestJsonConfidenceShift>;
  readonly contradictions: ReadonlyArray<DigestJsonContradiction>;
  readonly top_applied: ReadonlyArray<DigestJsonTopApplied>;
  readonly top_referenced: ReadonlyArray<DigestJsonTopReferenced>;
  readonly merge_suggestions: ReadonlyArray<DigestJsonMergeSuggestion>;
  readonly agent_summary: ReadonlyArray<AgentSummaryEntry>;
  readonly most_applied: DigestJsonMostApplied;
  readonly connection_health: DigestJsonConnectionHealth;
  readonly actions: ReadonlyArray<ActionItem>;
}

function collectDigestData(vault: string, since: Date, until: Date): DigestData {
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const inWindow = (iso: string | null): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    return t >= sinceMs && t < untilMs;
  };

  // 1. Iterate preferences/ for unconfirmed (created_at in window) and
  //    confirmed (confirmed_at in window).
  const preferences = readAllPreferences(vault);
  const new_unconfirmed: DigestJsonNewUnconfirmed[] = [];
  const confirmed: DigestJsonConfirmed[] = [];

  for (const { pref, path } of preferences) {
    if (pref.status === "unconfirmed" && inWindow(pref.created_at)) {
      new_unconfirmed.push({
        id: pref.id,
        topic: pref.topic,
        principle: pref.principle,
        scope: pref.scope ?? null,
        signal_count: pref.evidenced_by.length,
        unconfirmed_until: pref.unconfirmed_until,
        path: vaultRelative(path, vault),
      });
    }
    if (pref.status === "confirmed" && inWindow(pref.confirmed_at)) {
      confirmed.push({
        id: pref.id,
        topic: pref.topic,
        principle: pref.principle,
        scope: pref.scope ?? null,
        confirmed_at: pref.confirmed_at!,
        first_applied_artifact: findFirstAppliedArtifact(vault, pref.id),
      });
    }
  }

  // 2. Iterate retired/ for entries retired in window.
  const retiredEntries: DigestJsonRetired[] = [];
  const retiredAll = readAllRetired(vault);
  for (const { ret, path } of retiredAll) {
    void path;
    if (inWindow(ret.retired_at)) {
      const daysStale = daysStaleFor(ret);
      retiredEntries.push({
        id: ret.id,
        topic: ret.topic,
        principle: ret.principle,
        scope: ret.scope ?? null,
        retired_at: ret.retired_at,
        reason: ret.retired_reason,
        days_stale: daysStale,
      });
    }
  }

  // 3 & 4. Confidence shifts and contradictions — degraded gracefully
  // when payload data is missing. The extractors look principles up
  // against the combined pref + retired index so the markdown renderer
  // can emit titled wikilinks; ids that resolve to neither map fall
  // back to an empty principle (and a bare `[[id]]` link).
  const idToPrinciple = new Map<string, string>();
  for (const { pref } of preferences) idToPrinciple.set(pref.id, pref.principle);
  for (const { ret } of retiredAll) idToPrinciple.set(ret.id, ret.principle);
  const logEntries = readLogsInWindow(vault, since, until);
  const confidenceShifts = extractConfidenceShifts(logEntries, idToPrinciple);
  const contradictions = extractContradictions(logEntries, idToPrinciple);

  // Stable ordering — id ascending so two runs on the same fixture
  // produce byte-identical output.
  new_unconfirmed.sort((a, b) => a.id.localeCompare(b.id));
  confirmed.sort((a, b) => a.id.localeCompare(b.id));
  retiredEntries.sort((a, b) => a.id.localeCompare(b.id));

  const top_applied = pickTopApplied(preferences);
  // Built once and shared with `computeConnectionHealth` below: both
  // read the same vault state within this digest run, so one
  // full-history backlink scan replaces two.
  const backlinkIndex = buildBacklinkIndex(vault);
  const top_referenced = pickTopReferenced(backlinkIndex, preferences);
  // `merge_suggestions` reflects current vault state, not windowed
  // change. It is independent of `since`/`until` on purpose —
  // operators should see pending duplicates regardless of the digest
  // window. Excluded from `isEmpty` for the same reason.
  // Reuse the already-parsed preferences from the digest scan
  // instead of asking the detector to walk `Brain/preferences/`
  // a second time. Same on-disk state, single read.
  const preferenceObjects = preferences.map(({ pref }) => pref);
  const merge_suggestions = findMergeCandidates(vault, {
    preferences: preferenceObjects,
  }).map((c) => ({
    a: c.a,
    b: c.b,
    principle_a: c.principle_a,
    principle_b: c.principle_b,
    topic: c.topic,
    scope: c.scope,
    jaccard: c.jaccard,
  }));

  const agent_summary = computeAgentSummary(vault, since, until);

  // Most-applied (Nd) — mirrors the section in `Brain/active.md`.
  // The window length / limit come from `_brain.yaml`; a corrupted
  // config falls back to defaults so the digest never breaks on
  // operator-side schema drift.
  let mostAppliedWindowDays = MOST_APPLIED_WINDOW_DAYS_DEFAULT;
  let mostAppliedLimit = MOST_APPLIED_LIMIT_DEFAULT;
  try {
    const cfg = loadBrainConfig(vault);
    if (cfg.active?.most_applied) {
      mostAppliedWindowDays = cfg.active.most_applied.window_days;
      mostAppliedLimit = cfg.active.most_applied.limit;
    }
  } catch {
    // fall through to defaults
  }
  const activePrefs = preferences
    .filter(
      ({ pref }) =>
        pref.status === BRAIN_PREFERENCE_STATUS.confirmed ||
        pref.status === BRAIN_PREFERENCE_STATUS.quarantine,
    )
    .map(({ pref }) => pref);
  const mostAppliedEntries = computeMostApplied(vault, activePrefs, {
    now: until,
    windowDays: mostAppliedWindowDays,
    limit: mostAppliedLimit,
  }).map((e) => ({
    id: e.preference.id,
    principle: e.preference.principle,
    scope: e.preference.scope ?? null,
    applied_in_window: e.applied_30d,
  }));
  const most_applied: DigestJsonMostApplied = {
    window_days: mostAppliedWindowDays,
    limit: mostAppliedLimit,
    entries: mostAppliedEntries,
  };

  return {
    new_unconfirmed,
    confirmed,
    retired: retiredEntries,
    confidence_shifts: confidenceShifts,
    contradictions,
    top_applied,
    top_referenced,
    merge_suggestions,
    agent_summary,
    most_applied,
    connection_health: computeConnectionHealth(vault, backlinkIndex, preferences),
    actions: collectMaintenanceActions(vault),
  };
}

function pickTopApplied(
  preferences: ReadonlyArray<PreferenceWithPath>,
): ReadonlyArray<DigestJsonTopApplied> {
  const active = preferences.filter(
    ({ pref }) =>
      (pref.status === BRAIN_PREFERENCE_STATUS.confirmed ||
        pref.status === BRAIN_PREFERENCE_STATUS.quarantine) &&
      pref.applied_count > 0,
  );
  active.sort((a, b) => {
    const diff = b.pref.applied_count - a.pref.applied_count;
    if (diff !== 0) return diff;
    // Stable secondary key: id ascending. Without it the same input on
    // two filesystems (different readdir order) could swap ties.
    return a.pref.id.localeCompare(b.pref.id);
  });
  return active.slice(0, HOT_SECTION_LIMIT).map(({ pref }) => ({
    id: pref.id,
    topic: pref.topic,
    principle: pref.principle,
    scope: pref.scope ?? null,
    applied_count: pref.applied_count,
    violated_count: pref.violated_count,
    confidence: pref.confidence,
    status: pref.status,
  }));
}

function pickTopReferenced(
  index: BacklinkIndex,
  preferences: ReadonlyArray<PreferenceWithPath>,
): ReadonlyArray<DigestJsonTopReferenced> {
  const scored = preferences
    .map(({ pref }) => ({
      pref,
      count: backlinkCount(index, pref.id),
    }))
    .filter((x) => x.count > 0);
  scored.sort((a, b) => {
    const diff = b.count - a.count;
    if (diff !== 0) return diff;
    return a.pref.id.localeCompare(b.pref.id);
  });
  return scored.slice(0, HOT_SECTION_LIMIT).map(({ pref, count }) => ({
    id: pref.id,
    topic: pref.topic,
    principle: pref.principle,
    scope: pref.scope ?? null,
    backlink_count: count,
  }));
}

/**
 * Compute vault-level connection-density health metrics from the
 * backlink index over all preferences and retired entries.
 */
function computeConnectionHealth(
  vault: string,
  index: BacklinkIndex,
  preferences: ReadonlyArray<PreferenceWithPath>,
): DigestJsonConnectionHealth {
  const allIds = preferences.map(({ pref }) => pref.id);
  // Also include retired entries.
  const dirs = brainDirs(vault);
  if (existsSync(dirs.retired)) {
    for (const entry of readdirSync(dirs.retired, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (!entry.name.startsWith("ret-")) continue;
      allIds.push(entry.name.replace(/\.md$/, ""));
    }
  }

  const totalNodes = allIds.length;
  const counts = allIds.map((id) => backlinkCount(index, id));
  const linkedNodes = counts.filter((c) => c > 0).length;
  const orphanNodes = totalNodes - linkedNodes;

  let meanBacklinks = 0;
  let medianBacklinks = 0;
  if (totalNodes > 0) {
    const sum = counts.reduce((a, b) => a + b, 0);
    meanBacklinks = Math.round((sum / totalNodes) * 100) / 100;
    const sorted = [...counts].toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianBacklinks =
      sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  }
  const linkDensity = totalNodes > 0 ? Math.round((linkedNodes / totalNodes) * 1000) / 1000 : 0;

  return Object.freeze({
    total_nodes: totalNodes,
    linked_nodes: linkedNodes,
    orphan_nodes: orphanNodes,
    mean_backlinks: meanBacklinks,
    median_backlinks: medianBacklinks,
    link_density: linkDensity,
  });
}

function isEmpty(data: DigestData): boolean {
  return (
    data.new_unconfirmed.length === 0 &&
    data.confirmed.length === 0 &&
    data.retired.length === 0 &&
    data.confidence_shifts.length === 0 &&
    data.contradictions.length === 0 &&
    data.most_applied.entries.length === 0 &&
    data.agent_summary.length === 0
  );
}

// ----- Filesystem scan helpers ---------------------------------------------

interface PreferenceWithPath {
  readonly pref: BrainPreference;
  readonly path: string;
}

function readAllPreferences(vault: string): ReadonlyArray<PreferenceWithPath> {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return [];
  const out: PreferenceWithPath[] = [];
  for (const entry of readdirSync(dirs.preferences, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("pref-")) continue;
    const path = join(dirs.preferences, entry.name);
    try {
      out.push({ pref: parsePreference(path), path });
    } catch {
      // The doctor reports corruption; digest skips silently.
    }
  }
  return out;
}

interface RetiredWithPath {
  readonly ret: BrainRetired;
  readonly path: string;
}

function readAllRetired(vault: string): ReadonlyArray<RetiredWithPath> {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.retired)) return [];
  const out: RetiredWithPath[] = [];
  for (const entry of readdirSync(dirs.retired, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("ret-")) continue;
    const path = join(dirs.retired, entry.name);
    try {
      out.push({ ret: parseRetired(path), path });
    } catch {
      // ditto
    }
  }
  return out;
}

function readLogsInWindow(vault: string, since: Date, until: Date): ReadonlyArray<BrainLogEntry> {
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  // Restrict scans to dates intersecting the window — but we err
  // permissive (one day before / after) to avoid TZ off-by-ones.
  // Shard-aware (Memory Integrity Suite): dates come from listLogDates
  // and entries arrive merged across device shards via readLogDay.
  const sinceDay = sinceIso.slice(0, 10);
  const untilDay = untilIso.slice(0, 10);
  const out: BrainLogEntry[] = [];
  for (const date of listLogDates(vault)) {
    if (date < addDays(sinceDay, -1)) continue;
    if (date > addDays(untilDay, 1)) continue;
    const { entries } = readLogDay(vault, date);
    for (const e of entries) {
      if (e.timestamp >= sinceIso && e.timestamp < untilIso) {
        out.push(e);
      }
    }
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}

function addDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + delta * ONE_DAY_MS).toISOString().slice(0, 10);
}

/**
 * Best-effort lookup of the artifact wikilink for the first `applied`
 * apply-evidence event against a preference id. Returns null if no
 * applied evidence is found — e.g. a preference that was force-confirmed
 * without ever being applied. This matches design doc §8.2 example.
 */
function findFirstAppliedArtifact(vault: string, prefId: string): string | null {
  for (const date of listLogDates(vault)) {
    const { entries } = readLogDay(vault, date);
    for (const e of entries) {
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      if (e.body["result"] !== BRAIN_APPLY_RESULT.applied) continue;
      const prefPayload = e.body["preference"];
      if (typeof prefPayload === "string" && refersTo(prefPayload, prefId)) {
        const artifact = e.body["artifact"];
        if (typeof artifact === "string") return artifact;
      }
    }
  }
  return null;
}

function refersTo(payload: string, prefId: string): boolean {
  return normaliseWikilinkTarget(payload) === prefId;
}

function daysStaleFor(ret: BrainRetired): number | null {
  // For `stale-no-evidence`, the "days stale" is the gap between
  // `retired_at` and `last_evidence_at` (or `created_at` if there is
  // no evidence at all). Other reasons get null — the field is only
  // meaningful under stale-no-evidence per §8.2 example. We still
  // emit non-null for completeness on rebutted / expired-unconfirmed
  // when computable, but only for stale-no-evidence is it the canonical
  // metric the digest's "(91 days)" parenthetical refers to.
  if (ret.retired_reason !== BRAIN_RETIRED_REASON.staleNoEvidence) return null;
  const start = ret.last_evidence_at ?? ret.created_at;
  const startMs = Date.parse(start);
  const endMs = Date.parse(ret.retired_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, Math.floor((endMs - startMs) / ONE_DAY_MS));
}

// ----- Confidence shifts & contradictions ----------------------------------
//
// Task 3 (`dream.ts`) is in progress as we ship this. It is the only
// component that can authoritatively emit confidence transitions and
// contradictions; without its payload data we cannot reconstruct
// transitions from filesystem state alone (the current `confidence`
// field has no `from` value to compare against). Per the §15 Task 4
// spec, the digest tolerates the absent payload as a graceful empty.
//
// When dream eventually emits these in its run summary, the parsers
// below will pick them up because we look in flexible payload shapes
// (the `dream` event's bullet list).

function extractConfidenceShifts(
  entries: ReadonlyArray<BrainLogEntry>,
  idToPrinciple: ReadonlyMap<string, string>,
): ReadonlyArray<DigestJsonConfidenceShift> {
  const out: DigestJsonConfidenceShift[] = [];
  for (const e of entries) {
    if (e.eventType !== BRAIN_LOG_EVENT_KIND.dream) continue;
    // Pattern A: a `confidence_shifts` array, each item like
    // `[[pref-foo]] medium -> high (applied: 11, violated: 0)`.
    const shifts = e.body["confidence_shifts"];
    if (Array.isArray(shifts)) {
      for (const raw of shifts) {
        const parsed = parseShiftLine(raw, idToPrinciple);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

function parseShiftLine(
  raw: string,
  idToPrinciple: ReadonlyMap<string, string>,
): DigestJsonConfidenceShift | null {
  // Tolerant parser: accept `[[pref-x]] medium -> high (applied: N, violated: M)`
  // and variations (en-dash / em-dash for arrow, missing parens).
  const m = /^\s*(?:\[\[([^\]]+)\]\]|(\S+))\s+(\w+)\s*(?:->|→)\s*(\w+)(?:\s*\(([^)]*)\))?/.exec(
    raw,
  );
  if (!m) return null;
  const idRaw = (m[1] ?? m[2])!.split(/[|#]/)[0]!.trim();
  if (!idRaw) return null;
  const from = m[3]!;
  const to = m[4]!;
  let applied: number | null = null;
  let violated: number | null = null;
  if (m[5]) {
    const appMatch = /applied\s*[:=]?\s*(\d+)/i.exec(m[5]);
    if (appMatch) applied = parseInt(appMatch[1]!, 10);
    const violMatch = /violated\s*[:=]?\s*(\d+)/i.exec(m[5]);
    if (violMatch) violated = parseInt(violMatch[1]!, 10);
  }
  return {
    id: idRaw,
    principle: idToPrinciple.get(idRaw) ?? "",
    from,
    to,
    applied_count: applied,
    violated_count: violated,
  };
}

function extractContradictions(
  entries: ReadonlyArray<BrainLogEntry>,
  idToPrinciple: ReadonlyMap<string, string>,
): ReadonlyArray<DigestJsonContradiction> {
  const out: DigestJsonContradiction[] = [];
  for (const e of entries) {
    if (e.eventType !== BRAIN_LOG_EVENT_KIND.dream) continue;
    const list = e.body["contradictions"];
    if (Array.isArray(list)) {
      for (const raw of list) {
        const parsed = parseContradictionLine(raw, idToPrinciple);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

function parseContradictionLine(
  raw: string,
  idToPrinciple: ReadonlyMap<string, string>,
): DigestJsonContradiction | null {
  // Best-effort: extract a wikilink as id and treat the rest as topic
  // or description. A missing wikilink means we cannot anchor the
  // contradiction to a preference; skip rather than fabricate.
  const wm = /\[\[([^\]]+)\]\]/.exec(raw);
  if (!wm) return null;
  const id = wm[1]!.split(/[|#]/)[0]!.trim();
  const description = raw.replace(wm[0], "").trim() || raw.trim();
  // The line may carry `(topic: foo)` — pull it out if present.
  let topic: string | null = null;
  const tm = /topic\s*[:=]\s*([A-Za-z0-9_-]+)/.exec(description);
  if (tm) topic = tm[1]!;
  return {
    id,
    principle: idToPrinciple.get(id) ?? "",
    topic,
    description,
  };
}

// ----- Markdown rendering --------------------------------------------------

function renderEmptyMarkdown(until: Date): string {
  // Single-line collapse per §8 paragraph above the listing.
  const ymd = until.toISOString().slice(0, 10);
  return `Brain digest — ${ymd}: no changes\n`;
}

function renderMarkdown(
  data: DigestData,
  since: Date,
  until: Date,
  linkOutputFormat: LinkOutputFormat,
): string {
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const windowHours = Math.round((until.getTime() - since.getTime()) / (60 * 60 * 1000));
  const lines: string[] = [];
  lines.push(
    `# Brain digest — ${untilIso.slice(0, 16)}Z (${windowHours}h)`,
    "",
    `Window: ${sinceIso} — ${untilIso}`,
    "",
  );

  if (data.new_unconfirmed.length > 0) {
    lines.push("## New (unconfirmed, in trial)", "");
    for (const item of data.new_unconfirmed) {
      const scope = item.scope ?? "—";
      const trialDay = item.unconfirmed_until.slice(0, 10);
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${item.signal_count} signals, trial ends ${trialDay}`,
      );
    }
    lines.push("");
  }
  if (data.confirmed.length > 0) {
    lines.push("## Confirmed", "");
    for (const item of data.confirmed) {
      const scope = item.scope ?? "—";
      const artifact = item.first_applied_artifact ?? "_(none)_";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, first applied in ${artifact}`,
      );
    }
    lines.push("");
  }
  if (data.retired.length > 0) {
    lines.push("## Retired", "");
    for (const item of data.retired) {
      const scope = item.scope ?? "—";
      const detail =
        item.reason === BRAIN_RETIRED_REASON.staleNoEvidence && item.days_stale !== null
          ? `${item.reason} (${item.days_stale} days)`
          : item.reason;
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${detail}`,
      );
    }
    lines.push("");
  }
  if (data.most_applied.entries.length > 0) {
    lines.push(
      `## Most-applied (${data.most_applied.window_days}d) (${data.most_applied.entries.length})`,
      "",
    );
    for (const item of data.most_applied.entries) {
      const scope = item.scope ?? "—";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${item.applied_in_window} applied`,
      );
    }
    lines.push("");
  }
  if (data.agent_summary.length > 0) {
    lines.push(`## Agent summary (${data.agent_summary.length})`, "");
    for (const item of data.agent_summary) {
      const parts = [
        `**${item.agent}**`,
        `${item.total_events} events`,
        `(feedback: ${item.feedback_count}, apply: ${item.apply_evidence_count}, note: ${item.note_count})`,
      ];
      if (item.confirmed_attributed > 0) parts.push(`→ ${item.confirmed_attributed} confirmed`);
      if (item.retired_attributed > 0) parts.push(`→ ${item.retired_attributed} retired`);
      lines.push(`- ${parts.join(" ")}`);
    }
    lines.push("");
  }
  if (data.top_applied.length > 0) {
    lines.push(`## Top applied (${data.top_applied.length})`, "");
    for (const item of data.top_applied) {
      const scope = item.scope ?? "—";
      const stats = `applied: ${item.applied_count}, violated: ${item.violated_count}`;
      const tags = item.status === "quarantine" ? " [quarantine]" : "";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${stats}${tags}`,
      );
    }
    lines.push("");
  }
  if (data.top_referenced.length > 0) {
    lines.push(`## Top referenced (${data.top_referenced.length})`, "");
    for (const item of data.top_referenced) {
      const scope = item.scope ?? "—";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${scope}, ${item.backlink_count} inbound`,
      );
    }
    lines.push("");
  }
  // Connection health is always rendered when vault has nodes — it
  // reflects vault-wide structural state, not windowed change.
  if (data.connection_health.total_nodes > 0) {
    const ch = data.connection_health;
    const pct = Math.round(ch.link_density * 100);
    lines.push(
      "## Connection health",
      "",
      `- Total nodes: ${ch.total_nodes}`,
      `- Linked (≥1 inbound): ${ch.linked_nodes}`,
      `- Orphans (0 inbound): ${ch.orphan_nodes}`,
      `- Mean backlinks: ${ch.mean_backlinks}`,
      `- Median backlinks: ${ch.median_backlinks}`,
      `- Link density: ${pct}%`,
      "",
    );
  }
  // Ranked maintenance actions (v0.10.15). Same window-independent
  // shape as connection-health: surface only when the scorer
  // returned anything, so empty vaults stay quiet.
  if (data.actions.length > 0) {
    lines.push(`## Actions (${data.actions.length})`, "");
    for (const a of data.actions) {
      lines.push(`- [${a.category}] impact ${a.impact} — ${a.title}`);
    }
    lines.push("");
  }
  if (data.merge_suggestions.length > 0) {
    lines.push(`## Merge suggestions (${data.merge_suggestions.length})`, "");
    for (const item of data.merge_suggestions) {
      const scope = item.scope ?? "—";
      lines.push(
        `- ${renderPrefLink({ id: item.a, principle: item.principle_a, format: linkOutputFormat })}` +
          ` ≈ ${renderPrefLink({ id: item.b, principle: item.principle_b, format: linkOutputFormat })}` +
          ` — topic '${item.topic}', scope ${scope}, jaccard ${item.jaccard.toFixed(2)}`,
      );
    }
    lines.push("");
  }
  if (data.confidence_shifts.length > 0) {
    lines.push("## Confidence shifts", "");
    for (const item of data.confidence_shifts) {
      const stats =
        item.applied_count !== null && item.violated_count !== null
          ? ` (applied: ${item.applied_count}, violated: ${item.violated_count})`
          : "";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} ${item.from} → ${item.to}${stats}`,
      );
    }
    lines.push("");
  }
  if (data.contradictions.length > 0) {
    lines.push("## Contradictions", "");
    for (const item of data.contradictions) {
      const topic = item.topic ? ` (topic: ${item.topic})` : "";
      lines.push(
        `- ${renderPrefLink({ id: item.id, principle: item.principle, format: linkOutputFormat })} — ${item.description}${topic}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

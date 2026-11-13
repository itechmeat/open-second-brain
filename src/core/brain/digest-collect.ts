/**
 * The digest's data collection (task 3.19): the fold over the
 * preferences, retired records and log window the digest reports on,
 * the filesystem scan helpers it reads through, and the confidence-shift
 * and contradiction extractors. Split from `digest.ts`.
 */

import { posix } from "node:path";
import { everyArtifactRefView, type ArtifactRefView } from "./artifact-ref-view.ts";
import { logEntriesAtReach, logEntryAtReach } from "./log-events-at-reach.ts";
import { buildBacklinkIndex } from "./backlinks.ts";
import { computeAgentSummary } from "./digest-agent-summary.ts";
import { findMergeCandidates } from "./merge-candidates.ts";
import { computeMostApplied } from "./most-applied.ts";
import { BRAIN_RETIRED_REL, brainDirs, vaultRelative } from "./paths.ts";
import { collectMaintenanceActions, type MaintenanceCollectError } from "./maintenance/collect.ts";
import { loadActiveMostAppliedSafe } from "./policy.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";
import { parseRetiredMeta } from "./preference.ts";
import {
  collectPreferences,
  PREFERENCE_ID_PREFIX,
  resolveOwnerScopeDelivery,
} from "./preferences-collect.ts";
import { isPreferenceVisible } from "./owner-scoped-facts.ts";
import { gatedOwnerScopeView } from "./owner-scope-view.ts";
import type { BrainLogEntry } from "./log.ts";
import { memoryFolderPages } from "./memory-pages.ts";
import { logDayReader } from "./log-days.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
} from "./types.ts";
import type { BrainRetired } from "./types.ts";
import type {
  DigestData,
  DigestJsonConfidenceShift,
  DigestJsonConfirmed,
  DigestJsonContradiction,
  DigestJsonMostApplied,
  DigestJsonNewUnconfirmed,
  DigestJsonRetired,
} from "./digest-types.ts";
import type { PreferenceWithPath } from "./digest-analysis.ts";
import {
  computeConnectionHealth,
  pickTopApplied,
  pickTopReferenced,
  visibleBacklinkCount,
} from "./digest-analysis.ts";

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function collectDigestData(
  vault: string,
  since: Date,
  until: Date,
  agentScope: string | undefined,
  refs: ArtifactRefView,
): DigestData {
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
  const preferences = readAllPreferences(vault, agentScope, refs);
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
        first_applied_artifact: findFirstAppliedArtifact(vault, pref.id, refs),
      });
    }
  }

  // 2. Iterate retired/ for entries retired in window.
  const retiredEntries: DigestJsonRetired[] = [];
  const retiredAll = readAllRetired(vault, agentScope, refs);
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
  const logEntries = logEntriesAtReach(refs, readLogsInWindow(vault, since, until));
  // A shift or contradiction line is one string naming its preference
  // inside other text, so the event-level filter above cannot resolve it;
  // the parsed id is asked on its own. The id resolves through the Brain
  // id-directories, so the enforced ownership rule joins the reach view
  // for these rows - the same composed view the actions below are kept
  // through, so every section that reads past the windowed records asks
  // one question about what "hidden" means.
  const scopedRefs = everyArtifactRefView(gatedOwnerScopeView(vault, agentScope), refs);
  const confidenceShifts = extractConfidenceShifts(logEntries, idToPrinciple).filter((row) =>
    scopedRefs.visible(row.id),
  );
  const contradictions = extractContradictions(logEntries, idToPrinciple).filter((row) =>
    scopedRefs.visible(row.id),
  );

  // Stable ordering — id ascending so two runs on the same fixture
  // produce byte-identical output.
  new_unconfirmed.sort((a, b) => a.id.localeCompare(b.id));
  confirmed.sort((a, b) => a.id.localeCompare(b.id));
  retiredEntries.sort((a, b) => a.id.localeCompare(b.id));

  const top_applied = pickTopApplied(preferences);
  // Built once and shared with `computeConnectionHealth` below: both
  // read the same vault state within this digest run, so one
  // full-history backlink scan replaces two.
  const backlinkIndex = buildBacklinkIndex(vault, undefined, {
    withholdsPrivate: refs.withholdsPrivate === true,
  });
  const inbound = (id: string): number => visibleBacklinkCount(backlinkIndex, id, refs);
  const top_referenced = pickTopReferenced(inbound, preferences);
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

  const agent_summary = computeAgentSummary(
    vault,
    since,
    until,
    refs.filtersNothing ? undefined : (e) => logEntryAtReach(refs, e) !== null,
  );

  // Most-applied (Nd) — mirrors the section in `Brain/active.md`.
  // The window length / limit come from `_brain.yaml`. A vault that has
  // never run `brain init` has no window to read and lands on the
  // documented defaults; a config that is PRESENT but unreadable raises,
  // because re-windowing this section silently changes which rules it
  // names while the digest still reports as healthy.
  //
  // Unlike `active.md`, nothing earlier on this path raises for us: the
  // owner-scope gate consulted by `readAllPreferences` above is the
  // integrity reader, which resolves to its strict fallback rather than
  // throwing. The split has to happen at this read.
  const { window_days: mostAppliedWindowDays, limit: mostAppliedLimit } =
    loadActiveMostAppliedSafe(vault);
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
    withholdsPrivate: refs.withholdsPrivate === true,
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

  // The collector's absorbed scan failures (review M10): observed here so
  // the digest can say why its actions list came back thin.
  const collectErrors: MaintenanceCollectError[] = [];

  // The actions list is collected vault-wide (lint demotions, dedup
  // candidates, merged-link rewrites), so a row can name a preference
  // every section beside it already withholds. The enforced ownership
  // rule therefore joins the reach view for these rows too - the
  // `scopedRefs` composed above for the shift and contradiction lines.
  // `gatedOwnerScopeView` is the same adapter `brain_doctor`'s
  // `suggested_actions` and the operator summary's `top_actions` ask
  // over the same collector output, so the sinks cannot disagree
  // about what "hidden" means. The composed predicate is threaded INTO
  // the collector, so it applies to the candidate inputs before the
  // scorer caps: hidden top-ranked rows take no slot a visible one
  // could fill, and a dedup count excludes hidden secondaries. It
  // hides nothing until `integrity.owner_scope_delivery` is `fail`
  // with a scope, so an unscoped digest stays byte-identical; under
  // `warn` it withholds nothing too, matching every section above.
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
    connection_health: computeConnectionHealth(vault, inbound, preferences, refs),
    actions: scopedRefs.keep(
      collectMaintenanceActions(vault, {
        onError: (e) => collectErrors.push(e),
        visible: scopedRefs.visible,
        withholdsPrivate: refs.withholdsPrivate === true,
      }),
      (action) => [action.target],
    ),
    collect_errors: collectErrors,
  };
}

export function readAllPreferences(
  vault: string,
  agentScope: string | undefined,
  refs: ArtifactRefView,
): ReadonlyArray<PreferenceWithPath> {
  const dirs = brainDirs(vault);
  // Shared delivery-path walk (context-integrity-gates, Unit A). This
  // surface's listing is the strictest of the five - regular files only,
  // and only `pref-*` names - so both rules are passed as options rather
  // than unified away. The doctor reports corruption; digest skips
  // silently, which is what the collector's parse already does.
  return collectPreferences(dirs.preferences, {
    namePrefix: PREFERENCE_ID_PREFIX,
    regularFilesOnly: true,
    ownerScope: resolveOwnerScopeDelivery(vault, agentScope),
  })
    .entries.filter(({ path }) => refs.visible(vaultRelative(path, vault)))
    .map(({ pref, path }) => ({ pref, path }));
}

export interface RetiredWithPath {
  readonly ret: BrainRetired;
  readonly path: string;
}

/**
 * Retirement KEEPS ownership (context-integrity-gates, A7): a retired
 * memory is withdrawn from the active set, never published to every
 * agent. Same gate resolution as {@link readAllPreferences}, so an
 * unscoped digest is byte-identical.
 */
export function readAllRetired(
  vault: string,
  agentScope: string | undefined,
  refs: ArtifactRefView,
): ReadonlyArray<RetiredWithPath> {
  const scope = resolveOwnerScopeDelivery(vault, agentScope).enforcedScope;
  const out: RetiredWithPath[] = [];
  for (const entry of memoryFolderPages(vault, "retired", { regularFilesOnly: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("ret-")) continue;
    if (!refs.visible(posix.join(BRAIN_RETIRED_REL, entry.name))) continue;
    const path = entry.path;
    try {
      const ret = parseRetiredMeta(entry.read()[0], path);
      if (scope !== null && !isPreferenceVisible(ret, scope)) continue;
      out.push({ ret, path });
    } catch {
      // ditto
    }
  }
  return out;
}

export function readLogsInWindow(
  vault: string,
  since: Date,
  until: Date,
): ReadonlyArray<BrainLogEntry> {
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  // Restrict scans to dates intersecting the window — but we err
  // permissive (one day before / after) to avoid TZ off-by-ones.
  // Shard-aware (Memory Integrity Suite): dates come from listLogDates
  // and entries arrive merged across device shards via readLogDay.
  const sinceDay = sinceIso.slice(0, 10);
  const untilDay = untilIso.slice(0, 10);
  const out: BrainLogEntry[] = [];
  const log = logDayReader(vault);
  for (const date of log.dates) {
    if (date < addDays(sinceDay, -1)) continue;
    if (date > addDays(untilDay, 1)) continue;
    const { entries } = log.day(date);
    for (const e of entries) {
      if (e.timestamp >= sinceIso && e.timestamp < untilIso) {
        out.push(e);
      }
    }
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}

export function addDays(day: string, delta: number): string {
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
export function findFirstAppliedArtifact(
  vault: string,
  prefId: string,
  refs: ArtifactRefView,
): string | null {
  const log = logDayReader(vault);
  for (const date of log.dates) {
    const { entries } = log.day(date);
    for (const e of logEntriesAtReach(refs, entries)) {
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

export function refersTo(payload: string, prefId: string): boolean {
  return normaliseWikilinkTarget(payload) === prefId;
}

export function daysStaleFor(ret: BrainRetired): number | null {
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

export function extractConfidenceShifts(
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

export function parseShiftLine(
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

export function extractContradictions(
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

export function parseContradictionLine(
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

/**
 * One rule for every reader that renders Brain log events to a caller
 * who may not read every record those events name.
 *
 * A log event names records by id: an evidence event its preference and
 * the artifact the rule was applied to, a dream the preferences it
 * created, confirmed and retired, any other event the record it scopes
 * to. Below local reach a reader shows the caller the log as if a record
 * it cannot read had never been logged:
 *
 *   - an event naming such a record is dropped, and nothing counts it;
 *   - a dream is the exception, because it is shared: a vault that never
 *     had the withheld record still logged the dream for the others. It
 *     is kept while at least one of its transitions is readable, and it
 *     shows only those. Dropping the whole dream was an oracle of its own
 *     (a count fell when a reserved preference shared a dream).
 *
 * A record is judged under every spelling it answers to across its
 * retirement ({@link recordRefs}), so a transition logged as `pref-x`
 * cannot pass once `ret-x` is the reserved page on disk.
 *
 * The rule is asked through an {@link ArtifactRefView}, so the per-path
 * decision stays with the reach predicate and the ownership predicate;
 * this module adds no visibility rule of its own.
 */

import type { ArtifactRef, ArtifactRefView } from "./artifact-ref-view.ts";
import { PREF_ID_PREFIX, RETIRED_ID_PREFIX } from "./dream-plan.ts";
import { logEntryArtifactRefs, type BrainLogEntry, type BrainLogEntryPayload } from "./log.ts";
import { isBrainLogRel } from "./paths.ts";
import { extractId } from "./temporal/period-common.ts";
import type { DreamSummarySlots, TemporalEvent } from "./temporal/types.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
import { stripBrainIdPrefix } from "./wikilink.ts";

/**
 * Every spelling a preference record answers to across its retirement:
 * `pref-<slug>` before `moveToRetired` renamed it and `ret-<slug>` after.
 * A row naming either must be judged by whichever page is on disk, or a
 * transition logged under `pref-x` would name nothing once `ret-x` is the
 * reserved page, and pass.
 */
export function recordRefs(id: string | undefined): ReadonlyArray<ArtifactRef> {
  if (id === undefined) return [];
  const slug = stripBrainIdPrefix(id);
  return [id, `${PREF_ID_PREFIX}${slug}`, `${RETIRED_ID_PREFIX}${slug}`];
}

/** May the reader see one dream transition, spelled as the dream logged it? */
export function transitionReadable(refs: ArtifactRefView, link: string): boolean {
  return refs.row(link, ...recordRefs(extractId(link)));
}

/** The dream body keys that carry transitions, as the dream pass logs them. */
const DREAM_TRANSITION_KEYS = Object.freeze(["new_unconfirmed", "confirmed", "retired"] as const);

/** The {@link DreamSummarySlots} keys, in the order of {@link DREAM_TRANSITION_KEYS}. */
const DREAM_SUMMARY_SLOTS = Object.freeze(["newUnconfirmed", "confirmed", "retired"] as const);

/**
 * Trim transition lists to the readable links. Answers `null` when the
 * lists held at least one transition and none is readable (the dream is
 * dropped), the input itself when nothing was withheld, and otherwise the
 * trimmed lists with every emptied list left out, as a dream that never
 * named the withheld record would have logged it.
 */
function trimTransitions<K extends string>(
  refs: ArtifactRefView,
  lists: ReadonlyArray<readonly [K, ReadonlyArray<string> | undefined]>,
): ReadonlyMap<K, ReadonlyArray<string>> | null | "unchanged" {
  let total = 0;
  let kept = 0;
  const out = new Map<K, ReadonlyArray<string>>();
  for (const [key, links] of lists) {
    if (links === undefined) continue;
    const readable = links.filter((link) => transitionReadable(refs, link));
    total += links.length;
    kept += readable.length;
    if (readable.length > 0) out.set(key, Object.freeze(readable));
  }
  if (kept === total) return "unchanged";
  return kept === 0 ? null : out;
}

/**
 * The event as a reader behind `refs` may see it, or `null` when it names
 * a record the reader cannot read. See the module docblock for the rule.
 *
 * The page an event was read from is asked too, except a Brain log page:
 * every log event comes from one, and its own verdict below local reach
 * is the reason this per-event rule exists.
 */
export function eventAtReach(refs: ArtifactRefView, ev: TemporalEvent): TemporalEvent | null {
  if (refs.filtersNothing) return ev;
  if (!isBrainLogRel(ev.source.path) && !refs.visible(ev.source.path)) return null;
  if (ev.kind === BRAIN_LOG_EVENT_KIND.applyEvidence) {
    return refs.row(ev.artifact, ...recordRefs(ev.prefId)) ? ev : null;
  }
  if (ev.kind !== BRAIN_LOG_EVENT_KIND.dream) {
    return refs.row(...recordRefs(ev.prefId)) ? ev : null;
  }
  const summary = ev.dreamSummary;
  if (summary === undefined) return ev;
  const trimmed = trimTransitions(
    refs,
    DREAM_SUMMARY_SLOTS.map((slot) => [slot, summary[slot]] as const),
  );
  if (trimmed === "unchanged") return ev;
  if (trimmed === null) return null;
  const dreamSummary: DreamSummarySlots = Object.freeze(Object.fromEntries(trimmed));
  return Object.freeze({ ...ev, dreamSummary });
}

/**
 * A dream log entry as a reader behind `refs` may see it: its transition
 * lists trimmed to the readable links, or `null` when it named
 * transitions and none is readable. Every other entry is returned as it
 * is; the caller still asks its own row rule over the result, which for a
 * trimmed dream no longer names the withheld record.
 */
export function dreamEntryAtReach(
  refs: ArtifactRefView,
  entry: BrainLogEntry,
): BrainLogEntry | null {
  if (refs.filtersNothing || entry.eventType !== BRAIN_LOG_EVENT_KIND.dream) return entry;
  const body = entry.body;
  const trimmed = trimTransitions(
    refs,
    DREAM_TRANSITION_KEYS.map((key) => {
      const value = body[key];
      return [key, Array.isArray(value) ? value : undefined] as const;
    }),
  );
  if (trimmed === "unchanged") return entry;
  if (trimmed === null) return null;
  // Rebuilt in the body's own key order, so a trimmed dream serialises
  // as the dream that never named the withheld record.
  const trimmedBody: Record<string, string | ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(DREAM_TRANSITION_KEYS as ReadonlyArray<string>).includes(key)) {
      trimmedBody[key] = value;
      continue;
    }
    const links = trimmed.get(key as (typeof DREAM_TRANSITION_KEYS)[number]);
    if (links !== undefined) trimmedBody[key] = links;
  }
  return Object.freeze({ ...entry, body: Object.freeze(trimmedBody) as BrainLogEntryPayload });
}

/**
 * A log entry as a reader behind `refs` may see it, or `null`: a dream is
 * trimmed to its readable transitions ({@link dreamEntryAtReach}), and the
 * entry must then name nothing the reader cannot read, every id-shaped
 * reference judged under each spelling its record answers to
 * ({@link recordRefs}). Without the spellings, `[[pref-x|rule]]` named no
 * page once `ret-x` was the reserved page on disk, and passed.
 */
export function logEntryAtReach(refs: ArtifactRefView, entry: BrainLogEntry): BrainLogEntry | null {
  if (refs.filtersNothing) return entry;
  const shown = dreamEntryAtReach(refs, entry);
  if (shown === null) return null;
  const named = logEntryArtifactRefs(shown).flatMap((ref) =>
    ref === undefined ? [] : [ref, ...recordRefs(extractId(ref))],
  );
  return refs.row(...named) ? shown : null;
}

/** The entries a reader behind `refs` may see, each in the form it may see it, in order. */
export function logEntriesAtReach(
  refs: ArtifactRefView,
  entries: ReadonlyArray<BrainLogEntry>,
): ReadonlyArray<BrainLogEntry> {
  if (refs.filtersNothing) return entries;
  return entries.flatMap((entry) => logEntryAtReach(refs, entry) ?? []);
}

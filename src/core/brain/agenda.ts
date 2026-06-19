/**
 * Agenda synthesis over agent-provided calendar events (upstream parity
 * with obsidian-second-brain `/obsidian-agenda`, t_f7b82ba4).
 *
 * Open Second Brain never reaches a calendar API itself - the runtime
 * (Hermes' google-workspace skill, or any MCP host) fetches the events
 * and passes them in. This module is the deterministic analysis layer:
 * given a list of events it computes overlap conflicts, free focus
 * blocks (the same gaps a scheduler would slot a task into), and flags
 * events organised by someone outside the operator's own domain. Pure
 * function of its input - no vault writes, no clock, no model.
 */

export interface AgendaEventInput {
  readonly id?: string;
  readonly title?: string;
  /** ISO-8601 start timestamp. */
  readonly start: string;
  /** ISO-8601 end timestamp. */
  readonly end: string;
  /** Organiser email (used for external-organiser detection). */
  readonly organizer?: string;
}

export interface AgendaOptions {
  /** Minimum free gap (minutes) that counts as a focus block. Default 60. */
  readonly focusMinMinutes?: number;
  /**
   * Operator's own email domain(s), lowercased. An event whose
   * organiser domain is not in this set is flagged external. Empty set
   * disables external-organiser detection.
   */
  readonly ownerDomains?: ReadonlyArray<string>;
  /**
   * Optional working window per calendar day, as `HH:MM` 24h strings.
   * Focus blocks are clipped to this window each day. Omit to derive
   * focus blocks purely from the gaps between events.
   */
  readonly workdayStart?: string;
  readonly workdayEnd?: string;
}

export interface NormalizedEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly organizer: string | null;
}

export interface AgendaConflict {
  readonly a: { id: string; title: string };
  readonly b: { id: string; title: string };
  readonly overlapStart: string;
  readonly overlapEnd: string;
  readonly overlapMinutes: number;
}

export interface FocusBlock {
  readonly start: string;
  readonly end: string;
  readonly minutes: number;
}

export interface ExternalOrganizer {
  readonly id: string;
  readonly title: string;
  readonly organizer: string;
  readonly domain: string;
}

export interface AgendaSnapshot {
  readonly events: ReadonlyArray<NormalizedEvent>;
  readonly conflicts: ReadonlyArray<AgendaConflict>;
  readonly focusBlocks: ReadonlyArray<FocusBlock>;
  readonly externalOrganizers: ReadonlyArray<ExternalOrganizer>;
  readonly counts: {
    readonly events: number;
    readonly conflicts: number;
    readonly focusBlocks: number;
    readonly externalOrganizers: number;
  };
}

export class AgendaError extends Error {}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const MINUTE_MS = 60 * 1000;

function isoMinute(ms: number): string {
  return new Date(ms).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z");
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0
    ? ""
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

function parseTimeOfDay(value: string, label: string): number {
  const match = TIME_RE.exec(value);
  if (!match) throw new AgendaError(`${label} must be HH:MM (24h): ${JSON.stringify(value)}`);
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
}

function normalize(events: ReadonlyArray<AgendaEventInput>): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  events.forEach((event, index) => {
    const startMs = Date.parse(event.start);
    const endMs = Date.parse(event.end);
    if (Number.isNaN(startMs)) {
      throw new AgendaError(
        `event ${index} has an unparseable start: ${JSON.stringify(event.start)}`,
      );
    }
    if (Number.isNaN(endMs)) {
      throw new AgendaError(`event ${index} has an unparseable end: ${JSON.stringify(event.end)}`);
    }
    if (endMs < startMs) {
      throw new AgendaError(`event ${index} ends before it starts`);
    }
    out.push({
      id: event.id?.trim() || `event-${index}`,
      title: event.title?.trim() || "(untitled)",
      start: event.start,
      end: event.end,
      startMs,
      endMs,
      organizer: event.organizer?.trim().toLowerCase() || null,
    });
  });
  return out.toSorted((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function detectConflicts(events: ReadonlyArray<NormalizedEvent>): AgendaConflict[] {
  const conflicts: AgendaConflict[] = [];
  for (let i = 0; i < events.length; i++) {
    const a = events[i]!;
    for (let j = i + 1; j < events.length; j++) {
      const b = events[j]!;
      // Sorted by start: once b starts at/after a ends, no later b overlaps a.
      if (b.startMs >= a.endMs) break;
      const overlapStart = Math.max(a.startMs, b.startMs);
      const overlapEnd = Math.min(a.endMs, b.endMs);
      if (overlapEnd <= overlapStart) continue;
      conflicts.push({
        a: { id: a.id, title: a.title },
        b: { id: b.id, title: b.title },
        overlapStart: isoMinute(overlapStart),
        overlapEnd: isoMinute(overlapEnd),
        overlapMinutes: Math.round((overlapEnd - overlapStart) / MINUTE_MS),
      });
    }
  }
  return conflicts;
}

function utcDayStartMs(ms: number): number {
  return Date.UTC(
    new Date(ms).getUTCFullYear(),
    new Date(ms).getUTCMonth(),
    new Date(ms).getUTCDate(),
  );
}

/**
 * Merge events into busy intervals, then return the complementary free
 * gaps that meet the focus-minute threshold. With a workday window, the
 * search range is clipped to that window on each covered UTC day;
 * otherwise gaps are taken between the first event start and last event
 * end.
 */
function detectFocusBlocks(
  events: ReadonlyArray<NormalizedEvent>,
  focusMinMinutes: number,
  workdayStart: string | undefined,
  workdayEnd: string | undefined,
): FocusBlock[] {
  if (events.length === 0) return [];
  const minMs = focusMinMinutes * MINUTE_MS;

  // Coalesce overlapping/touching busy intervals.
  const busy: Array<[number, number]> = [];
  for (const event of [...events].toSorted((a, b) => a.startMs - b.startMs)) {
    const last = busy.at(-1);
    if (last && event.startMs <= last[1]) {
      last[1] = Math.max(last[1], event.endMs);
    } else {
      busy.push([event.startMs, event.endMs]);
    }
  }

  // Candidate free ranges to search within.
  const ranges: Array<[number, number]> = [];
  if (workdayStart !== undefined && workdayEnd !== undefined) {
    const startMin = parseTimeOfDay(workdayStart, "workdayStart");
    const endMin = parseTimeOfDay(workdayEnd, "workdayEnd");
    if (endMin <= startMin) throw new AgendaError("workdayEnd must be after workdayStart");
    const firstDay = utcDayStartMs(events[0]!.startMs);
    const lastDay = utcDayStartMs(events.at(-1)!.endMs);
    for (let day = firstDay; day <= lastDay; day += 24 * 3600 * 1000) {
      ranges.push([day + startMin * MINUTE_MS, day + endMin * MINUTE_MS]);
    }
  } else {
    ranges.push([events[0]!.startMs, events.at(-1)!.endMs]);
  }

  const blocks: FocusBlock[] = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    let cursor = rangeStart;
    for (const [bStart, bEnd] of busy) {
      if (bEnd <= rangeStart || bStart >= rangeEnd) continue;
      const gapEnd = Math.min(bStart, rangeEnd);
      if (gapEnd - cursor >= minMs) {
        blocks.push({
          start: isoMinute(cursor),
          end: isoMinute(gapEnd),
          minutes: Math.round((gapEnd - cursor) / MINUTE_MS),
        });
      }
      cursor = Math.max(cursor, Math.min(bEnd, rangeEnd));
    }
    if (rangeEnd - cursor >= minMs) {
      blocks.push({
        start: isoMinute(cursor),
        end: isoMinute(rangeEnd),
        minutes: Math.round((rangeEnd - cursor) / MINUTE_MS),
      });
    }
  }
  return blocks.toSorted((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

function detectExternalOrganizers(
  events: ReadonlyArray<NormalizedEvent>,
  ownerDomains: ReadonlyArray<string>,
): ExternalOrganizer[] {
  if (ownerDomains.length === 0) return [];
  const owned = new Set(ownerDomains.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (owned.size === 0) return [];
  const out: ExternalOrganizer[] = [];
  for (const event of events) {
    if (event.organizer === null) continue;
    const domain = domainOf(event.organizer);
    if (domain.length === 0 || owned.has(domain)) continue;
    out.push({ id: event.id, title: event.title, organizer: event.organizer, domain });
  }
  return out;
}

/** Compute a deterministic agenda snapshot from agent-provided events. */
export function synthesizeAgenda(
  events: ReadonlyArray<AgendaEventInput>,
  options: AgendaOptions = {},
): AgendaSnapshot {
  const focusMinMinutes = options.focusMinMinutes ?? 60;
  if (!Number.isFinite(focusMinMinutes) || focusMinMinutes < 1) {
    throw new AgendaError("focusMinMinutes must be a positive number");
  }
  // Enforce the workday-window pair at the exported boundary so a direct
  // caller cannot pass only one bound and silently degrade to unbounded
  // focus-range mode. The MCP/CLI wrappers validate this too, but the
  // core API is public and should fail fast on the half-specified case.
  const hasWorkdayStart = options.workdayStart !== undefined;
  const hasWorkdayEnd = options.workdayEnd !== undefined;
  if (hasWorkdayStart !== hasWorkdayEnd) {
    throw new AgendaError("workdayStart and workdayEnd must be given together");
  }
  const normalized = normalize(events);
  const conflicts = detectConflicts(normalized);
  const focusBlocks = detectFocusBlocks(
    normalized,
    focusMinMinutes,
    options.workdayStart,
    options.workdayEnd,
  );
  const externalOrganizers = detectExternalOrganizers(normalized, options.ownerDomains ?? []);
  return Object.freeze({
    events: Object.freeze(normalized),
    conflicts: Object.freeze(conflicts),
    focusBlocks: Object.freeze(focusBlocks),
    externalOrganizers: Object.freeze(externalOrganizers),
    counts: Object.freeze({
      events: normalized.length,
      conflicts: conflicts.length,
      focusBlocks: focusBlocks.length,
      externalOrganizers: externalOrganizers.length,
    }),
  });
}

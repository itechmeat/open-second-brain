import type { ScanResult, SignalRecord } from "../dream-plan.ts";
import {
  matchEvidenceForSlug,
  type CollectEvidenceOptions,
  type CollectedEvidence,
} from "../evidence.ts";
import { privateEvidenceCounts, readEvidenceDays, type EvidenceDay } from "../evidence-read.ts";
import type { BrainLogEntry } from "../log.ts";
import { isoDate } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { normaliseWikilinkTarget, parseWikilink } from "../wikilink.ts";

export interface WindowSignal extends SignalRecord {
  readonly effectiveTime: string;
}

export type WindowScan = Omit<ScanResult, "signals"> & { readonly signals: WindowSignal[] };

export interface WindowEvidence {
  readonly days: ReadonlyArray<EvidenceDay>;
  readonly events: ReadonlyArray<BrainLogEntry>;
  readonly mergeAliases: ReadonlyMap<string, string>;
  isPrivate(slug: string): boolean;
  lookup(slug: string, options: CollectEvidenceOptions): CollectedEvidence;
}

export interface WindowContext<Evidence> {
  readonly instant: Date;
  readonly wallClock: Date;
  readonly day: string;
  readonly signals: WindowScan;
  readonly final: true;
  readonly evidence: Evidence;
  setEvidence(evidence: Evidence): void;
}

export function createWindowContext<Evidence = WindowEvidence>(
  instant: Date,
  scan: ScanResult,
): WindowContext<Evidence> {
  let evidenceSet = false;
  let evidenceValue: Evidence;
  const signals: WindowScan = {
    ...scan,
    signals: scan.signals.map((record) => ({
      ...record,
      effectiveTime: record.signal.created_at,
    })),
  };
  return {
    instant: new Date(instant),
    wallClock: new Date(),
    day: isoDate(instant),
    signals,
    final: true,
    get evidence() {
      if (!evidenceSet) throw new Error("dream window evidence has not been set");
      return evidenceValue;
    },
    setEvidence(value) {
      if (evidenceSet) throw new Error("dream window evidence has already been set");
      evidenceSet = true;
      evidenceValue = value;
    },
  };
}

export function readWindowEvidence(
  vault: string | null,
  scan: WindowScan,
  checkpoint: () => void = () => {},
): WindowEvidence {
  const days = readEvidenceDays(vault, checkpoint);
  const events = days.flatMap((day) => day.entries);
  const mergeAliases = new Map<string, string>();
  for (const event of events) {
    if (event.eventType !== BRAIN_LOG_EVENT_KIND.merge) continue;
    const keep = parseWikilinkValue(event.body["keep"]);
    const drop = parseWikilinkValue(event.body["drop"]);
    if (keep?.startsWith("pref-") && drop?.startsWith("pref-")) {
      mergeAliases.set(
        drop.slice("pref-".length),
        resolveMergeAlias(keep.slice("pref-".length), mergeAliases),
      );
    }
  }

  const privateCounts = new Map<string, boolean>();
  const isPrivate = (slug: string): boolean => {
    let value = privateCounts.get(slug);
    if (value === undefined) {
      value = privateEvidenceCounts(slug);
      privateCounts.set(slug, value);
    }
    return value;
  };
  for (const preference of scan.preferences) {
    const id = preference.pref.id;
    isPrivate(id.startsWith("pref-") ? id.slice("pref-".length) : id);
  }
  for (const preference of scan.retired) {
    const id = preference.id;
    isPrivate(id.startsWith("ret-") ? id.slice("ret-".length) : id);
  }
  for (const event of events) {
    if (event.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
    if (event.fromPrivatePartition !== true) continue;
    const target = parseWikilinkValue(event.body["preference"]);
    if (target?.startsWith("pref-")) {
      isPrivate(resolveMergeAlias(target.slice("pref-".length), mergeAliases));
    }
  }

  const eventsBySlug = new Map<string, BrainLogEntry[]>();
  for (const event of events) {
    if (event.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
    const preference = event.body["preference"];
    if (typeof preference !== "string") continue;
    const target = normaliseWikilinkTarget(preference) ?? preference.trim();
    const slug = target.startsWith("pref-")
      ? target.slice("pref-".length)
      : target.startsWith("ret-")
        ? target.slice("ret-".length)
        : null;
    if (slug === null) continue;
    const indexed = eventsBySlug.get(slug) ?? [];
    indexed.push(event);
    eventsBySlug.set(slug, indexed);
  }
  for (const indexed of eventsBySlug.values()) {
    indexed.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  return {
    days,
    events,
    mergeAliases,
    isPrivate,
    lookup: (slug, options) =>
      matchEvidenceForSlug(eventsBySlug.get(slug) ?? [], slug, options, isPrivate),
  };
}

function parseWikilinkValue(value: unknown): string | null {
  return typeof value === "string" ? parseWikilink(value) : null;
}

function resolveMergeAlias(slug: string, aliases: ReadonlyMap<string, string>): string {
  let current = slug;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliases.get(current);
    if (!next) return current;
    current = next;
  }
  return current;
}

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { proceduralRecurrencePath } from "./paths.ts";

export type RecurrenceCommitment = "exploring" | "leaning" | "decided" | "locked";
export type RecurrenceAction = "learn" | "forget";

export interface RecurrenceThresholds {
  readonly leaning: number;
  readonly decided: number;
  readonly locked: number;
}

export interface RecurrenceEventInput {
  readonly contentHash: string;
  readonly scope: string;
  readonly sourceId: string;
  readonly action: RecurrenceAction;
  readonly at?: string;
}

export interface RecurrenceEntry {
  readonly contentHash: string;
  readonly supportCount: number;
  readonly recurrenceCount: number;
  readonly scopes: ReadonlyArray<{ scope: string; support: number }>;
  readonly commitment: RecurrenceCommitment;
  readonly sources: ReadonlyArray<{ sourceId: string; support: number }>;
}

interface RecurrenceEvent {
  readonly kind: "support" | "purge-source";
  readonly contentHash?: string;
  readonly scope?: string;
  readonly sourceId: string;
  readonly action?: RecurrenceAction;
  readonly at: string;
}

const DEFAULT_THRESHOLDS: RecurrenceThresholds = {
  leaning: 3,
  decided: 5,
  locked: 8,
};

export function applyRecurrenceEvidence(
  vault: string,
  input: RecurrenceEventInput,
): RecurrenceEntry | null {
  appendEvent(vault, {
    kind: "support",
    contentHash: input.contentHash,
    scope: input.scope,
    sourceId: input.sourceId,
    action: input.action,
    at: input.at ?? new Date().toISOString(),
  });
  return getRecurrenceEntry(vault, input.contentHash);
}

export function purgeRecurrenceSource(vault: string, sourceId: string, at?: string): void {
  appendEvent(vault, {
    kind: "purge-source",
    sourceId,
    at: at ?? new Date().toISOString(),
  });
}

export function getRecurrenceEntry(
  vault: string,
  contentHash: string,
  thresholds: RecurrenceThresholds = DEFAULT_THRESHOLDS,
): RecurrenceEntry | null {
  return (
    listRecurrenceEntries(vault, thresholds).find((entry) => entry.contentHash === contentHash) ??
    null
  );
}

export function listRecurrenceEntries(
  vault: string,
  thresholds: RecurrenceThresholds = DEFAULT_THRESHOLDS,
): ReadonlyArray<RecurrenceEntry> {
  const events = readEvents(vault);
  const state = new Map<string, { supportBySourceScope: Map<string, number> }>();

  for (const event of events) {
    if (event.kind === "purge-source") {
      for (const value of state.values()) {
        for (const key of value.supportBySourceScope.keys()) {
          if (key.endsWith(`\u0000${event.sourceId}`)) {
            value.supportBySourceScope.delete(key);
          }
        }
      }
      continue;
    }

    if (!event.contentHash || !event.scope || !event.action) continue;
    const bucket = state.get(event.contentHash) ?? {
      supportBySourceScope: new Map<string, number>(),
    };
    const sourceScopeKey = `${event.scope}\u0000${event.sourceId}`;
    const current = bucket.supportBySourceScope.get(sourceScopeKey) ?? 0;

    if (event.action === "learn") {
      bucket.supportBySourceScope.set(sourceScopeKey, current + 1);
    } else {
      if (current > 1) bucket.supportBySourceScope.set(sourceScopeKey, current - 1);
      else bucket.supportBySourceScope.delete(sourceScopeKey);
    }

    state.set(event.contentHash, bucket);
  }

  const out: RecurrenceEntry[] = [];
  for (const [contentHash, bucket] of state) {
    const supportByScope = new Map<string, number>();
    const supportBySource = new Map<string, number>();
    for (const [sourceScopeKey, support] of bucket.supportBySourceScope) {
      if (support < 1) continue;
      const [scope, sourceId] = splitSourceScopeKey(sourceScopeKey);
      if (!scope || !sourceId) continue;
      supportByScope.set(scope, (supportByScope.get(scope) ?? 0) + support);
      supportBySource.set(sourceId, (supportBySource.get(sourceId) ?? 0) + support);
    }

    const scopes = [...supportByScope.entries()]
      .filter((item) => item[1] > 0)
      .map(([scope, support]) => ({ scope, support }))
      .toSorted((left, right) => left.scope.localeCompare(right.scope));
    const sources = [...supportBySource.entries()]
      .filter((item) => item[1] > 0)
      .map(([sourceId, support]) => ({ sourceId, support }))
      .toSorted((left, right) => left.sourceId.localeCompare(right.sourceId));
    const supportCount = scopes.reduce((sum, item) => sum + item.support, 0);
    if (supportCount < 1) continue;

    out.push({
      contentHash,
      supportCount,
      recurrenceCount: scopes.length,
      scopes: Object.freeze(scopes),
      commitment: commitmentForSupport(supportCount, thresholds),
      sources: Object.freeze(sources),
    });
  }

  return Object.freeze(
    out.toSorted((left, right) => left.contentHash.localeCompare(right.contentHash)),
  );
}

function splitSourceScopeKey(value: string): [string, string] {
  const idx = value.indexOf("\u0000");
  if (idx < 0) return ["", ""];
  return [value.slice(0, idx), value.slice(idx + 1)];
}

function commitmentForSupport(
  supportCount: number,
  thresholds: RecurrenceThresholds,
): RecurrenceCommitment {
  if (supportCount >= thresholds.locked) return "locked";
  if (supportCount >= thresholds.decided) return "decided";
  if (supportCount >= thresholds.leaning) return "leaning";
  return "exploring";
}

function appendEvent(vault: string, event: RecurrenceEvent): void {
  const path = proceduralRecurrencePath(vault);
  mkdirSync(ensureInsideVault(dirname(path), vault), { recursive: true });
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${JSON.stringify(event)}\n`;
  atomicWriteFileSync(path, `${prev}${line}`);
}

function readEvents(vault: string): RecurrenceEvent[] {
  const path = proceduralRecurrencePath(vault);
  if (!existsSync(path)) return [];
  const out: RecurrenceEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RecurrenceEvent);
    } catch {
      continue;
    }
  }
  return out;
}

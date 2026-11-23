import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { deviceLocalStateRoot, vaultKey } from "../state/machine-state.ts";
import { acquireProcessLock } from "../store/process-lock.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { neutralizeSingleLine } from "./untrusted-source.ts";
import { logDayReader } from "./log-days.ts";
import { workrunPath, WORKRUN_PHASE } from "./dream-workrun.ts";
import type { BrainLogEntry } from "./log.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

const DELIVERED_LIMIT = 20;
const BRIEF_LIMIT = 600;
const DREAM_EVENT_TYPES = new Set<string>([BRAIN_LOG_EVENT_KIND.dream]);
type ChangeKind = "new_unconfirmed" | "confirmed" | "retired";

export interface DreamDigestBrief {
  readonly key: string;
  readonly text: string;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function renderDigestBrief(entry: BrainLogEntry): DreamDigestBrief | null {
  const key = entry.body["run_id"];
  if (
    entry.eventType !== BRAIN_LOG_EVENT_KIND.dream ||
    typeof key !== "string" ||
    key.length === 0
  ) {
    return null;
  }
  const groups: ReadonlyArray<readonly [ChangeKind, string]> = [
    ["new_unconfirmed", "New"],
    ["confirmed", "confirmed"],
    ["retired", "retired"],
  ];
  const changes = groups.flatMap(([field]) =>
    strings(entry.body[field]).map((value) => [field, value] as const),
  );
  if (changes.length === 0) return null;
  const counts = groups
    .map(([field, label]) => `${label} ${strings(entry.body[field]).length}`)
    .join(", ");
  const command = "full: o2b brain digest";
  const prefix = `Dream digest: ${counts}\n`;
  const lines: string[] = [];
  for (const [, raw] of changes.slice(0, 5)) {
    const room = BRIEF_LIMIT - prefix.length - command.length - lines.join("\n").length - 3;
    if (room < 8) break;
    const value = neutralizeSingleLine(raw).slice(0, room - 2);
    if (value.length > 0) lines.push(`- ${value}`);
  }
  const text = `${prefix}${lines.length > 0 ? `${lines.join("\n")}\n` : ""}${command}`;
  return { key, text: text.slice(0, BRIEF_LIMIT) };
}

function ledgerPath(vault: string, configPath?: string): string {
  return join(deviceLocalStateRoot(configPath), "dream-trigger", `${vaultKey(vault)}.digest.json`);
}

function readKeys(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as { keys?: unknown }).keys)
    ) {
      return [];
    }
    return (value as { keys: unknown[] }).keys
      .filter((key): key is string => typeof key === "string")
      .slice(-DELIVERED_LIMIT);
  } catch {
    return [];
  }
}

function latestChangedDigest(vault: string, configPath?: string): DreamDigestBrief | null {
  const reader = logDayReader(vault, {
    eventTypes: DREAM_EVENT_TYPES,
    ...(configPath !== undefined ? { configPath } : {}),
  });
  for (const date of [...reader.dates].toReversed()) {
    const entries = reader.day(date).entries;
    for (const entry of [...entries].toReversed()) {
      const brief = renderDigestBrief(entry);
      if (brief !== null && finalizedWorkrun(vault, brief.key)) return brief;
    }
  }
  return null;
}

function finalizedWorkrun(vault: string, runId: string): boolean {
  try {
    const lines = readFileSync(workrunPath(vault, runId), "utf8").split("\n").filter(Boolean);
    const last: unknown = JSON.parse(lines.at(-1) ?? "null");
    return (
      typeof last === "object" &&
      last !== null &&
      (last as { phase?: unknown }).phase === WORKRUN_PHASE.finalized
    );
  } catch {
    return false;
  }
}

export function pendingDreamDigest(vault: string, configPath?: string): DreamDigestBrief | null {
  try {
    const brief = latestChangedDigest(vault, configPath);
    if (brief === null || readKeys(ledgerPath(vault, configPath)).includes(brief.key)) return null;
    return brief;
  } catch {
    return null;
  }
}

export function recordDreamDigestDelivered(
  vault: string,
  key: string,
  configPath?: string,
): boolean {
  const path = ledgerPath(vault, configPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const release = acquireProcessLock(`${path}.lock`, {
      label: "dream digest delivery lock",
      remedy: "retry the session start or digest read",
    });
    try {
      const keys = readKeys(path);
      if (keys.includes(key)) return true;
      atomicWriteFileSync(
        path,
        JSON.stringify({ keys: [...keys, key].slice(-DELIVERED_LIMIT) }) + "\n",
      );
      return true;
    } finally {
      release();
    }
  } catch {
    return false;
  }
}

/**
 * Trigger store with anti-nag lifecycle (Workspace Insight Suite,
 * t_cd1fee79).
 *
 * Each trigger is one Markdown file under `Brain/triggers/` - operator
 * readable without tooling, frontmatter carries the machine state.
 * History is a status change, not a file move: terminal triggers
 * (acted / dismissed / expired) stay in place so `history` is just a
 * status filter and the cooldown logic can see them.
 *
 * Anti-nag invariants live here and only here:
 *   - cooldown-key dedup across ALL statuses makes repeated scans
 *     idempotent (an open twin always blocks; a terminal twin blocks
 *     for `cooldownDays` after its resolution; an expired twin allows);
 *   - lifecycle transitions: acknowledge / act / dismiss are allowed
 *     from ANY open state (an operator may act on a trigger they found
 *     via `list` before the brief ever delivered it - delivery is a
 *     surfacing step, not a gate), terminal states reject everything;
 *   - brief delivery happens at most once per cooldown window
 *     ({@link briefTriggers} + {@link markTriggersDelivered}).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatterText } from "../../vault.ts";
import {
  isTriggerKind,
  isTriggerStatus,
  isTriggerUrgency,
  TRIGGER_URGENCIES,
  type InsightCandidate,
  type TriggerRecord,
  type TriggerStatus,
} from "./types.ts";

export const TRIGGER_TTL_DAYS = 14;
export const TRIGGER_COOLDOWN_DAYS = 7;
export const TRIGGER_MAX_PER_KIND = 10;

const DAY_MS = 24 * 3600 * 1000;
const OPEN_STATUSES: ReadonlySet<TriggerStatus> = new Set(["pending", "delivered", "acknowledged"]);

export function triggersDir(vault: string): string {
  return join(vault, "Brain", "triggers");
}

// ── Rendering and parsing ───────────────────────────────────────────────────

interface StoredTrigger extends Omit<TriggerRecord, "effectiveStatus"> {}

function renderTrigger(record: StoredTrigger): string {
  const lines = [
    "---",
    `trigger_id: ${record.id}`,
    `trigger_type: ${record.kind}`,
    `status: ${record.status}`,
    `urgency: ${record.urgency}`,
    // Free-text and list values are JSON-quoted so YAML-significant
    // characters can never corrupt the file (intentions/handoff pattern).
    `cooldown_key: ${JSON.stringify(record.cooldownKey)}`,
    `created_at: ${record.createdAt}`,
    `expires_at: ${record.expiresAt}`,
    ...(record.deliveredAt !== null ? [`delivered_at: ${record.deliveredAt}`] : []),
    ...(record.resolvedAt !== null ? [`resolved_at: ${record.resolvedAt}`] : []),
    `source_artifacts: ${JSON.stringify(record.sourceArtifacts)}`,
    "---",
    "",
    "## Reason",
    "",
    record.reason,
    "",
    "## Suggested action",
    "",
    record.suggestedAction,
    "",
  ];
  if (record.contextSnippets.length > 0) {
    lines.push("## Context", "");
    for (const snippet of record.contextSnippets) lines.push(`- ${snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}

function sectionText(body: string, heading: string): string {
  const re = new RegExp(`^## ${heading}$`, "mu");
  const match = re.exec(body);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = /^## /mu.exec(body.slice(start + 1));
  const end = next ? start + 1 + next.index : body.length;
  return body.slice(start, end).trim();
}

function parseJsonArray(raw: unknown): ReadonlyArray<string> {
  // Defensive: a frontmatter parser that materializes the value as a
  // real array round-trips too.
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return Object.freeze([...raw]);
  }
  if (typeof raw !== "string" || raw.trim() === "") return Object.freeze([]);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return Object.freeze(parsed);
    }
  } catch {
    // fall through - a hand-edited list degrades to empty, never throws
  }
  return Object.freeze([]);
}

function effectiveStatus(status: TriggerStatus, expiresAt: string, now: Date): TriggerStatus {
  if (!OPEN_STATUSES.has(status)) return status;
  const expiry = Date.parse(expiresAt);
  if (Number.isFinite(expiry) && now.getTime() > expiry) return "expired";
  return status;
}

function parseTrigger(vault: string, fileName: string, now: Date): TriggerRecord | null {
  const path = join(triggersDir(vault), fileName);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const [meta, body] = parseFrontmatterText(raw);
  const id = meta["trigger_id"];
  const kind = meta["trigger_type"];
  const status = meta["status"];
  const urgency = meta["urgency"];
  if (typeof id !== "string" || id === "") return null;
  if (typeof kind !== "string" || !isTriggerKind(kind)) return null;
  if (typeof status !== "string" || !isTriggerStatus(status)) return null;
  if (typeof urgency !== "string" || !isTriggerUrgency(urgency)) return null;
  const createdAt = typeof meta["created_at"] === "string" ? meta["created_at"] : "";
  const expiresAt = typeof meta["expires_at"] === "string" ? meta["expires_at"] : "";
  return Object.freeze({
    id,
    kind,
    status,
    effectiveStatus: effectiveStatus(status, expiresAt, now),
    urgency,
    reason: sectionText(body, "Reason"),
    suggestedAction: sectionText(body, "Suggested action"),
    sourceArtifacts: parseJsonArray(meta["source_artifacts"]),
    contextSnippets: Object.freeze(
      sectionText(body, "Context")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2)),
    ),
    cooldownKey: typeof meta["cooldown_key"] === "string" ? meta["cooldown_key"] : "",
    createdAt,
    expiresAt,
    deliveredAt: typeof meta["delivered_at"] === "string" ? meta["delivered_at"] : null,
    resolvedAt: typeof meta["resolved_at"] === "string" ? meta["resolved_at"] : null,
    path,
  });
}

function writeRecord(record: TriggerRecord): void {
  const { effectiveStatus: _ignored, ...stored } = record;
  atomicWriteFileSync(record.path, renderTrigger(stored));
}

// ── Listing ─────────────────────────────────────────────────────────────────

export interface ListTriggersOptions {
  readonly now: Date;
  /** Filter on EFFECTIVE status (expiry applied). */
  readonly status?: TriggerStatus;
}

/** Every trigger, newest first (created_at desc, then id). */
export function listTriggers(
  vault: string,
  opts: ListTriggersOptions,
): ReadonlyArray<TriggerRecord> {
  const dir = triggersDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const records: TriggerRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const record = parseTrigger(vault, name, opts.now);
    if (record === null) continue;
    if (opts.status !== undefined && record.effectiveStatus !== opts.status) continue;
    records.push(record);
  }
  records.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return Object.freeze(records);
}

// ── Creation with cooldown dedup ────────────────────────────────────────────

export interface CreateTriggersOptions {
  readonly now: Date;
  /** Days a terminal (dismissed/acted) twin blocks recreation. */
  readonly cooldownDays?: number;
  /** Days until a fresh trigger expires. */
  readonly ttlDays?: number;
  /** Per-kind cap for one scan. */
  readonly maxPerKind?: number;
}

export interface SkippedCandidate {
  readonly cooldownKey: string;
  readonly reason: "active" | "cooldown" | "kind-cap" | "invalid";
}

export interface CreateTriggersResult {
  readonly created: ReadonlyArray<TriggerRecord>;
  readonly skipped: ReadonlyArray<SkippedCandidate>;
}

function blockReason(
  twin: TriggerRecord,
  now: Date,
  cooldownDays: number,
): "active" | "cooldown" | null {
  if (OPEN_STATUSES.has(twin.effectiveStatus)) return "active";
  if (twin.effectiveStatus === "expired") return null;
  // dismissed / acted: silent for the cooldown window after resolution.
  const resolved = twin.resolvedAt !== null ? Date.parse(twin.resolvedAt) : Number.NaN;
  if (!Number.isFinite(resolved)) return null;
  return now.getTime() < resolved + cooldownDays * DAY_MS ? "cooldown" : null;
}

/** Persist candidates as triggers, skipping cooldown-blocked twins. */
export function createTriggers(
  vault: string,
  candidates: ReadonlyArray<InsightCandidate>,
  opts: CreateTriggersOptions,
): CreateTriggersResult {
  // Serialize the check-then-write against concurrent scans (CLI and
  // MCP can both reach this): without the lock two callers could each
  // observe "no twin" and persist duplicates for one cooldown key.
  const dir = triggersDir(vault);
  mkdirSync(dir, { recursive: true });
  const release = lockfile.lockSync(dir, { stale: 10_000, realpath: false });
  try {
    return createTriggersLocked(vault, candidates, opts);
  } finally {
    release();
  }
}

function createTriggersLocked(
  vault: string,
  candidates: ReadonlyArray<InsightCandidate>,
  opts: CreateTriggersOptions,
): CreateTriggersResult {
  const cooldownDays = opts.cooldownDays ?? TRIGGER_COOLDOWN_DAYS;
  const ttlDays = opts.ttlDays ?? TRIGGER_TTL_DAYS;
  const maxPerKind = opts.maxPerKind ?? TRIGGER_MAX_PER_KIND;
  const existing = listTriggers(vault, { now: opts.now });
  const byKey = new Map<string, TriggerRecord>();
  for (const record of existing) {
    // Newest record per key wins (list is newest-first, keep the first).
    if (!byKey.has(record.cooldownKey)) byKey.set(record.cooldownKey, record);
  }

  const created: TriggerRecord[] = [];
  const skipped: SkippedCandidate[] = [];
  const perKind = new Map<string, number>();
  const dir = triggersDir(vault);
  const createdAt = opts.now.toISOString();
  const expiresAt = new Date(opts.now.getTime() + ttlDays * DAY_MS).toISOString();
  const usedKeys = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.cooldownKey.trim() === "" || candidate.reason.trim() === "") {
      skipped.push({ cooldownKey: candidate.cooldownKey, reason: "invalid" });
      continue;
    }
    if (usedKeys.has(candidate.cooldownKey)) {
      skipped.push({ cooldownKey: candidate.cooldownKey, reason: "active" });
      continue;
    }
    const twin = byKey.get(candidate.cooldownKey);
    if (twin !== undefined) {
      const reason = blockReason(twin, opts.now, cooldownDays);
      if (reason !== null) {
        skipped.push({ cooldownKey: candidate.cooldownKey, reason });
        continue;
      }
    }
    const count = perKind.get(candidate.kind) ?? 0;
    if (count >= maxPerKind) {
      skipped.push({ cooldownKey: candidate.cooldownKey, reason: "kind-cap" });
      continue;
    }
    perKind.set(candidate.kind, count + 1);
    usedKeys.add(candidate.cooldownKey);

    const hash = createHash("sha256").update(candidate.cooldownKey).digest("hex").slice(0, 10);
    let id = `tr-${hash}-${createdAt.slice(0, 10)}`;
    let suffix = 2;
    while (existsSync(join(dir, `${id}.md`))) {
      id = `tr-${hash}-${createdAt.slice(0, 10)}-${suffix}`;
      suffix += 1;
    }
    const record: TriggerRecord = Object.freeze({
      ...candidate,
      id,
      status: "pending" as const,
      effectiveStatus: "pending" as const,
      createdAt,
      expiresAt,
      deliveredAt: null,
      resolvedAt: null,
      path: join(dir, `${id}.md`),
    });
    writeRecord(record);
    created.push(record);
  }

  return Object.freeze({ created: Object.freeze(created), skipped: Object.freeze(skipped) });
}

// ── Transitions ─────────────────────────────────────────────────────────────

export type TriggerAction = "acknowledge" | "dismiss" | "act";

export interface TransitionOptions {
  readonly now: Date;
}

const ACTION_TO_STATUS: Record<TriggerAction, TriggerStatus> = {
  acknowledge: "acknowledged",
  dismiss: "dismissed",
  act: "acted",
};

/** Apply one lifecycle transition. Throws on unknown id or terminal state. */
export function transitionTrigger(
  vault: string,
  id: string,
  action: TriggerAction,
  opts: TransitionOptions,
): TriggerRecord {
  const record = listTriggers(vault, { now: opts.now }).find((r) => r.id === id);
  if (record === undefined) throw new Error(`unknown trigger: ${id}`);
  if (!OPEN_STATUSES.has(record.effectiveStatus)) {
    throw new Error(`trigger ${id} is terminal (${record.effectiveStatus})`);
  }
  if (action === "acknowledge" && record.effectiveStatus === "acknowledged") {
    return record; // idempotent
  }
  const nowIso = opts.now.toISOString();
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: ACTION_TO_STATUS[action],
    effectiveStatus: ACTION_TO_STATUS[action],
    resolvedAt: action === "acknowledge" ? record.resolvedAt : nowIso,
  });
  writeRecord(next);
  return next;
}

/** Stamp delivered_at + status=delivered on the given pending triggers. */
export function markTriggersDelivered(
  vault: string,
  ids: ReadonlyArray<string>,
  opts: TransitionOptions,
): void {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  const nowIso = opts.now.toISOString();
  for (const record of listTriggers(vault, { now: opts.now })) {
    if (!wanted.has(record.id)) continue;
    if (record.effectiveStatus !== "pending" && record.effectiveStatus !== "delivered") continue;
    writeRecord(
      Object.freeze({
        ...record,
        status: "delivered" as const,
        effectiveStatus: "delivered" as const,
        deliveredAt: nowIso,
      }),
    );
  }
}

// ── Brief integration ───────────────────────────────────────────────────────

export interface BriefTriggersOptions {
  readonly now: Date;
  readonly cap: number;
  readonly cooldownDays: number;
}

const URGENCY_RANK: Record<string, number> = Object.fromEntries(
  TRIGGER_URGENCIES.map((u, i) => [u, i]),
);

/**
 * Triggers the morning brief may surface NOW: pending ones, plus
 * delivered-but-still-open ones whose last delivery is older than the
 * cooldown window. Ranked urgency desc, then newest first, capped.
 */
export function briefTriggers(
  vault: string,
  opts: BriefTriggersOptions,
): ReadonlyArray<TriggerRecord> {
  const eligible = listTriggers(vault, { now: opts.now }).filter((record) => {
    if (record.effectiveStatus === "pending") return true;
    if (record.effectiveStatus !== "delivered") return false;
    const delivered = record.deliveredAt !== null ? Date.parse(record.deliveredAt) : Number.NaN;
    if (!Number.isFinite(delivered)) return true;
    return opts.now.getTime() >= delivered + opts.cooldownDays * DAY_MS;
  });
  const ranked = eligible.toSorted((a, b) => {
    const ur = (URGENCY_RANK[b.urgency] ?? 0) - (URGENCY_RANK[a.urgency] ?? 0);
    if (ur !== 0) return ur;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return Object.freeze(ranked.slice(0, Math.max(0, opts.cap)));
}

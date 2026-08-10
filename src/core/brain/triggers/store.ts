/**
 * Trigger store with anti-nag lifecycle (Workspace Insight Suite,
 * t_cd1fee79).
 *
 * Each trigger is one Markdown file under `Brain/triggers/` - operator
 * readable without tooling, frontmatter carries the machine state.
 * History is a status change, not a file move: terminal triggers
 * (acted / dismissed / expired / suppressed) stay in place so `history`
 * is just a status filter and the cooldown logic can see them.
 *
 * Anti-nag invariants live here and only here:
 *   - cooldown-key dedup across ALL statuses makes repeated scans
 *     idempotent (a suppressed twin always blocks; an open twin always
 *     blocks; a dismissed or acted twin blocks for `cooldownDays` after
 *     its resolution; an expired twin allows);
 *   - lifecycle transitions: acknowledge / act / dismiss are allowed
 *     from ANY open state (an operator may act on a trigger they found
 *     via `list` before the brief ever delivered it - delivery is a
 *     surfacing step, not a gate), terminal states reject everything;
 *   - suppression is the one edge OUT of a terminal state: it is legal
 *     from any status, it carries no clock, and {@link transitionTrigger}
 *     restores the interrupted status verbatim on `unsuppress` because
 *     suppressing leaves the delivery and resolution instants untouched;
 *   - the recurrence ledger records every candidate the anti-nag logic
 *     silenced, so a suppressed finding that keeps firing is auditable
 *     rather than invisible ({@link recordRecurrence});
 *   - brief delivery happens at most once per cooldown window
 *     ({@link briefTriggers} + {@link markTriggersDelivered}).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatterText } from "../../vault.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  isTriggerKind,
  isTriggerStatus,
  isTriggerUrgency,
  TRIGGER_OPEN_STATUSES,
  TRIGGER_STATUS,
  TRIGGER_TERMINAL_STATUSES,
  TRIGGER_URGENCIES,
  type InsightCandidate,
  type TriggerRecord,
  type TriggerStatus,
} from "./types.ts";

export const TRIGGER_TTL_DAYS = 14;
export const TRIGGER_COOLDOWN_DAYS = 7;
export const TRIGGER_MAX_PER_KIND = 10;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Occurrences credited to a record that predates the recurrence ledger.
 * It is the count of occurrences anyone actually recorded for such a
 * record - the creation - and not a placeholder for an unknown number.
 */
const OCCURRENCES_WHEN_UNRECORDED = 1;

/** Frontmatter key holding the JSON-encoded grounding artifact list. */
const SOURCE_ARTIFACTS_KEY = "source_artifacts";

/** Longest run of an unreadable field value reproduced in an error. */
const FIELD_EXCERPT_MAX = 120;

/** Frontmatter key holding the recurrence count. */
const OCCURRENCES_KEY = "occurrences";

/** Frontmatter key holding the instant the finding was last seen. */
const LAST_SEEN_AT_KEY = "last_seen_at";

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
    ...(record.suppressedAt !== null ? [`suppressed_at: ${record.suppressedAt}`] : []),
    ...(record.suppressedFrom !== null ? [`suppressed_from: ${record.suppressedFrom}`] : []),
    `${OCCURRENCES_KEY}: ${record.occurrences}`,
    `${LAST_SEEN_AT_KEY}: ${record.lastSeenAt}`,
    `${SOURCE_ARTIFACTS_KEY}: ${JSON.stringify(record.sourceArtifacts)}`,
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

/**
 * A `source_artifacts` value that is present and cannot be read as a
 * list of strings.
 *
 * It is a refusal rather than an empty list on purpose. The grounding
 * artifacts are the evidence a finding rests on, so a trigger reporting
 * none is a materially different claim from a trigger whose evidence
 * could not be read - and the earlier behaviour, which degraded a
 * hand-edited list to `[]`, made an unparseable finding present as an
 * ungrounded one with nothing anywhere saying so.
 */
/**
 * A frontmatter field is present and cannot be read.
 *
 * Absent and unreadable are different claims and this type is what keeps
 * them apart. An absent field means nobody ever recorded the thing, which
 * several fields here have an honest reading for; a present field that
 * does not parse means a record says something and the store cannot tell
 * what. Substituting the absent-field reading for the second case would
 * state a value nothing supports - which is the failure this whole wave
 * exists to remove - so it refuses, naming the file, the key, and the
 * operator's own bytes so the broken line can be found.
 */
export class TriggerFieldError extends Error {
  /** The trigger file carrying the unreadable value. */
  readonly path: string;
  /** The frontmatter key that could not be read. */
  readonly key: string;

  constructor(path: string, key: string, raw: unknown, expectation: string) {
    super(`trigger ${path}: ${key} is present but ${expectation}: ${excerptFieldValue(raw)}`);
    this.name = "TriggerFieldError";
    this.path = path;
    this.key = key;
  }
}

export class TriggerSourceArtifactsError extends TriggerFieldError {
  constructor(path: string, raw: unknown) {
    super(path, SOURCE_ARTIFACTS_KEY, raw, "is not a list of strings");
    this.name = "TriggerSourceArtifactsError";
  }
}

/**
 * Operator bytes bounded to one line, so an error message stays one
 * line whatever the file contains. The value is reproduced verbatim and
 * never inspected - it is opaque content, quoted back so the operator
 * can find the line they broke.
 */
function excerptFieldValue(raw: unknown): string {
  const text = typeof raw === "string" ? raw : String(raw);
  return text.length <= FIELD_EXCERPT_MAX ? text : `${text.slice(0, FIELD_EXCERPT_MAX)}…`;
}

/**
 * Read the grounding artifact list. An absent key names no artifacts and
 * yields an empty list; a present but unreadable one throws - see
 * {@link TriggerSourceArtifactsError}.
 */
function parseArtifactList(raw: unknown, path: string): ReadonlyArray<string> {
  if (raw === undefined) return Object.freeze([]);
  // Defensive: a frontmatter parser that materializes the value as a
  // real array round-trips too.
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return Object.freeze([...raw]);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return Object.freeze(parsed);
      }
    } catch {
      // fall through to the refusal below
    }
  }
  throw new TriggerSourceArtifactsError(path, raw);
}

/**
 * The recorded occurrence count.
 *
 * An ABSENT key yields {@link OCCURRENCES_WHEN_UNRECORDED}: the record
 * predates the ledger, and one - its creation - is the count of
 * occurrences anybody actually recorded for it. A PRESENT key that does
 * not read as a positive integer refuses, because crediting a corrupt
 * counter that same one would understate a finding that has fired forty
 * times and would make a hand-edit indistinguishable from a record
 * written before the ledger existed.
 *
 * The numeric arm is not defensive dressing: the count is written as a
 * bare integer, so a frontmatter parser that materializes it as a number
 * must not fall through and quietly discard a real count.
 */
function parseOccurrences(raw: unknown, path: string): number {
  if (raw === undefined) return OCCURRENCES_WHEN_UNRECORDED;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < OCCURRENCES_WHEN_UNRECORDED) {
    throw new TriggerFieldError(path, OCCURRENCES_KEY, raw, "not a positive integer");
  }
  return parsed;
}

/**
 * The instant the finding was last seen.
 *
 * An ABSENT key yields the creation instant: a record predating the
 * ledger last fired when it was created, and that is a true statement
 * about it. A PRESENT key that is not a readable instant refuses, for
 * the same reason the occurrence count does.
 */
function parseLastSeenAt(raw: unknown, createdAt: string, path: string): string {
  if (raw === undefined) return createdAt;
  const text = typeof raw === "string" ? raw : String(raw);
  if (text.length === 0 || Number.isNaN(Date.parse(text))) {
    throw new TriggerFieldError(path, LAST_SEEN_AT_KEY, raw, "not a readable instant");
  }
  return text;
}

function effectiveStatus(status: TriggerStatus, expiresAt: string, now: Date): TriggerStatus {
  // Expiry applies to open statuses only, which is precisely what makes
  // `suppressed` indefinite: it is terminal, so no clock reaches it.
  if (!TRIGGER_OPEN_STATUSES.has(status)) return status;
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
  const suppressedFrom = meta["suppressed_from"];
  return Object.freeze({
    id,
    kind,
    status,
    effectiveStatus: effectiveStatus(status, expiresAt, now),
    urgency,
    reason: sectionText(body, "Reason"),
    suggestedAction: sectionText(body, "Suggested action"),
    sourceArtifacts: parseArtifactList(meta[SOURCE_ARTIFACTS_KEY], path),
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
    suppressedAt: typeof meta["suppressed_at"] === "string" ? meta["suppressed_at"] : null,
    suppressedFrom: isTriggerStatus(suppressedFrom) ? suppressedFrom : null,
    occurrences: parseOccurrences(meta[OCCURRENCES_KEY], path),
    lastSeenAt: parseLastSeenAt(meta[LAST_SEEN_AT_KEY], createdAt, path),
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
  readonly reason: "active" | "cooldown" | "kind-cap" | "invalid" | "suppressed";
}

export interface CreateTriggersResult {
  readonly created: ReadonlyArray<TriggerRecord>;
  readonly skipped: ReadonlyArray<SkippedCandidate>;
}

function blockReason(
  twin: TriggerRecord,
  now: Date,
  cooldownDays: number,
): SkippedCandidate["reason"] | null {
  // Suppression comes first and carries no clock: the operator judged
  // this cooldown key structurally benign, so no arithmetic below can
  // ever let it back through.
  if (twin.effectiveStatus === TRIGGER_STATUS.suppressed) return "suppressed";
  if (TRIGGER_OPEN_STATUSES.has(twin.effectiveStatus)) return "active";
  if (twin.effectiveStatus === TRIGGER_STATUS.expired) return null;
  // dismissed / acted: silent for the cooldown window after resolution.
  const resolved = twin.resolvedAt !== null ? Date.parse(twin.resolvedAt) : Number.NaN;
  if (!Number.isFinite(resolved)) return null;
  return now.getTime() < resolved + cooldownDays * DAY_MS ? "cooldown" : null;
}

/**
 * Record that a finding fired again while the queue stayed silent.
 *
 * Written for EVERY blocked twin, not only suppressed ones: one code
 * path with no special case, and it is exactly the event worth keeping
 * - without it a suppressed finding that recurs daily is
 * indistinguishable from one that never fired again.
 *
 * Callers must hold the trigger-directory lock; {@link createTriggers}
 * already does, which is what makes the counter race-free.
 */
export function recordRecurrence(record: TriggerRecord, now: Date): TriggerRecord {
  const next: TriggerRecord = Object.freeze({
    ...record,
    occurrences: record.occurrences + 1,
    lastSeenAt: now.toISOString(),
  });
  writeRecord(next);
  return next;
}

/** Persist candidates as triggers, skipping cooldown-blocked twins. */
export function createTriggers(
  vault: string,
  candidates: ReadonlyArray<InsightCandidate>,
  opts: CreateTriggersOptions,
): CreateTriggersResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
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
        // The twin stays in the map in its updated form so a second
        // candidate on the same key in this scan counts once more
        // rather than overwriting the first count.
        byKey.set(candidate.cooldownKey, recordRecurrence(twin, opts.now));
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
      status: TRIGGER_STATUS.pending,
      effectiveStatus: TRIGGER_STATUS.pending,
      createdAt,
      expiresAt,
      deliveredAt: null,
      resolvedAt: null,
      suppressedAt: null,
      suppressedFrom: null,
      // Creating the record IS the first recorded occurrence.
      occurrences: OCCURRENCES_WHEN_UNRECORDED,
      lastSeenAt: createdAt,
      path: join(dir, `${id}.md`),
    });
    writeRecord(record);
    created.push(record);
  }

  return Object.freeze({ created: Object.freeze(created), skipped: Object.freeze(skipped) });
}

// ── Transitions ─────────────────────────────────────────────────────────────

export type TriggerAction = "acknowledge" | "dismiss" | "act" | "suppress" | "unsuppress";

export interface TransitionOptions {
  readonly now: Date;
}

/**
 * Actions whose target status is fixed. `unsuppress` is absent because
 * its target is whatever status suppression interrupted, which is read
 * off the record rather than looked up here.
 */
const ACTION_TO_STATUS: Record<Exclude<TriggerAction, "unsuppress">, TriggerStatus> = {
  acknowledge: TRIGGER_STATUS.acknowledged,
  dismiss: TRIGGER_STATUS.dismissed,
  act: TRIGGER_STATUS.acted,
  suppress: TRIGGER_STATUS.suppressed,
};

/**
 * Apply one lifecycle transition. Throws on an unknown id, on a terminal
 * state for acknowledge / dismiss / act, and on `unsuppress` against
 * anything that is not suppressed.
 */
export function transitionTrigger(
  vault: string,
  id: string,
  action: TriggerAction,
  opts: TransitionOptions,
): TriggerRecord {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const record = listTriggers(vault, { now: opts.now }).find((r) => r.id === id);
  if (record === undefined) throw new Error(`unknown trigger: ${id}`);
  const nowIso = opts.now.toISOString();

  if (action === "suppress") return suppress(record, nowIso);
  if (action === "unsuppress") return unsuppress(record, opts.now);

  if (TRIGGER_TERMINAL_STATUSES.has(record.effectiveStatus)) {
    throw new Error(`trigger ${id} is terminal (${record.effectiveStatus})`);
  }
  if (action === "acknowledge" && record.effectiveStatus === TRIGGER_STATUS.acknowledged) {
    return record; // idempotent
  }
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: ACTION_TO_STATUS[action],
    effectiveStatus: ACTION_TO_STATUS[action],
    resolvedAt: action === "acknowledge" ? record.resolvedAt : nowIso,
  });
  writeRecord(next);
  return next;
}

/**
 * Silence a cooldown key indefinitely.
 *
 * Legal from ANY status - "never surface this again" is a meaningful
 * judgement about an expired or already-acted finding too, because what
 * it silences is the key, not the record. The delivery and resolution
 * instants are deliberately left untouched: that is what makes
 * {@link unsuppress} an exact restore rather than a reconstruction.
 */
function suppress(record: TriggerRecord, nowIso: string): TriggerRecord {
  if (record.effectiveStatus === TRIGGER_STATUS.suppressed) return record; // idempotent
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: TRIGGER_STATUS.suppressed,
    effectiveStatus: TRIGGER_STATUS.suppressed,
    suppressedAt: nowIso,
    suppressedFrom: record.status,
  });
  writeRecord(next);
  return next;
}

/**
 * Undo a suppression, restoring the status it interrupted.
 *
 * The stored status is restored, not the effective one, so a trigger
 * suppressed while its TTL had already lapsed goes back to reading as
 * expired on the next read exactly as it did before.
 */
function unsuppress(record: TriggerRecord, now: Date): TriggerRecord {
  if (record.effectiveStatus !== TRIGGER_STATUS.suppressed) {
    throw new Error(`trigger ${record.id} is not suppressed (${record.effectiveStatus})`);
  }
  if (record.suppressedFrom === null) {
    // Never default to pending: that would invent a lifecycle position
    // and, for a formerly dismissed finding, silently restart its
    // cooldown from nothing.
    throw new Error(
      `trigger ${record.id} is suppressed but carries no suppressed_from; ` +
        "restore the field or dismiss the trigger instead",
    );
  }
  const restored = record.suppressedFrom;
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: restored,
    effectiveStatus: effectiveStatus(restored, record.expiresAt, now),
    suppressedAt: null,
    suppressedFrom: null,
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
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const wanted = new Set(ids);
  const nowIso = opts.now.toISOString();
  for (const record of listTriggers(vault, { now: opts.now })) {
    if (!wanted.has(record.id)) continue;
    if (
      record.effectiveStatus !== TRIGGER_STATUS.pending &&
      record.effectiveStatus !== TRIGGER_STATUS.delivered
    ) {
      continue;
    }
    writeRecord(
      Object.freeze({
        ...record,
        status: TRIGGER_STATUS.delivered,
        effectiveStatus: TRIGGER_STATUS.delivered,
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
 *
 * Eligibility is an allow-list of two statuses, so a suppressed trigger
 * is excluded by the same rule that excludes a dismissed one - no
 * suppression-specific branch exists or is needed here.
 */
export function briefTriggers(
  vault: string,
  opts: BriefTriggersOptions,
): ReadonlyArray<TriggerRecord> {
  const eligible = listTriggers(vault, { now: opts.now }).filter((record) => {
    if (record.effectiveStatus === TRIGGER_STATUS.pending) return true;
    if (record.effectiveStatus !== TRIGGER_STATUS.delivered) return false;
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

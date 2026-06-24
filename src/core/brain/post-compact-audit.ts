import { createHash } from "node:crypto";

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord, ContinuitySourceRef } from "./continuity/types.ts";
import { sanitizePreCompactText } from "./pre-compact-extract.ts";
import { appendPinnedContext, readPinnedContext } from "./pinned.ts";

/**
 * Post-compaction pinned-anchor survival audit — the symmetric POST
 * complement to {@link extractPreCompactRecords} (which captures
 * decisions/rules BEFORE a Hermes context-compaction). After Hermes
 * summarizes a long conversation, a pinned anchor's text can be demoted
 * into the (background) summary block while the ACTIVE region carries on
 * without it. This module detects the compaction event, audits which
 * anchors still live in the active region, and re-asserts ONLY the ones
 * that drifted — survivors cost zero tokens.
 *
 * Deterministic and LLM-free: detection is a literal marker scan plus a
 * summary-body hash; the survival probe is keyword-only (an optional
 * windowed-embedding probe is a documented future extension gated behind
 * `post_compact_survival_audit_embedding`, off by default — NOT built
 * here). Fail-open throughout: a malformed conversation, an unreadable
 * pinned store, or an over-budget re-assertion is recorded in the bounded
 * audit record and never thrown into the caller's turn.
 */

/**
 * Hermes compressor handoff markers. The summary block a compaction
 * emits is prefixed by one of these. Defaults mirror the design's
 * enumerated set: the Unicode `SUMMARY_PREFIX`, its ASCII fallback, and
 * the legacy `[CONTEXT SUMMARY]:`. A host that emits a different literal
 * passes its own via {@link PostCompactAuditInput.summaryMarkers}; the
 * defaults stay in place when it does not.
 */
export const DEFAULT_SUMMARY_MARKERS: ReadonlyArray<string> = Object.freeze([
  "⟦CONTEXT-SUMMARY⟧",
  "[[CONTEXT-SUMMARY]]",
  "[CONTEXT SUMMARY]:",
]);

/** Header of the on-drift re-assertion block written to the pinned store. */
export const REASSERT_HEADER = "## Re-asserted standing context (post-compaction";

const DEFAULT_PRESENCE_RATIO = 0.5;
const DEFAULT_MAX_ANCHORS = 200;
const DEFAULT_MAX_DRIFT_LOG = 50;
const MAX_PROBES_PER_ANCHOR = 8;
const ANCHOR_LOG_MAX_CHARS = 400;

export type AnchorStatus = "survived" | "drifted" | "absent";
export type AnchorSource = "pinned" | "static";

export interface ConversationMessage {
  readonly role?: string;
  readonly content: string;
}

export interface PostCompactAuditInput {
  readonly sessionId: string;
  /**
   * The post-compaction conversation, in order. The summary block is the
   * LAST message whose content opens with a known marker; every message
   * after it is the ACTIVE (non-summary) region.
   */
  readonly messages: ReadonlyArray<ConversationMessage>;
  /**
   * Static standing-instruction anchors (e.g. config, reseeded each
   * session start). Audited alongside the dynamic pins read from the
   * pinned store. Absent by default.
   */
  readonly staticAnchors?: ReadonlyArray<string>;
  /** Override the compaction markers; defaults to {@link DEFAULT_SUMMARY_MARKERS}. */
  readonly summaryMarkers?: ReadonlyArray<string>;
  /**
   * Fraction of an anchor's keyword probes that must hit a region for the
   * anchor to count as present there. Default 0.5 (at least one probe is
   * always required).
   */
  readonly presenceRatio?: number;
  /**
   * When false, compute the audit + reminder block but do NOT write the
   * re-assertion into the pinned store (dry-run). Default true.
   */
  readonly reassert?: boolean;
  /** Bounded cap on anchors recorded in the audit drift log. Default 50. */
  readonly maxDriftLog?: number;
  readonly createdAt?: string;
}

export interface AnchorVerdict {
  readonly anchor: string;
  readonly status: AnchorStatus;
  readonly source: AnchorSource;
  readonly probes: ReadonlyArray<string>;
}

export interface PostCompactAuditResult {
  readonly compactionDetected: boolean;
  /** True when this exact summary (by hash) was already audited for the session. */
  readonly alreadyAudited: boolean;
  readonly summaryHash: string | null;
  readonly anchors: ReadonlyArray<AnchorVerdict>;
  readonly drifted: ReadonlyArray<string>;
  readonly survived: number;
  readonly absent: number;
  /** True when an on-drift reminder block was written to the pinned store. */
  readonly reasserted: boolean;
  /** The on-drift repair text (the reminder block), or null when nothing drifted. */
  readonly reminderBlock: string | null;
  /** The bounded `post_compact_audit` continuity record, or null when nothing was recorded. */
  readonly record: ContinuityRecord | null;
  readonly errors: ReadonlyArray<string>;
}

interface CompactionSplit {
  readonly summaryBody: string;
  readonly summaryRegion: string;
  readonly activeRegion: string;
}

interface Anchor {
  readonly text: string;
  readonly source: AnchorSource;
  readonly probes: ReadonlyArray<string>;
}

/**
 * Audit pinned-anchor survival after a Hermes compaction. Never throws:
 * every recoverable failure lands in the returned `errors` array, so a
 * caller can wire this into a per-turn hook without a try/catch.
 */
export function auditPostCompaction(
  vault: string,
  input: PostCompactAuditInput,
): PostCompactAuditResult {
  const errors: string[] = [];
  try {
    return runAudit(vault, input, errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return emptyResult(false, false, null, errors);
  }
}

function runAudit(
  vault: string,
  input: PostCompactAuditInput,
  errors: string[],
): PostCompactAuditResult {
  const markers =
    input.summaryMarkers && input.summaryMarkers.length > 0
      ? input.summaryMarkers
      : DEFAULT_SUMMARY_MARKERS;
  const split = detectCompaction(input.messages, markers);
  if (split === null) {
    return emptyResult(false, false, null, errors);
  }

  const summaryHash = hash(split.summaryBody);
  const dedupeKey = `${input.sessionId}:${summaryHash}`;
  if (findExistingAudit(vault, dedupeKey) !== null) {
    // The same compaction was already audited for this session. Re-running
    // every turn would re-inject drifted anchors repeatedly and churn the
    // prompt cache; skip as a no-op.
    return emptyResult(true, true, summaryHash, errors);
  }

  const ratio = clampRatio(input.presenceRatio);
  const anchors = collectAnchors(vault, input.staticAnchors, errors);
  const verdicts: AnchorVerdict[] = [];
  for (const anchor of anchors) {
    let status: AnchorStatus;
    try {
      const inActive = regionContainsAnchor(split.activeRegion, anchor.probes, ratio);
      const inSummary = regionContainsAnchor(split.summaryRegion, anchor.probes, ratio);
      status = inActive ? "survived" : inSummary ? "drifted" : "absent";
    } catch (error) {
      // A single un-probeable anchor never aborts the audit.
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    verdicts.push({ anchor: anchor.text, status, source: anchor.source, probes: anchor.probes });
  }

  const drifted = verdicts.filter((v) => v.status === "drifted").map((v) => v.anchor);
  const survived = verdicts.filter((v) => v.status === "survived").length;
  const absent = verdicts.filter((v) => v.status === "absent").length;
  const reminderBlock = drifted.length > 0 ? buildReminderBlock(drifted, summaryHash) : null;

  let reasserted = false;
  if (reminderBlock !== null && input.reassert !== false) {
    reasserted = reassertReminder(vault, reminderBlock, errors);
  }

  const record = recordAudit(vault, {
    sessionId: input.sessionId,
    summaryHash,
    dedupeKey,
    anchorsTotal: verdicts.length,
    survived,
    drifted,
    absent,
    reasserted,
    createdAt: input.createdAt,
    maxDriftLog: input.maxDriftLog ?? DEFAULT_MAX_DRIFT_LOG,
    errors,
  });

  return Object.freeze({
    compactionDetected: true,
    alreadyAudited: false,
    summaryHash,
    anchors: Object.freeze(verdicts),
    drifted: Object.freeze(drifted),
    survived,
    absent,
    reasserted,
    reminderBlock,
    record,
    errors: Object.freeze([...errors]),
  });
}

/**
 * Locate the most recent compaction summary in the conversation. The
 * summary is the LAST message whose content opens with a marker; the
 * active region is every message after it, the summary region everything
 * up to and including it. Returns null when no marker is present.
 */
export function detectCompaction(
  messages: ReadonlyArray<ConversationMessage>,
  markers: ReadonlyArray<string> = DEFAULT_SUMMARY_MARKERS,
): CompactionSplit | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let summaryIndex = -1;
  let summaryBody = "";
  for (let index = 0; index < messages.length; index += 1) {
    const content = messages[index]?.content;
    if (typeof content !== "string") continue;
    const marker = markers.find((m) => content.trimStart().startsWith(m));
    if (marker !== undefined) {
      summaryIndex = index;
      summaryBody = content.trimStart().slice(marker.length).trim();
    }
  }
  if (summaryIndex === -1) return null;

  const contentAt = (index: number): string =>
    typeof messages[index]?.content === "string" ? (messages[index]!.content as string) : "";
  const summaryRegion = messages
    .slice(0, summaryIndex + 1)
    .map((_, offset) => contentAt(offset))
    .join("\n");
  const activeRegion = messages
    .slice(summaryIndex + 1)
    .map((_, offset) => contentAt(summaryIndex + 1 + offset))
    .join("\n");
  return { summaryBody, summaryRegion, activeRegion };
}

/**
 * Derive locale-agnostic keyword probes from an anchor's own text. No
 * hardcoded stopword lists: distinctiveness is approximated purely by
 * token length, so the probe set is the same regardless of language.
 */
export function deriveProbes(anchorText: string): string[] {
  const tokens = anchorText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  let probes = tokens.filter((t) => t.length >= 4);
  if (probes.length === 0) probes = tokens.filter((t) => t.length >= 2);
  return [...new Set(probes)]
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_PROBES_PER_ANCHOR);
}

function regionContainsAnchor(
  region: string,
  probes: ReadonlyArray<string>,
  ratio: number,
): boolean {
  if (probes.length === 0) return false;
  const lower = region.toLowerCase();
  const matched = probes.filter((p) => lower.includes(p)).length;
  if (matched === 0) return false;
  return matched / probes.length >= ratio;
}

function collectAnchors(
  vault: string,
  staticAnchors: ReadonlyArray<string> | undefined,
  errors: string[],
): Anchor[] {
  const anchors: Anchor[] = [];
  const seen = new Set<string>();
  const push = (text: string, source: AnchorSource): void => {
    const clean = sanitizePreCompactText(text.trim());
    if (clean.length === 0) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    const probes = deriveProbes(clean);
    if (probes.length === 0) return; // un-probeable line (punctuation/separator only)
    seen.add(key);
    anchors.push({ text: clean, source, probes });
  };

  let pinnedContent = "";
  try {
    pinnedContent = readPinnedContext(vault).content;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const line of pinnedContent.split(/\r?\n/)) {
    if (anchors.length >= DEFAULT_MAX_ANCHORS) break;
    const stripped = stripAnchorLine(line);
    if (stripped !== null) push(stripped, "pinned");
  }
  for (const raw of staticAnchors ?? []) {
    if (anchors.length >= DEFAULT_MAX_ANCHORS) break;
    if (typeof raw === "string") push(raw, "static");
  }
  return anchors;
}

/**
 * Normalise one pinned line into an anchor, or null when it carries no
 * standing instruction (blank, heading, or rule separator). Leading list
 * markers are stripped so `- Always X` and `Always X` audit identically.
 */
function stripAnchorLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (/^#{1,6}\s/.test(trimmed)) return null; // markdown heading
  if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s+/g, ""))) return null; // --- *** ___ rule
  return trimmed.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim();
}

function buildReminderBlock(drifted: ReadonlyArray<string>, summaryHash: string): string {
  const header = `${REASSERT_HEADER} ${summaryHash.slice(0, 8)})`;
  return [header, ...drifted.map((a) => `- ${a}`)].join("\n");
}

/**
 * Append the reminder block to the pinned store, fail-open. Idempotent
 * against the per-compaction header (so a retried turn does not duplicate
 * the block) and bounded by the pinned budget (an over-budget append is
 * recorded, not thrown).
 */
function reassertReminder(vault: string, reminderBlock: string, errors: string[]): boolean {
  try {
    const header = reminderBlock.split("\n")[0] ?? "";
    if (header.length > 0 && readPinnedContext(vault).content.includes(header)) {
      return false; // already re-asserted for this compaction
    }
    appendPinnedContext(vault, reminderBlock);
    return true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return false;
  }
}

interface RecordAuditInput {
  readonly sessionId: string;
  readonly summaryHash: string;
  readonly dedupeKey: string;
  readonly anchorsTotal: number;
  readonly survived: number;
  readonly drifted: ReadonlyArray<string>;
  readonly absent: number;
  readonly reasserted: boolean;
  readonly createdAt?: string;
  readonly maxDriftLog: number;
  readonly errors: ReadonlyArray<string>;
}

function recordAudit(vault: string, input: RecordAuditInput): ContinuityRecord | null {
  try {
    const boundedDrift = input.drifted
      .slice(0, Math.max(0, input.maxDriftLog))
      .map((text) => sanitizePreCompactText(text).slice(0, ANCHOR_LOG_MAX_CHARS));
    return appendContinuityRecord(vault, {
      kind: "post_compact_audit",
      createdAt: input.createdAt ?? new Date().toISOString(),
      sourceRefs: auditSourceRefs(input.sessionId),
      payload: {
        session_id: input.sessionId,
        summary_hash: input.summaryHash,
        dedupe_key: input.dedupeKey,
        anchors_total: input.anchorsTotal,
        survived: input.survived,
        drifted_count: input.drifted.length,
        absent: input.absent,
        drifted: boundedDrift,
        drift_log_truncated: input.drifted.length > boundedDrift.length,
        reasserted: input.reasserted,
        ...(input.errors.length > 0 ? { errors: input.errors.slice(0, 10) } : {}),
      },
    });
  } catch (error) {
    // Recording the audit must never break the turn. A failure here means
    // no idempotency record exists, so the next turn re-audits — a soft
    // loss, not a turn-breaker.
    (input.errors as string[]).push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function auditSourceRefs(sessionId: string): ReadonlyArray<ContinuitySourceRef> {
  return Object.freeze([Object.freeze({ type: "session", id: sessionId })]);
}

function findExistingAudit(vault: string, dedupeKey: string): ContinuityRecord | null {
  return (
    listContinuityRecords(vault, { kind: "post_compact_audit" }).find(
      (record) => record.payload["dedupe_key"] === dedupeKey,
    ) ?? null
  );
}

function clampRatio(ratio: number | undefined): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return DEFAULT_PRESENCE_RATIO;
  if (ratio <= 0) return DEFAULT_PRESENCE_RATIO;
  return Math.min(1, ratio);
}

function emptyResult(
  compactionDetected: boolean,
  alreadyAudited: boolean,
  summaryHash: string | null,
  errors: string[],
): PostCompactAuditResult {
  return Object.freeze({
    compactionDetected,
    alreadyAudited,
    summaryHash,
    anchors: Object.freeze([]),
    drifted: Object.freeze([]),
    survived: 0,
    absent: 0,
    reasserted: false,
    reminderBlock: null,
    record: null,
    errors: Object.freeze([...errors]),
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

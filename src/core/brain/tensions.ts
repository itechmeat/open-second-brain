/**
 * Tension objects: persisted contradiction lifecycle (Belief lifecycle
 * suite, S2, t_0e3f2bee).
 *
 * A detected contradiction is a fleeting finding today - the semantic
 * health detectors surface it and it silently re-fires on the next pass.
 * A tension object gives that finding a durable home: a Markdown note
 * under `Brain/tensions/tension-<slug>.md` whose `_status` walks a small
 * state machine `open -> confirmed | dismissed | resolved`. The slug is
 * derived from a deterministic DEDUP KEY (the subject pair plus the
 * stance signature), so re-detecting the same contradiction UPDATES the
 * existing note in place instead of spawning a duplicate.
 *
 * This module CONSUMES the existing contradiction detector
 * (`health/contradiction.ts` - {@link detectNoteContradictions}); it does
 * not re-implement detection. The dedup key is built purely from
 * structural signals (ids + derived stance signs), so it stays
 * language-agnostic and identical on every Syncthing peer.
 *
 * Injection-time warning: {@link tensionWarningsForContextItems} lets the
 * context-pack builder flag when it is about to inject a memory that is a
 * subject of an UNRESOLVED (open or confirmed) tension. Dismissed and
 * resolved tensions warn about nothing.
 *
 * Import direction: this module imports from health/contradiction /
 * paths / log / vault helpers, never the reverse.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";

import { normalizeAgentArgument } from "../agent-identity.ts";
import { resolveAgentName } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { sanitiseTextField } from "../redactor.ts";
import { parseFrontmatter } from "../vault.ts";
import {
  detectNoteContradictions,
  type DetectNoteContradictionsOptions,
  type NoteContradictionFinding,
  type NoteForContradiction,
} from "./health/contradiction.ts";
import { appendLogEvent } from "./log.ts";
import { buildNoteWalkRules, resolveNoteRoots, walkMarkdownFiles } from "./notes/note-walk.ts";
import { tensionPath, tensionsDir } from "./paths.ts";
import { BRAIN_HEALTH_DEFAULTS } from "./policy.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, type BrainSignalSign } from "./types.ts";

// ----- Constants ------------------------------------------------------------

/** Frontmatter `type` discriminator carried by every tension note. */
export const TENSION_TYPE = "tension";
/** On-disk frontmatter key holding a tension's lifecycle status. */
export const TENSION_STATUS_KEY = "_status";
/** Cap on the operator-supplied resolution/dismiss reason. */
const REASON_MAX_LEN = 512;
/** Cap on a quoted subject-bearing span stored in the note body. */
const QUOTE_MAX_LEN = 512;
/** Length of the dedup-hash suffix appended to the readable slug stem. */
const DEDUP_HASH_LEN = 12;
/** Readable-stem cap so the composed slug stays a sane filename length. */
const SLUG_STEM_MAX_LEN = 48;
/**
 * Byte cap for a note read during a vault scan. Files over the cap are
 * skipped (and not counted as scanned), matching the open-loop scanner's
 * 1 MiB ceiling so one pathological file cannot stall detection.
 */
const NOTE_SCAN_MAX_BYTES = 1024 * 1024;

/** The lifecycle states a tension can occupy. */
export const TENSION_STATUS = {
  open: "open",
  confirmed: "confirmed",
  dismissed: "dismissed",
  resolved: "resolved",
} as const;
export type TensionStatus = (typeof TENSION_STATUS)[keyof typeof TENSION_STATUS];

/**
 * The states in which a tension still demands attention. Only these
 * produce an injection-time warning; dismissed and resolved are terminal
 * and silent.
 */
export const TENSION_UNRESOLVED_STATUSES: ReadonlySet<TensionStatus> = new Set([
  TENSION_STATUS.open,
  TENSION_STATUS.confirmed,
]);

/** The three operator transition verbs. */
export const TENSION_TRANSITION = {
  confirm: "confirm",
  dismiss: "dismiss",
  resolve: "resolve",
} as const;
export type TensionTransition = (typeof TENSION_TRANSITION)[keyof typeof TENSION_TRANSITION];

/**
 * The state machine: each transition maps to its resulting status and the
 * set of source states it is legal from. Any transition whose current
 * status is not in `from` raises {@link TensionError}.
 */
const TRANSITIONS: Readonly<
  Record<
    TensionTransition,
    { readonly to: TensionStatus; readonly from: ReadonlySet<TensionStatus> }
  >
> = {
  confirm: { to: TENSION_STATUS.confirmed, from: new Set([TENSION_STATUS.open]) },
  dismiss: {
    to: TENSION_STATUS.dismissed,
    from: new Set([TENSION_STATUS.open, TENSION_STATUS.confirmed]),
  },
  resolve: {
    to: TENSION_STATUS.resolved,
    from: new Set([TENSION_STATUS.open, TENSION_STATUS.confirmed]),
  },
};

// ----- Errors ---------------------------------------------------------------

/** Every failure path in this module raises this typed error. */
export class TensionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TensionError";
  }
}

// ----- Shapes ---------------------------------------------------------------

export interface TensionRecord {
  readonly slug: string;
  /** Filename basename without `.md`. Equals `tension-<slug>`. */
  readonly id: string;
  readonly type: typeof TENSION_TYPE;
  readonly status: TensionStatus;
  /** Lower-sorted subject id of the contradicting pair. */
  readonly subjectA: string;
  /** Higher-sorted subject id of the contradicting pair. */
  readonly subjectB: string;
  /** Sorted shared subject tokens, space-joined, for display. */
  readonly subject: string;
  /** Derived stance of {@link subjectA}. */
  readonly stanceA: BrainSignalSign;
  /** Derived stance of {@link subjectB}. */
  readonly stanceB: BrainSignalSign;
  /** Prose token overlap that put the pair over the detector threshold. */
  readonly jaccard: number;
  /** Deterministic dedup key (subject pair + stance signature). */
  readonly dedupKey: string;
  /** How many times this contradiction has been detected. */
  readonly detectedCount: number;
  readonly createdAt: string;
  /** ISO second of the most recent detection. */
  readonly detectedAt: string;
  /** ISO second of the most recent status transition, or null. */
  readonly statusChangedAt: string | null;
  /** Operator reason recorded on dismiss/resolve, or null. */
  readonly resolutionReason: string | null;
  readonly agent: string;
  /** Subject-bearing span quoted from {@link subjectA}. */
  readonly quoteA: string;
  /** Subject-bearing span quoted from {@link subjectB}. */
  readonly quoteB: string;
  readonly path: string;
}

export interface PersistTensionOptions {
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

export interface PersistTensionResult {
  readonly record: TensionRecord;
  /** False when an existing tension for this dedup key was refreshed. */
  readonly created: boolean;
}

export interface DetectTensionsOptions extends DetectNoteContradictionsOptions {
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

export interface DetectTensionsResult {
  readonly records: ReadonlyArray<TensionRecord>;
  /** How many tensions were newly created this run. */
  readonly created: number;
  /** How many existing tensions were refreshed this run. */
  readonly updated: number;
}

export interface TransitionOptions {
  readonly reason?: string;
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

// ----- Dedup key + slug -----------------------------------------------------

/**
 * Canonicalise a finding into `{ idLow, idHigh, signLow, signHigh, ... }`
 * with the pair ordered by id, so the two orderings of one contradiction
 * yield one identity. Stances travel with their id under the sort.
 */
function canonicalPair(finding: NoteContradictionFinding): {
  idLow: string;
  idHigh: string;
  signLow: BrainSignalSign;
  signHigh: BrainSignalSign;
  quoteLow: string;
  quoteHigh: string;
} {
  const aFirst = finding.aId <= finding.bId;
  return aFirst
    ? {
        idLow: finding.aId,
        idHigh: finding.bId,
        signLow: finding.aSign,
        signHigh: finding.bSign,
        quoteLow: finding.aQuote,
        quoteHigh: finding.bQuote,
      }
    : {
        idLow: finding.bId,
        idHigh: finding.aId,
        signLow: finding.bSign,
        signHigh: finding.aSign,
        quoteLow: finding.bQuote,
        quoteHigh: finding.aQuote,
      };
}

/**
 * Deterministic dedup key: the id-sorted subject pair joined with the
 * stance signature. Two detections of the same pair with the same stances
 * collapse onto one key; a stance flip produces a distinct key (and note),
 * because the belief at stake genuinely changed.
 */
export function tensionDedupKey(finding: NoteContradictionFinding): string {
  const { idLow, idHigh, signLow, signHigh } = canonicalPair(finding);
  return `${idLow} ${idHigh} ${signLow}-${signHigh}`;
}

/**
 * Filesystem-safe slug for a dedup key: a readable stem (the sorted id
 * pair) plus a short sha256 suffix of the full key. The suffix guarantees
 * uniqueness (so two pairs whose stems collide after truncation stay
 * distinct) and stance-sensitivity, while staying deterministic across
 * peers.
 */
function tensionSlug(finding: NoteContradictionFinding): string {
  const { idLow, idHigh } = canonicalPair(finding);
  const dedupKey = tensionDedupKey(finding);
  const stem = `${stripId(idLow)}-${stripId(idHigh)}`
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SLUG_STEM_MAX_LEN)
    .replace(/-+$/gu, "");
  const hash = createHash("sha256").update(dedupKey, "utf8").digest("hex").slice(0, DEDUP_HASH_LEN);
  return stem ? `${stem}-${hash}` : hash;
}

/** Lowercase an id for the readable slug stem (structural, not semantic). */
function stripId(id: string): string {
  return id.trim().toLowerCase();
}

// ----- (De)serialization ----------------------------------------------------

function render(record: Omit<TensionRecord, "path">): string {
  const lines = [
    "---",
    `type: ${TENSION_TYPE}`,
    `id: ${record.id}`,
    `${TENSION_STATUS_KEY}: ${record.status}`,
    `subject_a: ${record.subjectA}`,
    `subject_b: ${record.subjectB}`,
    `subject: ${JSON.stringify(record.subject)}`,
    `stance_a: ${record.stanceA}`,
    `stance_b: ${record.stanceB}`,
    `jaccard: ${record.jaccard}`,
    `dedup_key: ${JSON.stringify(record.dedupKey)}`,
    `detected_count: ${record.detectedCount}`,
    `created_at: ${record.createdAt}`,
    `detected_at: ${record.detectedAt}`,
  ];
  if (record.statusChangedAt !== null) lines.push(`status_changed_at: ${record.statusChangedAt}`);
  if (record.resolutionReason !== null) {
    lines.push(`resolution_reason: ${JSON.stringify(record.resolutionReason)}`);
  }
  lines.push(`agent: ${JSON.stringify(record.agent)}`);
  lines.push("---", "");
  lines.push(`- ${record.subjectA}: ${record.quoteA}`);
  lines.push(`- ${record.subjectB}: ${record.quoteB}`);
  lines.push("");
  return lines.join("\n");
}

function coerceStatus(value: unknown): TensionStatus {
  if (
    typeof value === "string" &&
    (Object.values(TENSION_STATUS) as ReadonlyArray<string>).includes(value)
  ) {
    return value as TensionStatus;
  }
  // A hand-edit that corrupts the status reads as `open` (the safe,
  // still-demands-attention default) rather than silently vanishing.
  return TENSION_STATUS.open;
}

function coerceSign(value: unknown): BrainSignalSign {
  return value === "negative" ? "negative" : "positive";
}

function scalarString(meta: Readonly<Record<string, unknown>>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value : "";
}

function parsePage(vault: string, slug: string): TensionRecord | null {
  const path = tensionPath(vault, slug);
  if (!existsSync(path)) return null;
  const [meta, body] = parseFrontmatter(path);
  if (meta["type"] !== TENSION_TYPE) return null;
  const statusChangedRaw = scalarString(meta, "status_changed_at");
  const reasonRaw = scalarString(meta, "resolution_reason");
  const detectedCount = Number(meta["detected_count"]);
  const jaccard = Number(meta["jaccard"]);
  // Body carries the two quote bullets; parse them back for round-trip.
  const quotes = parseQuoteBody(body);
  const subjectA = scalarString(meta, "subject_a");
  const subjectB = scalarString(meta, "subject_b");
  return Object.freeze({
    slug,
    id: `tension-${slug}`,
    type: TENSION_TYPE,
    status: coerceStatus(meta[TENSION_STATUS_KEY]),
    subjectA,
    subjectB,
    subject: scalarString(meta, "subject"),
    stanceA: coerceSign(meta["stance_a"]),
    stanceB: coerceSign(meta["stance_b"]),
    jaccard: Number.isFinite(jaccard) ? jaccard : 0,
    dedupKey: scalarString(meta, "dedup_key"),
    detectedCount: Number.isInteger(detectedCount) && detectedCount > 0 ? detectedCount : 1,
    createdAt: scalarString(meta, "created_at"),
    detectedAt: scalarString(meta, "detected_at"),
    statusChangedAt: statusChangedRaw.length > 0 ? statusChangedRaw : null,
    resolutionReason: reasonRaw.length > 0 ? reasonRaw : null,
    agent: scalarString(meta, "agent"),
    quoteA: quotes.get(subjectA) ?? "",
    quoteB: quotes.get(subjectB) ?? "",
    path,
  });
}

/** Parse the `- <id>: <quote>` body bullets back into a per-id map. */
function parseQuoteBody(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.split("\n")) {
    const m = /^-\s+([^:]+):\s*(.*)$/u.exec(line.trim());
    if (m) out.set(m[1]!.trim(), m[2]!.trim());
  }
  return out;
}

// ----- Agent + reason helpers -----------------------------------------------

function resolveAgent(explicit: string | undefined, configPath: string | undefined): string {
  return normalizeAgentArgument(explicit ?? null) ?? resolveAgentName(configPath);
}

function cleanReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const cleaned = sanitiseTextField(reason, { maxLen: REASON_MAX_LEN, singleLine: true }).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanQuote(quote: string): string {
  return sanitiseTextField(quote, { maxLen: QUOTE_MAX_LEN, singleLine: true }).trim();
}

// ----- Persist --------------------------------------------------------------

/**
 * Persist one detected contradiction as a tension note. On first sight of
 * a dedup key this creates an `open` note and logs a `tension` (detected)
 * event; on re-detection it refreshes the existing note (jaccard, quotes,
 * `detected_at`, `detected_count`) WITHOUT touching its `_status`,
 * `created_at`, or transition history, and emits nothing.
 */
export function persistTension(
  vault: string,
  finding: NoteContradictionFinding,
  opts: PersistTensionOptions = {},
): PersistTensionResult {
  const { idLow, idHigh, signLow, signHigh, quoteLow, quoteHigh } = canonicalPair(finding);
  const slug = tensionSlug(finding);
  const dedupKey = tensionDedupKey(finding);
  const now = opts.now ?? new Date();
  const stampedAt = isoSecond(now);
  const agent = resolveAgent(opts.agent, opts.configPath);

  const prior = parsePage(vault, slug);
  if (prior !== null) {
    // Idempotent refresh: bump detection bookkeeping, preserve lifecycle.
    const next: Omit<TensionRecord, "path"> = {
      ...prior,
      subject: finding.subject,
      stanceA: signLow,
      stanceB: signHigh,
      jaccard: finding.jaccard,
      dedupKey,
      detectedCount: prior.detectedCount + 1,
      detectedAt: stampedAt,
      quoteA: cleanQuote(quoteLow),
      quoteB: cleanQuote(quoteHigh),
    };
    mkdirSync(tensionsDir(vault), { recursive: true });
    atomicWriteFileSync(prior.path, render(next));
    return { record: Object.freeze({ ...next, path: prior.path }), created: false };
  }

  const record: Omit<TensionRecord, "path"> = {
    slug,
    id: `tension-${slug}`,
    type: TENSION_TYPE,
    status: TENSION_STATUS.open,
    subjectA: idLow,
    subjectB: idHigh,
    subject: finding.subject,
    stanceA: signLow,
    stanceB: signHigh,
    jaccard: finding.jaccard,
    dedupKey,
    detectedCount: 1,
    createdAt: stampedAt,
    detectedAt: stampedAt,
    statusChangedAt: null,
    resolutionReason: null,
    agent,
    quoteA: cleanQuote(quoteLow),
    quoteB: cleanQuote(quoteHigh),
  };

  mkdirSync(tensionsDir(vault), { recursive: true });
  const path = tensionPath(vault, slug);
  atomicWriteFileSync(path, render(record));

  appendLogEvent(vault, {
    timestamp: stampedAt,
    eventType: BRAIN_LOG_EVENT_KIND.tension,
    body: {
      tension: `[[${record.id}]]`,
      action: "detected",
      status: record.status,
      subject_a: idLow,
      subject_b: idHigh,
      agent,
    },
  });

  return { record: Object.freeze({ ...record, path }), created: true };
}

/**
 * Run the note contradiction detector over `notes` and persist every
 * finding as a tension. Consumes {@link detectNoteContradictions}; does
 * not re-implement detection. Returns the persisted records plus how many
 * were created vs refreshed.
 */
export function detectTensions(
  vault: string,
  notes: ReadonlyArray<NoteForContradiction>,
  opts: DetectTensionsOptions,
): DetectTensionsResult {
  const findings = detectNoteContradictions(notes, {
    jaccard: opts.jaccard,
    ...(opts.negationMarkers !== undefined ? { negationMarkers: opts.negationMarkers } : {}),
  });
  const records: TensionRecord[] = [];
  let created = 0;
  let updated = 0;
  for (const finding of findings) {
    const res = persistTension(vault, finding, {
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    });
    records.push(res.record);
    if (res.created) created++;
    else updated++;
  }
  return { records, created, updated };
}

export interface DetectTensionsInVaultOptions {
  /**
   * Explicit note roots to scan. When omitted (or all-blank) the roots
   * come from `notes.read_paths` in `Brain/_brain.yaml`; a vault with no
   * configured read paths scans nothing and creates no tensions, so an
   * un-opted-in vault is byte-identical to today.
   */
  readonly paths?: ReadonlyArray<string>;
  /**
   * Minimum prose jaccard for two notes to count as the same subject.
   * Defaults to the shared health threshold
   * ({@link BRAIN_HEALTH_DEFAULTS.contradiction_jaccard}).
   */
  readonly jaccard?: number;
  readonly negationMarkers?: ReadonlySet<string>;
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
  /** Byte cap per scanned file; defaults to {@link NOTE_SCAN_MAX_BYTES}. */
  readonly maxFileSizeBytes?: number;
}

export interface DetectTensionsInVaultResult extends DetectTensionsResult {
  /** How many note files were read and fed to the detector. */
  readonly scannedFiles: number;
}

/**
 * Production entry point for tension detection: load the configured note
 * corpus (`notes.read_paths`) as prose notes and persist every detected
 * contradiction as a tension. This is the operator-triggerable scan behind
 * the `detect` action on the tension CLI verb and MCP tool; without it the
 * detector ({@link detectTensions}) had no production caller and the
 * operator could never create a tension.
 *
 * Each markdown file under a configured root becomes one
 * {@link NoteForContradiction}: `id` is the frontmatter `id` when present
 * (else the vault-relative path), `subject` is the optional frontmatter
 * `subject` bucket, and `text` is the note body. The Brain machinery root
 * and `vault.ignore_paths` are excluded by the shared note walker.
 */
export function detectTensionsInVault(
  vault: string,
  opts: DetectTensionsInVaultOptions = {},
): DetectTensionsInVaultResult {
  const roots = resolveNoteRoots(vault, opts.paths);
  if (roots.length === 0) return { records: [], created: 0, updated: 0, scannedFiles: 0 };

  const rules = buildNoteWalkRules(vault);
  const cap = opts.maxFileSizeBytes ?? NOTE_SCAN_MAX_BYTES;
  const notes: NoteForContradiction[] = [];
  for (const file of walkMarkdownFiles(vault, roots, rules, { maxFileSizeBytes: cap })) {
    let meta: Readonly<Record<string, unknown>>;
    let body: string;
    try {
      [meta, body] = parseFrontmatter(file.absPath);
    } catch {
      continue; // unreadable or malformed frontmatter - skip, do not count
    }
    const rawId = meta["id"];
    const id = typeof rawId === "string" && rawId.trim() !== "" ? rawId.trim() : file.relPath;
    const rawSubject = meta["subject"];
    const subject =
      typeof rawSubject === "string" && rawSubject.trim() !== "" ? rawSubject.trim() : undefined;
    notes.push({ id, ...(subject !== undefined ? { subject } : {}), text: body });
  }

  const result = detectTensions(vault, notes, {
    jaccard: opts.jaccard ?? BRAIN_HEALTH_DEFAULTS.contradiction_jaccard,
    ...(opts.negationMarkers !== undefined ? { negationMarkers: opts.negationMarkers } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  return { ...result, scannedFiles: notes.length };
}

// ----- Transitions ----------------------------------------------------------

function transition(
  vault: string,
  slug: string,
  verb: TensionTransition,
  opts: TransitionOptions,
): TensionRecord {
  const prior = parsePage(vault, slug);
  if (prior === null) throw new TensionError(`no tension: ${slug}`);
  const rule = TRANSITIONS[verb];
  if (!rule.from.has(prior.status)) {
    throw new TensionError(
      `invalid tension transition: cannot ${verb} a tension in state '${prior.status}'`,
    );
  }
  const now = opts.now ?? new Date();
  const stampedAt = isoSecond(now);
  const agent = resolveAgent(opts.agent, opts.configPath);
  const reason = cleanReason(opts.reason);

  const next: Omit<TensionRecord, "path"> = {
    ...prior,
    status: rule.to,
    statusChangedAt: stampedAt,
    resolutionReason: reason ?? prior.resolutionReason,
  };
  atomicWriteFileSync(prior.path, render(next));

  appendLogEvent(vault, {
    timestamp: stampedAt,
    eventType: BRAIN_LOG_EVENT_KIND.tension,
    body: {
      tension: `[[${prior.id}]]`,
      action: verb,
      from: prior.status,
      status: rule.to,
      subject_a: prior.subjectA,
      subject_b: prior.subjectB,
      ...(reason !== null ? { reason } : {}),
      agent,
    },
  });

  return Object.freeze({ ...next, path: prior.path });
}

/** Confirm a tension (`open -> confirmed`). Invalid otherwise. */
export function confirmTension(
  vault: string,
  slug: string,
  opts: TransitionOptions = {},
): TensionRecord {
  return transition(vault, slug, TENSION_TRANSITION.confirm, opts);
}

/** Dismiss a tension (`open | confirmed -> dismissed`). Invalid otherwise. */
export function dismissTension(
  vault: string,
  slug: string,
  opts: TransitionOptions = {},
): TensionRecord {
  return transition(vault, slug, TENSION_TRANSITION.dismiss, opts);
}

/** Resolve a tension (`open | confirmed -> resolved`). Invalid otherwise. */
export function resolveTension(
  vault: string,
  slug: string,
  opts: TransitionOptions = {},
): TensionRecord {
  return transition(vault, slug, TENSION_TRANSITION.resolve, opts);
}

// ----- Reads ----------------------------------------------------------------

/** One tension, or null. */
export function showTension(vault: string, slug: string): TensionRecord | null {
  return parsePage(vault, slug);
}

/** Every tension, sorted by slug. */
export function listTensions(vault: string): TensionRecord[] {
  const dir = tensionsDir(vault);
  if (!existsSync(dir)) return [];
  const out: TensionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || !name.startsWith("tension-")) continue;
    const slug = name.replace(/^tension-/u, "").replace(/\.md$/u, "");
    const page = parsePage(vault, slug);
    if (page !== null) out.push(page);
  }
  return out.toSorted((a, b) => a.slug.localeCompare(b.slug));
}

/** Every tension still in an unresolved (open or confirmed) state. */
export function listUnresolvedTensions(vault: string): TensionRecord[] {
  return listTensions(vault).filter((t) => TENSION_UNRESOLVED_STATUSES.has(t.status));
}

// ----- Injection-time warnings ----------------------------------------------

/**
 * Warning lines for the context-pack builder: for every UNRESOLVED
 * tension whose subject pair intersects `itemIds`, one line naming the
 * tension and the injected subject(s) it touches. Dismissed and resolved
 * tensions contribute nothing. Returns `[]` when no vault tension matches,
 * so a tension-free vault keeps the pack output byte-identical.
 */
export function tensionWarningsForContextItems(
  vault: string,
  itemIds: ReadonlyArray<string>,
): string[] {
  const ids = new Set(itemIds);
  const out: string[] = [];
  for (const tension of listUnresolvedTensions(vault)) {
    const touched: string[] = [];
    if (ids.has(tension.subjectA)) touched.push(tension.subjectA);
    if (ids.has(tension.subjectB)) touched.push(tension.subjectB);
    if (touched.length === 0) continue;
    out.push(
      `unresolved tension [[${tension.id}]] (${tension.status}) involves injected memory ` +
        touched.join(", "),
    );
  }
  return out;
}

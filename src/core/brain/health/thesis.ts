/**
 * Declared-thesis register with a new-note support/contradiction monitor (D3).
 *
 * The operator records STANDING POSITIONS - a statement, a supporting- and
 * counter-evidence summary, a review cadence, and a falsification field
 * ("what would make me wrong"). Each thesis is a Markdown page under
 * `Brain/theses/thesis-<slug>.md`: operator-readable in Obsidian,
 * greppable, versionable - mirroring the `obligations.ts` page model.
 *
 * The monitor evaluates each newly-ingested note against the ACTIVE
 * theses and raises one of three flags, all `ask_user` (never
 * auto-resolved):
 *
 *   - `contradict` - the note asserts the OPPOSITE stance on the thesis
 *     subject. This is note-vs-declared-position, distinct from D2's
 *     note-vs-note detector, but built on the same structural,
 *     language-agnostic stance derivation (a negation marker among the
 *     note's tokens flips its sign).
 *   - `support`    - the note closely restates the thesis's own claim
 *     (same stance AND high token overlap). A same-subject same-stance
 *     note that merely ADDS COMPLEXITY (overlap below the support
 *     threshold) is deliberately suppressed, per the article ("Don't flag
 *     things that merely add complexity").
 *   - `falsification` - the note's prose matches the thesis's documented
 *     failure scenario (high coverage of the falsification's DISTINCTIVE
 *     tokens - those not already in the statement). The article's "flag it
 *     when live data starts matching the failure scenario you described".
 *
 * Two lifecycle checks reuse the shared cadence machinery:
 *   - {@link detectStaleTheses} flags an active thesis whose `last_updated`
 *     is past its cadence's next-due date (via `obligations.ts`
 *     `nextDueDate`).
 *   - {@link detectThesisGraveyard} flags an active thesis with no
 *     supporting evidence in the last N days (mirroring `stale-claim.ts`),
 *     suggesting a formal close.
 *
 * The kernel never calls a model: stance, overlap, and cadence arithmetic
 * are pure and deterministic, so the same inputs yield the same findings
 * on every Syncthing peer.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatter, slugify } from "../../vault.ts";
import { nextDueDate, parseCadence, type ObligationCadence } from "../obligations.ts";
import { thesesDir, thesisPath, validateIsoDate } from "../paths.ts";
import { isoDate, isoSecond } from "../time.ts";
import { type BrainSignalSign } from "../types.ts";
import {
  DEFAULT_NEGATION_MARKERS,
  deriveNoteStance,
  extractSpan,
  type NoteForContradiction,
} from "./contradiction.ts";
import { jaccard, tokenise } from "../similarity.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A thesis is either an active standing position or formally closed. */
export const THESIS_STATUS = {
  active: "active",
  closed: "closed",
} as const;
export type ThesisStatus = (typeof THESIS_STATUS)[keyof typeof THESIS_STATUS];

export class ThesisError extends Error {}

export interface ThesisPage {
  readonly slug: string;
  /** The declared position, quoted verbatim when a finding cites it. */
  readonly statement: string;
  readonly supportingEvidence: string;
  readonly counterEvidence: string;
  /** "What would make me wrong" - the documented failure scenario. */
  readonly falsification: string;
  readonly status: ThesisStatus;
  /** Review cadence driving the staleness check. */
  readonly cadence: ObligationCadence;
  readonly createdAt: string;
  /** Last time the operator revised the thesis (`YYYY-MM-DD`). */
  readonly lastUpdated: string;
  /** Last time supporting evidence landed, or null if never. */
  readonly lastSupportAt: string | null;
  readonly agent: string;
  readonly notes: string;
  readonly path: string;
}

export interface RecordThesisInput {
  readonly statement: string;
  readonly supportingEvidence?: string;
  readonly counterEvidence?: string;
  readonly falsification?: string;
  /** Review cadence; defaults to `monthly`. */
  readonly cadence?: string;
  readonly agent: string;
  readonly notes?: string;
  /** Overrides `last_updated` (defaults to today, UTC). */
  readonly lastUpdated?: string;
  /** Seeds `last_support_at` (defaults to null). */
  readonly lastSupportAt?: string;
  readonly now?: Date;
}

export interface UpdateThesisInput {
  readonly slug: string;
  readonly statement?: string;
  readonly supportingEvidence?: string;
  readonly counterEvidence?: string;
  readonly falsification?: string;
  readonly cadence?: string;
  readonly notes?: string;
  readonly now?: Date;
}

// ----- Body-section (de)serialization --------------------------------------
//
// The statement and the machine fields live in frontmatter; the free-form
// prose fields live as body sections so multi-line operator notes survive a
// round-trip without straining the flat frontmatter parser.

const SECTION_SUPPORTING = "Supporting evidence";
const SECTION_COUNTER = "Counter-evidence";
const SECTION_FALSIFICATION = "Falsification";
const SECTION_NOTES = "Notes";

function renderBody(
  page: Pick<ThesisPage, "supportingEvidence" | "counterEvidence" | "falsification" | "notes">,
): string {
  const sections: Array<[string, string]> = [
    [SECTION_SUPPORTING, page.supportingEvidence],
    [SECTION_COUNTER, page.counterEvidence],
    [SECTION_FALSIFICATION, page.falsification],
    [SECTION_NOTES, page.notes],
  ];
  const parts: string[] = [];
  for (const [header, content] of sections) {
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;
    parts.push(`## ${header}\n\n${trimmed}`);
  }
  return parts.join("\n\n");
}

/** Split a rendered body back into its `## `-headed sections. */
function parseSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split("\n");
  let header: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (header !== null) out.set(header, buffer.join("\n").trim());
    buffer = [];
  };
  for (const line of lines) {
    const match = /^##\s+(.*)$/u.exec(line.trim());
    if (match) {
      flush();
      header = match[1]!.trim();
    } else if (header !== null) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

function render(page: Omit<ThesisPage, "path">): string {
  const lines = [
    "---",
    `statement: ${JSON.stringify(page.statement)}`,
    `status: ${page.status}`,
    `cadence: ${page.cadence}`,
    `created_at: ${page.createdAt}`,
    `last_updated: ${page.lastUpdated}`,
    `last_support_at: ${page.lastSupportAt ?? ""}`,
    `agent: ${JSON.stringify(page.agent)}`,
    "---",
    "",
    renderBody(page),
    "",
  ];
  return lines.join("\n");
}

function parseIsoOrEmpty(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return validateIsoDate(value.trim());
  } catch {
    return "";
  }
}

function parseStatus(raw: unknown): ThesisStatus {
  return raw === THESIS_STATUS.closed ? THESIS_STATUS.closed : THESIS_STATUS.active;
}

function parsePage(vault: string, slug: string): ThesisPage | null {
  const path = thesisPath(vault, slug);
  if (!existsSync(path)) return null;
  const [meta, body] = parseFrontmatter(path);
  let cadence: ObligationCadence;
  try {
    cadence = parseCadence(typeof meta["cadence"] === "string" ? meta["cadence"] : "");
  } catch {
    cadence = "monthly";
  }
  const sections = parseSections(body);
  const lastSupport = parseIsoOrEmpty(meta["last_support_at"]);
  return Object.freeze({
    slug,
    statement: typeof meta["statement"] === "string" ? meta["statement"] : "",
    supportingEvidence: sections.get(SECTION_SUPPORTING) ?? "",
    counterEvidence: sections.get(SECTION_COUNTER) ?? "",
    falsification: sections.get(SECTION_FALSIFICATION) ?? "",
    status: parseStatus(meta["status"]),
    cadence,
    createdAt: typeof meta["created_at"] === "string" ? meta["created_at"] : "",
    lastUpdated: parseIsoOrEmpty(meta["last_updated"]),
    lastSupportAt: lastSupport.length > 0 ? lastSupport : null,
    agent: typeof meta["agent"] === "string" ? meta["agent"] : "",
    notes: sections.get(SECTION_NOTES) ?? "",
    path,
  });
}

/** Create a declared-thesis page. Refuses to clobber an existing slug. */
export function recordThesis(vault: string, input: RecordThesisInput): ThesisPage {
  const statement = input.statement.trim();
  if (statement.length === 0) throw new ThesisError("thesis statement must not be empty");
  const cadence = parseCadence(input.cadence ?? "monthly");
  const now = input.now ?? new Date();
  const slug = slugify(statement);
  if (existsSync(thesisPath(vault, slug))) {
    throw new ThesisError(`thesis already exists: ${slug} (remove it first to recreate)`);
  }
  const page = {
    slug,
    statement,
    supportingEvidence: (input.supportingEvidence ?? "").trim(),
    counterEvidence: (input.counterEvidence ?? "").trim(),
    falsification: (input.falsification ?? "").trim(),
    status: THESIS_STATUS.active,
    cadence,
    createdAt: isoSecond(now),
    lastUpdated: input.lastUpdated ? validateIsoDate(input.lastUpdated) : isoDate(now),
    lastSupportAt: input.lastSupportAt ? validateIsoDate(input.lastSupportAt) : null,
    agent: input.agent,
    notes: (input.notes ?? "").trim(),
  };
  mkdirSync(thesesDir(vault), { recursive: true });
  const path = thesisPath(vault, slug);
  atomicWriteFileSync(path, render(page));
  return Object.freeze({ ...page, path });
}

/** Revise a thesis; bumps `last_updated` to now (or the injected clock). */
export function updateThesis(vault: string, input: UpdateThesisInput): ThesisPage {
  const slug = slugify(input.slug);
  const prior = parsePage(vault, slug);
  if (prior === null) throw new ThesisError(`no thesis: ${slug}`);
  const now = input.now ?? new Date();
  const page = {
    slug: prior.slug,
    statement: input.statement?.trim() || prior.statement,
    supportingEvidence:
      input.supportingEvidence !== undefined
        ? input.supportingEvidence.trim()
        : prior.supportingEvidence,
    counterEvidence:
      input.counterEvidence !== undefined ? input.counterEvidence.trim() : prior.counterEvidence,
    falsification:
      input.falsification !== undefined ? input.falsification.trim() : prior.falsification,
    status: prior.status,
    cadence: input.cadence ? parseCadence(input.cadence) : prior.cadence,
    createdAt: prior.createdAt,
    lastUpdated: isoDate(now),
    lastSupportAt: prior.lastSupportAt,
    agent: prior.agent,
    notes: input.notes !== undefined ? input.notes.trim() : prior.notes,
  };
  atomicWriteFileSync(prior.path, render(page));
  return Object.freeze({ ...page, path: prior.path });
}

/**
 * Record that supporting evidence landed for a thesis: advances
 * `last_support_at` (resetting the graveyard clock) and `last_updated`.
 */
export function recordThesisSupport(
  vault: string,
  slug: string,
  opts: { date?: string; now?: Date } = {},
): ThesisPage {
  const normalized = slugify(slug);
  const prior = parsePage(vault, normalized);
  if (prior === null) throw new ThesisError(`no thesis: ${normalized}`);
  const now = opts.now ?? new Date();
  const date = opts.date ? validateIsoDate(opts.date) : isoDate(now);
  const page = { ...prior, lastSupportAt: date, lastUpdated: isoDate(now) };
  const { path: _path, ...rest } = page;
  atomicWriteFileSync(prior.path, render(rest));
  return Object.freeze(page);
}

/** Formally close a thesis (the graveyard's recommended action). */
export function closeThesis(vault: string, slug: string): ThesisPage {
  const normalized = slugify(slug);
  const prior = parsePage(vault, normalized);
  if (prior === null) throw new ThesisError(`no thesis: ${normalized}`);
  const page = { ...prior, status: THESIS_STATUS.closed };
  const { path: _path, ...rest } = page;
  atomicWriteFileSync(prior.path, render(rest));
  return Object.freeze(page);
}

/** One thesis, or null. */
export function showThesis(vault: string, slug: string): ThesisPage | null {
  return parsePage(vault, slugify(slug));
}

/** All theses sorted by slug; optionally only the active ones. */
export function listTheses(vault: string, options: { activeOnly?: boolean } = {}): ThesisPage[] {
  const dir = thesesDir(vault);
  if (!existsSync(dir)) return [];
  const out: ThesisPage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || !name.startsWith("thesis-")) continue;
    const slug = name.replace(/^thesis-/u, "").replace(/\.md$/u, "");
    const page = parsePage(vault, slug);
    if (page === null) continue;
    if (options.activeOnly && page.status !== THESIS_STATUS.active) continue;
    out.push(page);
  }
  return out.toSorted((a, b) => a.slug.localeCompare(b.slug));
}

// ----- Monitor: new note vs declared positions -----------------------------

/**
 * Narrow projection the monitor needs. A full {@link ThesisPage}
 * satisfies it structurally, so callers pass parsed pages directly.
 */
export interface ThesisForMonitor {
  readonly slug: string;
  readonly status: ThesisStatus;
  readonly statement: string;
  readonly falsification?: string;
}

export type ThesisFindingKind = "support" | "contradict" | "falsification";

export interface ThesisNoteFinding {
  readonly thesisSlug: string;
  readonly noteId: string;
  readonly kind: ThesisFindingKind;
  /**
   * The deciding metric: subject jaccard for support/contradict, or the
   * distinctive-token coverage for falsification.
   */
  readonly score: number;
  readonly thesisStance: BrainSignalSign;
  readonly noteStance: BrainSignalSign;
  /** The declared position (or its failure scenario) quoted verbatim. */
  readonly thesisQuote: string;
  /** The subject-bearing span quoted verbatim from the incoming note. */
  readonly noteQuote: string;
  /** Always `ask_user`: findings are surfaced, never auto-resolved. */
  readonly action: "ask_user";
}

export interface MonitorThesesOptions {
  /** Minimum statement-vs-note jaccard for the note to address the thesis. */
  readonly subjectJaccard?: number;
  /** Jaccard at/above which a same-stance note counts as SUPPORT. */
  readonly supportJaccard?: number;
  /** Coverage of the falsification's distinctive tokens that raises an alert. */
  readonly falsificationCoverage?: number;
  /** Negation markers for structural stance derivation (mirrors D2). */
  readonly negationMarkers?: ReadonlySet<string>;
}

const DEFAULT_SUBJECT_JACCARD = 0.3;
const DEFAULT_SUPPORT_JACCARD = 0.6;
const DEFAULT_FALSIFICATION_COVERAGE = 0.6;

/** Directional coverage: fraction of `needle` tokens present in `haystack`. */
function coverage(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  let hits = 0;
  for (const t of needle) if (haystack.has(t)) hits++;
  return hits / needle.size;
}

/**
 * Evaluate every note against every ACTIVE thesis, returning support /
 * contradiction / falsification findings. Deterministic and
 * language-agnostic (stance derived structurally from an injected marker
 * set). Never auto-resolves - all findings carry `action: "ask_user"`.
 */
export function monitorNotesAgainstTheses(
  theses: ReadonlyArray<ThesisForMonitor>,
  notes: ReadonlyArray<NoteForContradiction>,
  opts: MonitorThesesOptions = {},
): ThesisNoteFinding[] {
  const subjectJaccard = opts.subjectJaccard ?? DEFAULT_SUBJECT_JACCARD;
  const supportJaccard = opts.supportJaccard ?? DEFAULT_SUPPORT_JACCARD;
  const falsificationCoverage = opts.falsificationCoverage ?? DEFAULT_FALSIFICATION_COVERAGE;
  const markers = opts.negationMarkers ?? DEFAULT_NEGATION_MARKERS;

  const out: ThesisNoteFinding[] = [];
  for (const thesis of theses) {
    if (thesis.status !== THESIS_STATUS.active) continue;
    const statement = thesis.statement.trim();
    if (statement.length === 0) continue;
    const stmtTokens = tokenise(statement);
    if (stmtTokens.size === 0) continue;
    const thesisStance = deriveNoteStance(stmtTokens, markers);

    // Distinctive falsification tokens: those NOT already in the statement,
    // so the failure-scenario match cannot be triggered by generic subject
    // overlap.
    const falsification = (thesis.falsification ?? "").trim();
    const falsTokens = falsification.length > 0 ? tokenise(falsification) : new Set<string>();
    const distinctive = new Set<string>();
    for (const t of falsTokens) if (!stmtTokens.has(t)) distinctive.add(t);

    for (const note of notes) {
      // 1) Falsification: does the note match the documented failure scenario?
      if (distinctive.size > 0) {
        const falsSpan = extractSpan(note.text, falsTokens);
        const cov = coverage(distinctive, tokenise(falsSpan));
        if (cov >= falsificationCoverage) {
          out.push({
            thesisSlug: thesis.slug,
            noteId: note.id,
            kind: "falsification",
            score: cov,
            thesisStance,
            noteStance: deriveNoteStance(tokenise(falsSpan), markers),
            thesisQuote: falsification,
            noteQuote: falsSpan,
            action: "ask_user",
          });
          continue;
        }
      }

      // 2) Support / contradiction over the subject-bearing span.
      const span = extractSpan(note.text, stmtTokens);
      const spanTokens = tokenise(span);
      const subj = jaccard(stmtTokens, spanTokens);
      if (subj < subjectJaccard) continue;
      const noteStance = deriveNoteStance(spanTokens, markers);
      const base = {
        thesisSlug: thesis.slug,
        noteId: note.id,
        score: subj,
        thesisStance,
        noteStance,
        thesisQuote: statement,
        noteQuote: span,
        action: "ask_user" as const,
      };
      if (noteStance !== thesisStance) {
        out.push({ ...base, kind: "contradict" });
      } else if (subj >= supportJaccard) {
        out.push({ ...base, kind: "support" });
      }
      // Same stance below the support threshold merely adds complexity:
      // deliberately not flagged (per the article).
    }
  }

  out.sort(
    (x, y) =>
      x.thesisSlug.localeCompare(y.thesisSlug) ||
      x.noteId.localeCompare(y.noteId) ||
      x.kind.localeCompare(y.kind),
  );
  return out;
}

// ----- Lifecycle checks -----------------------------------------------------

export interface ThesisForStaleness {
  readonly slug: string;
  readonly status: ThesisStatus;
  readonly cadence: ObligationCadence;
  readonly lastUpdated: string;
}

export interface StaleThesisFinding {
  readonly slug: string;
  readonly lastUpdated: string;
  /** Next-due date derived from the cadence; already in the past. */
  readonly nextDue: string;
  readonly cadence: ObligationCadence;
}

/**
 * Flag active theses whose `last_updated` is past their cadence's next-due
 * date. Reuses `obligations.ts` `nextDueDate` for the cadence arithmetic.
 * Closed theses and those with an unparseable `last_updated` are skipped.
 */
export function detectStaleTheses(
  theses: ReadonlyArray<ThesisForStaleness>,
  opts: { now: Date },
): StaleThesisFinding[] {
  const today = isoDate(opts.now);
  const out: StaleThesisFinding[] = [];
  for (const t of theses) {
    if (t.status !== THESIS_STATUS.active) continue;
    let nextDue: string;
    try {
      nextDue = nextDueDate(t.cadence, t.lastUpdated);
    } catch {
      continue;
    }
    if (nextDue >= today) continue;
    out.push({ slug: t.slug, lastUpdated: t.lastUpdated, nextDue, cadence: t.cadence });
  }
  out.sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.slug.localeCompare(b.slug));
  return out;
}

export interface ThesisForGraveyard {
  readonly slug: string;
  readonly status: ThesisStatus;
  readonly createdAt: string;
  readonly lastSupportAt: string | null;
}

export interface GraveyardThesisFinding {
  readonly slug: string;
  /** The date support was last seen (or null → measured from `createdAt`). */
  readonly lastSupportAt: string | null;
  readonly ageDays: number;
  /** The recommended action; the operator confirms - never auto-applied. */
  readonly suggestion: "close";
}

function parseIsoUtc(value: string): number {
  const iso = ISO_DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
  return Date.parse(iso);
}

/**
 * Flag active theses with no supporting evidence in the last
 * `maxAgeDays` (the "thesis graveyard" pass). A thesis that never had
 * supporting evidence is measured from `createdAt`. Mirrors
 * `stale-claim.ts`; deterministic with an injected clock.
 */
export function detectThesisGraveyard(
  theses: ReadonlyArray<ThesisForGraveyard>,
  opts: { maxAgeDays: number; now: Date },
): GraveyardThesisFinding[] {
  const nowMs = opts.now.getTime();
  const out: GraveyardThesisFinding[] = [];
  for (const t of theses) {
    if (t.status !== THESIS_STATUS.active) continue;
    const anchor = t.lastSupportAt ?? t.createdAt;
    const anchorMs = parseIsoUtc(anchor);
    if (!Number.isFinite(anchorMs)) continue;
    const ageDays = Math.floor((nowMs - anchorMs) / DAY_MS);
    if (ageDays <= opts.maxAgeDays) continue;
    out.push({ slug: t.slug, lastSupportAt: t.lastSupportAt, ageDays, suggestion: "close" });
  }
  out.sort((a, b) => b.ageDays - a.ageDays || a.slug.localeCompare(b.slug));
  return out;
}

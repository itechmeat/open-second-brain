/**
 * Deterministic memory-graph repair lane (G1, t_6832aac6).
 *
 * The lane proposes and (on explicit apply) writes missing edges into the
 * durable-memory link graph. It is deliberately CLI-first, not a dream phase:
 * dry-run is the default and writes nothing; apply requires an exact
 * confirmation phrase.
 *
 * Determinism and safety invariants:
 *   - candidates are ordered by identity strength (explicit references, then
 *     session continuity, then same-topic evidence, then opt-in inferred),
 *     with confidence and the edge endpoints breaking ties;
 *   - a confidence threshold and a hard per-run write cap are named constants;
 *   - the lane never creates a dangling edge: a candidate whose endpoint does
 *     not resolve to a durable-memory note is skipped, so the graph-efficacy
 *     holdout gate stays satisfiable;
 *   - a forward scan past existing edges (seeded from the note's current
 *     wikilinks and grown as the run writes) makes a rerun after apply
 *     converge to zero writes.
 *
 * Reads only link structure and the caller-supplied candidates; there is no
 * natural-language word list anywhere in the lane.
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { canonicalNotePath, ensureInsideVault } from "../../path-safety.ts";
import {
  EXCLUDED_DIRS,
  extractWikilinks,
  listVaultPages,
  parseFrontmatter,
  writeFrontmatterAtomic,
} from "../../vault.ts";
import { listContinuityRecords } from "../continuity/store.ts";
import { canonicalCoOccurrenceKey, computeCoOccurrenceSuggestions } from "./co-occurrence.ts";

/** Identity-strength tiers, strongest first. `inferred` is opt-in. */
export const IDENTITY_STRENGTH = Object.freeze({
  explicitReference: "explicit_reference",
  sessionContinuity: "session_continuity",
  sameTopicEvidence: "same_topic_evidence",
  inferred: "inferred",
} as const);

export type IdentityStrength = (typeof IDENTITY_STRENGTH)[keyof typeof IDENTITY_STRENGTH];

/** Ordering rank per tier (lower = stronger). */
const STRENGTH_RANK: Readonly<Record<IdentityStrength, number>> = Object.freeze({
  explicit_reference: 0,
  session_continuity: 1,
  same_topic_evidence: 2,
  inferred: 3,
});

/** Minimum confidence for a candidate to be written. */
export const REPAIR_CONFIDENCE_THRESHOLD = 0.5;

/** Hard cap on edges written in a single run. */
export const REPAIR_WRITE_CAP = 25;

/** Exact phrase an apply must supply as confirmation. */
export const REPAIR_CONFIRM_PHRASE = "apply repair";

/** Heading under which repaired edges are appended, for auditability. */
const REPAIR_SECTION_HEADING = "## Related (repair-lane)";

/** One proposed edge between two durable-memory notes. */
export interface RepairCandidate {
  /** Vault-relative path of the note that gains the edge. */
  readonly source: string;
  /** Vault-relative path of the linked note. */
  readonly target: string;
  readonly strength: IdentityStrength;
  readonly confidence: number;
  /** Structural reason the candidate was proposed. */
  readonly reason: string;
}

export type RepairAction =
  | "write"
  | "skip-existing"
  | "skip-threshold"
  | "skip-inferred"
  | "skip-cap"
  | "skip-missing-source"
  | "skip-missing-target";

export interface RepairDecision extends RepairCandidate {
  readonly action: RepairAction;
}

export interface RepairReport {
  readonly mode: "dry-run" | "apply";
  /** Count of edges written (or, in dry-run, that would be written). */
  readonly written: number;
  readonly decisions: readonly RepairDecision[];
}

export interface RepairLaneOptions {
  /** Apply the writes. Default false (dry-run). */
  readonly apply?: boolean;
  /** Exact confirmation phrase; required when `apply` is true. */
  readonly confirm?: string;
  /** Include opt-in inferred candidates. Default false. */
  readonly includeInferred?: boolean;
  /** Confidence threshold override. Defaults to {@link REPAIR_CONFIDENCE_THRESHOLD}. */
  readonly confidenceThreshold?: number;
  /** Per-run write cap override. Defaults to {@link REPAIR_WRITE_CAP}. */
  readonly writeCap?: number;
}

/** Raised when an apply is requested without the exact confirmation phrase. */
export class RepairConfirmationError extends Error {
  constructor() {
    super(
      `repair apply requires the exact confirmation phrase: ${JSON.stringify(REPAIR_CONFIRM_PHRASE)}`,
    );
    this.name = "RepairConfirmationError";
  }
}

function orderCandidates(candidates: readonly RepairCandidate[]): RepairCandidate[] {
  return [...candidates].toSorted((a, b) => {
    const rank = STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
    if (rank !== 0) return rank;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
}

function noteAbsPath(vault: string, rel: string): string {
  return ensureInsideVault(join(vault, rel), vault);
}

/** Canonical identity key for an edge endpoint (basename, no ext, lowercased). */
function endpointKey(rel: string): string | null {
  return canonicalCoOccurrenceKey(rel);
}

/** Existing outgoing edge keys of a note, read from its current wikilinks. */
function existingEdgeKeys(abs: string): Set<string> {
  const keys = new Set<string>();
  try {
    const [, body] = parseFrontmatter(abs);
    for (const raw of extractWikilinks(body)) {
      const key = endpointKey(raw);
      if (key !== null) keys.add(key);
    }
  } catch {
    // Unreadable notes contribute no edges; the source-existence check above
    // already guards the apply path.
  }
  return keys;
}

function appendEdge(abs: string, target: string): void {
  const [meta, body] = parseFrontmatter(abs);
  const link = `- [[${canonicalNotePath(target)}]]`;
  const hasSection = body.includes(REPAIR_SECTION_HEADING);
  const trimmed = body.replace(/\s+$/u, "");
  const nextBody = hasSection
    ? `${trimmed}\n${link}\n`
    : `${trimmed}\n\n${REPAIR_SECTION_HEADING}\n\n${link}\n`;
  writeFrontmatterAtomic(abs, meta, nextBody, { overwrite: true });
}

/**
 * Run the repair lane over `candidates`. Orders by identity strength, gates on
 * the confidence threshold and the write cap, refuses to create dangling
 * edges, and (only on a confirmed apply) writes each accepted edge.
 */
export function runRepairLane(
  vault: string,
  candidates: readonly RepairCandidate[],
  opts: RepairLaneOptions = {},
): RepairReport {
  const apply = opts.apply === true;
  if (apply && opts.confirm !== REPAIR_CONFIRM_PHRASE) {
    throw new RepairConfirmationError();
  }

  const threshold = opts.confidenceThreshold ?? REPAIR_CONFIDENCE_THRESHOLD;
  const writeCap = Math.max(0, Math.floor(opts.writeCap ?? REPAIR_WRITE_CAP));

  // Per-source set of edge keys already present or written this run. The
  // forward scan reads existing links once per source, then grows the set as
  // it writes, so a duplicate candidate later in the run is skip-existing and
  // a full rerun after apply converges to zero writes.
  const linkedBySource = new Map<string, Set<string>>();
  const decisions: RepairDecision[] = [];
  let written = 0;

  for (const candidate of orderCandidates(candidates)) {
    const decide = (action: RepairAction): void => {
      decisions.push({ ...candidate, action });
    };

    if (candidate.strength === IDENTITY_STRENGTH.inferred && opts.includeInferred !== true) {
      decide("skip-inferred");
      continue;
    }
    if (candidate.confidence < threshold) {
      decide("skip-threshold");
      continue;
    }

    const sourceAbs = noteAbsPath(vault, candidate.source);
    if (!existsSync(sourceAbs)) {
      decide("skip-missing-source");
      continue;
    }
    const targetAbs = noteAbsPath(vault, candidate.target);
    if (!existsSync(targetAbs)) {
      decide("skip-missing-target");
      continue;
    }

    let linked = linkedBySource.get(candidate.source);
    if (linked === undefined) {
      linked = existingEdgeKeys(sourceAbs);
      linkedBySource.set(candidate.source, linked);
    }
    const targetKey = endpointKey(candidate.target);
    if (targetKey !== null && linked.has(targetKey)) {
      decide("skip-existing");
      continue;
    }

    if (written >= writeCap) {
      decide("skip-cap");
      continue;
    }

    if (apply) appendEdge(sourceAbs, candidate.target);
    if (targetKey !== null) linked.add(targetKey);
    written += 1;
    decide("write");
  }

  return {
    mode: apply ? "apply" : "dry-run",
    written,
    decisions: Object.freeze(decisions),
  };
}

// ----- Candidate collection from vault structure ----------------------------
//
// The default lane draws candidates from structural signals only: explicit
// references (a note textually names another note without linking it), session
// continuity (two notes co-referenced in one recorded session event), and
// same-topic evidence (co-occurrence over shared references). Inferred
// candidates are NOT collected here - they require a similarity model and are
// opt-in at the lane, kept out of the deterministic default.

/** Confidence assigned to an explicit textual reference (strongest signal). */
export const EXPLICIT_REFERENCE_CONFIDENCE = 0.9;
/** Base confidence for a session-continuity co-reference. */
export const SESSION_CONTINUITY_BASE_CONFIDENCE = 0.6;
/** Ceiling for scaled confidences below the explicit tier. */
const CONFIDENCE_CEILING = 0.85;

const CODE_SPAN_RE = /```[\s\S]*?```|`[^`]+`/g;
const WIKILINK_SPAN_RE = /\[\[[^\]\n]+\]\]/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(CONFIDENCE_CEILING, Math.round(value * 1000) / 1000));
}

function pairId(source: string, target: string): string {
  return `${source} ${target}`;
}

/** Mask wikilink and code spans so a mention inside them is not counted. */
function maskSpans(text: string): string {
  return text
    .replace(CODE_SPAN_RE, (s) => " ".repeat(s.length))
    .replace(WIKILINK_SPAN_RE, (s) => " ".repeat(s.length));
}

function isWordEdge(ch: string | undefined): boolean {
  return ch === undefined || !WORD_CHAR_RE.test(ch);
}

/** True when `term` occurs in `masked` at a word boundary (case-insensitive). */
function mentionsTerm(masked: string, term: string): boolean {
  if (term.length < 2) return false;
  const lower = masked.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx > 0 ? masked[idx - 1] : undefined;
    const after = masked[idx + needle.length];
    if (isWordEdge(before) && isWordEdge(after)) return true;
    from = idx + needle.length;
  }
}

interface CollectedPage {
  readonly rel: string;
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly linkedKeys: ReadonlySet<string>;
}

function loadPages(vault: string): CollectedPage[] {
  const out: CollectedPage[] = [];
  for (const page of listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS] })) {
    const rel = canonicalNotePath(relative(vault, page.path));
    const key = canonicalCoOccurrenceKey(rel);
    if (key === null) continue;
    let body = "";
    try {
      [, body] = parseFrontmatter(page.path);
    } catch {
      body = "";
    }
    const linkedKeys = new Set<string>();
    for (const raw of extractWikilinks(body)) {
      const k = canonicalCoOccurrenceKey(raw);
      if (k !== null) linkedKeys.add(k);
    }
    out.push({ rel, key, title: page.title, body, linkedKeys });
  }
  return out;
}

export interface CollectRepairCandidatesOptions {
  /** Minimum co-referencing notes for a same-topic candidate. Default 2. */
  readonly minCoDocuments?: number;
}

/**
 * Collect deterministic repair candidates from vault structure. Never emits an
 * edge that already exists, and never emits inferred candidates.
 */
export function collectRepairCandidates(
  vault: string,
  opts: CollectRepairCandidatesOptions = {},
): RepairCandidate[] {
  const pages = loadPages(vault);
  const byKey = new Map<string, CollectedPage>();
  for (const page of pages) byKey.set(page.key, page);

  const best = new Map<string, RepairCandidate>();
  const consider = (candidate: RepairCandidate): void => {
    if (candidate.source === candidate.target) return;
    const id = pairId(candidate.source, candidate.target);
    const existing = best.get(id);
    if (
      existing === undefined ||
      STRENGTH_RANK[candidate.strength] < STRENGTH_RANK[existing.strength]
    ) {
      best.set(id, candidate);
    }
  };

  // Explicit references: a note names another note's title but does not link it.
  for (const page of pages) {
    const masked = maskSpans(page.body);
    for (const other of pages) {
      if (other.key === page.key) continue;
      if (page.linkedKeys.has(other.key)) continue;
      if (!mentionsTerm(masked, other.title)) continue;
      consider({
        source: page.rel,
        target: other.rel,
        strength: IDENTITY_STRENGTH.explicitReference,
        confidence: EXPLICIT_REFERENCE_CONFIDENCE,
        reason: `explicit textual reference to ${JSON.stringify(other.title)}`,
      });
    }
  }

  // Session continuity: notes co-referenced in one recorded session event.
  for (const record of listContinuityRecords(vault)) {
    const paths = [
      ...new Set(
        record.sourceRefs
          .map((ref) => ref.path)
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .map((p) => canonicalNotePath(p)),
      ),
    ].toSorted();
    if (paths.length < 2) continue;
    const confidence = clampConfidence(
      SESSION_CONTINUITY_BASE_CONFIDENCE + 0.05 * (paths.length - 2),
    );
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const source = paths[i]!;
        const target = paths[j]!;
        const sourceKey = canonicalCoOccurrenceKey(source);
        const targetKey = canonicalCoOccurrenceKey(target);
        if (sourceKey !== null && byKey.get(sourceKey)?.linkedKeys.has(targetKey ?? "")) continue;
        consider({
          source,
          target,
          strength: IDENTITY_STRENGTH.sessionContinuity,
          confidence,
          reason: `co-referenced with ${JSON.stringify(target)} in one session event`,
        });
      }
    }
  }

  // Same-topic evidence: co-occurrence over shared references (undirected).
  const cooccurrence = computeCoOccurrenceSuggestions(
    vault,
    opts.minCoDocuments !== undefined ? { minCoDocuments: opts.minCoDocuments } : {},
  );
  for (const suggestion of cooccurrence.suggestions) {
    const left = byKey.get(suggestion.left);
    const right = byKey.get(suggestion.right);
    if (left === undefined || right === undefined) continue;
    if (left.linkedKeys.has(right.key) || right.linkedKeys.has(left.key)) continue;
    consider({
      source: left.rel,
      target: right.rel,
      strength: IDENTITY_STRENGTH.sameTopicEvidence,
      confidence: clampConfidence(0.5 + 0.05 * suggestion.coDocumentCount),
      reason: `co-occurs across ${suggestion.coDocumentCount} notes`,
    });
  }

  return orderCandidates([...best.values()]);
}

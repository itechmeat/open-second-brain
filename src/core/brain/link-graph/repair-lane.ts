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
import { ENTITY_STATUS_SCOPE, vaultPageInStatusScope } from "../entities/page-scope.ts";
import { canonicalCoOccurrenceKey, computeCoOccurrenceSuggestions } from "./co-occurrence.ts";
import { listAliasClaims } from "./alias-index.ts";
import { resolveUniqueMatch } from "../../graph/unique-match.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { scaffoldStub } from "../notes/scaffold-stub.ts";
import { MAINTENANCE_LANE_REACH } from "../../graph/transport-reach.ts";

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
  | "skip-missing-target"
  | "skip-unsafe-path"
  | "skip-null-endpoint-key"
  | "skip-ambiguous";

export interface RepairDecision extends RepairCandidate {
  readonly action: RepairAction;
}

export interface RepairReport {
  readonly mode: "dry-run" | "apply";
  /** Count of edges written (or, in dry-run, that would be written). */
  readonly written: number;
  readonly decisions: readonly RepairDecision[];
  /**
   * Vault-relative paths of stub notes this run materialised, sorted.
   *
   * Always empty unless the caller opted in AND this is an apply. The
   * lane's premise is that it never creates a dangling edge; before B3
   * the only way to honour that was `skip-missing-target`, which left the
   * operator with a report and no verb. Scaffolding is the other way to
   * honour it, and it is opt-in precisely because "the repair pass also
   * created eleven notes" must never be something a run discovers
   * afterwards.
   */
  readonly scaffolded: ReadonlyArray<string>;
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
  /**
   * Materialise a stub for a candidate whose target does not exist,
   * instead of deciding `skip-missing-target` (B3). Default false, and
   * inert on a dry run: scaffolding must never be a side effect of a
   * repair pass.
   */
  readonly scaffoldMissingTargets?: boolean;
  /**
   * Named refusals collected upstream - today, the explicit-reference
   * collector's `skip-ambiguous` decisions for a mention term carried by
   * more than one corpus page. They are reported verbatim in `decisions`
   * (ordered by the candidate order) and nothing else: never re-decided
   * by the loop below, never counted in `written`, never capped. A
   * refusal proposes no edge, so it is the caller's job to keep it out
   * of any downstream population that reasoning over proposed edges.
   */
  readonly collectedRefusals?: ReadonlyArray<RepairDecision>;
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

function orderCandidates<T extends RepairCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].toSorted((a, b) => {
    const rank = STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
    if (rank !== 0) return rank;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
}

/** Absolute path of a note, or null when the candidate escapes the vault. */
function noteAbsPath(vault: string, rel: string): string | null {
  try {
    return ensureInsideVault(join(vault, rel), vault);
  } catch {
    return null;
  }
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
  // Vault-identity write guard (context-integrity-gates, Unit J).
  // A non-apply run reports decisions and writes nothing.
  if (apply) assertVaultIdentityForWrite(vault);

  const threshold = opts.confidenceThreshold ?? REPAIR_CONFIDENCE_THRESHOLD;
  const writeCap = Math.max(0, Math.floor(opts.writeCap ?? REPAIR_WRITE_CAP));

  // Per-source set of edge keys already present or written this run. The
  // forward scan reads existing links once per source, then grows the set as
  // it writes, so a duplicate candidate later in the run is skip-existing and
  // a full rerun after apply converges to zero writes.
  const linkedBySource = new Map<string, Set<string>>();
  const decisions: RepairDecision[] = [];
  const scaffolded: string[] = [];
  const scaffold = apply && opts.scaffoldMissingTargets === true;
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
    if (sourceAbs === null) {
      decide("skip-unsafe-path");
      continue;
    }
    if (!existsSync(sourceAbs)) {
      decide("skip-missing-source");
      continue;
    }
    const targetAbs = noteAbsPath(vault, candidate.target);
    if (targetAbs === null) {
      decide("skip-unsafe-path");
      continue;
    }
    if (!existsSync(targetAbs)) {
      // The default is unchanged and stays the default: a missing target
      // is a skip. Only an explicit opt-in on an apply run turns it into
      // a materialisation, and a scaffold that could not run falls back
      // to the skip rather than writing an edge to a note that still does
      // not exist.
      if (!scaffold || !scaffoldMissingTarget(vault, candidate.target, candidate.source)) {
        decide("skip-missing-target");
        continue;
      }
      scaffolded.push(candidate.target);
    }

    // A candidate with no canonical endpoint key cannot be deduped against
    // existing edges or tracked for idempotence, so a re-run would re-append
    // the same wikilink. Refuse it rather than write an untrackable edge.
    const targetKey = endpointKey(candidate.target);
    if (targetKey === null) {
      decide("skip-null-endpoint-key");
      continue;
    }

    let linked = linkedBySource.get(candidate.source);
    if (linked === undefined) {
      linked = existingEdgeKeys(sourceAbs);
      linkedBySource.set(candidate.source, linked);
    }
    if (linked.has(targetKey)) {
      decide("skip-existing");
      continue;
    }

    if (written >= writeCap) {
      decide("skip-cap");
      continue;
    }

    if (apply) appendEdge(sourceAbs, candidate.target);
    linked.add(targetKey);
    written += 1;
    decide("write");
  }

  return {
    mode: apply ? "apply" : "dry-run",
    written,
    decisions: Object.freeze([...orderCandidates(opts.collectedRefusals ?? []), ...decisions]),
    scaffolded: Object.freeze(scaffolded.toSorted()),
  };
}

/**
 * Materialise the stub for one missing target, reporting whether it now
 * exists.
 *
 * A refusal from the scaffolder - the target actually resolves, or names
 * several notes, or the path envelope rejects the destination - is
 * answered with `false`, so that candidate falls back to
 * `skip-missing-target` rather than one unscaffoldable endpoint aborting
 * a whole run. The fallback is not silent: the decision the caller reads
 * back is the same `skip-missing-target` it would have got with the
 * option off, and the path is absent from `scaffolded`.
 */
function scaffoldMissingTarget(vault: string, target: string, source: string): boolean {
  try {
    return (
      scaffoldStub(vault, { target, path: target, sources: [source], apply: true }).outcome !== null
    );
  } catch {
    return false;
  }
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
/**
 * Minimum note-title length for an explicit-reference match. Generic short
 * titles (two-letter tokens such as "AI" or "ML") occur in prose all over the
 * vault, so matching them would mass-generate spurious 0.9-confidence edges.
 * Requiring at least this many characters keeps the strongest tier specific.
 */
export const MIN_EXPLICIT_REFERENCE_TITLE_LENGTH = 4;
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
  return `${source}\0${target}`;
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

/** True when `needle` occurs in `masked` at a word boundary (case-insensitive).
 * `lower` is `masked` pre-lowercased, hoisted out of the per-term loop. */
function mentionsTerm(lower: string, masked: string, needle: string): boolean {
  if (needle.length < MIN_EXPLICIT_REFERENCE_TITLE_LENGTH) return false;
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

/**
 * Every page the repair lane may reason over.
 *
 * The walk covers `Brain/`, so entity pages are in it. A quarantined
 * record's title, body and links come from an untrusted source; proposing
 * repairs that cite them would put that source's text in front of the
 * operator as a suggestion.
 */
function loadPages(vault: string): CollectedPage[] {
  const out: CollectedPage[] = [];
  for (const page of listVaultPages(vault, {
    skipDirs: [...EXCLUDED_DIRS],
    reach: MAINTENANCE_LANE_REACH,
  })) {
    if (!vaultPageInStatusScope(page.metadata, ENTITY_STATUS_SCOPE.readable)) continue;
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

/** One mention term in the corpus pool: its scanned form, its display spelling, and every page carrying it. */
interface MentionTerm {
  /** NFC + lowercase form the word-boundary scan matches. */
  readonly needle: string;
  /** Spelling the reason strings name (the title, or the alias as indexed). */
  readonly display: string;
  /** The corpus pages carrying the term, one per path, ordered by path. */
  readonly carriers: ReadonlyArray<CollectedPage>;
}

/** Code-point order of two strings, for deterministic sorts. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalized lookup form of a term, exactly as the alias index keys its side. */
function termNeedle(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Pool the mention terms every corpus page carries: each page's title, plus
 * every page claiming each alias (`listAliasClaims`, never the first-wins
 * index, so a colliding alias reaches the exactly-one rule with all its
 * carriers). Titles register first, so a term spelled as a title keeps the
 * title as its display form; a claimant matching no corpus page contributes
 * nothing.
 */
function collectMentionTerms(pages: ReadonlyArray<CollectedPage>, vault: string): MentionTerm[] {
  // Carriers pool by path while terms register, so a page reached through
  // both its title and an alias carries a term once.
  const terms = new Map<
    string,
    {
      readonly needle: string;
      readonly display: string;
      readonly carriers: Map<string, CollectedPage>;
    }
  >();
  for (const page of pages) {
    const needle = termNeedle(page.title);
    if (needle.length === 0) continue;
    const existing = terms.get(needle);
    if (existing === undefined) {
      terms.set(needle, { needle, display: page.title, carriers: new Map([[page.rel, page]]) });
    } else {
      existing.carriers.set(page.rel, page);
    }
  }
  const byKey = new Map<string, CollectedPage[]>();
  for (const page of pages) {
    const bucket = byKey.get(page.key);
    if (bucket === undefined) byKey.set(page.key, [page]);
    else bucket.push(page);
  }
  for (const [aliasKey, canonicalIds] of listAliasClaims(vault)) {
    for (const canonicalId of canonicalIds) {
      const bucket = byKey.get(canonicalId.normalize("NFC").toLowerCase().trim());
      if (bucket === undefined) continue;
      const existing = terms.get(aliasKey);
      if (existing === undefined) {
        terms.set(aliasKey, {
          needle: aliasKey,
          display: aliasKey,
          carriers: new Map(bucket.map((page) => [page.rel, page])),
        });
      } else {
        for (const page of bucket) existing.carriers.set(page.rel, page);
      }
    }
  }
  return [...terms.values()]
    .map((term) => ({
      needle: term.needle,
      display: term.display,
      carriers: [...term.carriers.values()].toSorted((a, b) => compareStrings(a.rel, b.rel)),
    }))
    .toSorted((a, b) => compareStrings(a.needle, b.needle));
}

/** Refusal reason for a term the corpus cannot bind to one page. */
function ambiguousTermReason(display: string, carrierCount: number): string {
  return (
    `explicit textual reference to ${JSON.stringify(display)} is ambiguous: ` +
    `${carrierCount} pages carry it`
  );
}

/**
 * Collect deterministic repair candidates from vault structure, together
 * with the mention terms the corpus refuses to bind. Never emits an edge that
 * already exists, and never emits inferred candidates.
 *
 * A term (title or alias) that exactly one corpus page carries proposes the
 * same explicit-reference candidate a title match always has. A term carried
 * by several pages binds to none of them: every (mentioning page, carrying
 * page) pair comes back as a `skip-ambiguous` refusal, so the operator sees
 * why no edge was proposed instead of finding one arbitrary target linked.
 */
export function collectRepairCandidatesWithRefusals(
  vault: string,
  opts: CollectRepairCandidatesOptions = {},
): RepairCandidateCollection {
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

  // Explicit references: a note names a corpus term but does not link its
  // page. Terms pool titles and aliases; only an exactly-one carrier binds.
  const refusals: RepairDecision[] = [];
  const terms = collectMentionTerms(pages, vault);
  for (const page of pages) {
    const masked = maskSpans(page.body);
    const lower = masked.toLowerCase();
    for (const term of terms) {
      if (!mentionsTerm(lower, masked, term.needle)) continue;
      const verdict = resolveUniqueMatch(term.carriers);
      if (verdict.status === "unique") {
        const target = verdict.target;
        if (target.key === page.key) continue;
        if (page.linkedKeys.has(target.key)) continue;
        consider({
          source: page.rel,
          target: target.rel,
          strength: IDENTITY_STRENGTH.explicitReference,
          confidence: EXPLICIT_REFERENCE_CONFIDENCE,
          reason: `explicit textual reference to ${JSON.stringify(term.display)}`,
        });
      } else if (verdict.status === "ambiguous") {
        // A page that already links one carrier has resolved the mention
        // itself, exactly as the unique path skips an existing edge: there
        // is nothing left to refuse.
        if (verdict.matches.some((carrier) => page.linkedKeys.has(carrier.key))) continue;
        // A carrier naming the term names itself, the same self-reference
        // the unique path skips: refusing it would point at the others.
        if (verdict.matches.includes(page)) continue;
        for (const target of verdict.matches) {
          refusals.push({
            source: page.rel,
            target: target.rel,
            strength: IDENTITY_STRENGTH.explicitReference,
            confidence: EXPLICIT_REFERENCE_CONFIDENCE,
            action: "skip-ambiguous",
            reason: ambiguousTermReason(term.display, verdict.matches.length),
          });
        }
      }
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

  return {
    candidates: orderCandidates([...best.values()]),
    refusals: orderCandidates(refusals),
  };
}

/** Candidates plus the named refusals the corpus recorded while collecting. */
export interface RepairCandidateCollection {
  readonly candidates: RepairCandidate[];
  /** `skip-ambiguous` decisions, ordered by the candidate order. */
  readonly refusals: ReadonlyArray<RepairDecision>;
}

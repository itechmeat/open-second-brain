/**
 * Deep vault synthesis (Workspace Insight Suite, t_04e94382).
 *
 * Topic-scoped, deterministic evidence assembly: every note matching a
 * topic is cross-referenced for agreements (positive typed relations
 * between matched notes), contradictions (`contradicts` relations),
 * stale claims (aged or superseded notes), and knowledge gaps
 * (dangling wikilink targets). The dossier states exactly which
 * dimensions were checked so an empty section is interpretable as
 * "checked, nothing found" - prose synthesis stays with the calling
 * agent, never inside core.
 *
 * Contradiction and gap findings convert into trigger candidates
 * (Kernel B) via {@link synthesisCandidates}.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { search } from "../search/search.ts";
import { walkVault } from "../search/walker.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../search/types.ts";
import { buildEntityIndex } from "./entities/index-builder.ts";
import { extractWikilinkRichBodies, parseWikilinkRich } from "./link-graph/parse-wikilink.ts";
import type { InsightCandidate } from "./triggers/types.ts";
import { checkEntityContamination, type ContaminationEntityLike } from "./truth/contamination.ts";

const POSITIVE_RELATIONS: ReadonlySet<string> = new Set(["related", "extends", "supports"]);

export interface SynthesisNote {
  readonly path: string;
  readonly title: string | null;
  readonly score: number;
}

export interface SynthesisAgreement {
  readonly path: string;
  readonly relation: string;
  readonly target: string;
}

export interface SynthesisContradiction {
  readonly path: string;
  readonly target: string;
}

export interface SynthesisStaleClaim {
  readonly path: string;
  readonly ageDays: number;
  readonly supersededBy: string | null;
}

export interface SynthesisGap {
  readonly target: string;
  readonly sources: ReadonlyArray<string>;
}

export interface SynthesisContamination {
  /** The note asserting the entity. */
  readonly path: string;
  /** Canonical entity id mentioned but uncited. */
  readonly entity: string;
  /** The cited sources that fail to mention it. */
  readonly sources: ReadonlyArray<string>;
}

/**
 * Stable identity for a single piece of evidence grounding a finding
 * (t_40fa4e8d). The identity is deliberately tied to retrievable
 * content: `path` names the artifact, `kind` labels what class of
 * artifact it is (`note`, `source_page`, `claim`, ...), and
 * `contentHash` is a digest of the evidence bytes. A finding whose
 * evidence cannot be resolved to concrete content has no identity and
 * is gated out of emission.
 *
 * Exported for reuse by subject diarization (t_28ba3fc4), which builds
 * the same identity for stated claims and behavioral-signal lines.
 */
export interface EvidenceIdentity {
  /** Vault-relative path (or stable reference) of the grounding artifact. */
  readonly path: string;
  /** Artifact class label, e.g. `note`, `source_page`, `claim`. */
  readonly kind: string;
  /** Lowercase hex sha256 of the evidence bytes; ties identity to content. */
  readonly contentHash: string;
}

/**
 * True when the identity names a concrete, retrievable artifact: a
 * non-empty path, a non-empty kind, and a non-empty content hash. The
 * emission gate drops any finding whose evidence fails this predicate.
 */
export function hasEvidenceIdentity(
  id: EvidenceIdentity | null | undefined,
): id is EvidenceIdentity {
  return (
    id !== null &&
    id !== undefined &&
    id.path.trim() !== "" &&
    id.kind.trim() !== "" &&
    id.contentHash.trim() !== ""
  );
}

/** A typed relation that draws a note into the matched body. */
export interface SynthesisRelation {
  readonly relation: string;
  readonly target: string;
}

/**
 * Additive causal context for a finding (t_40fa4e8d): the deterministic
 * chain that explains why the note sits in the dossier. No generated
 * prose - just the structural facts already gathered by the pass.
 */
export interface SynthesisCausalContext {
  /** Typed relations connecting this note to the matched body. */
  readonly relations: ReadonlyArray<SynthesisRelation>;
  /** The `superseded_by` pointer bearing on the finding, or null. */
  readonly supersededBy: string | null;
  /** Dangling wikilink targets originating here (unverified links). */
  readonly danglingCitations: number;
}

/**
 * Decomposed, deterministic confidence components for one finding
 * (t_40fa4e8d). Each is computed from data already flowing through the
 * synthesis; none involves a model call or language analysis.
 */
export interface SynthesisConfidence {
  /** Positive typed relations incident to this note within the matched body. */
  readonly support: number;
  /** Contradiction relations incident to this note. */
  readonly opposition: number;
  /** Recency in [0,1]: 1 = touched today, 0 = at/over the stale age. */
  readonly freshness: number;
  /** Resolvable citations originating in this note. */
  readonly coverage: number;
}

/**
 * A synthesis finding (t_40fa4e8d): one matched note carried with its
 * evidence identity, causal context, and decomposed confidence. Only
 * findings that clear the evidence-identity gate are emitted.
 */
export interface SynthesisFinding {
  readonly evidence: EvidenceIdentity;
  readonly title: string | null;
  readonly causalContext: SynthesisCausalContext;
  readonly confidence: SynthesisConfidence;
}

/** Why a candidate finding was gated out of emission (visible loss). */
export type SynthesisExclusionReason = "unreadable" | "no_evidence_identity";

/** One gated-out finding: its identifier plus the structural reason. */
export interface SynthesisExcludedFinding {
  readonly path: string;
  readonly reason: SynthesisExclusionReason;
}

/**
 * The single best-formed objection to the dossier's implicit
 * conclusion (that the matched notes form a coherent, current body of
 * knowledge on the topic). This is NOT generated prose — core stays
 * deterministic — but the strongest counter-finding selected by a fixed
 * priority and framed as a steelman seed for the calling agent to
 * develop. `basis` records which finding class grounds it; `null` is
 * returned only when no counter-finding exists and the body is large
 * enough that thin evidence is not itself an objection.
 */
export interface SynthesisObjection {
  readonly basis: "contradiction" | "superseded" | "stale" | "knowledge_gap" | "thin_evidence";
  readonly statement: string;
  readonly sourceArtifacts: ReadonlyArray<string>;
}

export interface DeepSynthesisReport {
  readonly topic: string;
  readonly generatedAt: string;
  /** Dimensions this dossier actually checked, in order. */
  readonly checked: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<SynthesisNote>;
  readonly agreements: ReadonlyArray<SynthesisAgreement>;
  readonly contradictions: ReadonlyArray<SynthesisContradiction>;
  readonly staleClaims: ReadonlyArray<SynthesisStaleClaim>;
  readonly gaps: ReadonlyArray<SynthesisGap>;
  /**
   * Entity-contamination findings (t_e9692750): matched notes whose
   * wikilink-cited sources never mention a registered entity the note
   * asserts. Empty when the vault has no entity registry, and the
   * `entity_contamination` dimension is then omitted from `checked`
   * so registry-free vaults stay byte-identical.
   */
  readonly contaminated: ReadonlyArray<SynthesisContamination>;
  /**
   * The strongest objection to the dossier's implicit conclusion, or
   * `null` when none could be constructed. Always among the `checked`
   * dimensions.
   */
  readonly strongestObjection: SynthesisObjection | null;
  /**
   * Per-note findings (t_40fa4e8d): each matched note that cleared the
   * evidence-identity gate, carried with its causal context and
   * decomposed confidence. Additive - existing consumers ignore it.
   */
  readonly findings: ReadonlyArray<SynthesisFinding>;
  /**
   * Matched notes gated out of {@link findings} because they lacked an
   * evidence identity, each with the structural reason. The loss is
   * visible, never silent.
   */
  readonly excludedFindings: ReadonlyArray<SynthesisExcludedFinding>;
  /** Count of {@link excludedFindings} (mirrors the array length). */
  readonly excludedFindingCount: number;
}

export interface DeepSynthesisOptions {
  readonly now: Date;
  /** Max matched notes considered. Default 30. */
  readonly limit?: number;
  /** A matched note older than this counts as a stale claim. Default 90. */
  readonly staleAgeDays?: number;
}

const CHECKED = Object.freeze([
  "matched_notes",
  "agreements",
  "contradictions",
  "stale_claims",
  "knowledge_gaps",
  "strongest_objection",
]);

/** A body of this many matched notes or fewer is itself an objection. */
const THIN_EVIDENCE_MAX = 1;

/** Evidence-identity kind label for a matched vault note. */
const EVIDENCE_KIND_NOTE = "note";

/**
 * Per-note working state gathered in the main scan, consumed by the
 * finding pass. `content` is null when the note's bytes could not be
 * read - the signal the gate turns into a visible exclusion.
 */
interface NoteAccumulator {
  readonly note: BrainSearchResult;
  /** The note's page + short-name forms, for incidence matching. */
  readonly names: ReadonlySet<string>;
  readonly ageDays: number;
  readonly supersededBy: string | null;
  readonly relations: SynthesisRelation[];
  coverage: number;
  danglingCitations: number;
  content: string | null;
}

function stripMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -".md".length) : path;
}

/** The page and short-name forms a note answers to as a wikilink target. */
function noteNames(path: string): ReadonlySet<string> {
  const page = stripMd(path);
  const slash = page.lastIndexOf("/");
  return new Set(slash >= 0 ? [page, page.slice(slash + 1)] : [page]);
}

/** Lowercase hex sha256 of a string; ties evidence identity to content. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Recency in [0,1]: 1 the day a note is touched, decaying linearly to 0
 * at the stale-age horizon and staying 0 beyond it. Rounded to four
 * decimals so the value is byte-stable across runs.
 */
function computeFreshness(ageDays: number, horizonDays: number): number {
  if (horizonDays <= 0) return 0;
  const raw = 1 - ageDays / horizonDays;
  const clamped = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return Math.round(clamped * 10000) / 10000;
}

/**
 * Select the single strongest counter-finding and frame it as a
 * steelman seed. Deterministic: a direct contradiction is the sharpest
 * objection, then a superseded claim, then the oldest aged claim, then
 * a missing load-bearing note. With no counter-finding, a one-note body
 * is itself the objection (too thin to trust); a larger consistent body
 * yields `null`, and an empty topic has nothing to object to.
 */
function buildStrongestObjection(params: {
  readonly notePaths: ReadonlyArray<string>;
  readonly contradictions: ReadonlyArray<SynthesisContradiction>;
  readonly staleClaims: ReadonlyArray<SynthesisStaleClaim>;
  readonly gaps: ReadonlyArray<SynthesisGap>;
}): SynthesisObjection | null {
  const { notePaths, contradictions, staleClaims, gaps } = params;

  if (contradictions.length > 0) {
    const c = contradictions[0]!;
    return Object.freeze({
      basis: "contradiction" as const,
      statement: `The strongest case against this synthesis: \`${c.path}\` explicitly contradicts \`${c.target}\`. If that counter-note holds, the topic's consensus does not.`,
      sourceArtifacts: Object.freeze([c.path, `[[${c.target}]]`]),
    });
  }

  const superseded = staleClaims.find((s) => s.supersededBy !== null);
  if (superseded !== undefined) {
    return Object.freeze({
      basis: "superseded" as const,
      statement: `The strongest case against this synthesis: \`${superseded.path}\` has been superseded by \`${superseded.supersededBy}\`, so any conclusion resting on it may already be obsolete.`,
      sourceArtifacts: Object.freeze([superseded.path, `[[${superseded.supersededBy}]]`]),
    });
  }

  if (staleClaims.length > 0) {
    const oldest = staleClaims.reduce((a, b) => (b.ageDays > a.ageDays ? b : a));
    return Object.freeze({
      basis: "stale" as const,
      statement: `The strongest case against this synthesis: \`${oldest.path}\` is ${oldest.ageDays} days old with no recent corroboration; its claims may no longer hold.`,
      sourceArtifacts: Object.freeze([oldest.path]),
    });
  }

  if (gaps.length > 0) {
    const g = gaps[0]!;
    return Object.freeze({
      basis: "knowledge_gap" as const,
      statement: `The strongest case against this synthesis: it leans on \`[[${g.target}]]\`, a referenced note that does not exist, leaving a load-bearing claim unverified.`,
      sourceArtifacts: Object.freeze([...g.sources]),
    });
  }

  if (notePaths.length >= 1 && notePaths.length <= THIN_EVIDENCE_MAX) {
    return Object.freeze({
      basis: "thin_evidence" as const,
      statement: `The strongest case against this synthesis: it rests on a single matched note — too little evidence to treat the conclusion as settled.`,
      sourceArtifacts: Object.freeze([...notePaths]),
    });
  }

  return null;
}

export async function deepSynthesis(
  config: ResolvedSearchConfig,
  topic: string,
  opts: DeepSynthesisOptions,
): Promise<DeepSynthesisReport> {
  const limit = opts.limit ?? 30;
  const staleAgeDays = opts.staleAgeDays ?? 90;
  // Fetch raw CHUNK hits well past the note limit: one long document
  // can produce many chunks, and capping before the per-document
  // dedupe would let it crowd every other note out of the dossier.
  const rawLimit = Math.min(100, Math.max(limit * 3, limit));
  const outcome = await search(config, { query: topic, limit: rawLimit, keywordOnly: true });

  // Dedupe chunk hits into per-document notes (best score wins), THEN
  // apply the note limit.
  const byPath = new Map<string, BrainSearchResult>();
  for (const result of outcome.results) {
    const seen = byPath.get(result.path);
    if (seen === undefined || result.score > seen.score) byPath.set(result.path, result);
  }
  const matched = [...byPath.values()]
    .toSorted((a, b) => (a.score !== b.score ? b.score - a.score : a.path < b.path ? -1 : 1))
    .slice(0, limit);

  // Known pages across the vault: gap detection needs the full set,
  // not just the matched slice. The name->relPath map additionally
  // lets the contamination check resolve a cited wikilink target back
  // to the source file it names (first deterministic match wins).
  const knownTargets = new Set<string>();
  const pageByName = new Map<string, string>();
  for (const file of walkVault(config)) {
    const page = stripMd(file.relPath);
    knownTargets.add(page);
    if (!pageByName.has(page)) pageByName.set(page, file.relPath);
    const slash = page.lastIndexOf("/");
    const short = slash >= 0 ? page.slice(slash + 1) : page;
    knownTargets.add(short);
    if (!pageByName.has(short)) pageByName.set(short, file.relPath);
  }

  // Entity-contamination substrate (t_e9692750): the dimension only
  // exists when the vault HAS a registry, so registry-free vaults
  // produce byte-identical reports.
  let guardEntities: ReadonlyArray<ContaminationEntityLike> = [];
  try {
    guardEntities = buildEntityIndex(config.vault).entities;
  } catch {
    guardEntities = [];
  }

  // Agreement edges stay scoped to the matched-topic set: a positive
  // relation to an off-topic note is not evidence about THIS topic.
  // Contradiction edges deliberately stay unscoped - the counterpart
  // of a topical claim often uses different vocabulary and would never
  // match the query, and those are exactly the finds a synthesis is
  // for.
  const matchedTargets = new Set<string>();
  for (const note of matched) {
    const page = stripMd(note.path);
    matchedTargets.add(page);
    const slash = page.lastIndexOf("/");
    matchedTargets.add(slash >= 0 ? page.slice(slash + 1) : page);
  }

  const agreements: SynthesisAgreement[] = [];
  const contradictions: SynthesisContradiction[] = [];
  const staleClaims: SynthesisStaleClaim[] = [];
  const gapSources = new Map<string, Set<string>>();
  const contaminated: SynthesisContamination[] = [];
  const citedContentCache = new Map<string, string>();
  // Per-note accumulation for the finding pass (t_40fa4e8d). Support and
  // opposition are cross-note incidence counts, so findings are built in
  // a second pass once every relation edge is known.
  const perNote: NoteAccumulator[] = [];

  for (const note of matched) {
    const names = noteNames(note.path);
    const relations: SynthesisRelation[] = [];
    let supersededBy: string | null = null;
    for (const rel of note.relations ?? []) {
      if (rel.relation === "contradicts") {
        contradictions.push(Object.freeze({ path: note.path, target: rel.target }));
        relations.push(Object.freeze({ relation: rel.relation, target: rel.target }));
      } else if (rel.relation === "superseded_by") {
        supersededBy = rel.target;
        relations.push(Object.freeze({ relation: rel.relation, target: rel.target }));
      } else if (POSITIVE_RELATIONS.has(rel.relation) && matchedTargets.has(rel.target)) {
        agreements.push(
          Object.freeze({ path: note.path, relation: rel.relation, target: rel.target }),
        );
        relations.push(Object.freeze({ relation: rel.relation, target: rel.target }));
      }
    }

    // Stale: superseded notes always; otherwise age by mtime.
    let ageDays = 0;
    try {
      const mtimeMs = statSync(join(config.vault, note.path)).mtimeMs;
      ageDays = Math.floor((opts.now.getTime() - mtimeMs) / (24 * 3600 * 1000));
    } catch {
      ageDays = 0;
    }
    if (supersededBy !== null || ageDays > staleAgeDays) {
      staleClaims.push(Object.freeze({ path: note.path, ageDays, supersededBy }));
    }

    const acc: NoteAccumulator = {
      note,
      names,
      ageDays,
      supersededBy,
      relations,
      coverage: 0,
      danglingCitations: 0,
      content: null,
    };
    perNote.push(acc);

    // Gaps: wikilink targets referenced by this note that resolve to
    // no vault page. A note whose bytes cannot be read is recorded (its
    // `content` stays null) so the finding pass reports the loss rather
    // than dropping it silently.
    let content: string;
    try {
      content = readFileSync(join(config.vault, note.path), "utf8");
    } catch {
      continue;
    }
    acc.content = content;
    const citedRel = new Set<string>();
    for (const body of extractWikilinkRichBodies(content)) {
      const target = parseWikilinkRich(body).target;
      if (target === "") continue;
      if (knownTargets.has(target)) {
        const rel = pageByName.get(target);
        if (rel !== undefined && rel !== note.path) citedRel.add(rel);
        continue;
      }
      const sources = gapSources.get(target) ?? new Set<string>();
      sources.add(note.path);
      gapSources.set(target, sources);
      acc.danglingCitations += 1;
    }
    acc.coverage = citedRel.size;

    // Contamination: a note asserting a registered entity its cited
    // sources never mention. Only notes that actually cite something
    // are checked - an uncited note claims no provenance.
    if (guardEntities.length > 0 && citedRel.size > 0) {
      const cited = [...citedRel].toSorted();
      const sourceTexts: string[] = [];
      for (const rel of cited) {
        const cachedText = citedContentCache.get(rel);
        if (cachedText !== undefined) {
          sourceTexts.push(cachedText);
          continue;
        }
        try {
          const text = readFileSync(join(config.vault, rel), "utf8");
          citedContentCache.set(rel, text);
          sourceTexts.push(text);
        } catch {
          // An unreadable source cannot clear an entity; skip it.
        }
      }
      const result = checkEntityContamination({
        conclusion: content,
        sources: sourceTexts,
        entities: guardEntities,
      });
      for (const violation of result.violations) {
        contaminated.push(
          Object.freeze({
            path: note.path,
            entity: violation.entityId,
            sources: Object.freeze(cited),
          }),
        );
      }
    }
  }

  // Finding pass (t_40fa4e8d): build one finding per matched note that
  // clears the evidence-identity gate; report the rest as a visible loss.
  const findings: SynthesisFinding[] = [];
  const excludedFindings: SynthesisExcludedFinding[] = [];
  for (const acc of perNote) {
    if (acc.content === null) {
      excludedFindings.push(Object.freeze({ path: acc.note.path, reason: "unreadable" }));
      continue;
    }
    const evidence: EvidenceIdentity = {
      path: acc.note.path,
      kind: EVIDENCE_KIND_NOTE,
      contentHash: sha256Hex(acc.content),
    };
    // Defensive gate: the three fields above are always non-empty here, so this
    // branch is currently unreachable. It is kept deliberately so that if the
    // evidence construction above ever changes (an empty path, a missing hash),
    // the finding is dropped as a visible loss rather than emitted identity-less.
    if (!hasEvidenceIdentity(evidence)) {
      excludedFindings.push(Object.freeze({ path: acc.note.path, reason: "no_evidence_identity" }));
      continue;
    }
    const support = agreements.filter(
      (a) => a.path === acc.note.path || acc.names.has(a.target),
    ).length;
    const opposition = contradictions.filter(
      (c) => c.path === acc.note.path || acc.names.has(c.target),
    ).length;
    findings.push(
      Object.freeze({
        evidence: Object.freeze(evidence),
        title: acc.note.title,
        causalContext: Object.freeze({
          relations: Object.freeze([...acc.relations]),
          supersededBy: acc.supersededBy,
          danglingCitations: acc.danglingCitations,
        }),
        confidence: Object.freeze({
          support,
          opposition,
          freshness: computeFreshness(acc.ageDays, staleAgeDays),
          coverage: acc.coverage,
        }),
      }),
    );
  }

  contaminated.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0;
  });

  const gaps: ReadonlyArray<SynthesisGap> = Object.freeze(
    [...gapSources.entries()]
      .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([target, sources]) =>
        Object.freeze({ target, sources: Object.freeze([...sources].toSorted()) }),
      ),
  );

  const strongestObjection = buildStrongestObjection({
    notePaths: matched.map((note) => note.path),
    contradictions,
    staleClaims,
    gaps,
  });

  return Object.freeze({
    topic,
    generatedAt: opts.now.toISOString(),
    checked:
      guardEntities.length > 0 ? Object.freeze([...CHECKED, "entity_contamination"]) : CHECKED,
    notes: Object.freeze(
      matched.map((note) =>
        Object.freeze({ path: note.path, title: note.title, score: note.score }),
      ),
    ),
    agreements: Object.freeze(agreements),
    contradictions: Object.freeze(contradictions),
    staleClaims: Object.freeze(staleClaims),
    gaps,
    contaminated: Object.freeze(contaminated),
    strongestObjection,
    findings: Object.freeze(findings),
    excludedFindings: Object.freeze(excludedFindings),
    excludedFindingCount: excludedFindings.length,
  });
}

/**
 * The additive t_40fa4e8d surface of a report, in the snake_case shape
 * both the CLI `--json` payload and the MCP structured content emit.
 * Shared so the two operator surfaces stay byte-identical: each finding
 * carries its evidence identity, causal context, and decomposed
 * confidence, and the evidence loss is a visible ledger, never silent.
 */
export function synthesisFindingsJson(report: DeepSynthesisReport): {
  findings: ReadonlyArray<{
    evidence: { path: string; kind: string; content_hash: string };
    title: string | null;
    causal_context: {
      relations: ReadonlyArray<SynthesisRelation>;
      superseded_by: string | null;
      dangling_citations: number;
    };
    confidence: SynthesisConfidence;
  }>;
  excluded_findings: ReadonlyArray<SynthesisExcludedFinding>;
  excluded_finding_count: number;
} {
  return {
    findings: report.findings.map((f) => ({
      evidence: {
        path: f.evidence.path,
        kind: f.evidence.kind,
        content_hash: f.evidence.contentHash,
      },
      title: f.title,
      causal_context: {
        relations: f.causalContext.relations,
        superseded_by: f.causalContext.supersededBy,
        dangling_citations: f.causalContext.danglingCitations,
      },
      confidence: f.confidence,
    })),
    excluded_findings: report.excludedFindings,
    excluded_finding_count: report.excludedFindingCount,
  };
}

/** Contradiction and gap findings as trigger candidates (Kernel B). */
export function synthesisCandidates(report: DeepSynthesisReport): ReadonlyArray<InsightCandidate> {
  const out: InsightCandidate[] = [];
  for (const finding of report.contradictions) {
    out.push(
      Object.freeze({
        kind: "contradiction" as const,
        urgency: "high" as const,
        reason: `${finding.path} declares contradicts -> ${finding.target} (topic: ${report.topic})`,
        suggestedAction: "Reconcile the two notes or retire the stale claim",
        sourceArtifacts: Object.freeze([finding.path, `[[${finding.target}]]`]),
        contextSnippets: Object.freeze([`topic: ${report.topic}`]),
        cooldownKey: `contradiction:${finding.path}:${finding.target}`,
      }),
    );
  }
  for (const gap of report.gaps) {
    out.push(
      Object.freeze({
        kind: "knowledge_gap" as const,
        urgency: "medium" as const,
        reason: `[[${gap.target}]] is referenced but has no note (topic: ${report.topic})`,
        suggestedAction: "Write the missing note or fix the dangling link",
        sourceArtifacts: Object.freeze([...gap.sources]),
        contextSnippets: Object.freeze([`topic: ${report.topic}`]),
        cooldownKey: `knowledge_gap:${gap.target}`,
      }),
    );
  }
  return Object.freeze(out);
}

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

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { search } from "../search/search.ts";
import { walkVault } from "../search/walker.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../search/types.ts";
import { extractWikilinkRichBodies, parseWikilinkRich } from "./link-graph/parse-wikilink.ts";
import type { InsightCandidate } from "./triggers/types.ts";

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
]);

function stripMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -".md".length) : path;
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
  // not just the matched slice.
  const knownTargets = new Set<string>();
  for (const file of walkVault(config)) {
    const page = stripMd(file.relPath);
    knownTargets.add(page);
    const slash = page.lastIndexOf("/");
    knownTargets.add(slash >= 0 ? page.slice(slash + 1) : page);
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

  for (const note of matched) {
    let supersededBy: string | null = null;
    for (const rel of note.relations ?? []) {
      if (rel.relation === "contradicts") {
        contradictions.push(Object.freeze({ path: note.path, target: rel.target }));
      } else if (rel.relation === "superseded_by") {
        supersededBy = rel.target;
      } else if (POSITIVE_RELATIONS.has(rel.relation) && matchedTargets.has(rel.target)) {
        agreements.push(
          Object.freeze({ path: note.path, relation: rel.relation, target: rel.target }),
        );
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

    // Gaps: wikilink targets referenced by this note that resolve to
    // no vault page.
    let content: string;
    try {
      content = readFileSync(join(config.vault, note.path), "utf8");
    } catch {
      continue;
    }
    for (const body of extractWikilinkRichBodies(content)) {
      const target = parseWikilinkRich(body).target;
      if (target === "" || knownTargets.has(target)) continue;
      const sources = gapSources.get(target) ?? new Set<string>();
      sources.add(note.path);
      gapSources.set(target, sources);
    }
  }

  return Object.freeze({
    topic,
    generatedAt: opts.now.toISOString(),
    checked: CHECKED,
    notes: Object.freeze(
      matched.map((note) =>
        Object.freeze({ path: note.path, title: note.title, score: note.score }),
      ),
    ),
    agreements: Object.freeze(agreements),
    contradictions: Object.freeze(contradictions),
    staleClaims: Object.freeze(staleClaims),
    gaps: Object.freeze(
      [...gapSources.entries()]
        .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([target, sources]) =>
          Object.freeze({ target, sources: Object.freeze([...sources].toSorted()) }),
        ),
    ),
  });
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

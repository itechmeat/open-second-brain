/**
 * Idea discovery (Workspace Insight Suite, t_8722a62a).
 *
 * Ranks next-direction candidates from the vault's open loops:
 * unanswered open questions (reconcile log entries), orphan research
 * notes (no inbound wikilink anywhere under Brain/), and aging
 * unresolved inbox signals. Scoring is deterministic and documented
 * here: open questions (weight 3) outrank orphans (2) outrank aging
 * signals (1); ties break by age (older first), then by title. The
 * top candidates can feed the trigger queue (Kernel B).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildMorningBrief, type MorningBriefOpenQuestion } from "./morning-brief.ts";
import { extractWikilinkRichBodies, parseWikilinkRich } from "./link-graph/parse-wikilink.ts";
import { parseFrontmatterText } from "../vault.ts";
import type { InsightCandidate, TriggerKind } from "./triggers/types.ts";

const DAY_MS = 24 * 3600 * 1000;
const KIND_WEIGHT: Readonly<Record<string, number>> = Object.freeze({
  open_question: 3,
  orphan_research: 2,
  idea_direction: 1,
});

export interface IdeaCandidate {
  readonly kind: TriggerKind;
  readonly title: string;
  readonly reason: string;
  readonly score: number;
  readonly sourceArtifacts: ReadonlyArray<string>;
}

export interface DiscoverIdeasOptions {
  readonly now: Date;
  /** Ranked candidates returned. Default 5. */
  readonly cap?: number;
  /** Days before an unresolved inbox signal counts as aging. Default 14. */
  readonly agingSignalDays?: number;
  /** Log lookback for open questions. Default 30. */
  readonly lookbackDays?: number;
  /** Injection point for tests; default reads the morning-brief scan. */
  readonly openQuestions?: ReadonlyArray<MorningBriefOpenQuestion>;
}

interface NoteFile {
  readonly relPath: string;
  readonly absPath: string;
}

/** Recursively list .md files under Brain/, skipping machine dirs. */
function listBrainNotes(vault: string): NoteFile[] {
  const skip = new Set(["log", "inbox", "triggers", "intentions", "handoffs", "continuity"]);
  const out: NoteFile[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (rel === "" && skip.has(entry.name)) continue;
        walk(join(dir, entry.name), childRel);
      } else if (entry.name.endsWith(".md")) {
        out.push({ relPath: `Brain/${childRel}`, absPath: join(dir, entry.name) });
      }
    }
  };
  walk(join(vault, "Brain"), "");
  return out;
}

function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  return name.endsWith(".md") ? name.slice(0, -".md".length) : name;
}

function ageDays(absPath: string, now: Date): number {
  try {
    return Math.floor((now.getTime() - statSync(absPath).mtimeMs) / DAY_MS);
  } catch {
    return 0;
  }
}

export function discoverIdeas(
  vault: string,
  opts: DiscoverIdeasOptions,
): ReadonlyArray<IdeaCandidate> {
  const cap = opts.cap ?? 5;
  const agingSignalDays = opts.agingSignalDays ?? 14;
  const candidates: IdeaCandidate[] = [];

  // 1. Open questions from the reconcile trail.
  const openQuestions =
    opts.openQuestions ??
    buildMorningBrief(vault, {
      now: opts.now,
      topK: 0,
      lookbackDays: opts.lookbackDays ?? 30,
    }).openQuestions;
  for (const question of openQuestions) {
    candidates.push(
      Object.freeze({
        kind: "open_question" as const,
        title: question.topic,
        reason: `open question '${question.topic}' (${question.domain}) has no resolution on record`,
        score: KIND_WEIGHT["open_question"]!,
        sourceArtifacts: Object.freeze([question.topic]),
      }),
    );
  }

  // 2. Orphan research notes: no inbound wikilink from any Brain note.
  const notes = listBrainNotes(vault);
  const inbound = new Set<string>();
  for (const note of notes) {
    let content: string;
    try {
      content = readFileSync(note.absPath, "utf8");
    } catch {
      continue;
    }
    for (const body of extractWikilinkRichBodies(content)) {
      const target = parseWikilinkRich(body).target;
      if (target !== "") inbound.add(target);
    }
  }
  for (const note of notes) {
    const name = baseName(note.relPath);
    if (name === "profile" || name === "active" || name === "pinned") continue;
    // Heuristic: inbound matching is by bare basename, so two notes
    // sharing a basename can mask a true orphan. Acceptable for a
    // ranked suggestion list - precision over completeness.
    if (inbound.has(name)) continue;
    const age = ageDays(note.absPath, opts.now);
    candidates.push(
      Object.freeze({
        kind: "orphan_research" as const,
        title: name,
        reason: `${note.relPath} has no inbound links (${age}d old) - research nobody picked up`,
        score: KIND_WEIGHT["orphan_research"]! + Math.min(age, 365) / 1000,
        sourceArtifacts: Object.freeze([note.relPath]),
      }),
    );
  }

  // 3. Aging unresolved inbox signals.
  const inbox = join(vault, "Brain", "inbox");
  if (existsSync(inbox)) {
    for (const name of readdirSync(inbox)) {
      if (!name.startsWith("sig-") || !name.endsWith(".md")) continue;
      const absPath = join(inbox, name);
      const age = ageDays(absPath, opts.now);
      if (age < agingSignalDays) continue;
      let topic = name.slice(0, -".md".length);
      try {
        const [meta] = parseFrontmatterText(readFileSync(absPath, "utf8"));
        if (typeof meta["topic"] === "string" && meta["topic"] !== "") topic = meta["topic"];
      } catch {
        // keep the filename-derived topic
      }
      candidates.push(
        Object.freeze({
          kind: "idea_direction" as const,
          title: topic,
          reason: `inbox signal '${topic}' has waited ${age}d without becoming a preference`,
          score: KIND_WEIGHT["idea_direction"]! + Math.min(age, 365) / 1000,
          sourceArtifacts: Object.freeze([`Brain/inbox/${name}`]),
        }),
      );
    }
  }

  const ranked = candidates.toSorted((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  return Object.freeze(ranked.slice(0, Math.max(0, cap)));
}

/** Ranked ideas as trigger candidates (Kernel B). */
export function ideaCandidates(
  ideas: ReadonlyArray<IdeaCandidate>,
): ReadonlyArray<InsightCandidate> {
  return Object.freeze(
    ideas.map((idea) =>
      Object.freeze({
        kind: idea.kind,
        urgency: "low" as const,
        reason: idea.reason,
        suggestedAction: "Pick this up as a next direction or archive it deliberately",
        sourceArtifacts: idea.sourceArtifacts,
        contextSnippets: Object.freeze([`score: ${idea.score.toFixed(3)}`]),
        cooldownKey: `${idea.kind}:${idea.sourceArtifacts[0] ?? idea.title}`,
      }),
    ),
  );
}

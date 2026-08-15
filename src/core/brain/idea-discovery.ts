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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildMorningBrief, type MorningBriefOpenQuestion } from "./morning-brief.ts";
import { extractWikilinkRichBodies, parseWikilinkRich } from "./link-graph/parse-wikilink.ts";
import { fileAgeMs, msToWholeDays } from "./time.ts";
import { parseFrontmatter } from "../vault.ts";
import type { InsightCandidate, TriggerKind } from "./triggers/types.ts";

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

/** Top-level Brain dirs whose notes never count as orphan CANDIDATES. */
const MACHINE_DIRS: ReadonlySet<string> = new Set([
  "log",
  "inbox",
  "triggers",
  "intentions",
  "handoffs",
  "continuity",
]);

/** Recursively list .md files under Brain/, optionally skipping dirs. */
function listBrainNotes(vault: string, skipTopLevel: ReadonlySet<string> = new Set()): NoteFile[] {
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
        if (rel === "" && skipTopLevel.has(entry.name)) continue;
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

/**
 * Age cap on the tie-break bonus, so an ancient artifact cannot outrank
 * a higher-weighted kind on age alone.
 */
const AGE_BONUS_CAP_DAYS = 365;

/** Divisor turning the capped day count into a sub-unit tie-break bonus. */
const AGE_BONUS_DIVISOR = 1000;

/**
 * Whole-day age of a candidate artifact, or `null` when its mtime could
 * not be read.
 *
 * This used to return 0 on a stat failure, which said "brand new" about
 * a file nobody could read - the sharpest form of the defect this unit
 * removes, because the two consumers below both take a QUIETER action on
 * a low age (a smaller tie-break bonus, and a skip below the aging
 * threshold). `null` propagates instead, and each consumer names the
 * unmeasurable age in the `reason` string it already emits: this surface
 * is a ranked suggestion list with no report field, so the reason line IS
 * the channel, exactly as it already is for an unreadable frontmatter.
 */
function ageDays(absPath: string, now: Date): number | null {
  const ageMs = fileAgeMs(absPath, now.getTime());
  return ageMs === null ? null : msToWholeDays(ageMs);
}

/**
 * Tie-break bonus from an age, or 0 when the age is unmeasurable: an
 * artifact that could not be aged gets no age-derived rank, which leaves
 * it sorted with the youngest of its kind rather than promoted past
 * artifacts whose age is known.
 */
function ageBonus(age: number | null): number {
  if (age === null) return 0;
  return Math.min(age, AGE_BONUS_CAP_DAYS) / AGE_BONUS_DIVISOR;
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

  // 2. Orphan research notes: no inbound wikilink from ANY Brain note.
  // Two passes: inbound links are collected from the FULL Brain tree
  // (a reference from a handoff or trigger still counts), while orphan
  // CANDIDATES come only from non-machine dirs.
  const allNotes = listBrainNotes(vault);
  const notes = listBrainNotes(vault, MACHINE_DIRS);
  const inbound = new Set<string>();
  for (const note of allNotes) {
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
    const ageText = age === null ? "age unreadable" : `${age}d old`;
    candidates.push(
      Object.freeze({
        kind: "orphan_research" as const,
        title: name,
        reason: `${note.relPath} has no inbound links (${ageText}) - research nobody picked up`,
        score: KIND_WEIGHT["orphan_research"]! + ageBonus(age),
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
      // An unmeasurable age cannot clear the aging threshold and cannot
      // fail it either. Dropping the signal here is what the old age-0
      // return did silently; the signal is nominated instead, with a
      // reason that states the threshold was never evaluated. A false
      // nomination costs one line on a suggestion list, where a silent
      // drop costs the operator the only notice that the file is broken.
      if (age !== null && age < agingSignalDays) continue;
      let topic = name.slice(0, -".md".length);
      // Unit F: this site used to do its own `readFileSync` inside a
      // `catch {}` that silently kept the filename-derived topic - the one
      // genuinely reachable swallow among the frontmatter readers, since
      // the read is outside the parser. `parseFrontmatter` owns the read
      // now, so a failure is named at the source (a
      // `frontmatter-unreadable` notice) instead of here, and still
      // returns an empty map - which leaves the filename-derived topic in
      // place, exactly as before. A ranked candidate list has no report
      // field; see the "Why most readers keep the two-tuple form" section
      // in src/core/vault.ts for where the condition IS reported.
      const [meta] = parseFrontmatter(absPath);
      if (typeof meta["topic"] === "string" && meta["topic"] !== "") topic = meta["topic"];
      const reason =
        age === null
          ? `inbox signal '${topic}' could not be aged (Brain/inbox/${name} is unreadable), ` +
            `so the ${agingSignalDays}-day wait could not be checked`
          : `inbox signal '${topic}' has waited ${age}d without becoming a preference`;
      candidates.push(
        Object.freeze({
          kind: "idea_direction" as const,
          title: topic,
          reason,
          score: KIND_WEIGHT["idea_direction"]! + ageBonus(age),
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

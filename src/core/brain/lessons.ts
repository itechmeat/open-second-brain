/**
 * `Brain/lessons.md` — the unified, signed, recency-scored lessons
 * digest (Outcome-tagged lessons loop, t_62363378).
 *
 * OSB already owns the two halves of a lessons corpus as separate
 * registries:
 *
 *   - NEGATIVE knowledge — `Brain/dead-ends/` ("avoid X"), and the
 *     `violated` / `outdated` apply-evidence rows against a preference;
 *   - POSITIVE knowledge — `Brain/preferences/` confirmed rules and the
 *     `applied` apply-evidence rows that corroborate them.
 *
 * This module folds both classes into ONE outcome-tagged corpus scored
 * by a SIGNED, recency-decayed weight so that a fresh dead-end
 * outweighs a stale "useful", and promotes a lesson to a corroborated
 * tier only once ≥N distinct results back it — otherwise it stays
 * tentative, and a rule with both positive and negative recent
 * evidence renders as CONTESTED (the displayed stance follows the sign
 * of the decayed score, so recency wins).
 *
 * It is NOT a parallel loop: the corpus is derived from the existing
 * dead-end notes and apply-evidence log, the decay curve is the shared
 * `decayWeight` from continuity's usage-signal, and the digest is
 * regenerated at the tail of every `dream` pass exactly like
 * `Brain/active.md`. The SessionStart / PostCompact hook injects it
 * alongside `active.md`, so the agent gets a single auto-loaded lessons
 * surface without querying dead-ends and preferences independently.
 *
 * Pure derivation: no LLM, no network, no clock-dependent content
 * beyond the `generated_at` stamp. Identical inputs produce identical
 * bodies; the write is idempotent and atomic (mirrors `active.ts`).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { decayWeight } from "./continuity/usage-signal.ts";
import { listDeadEnds, type DeadEndEntry } from "./dead-ends.ts";
import { listLogDates, readLogDay } from "./log-jsonl.ts";
import { brainDirs, brainLessonsPath } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import {
  LESSONS_CORROBORATION_MIN_DEFAULT,
  LESSONS_HALF_LIFE_DAYS_DEFAULT,
  LESSONS_LIMIT_DEFAULT,
  loadBrainConfig,
} from "./policy.ts";
import { isoSecond } from "./time.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  type BrainPreference,
} from "./types.ts";

const FRONTMATTER_KIND = "brain-lessons";

/**
 * A net-positive lesson below the corroboration floor is `tentative`;
 * once ≥N distinct results back it, `preferred`. A rule carrying BOTH
 * positive and negative recent evidence is `contested` (recency-wins:
 * the displayed stance follows the sign of the decayed score). A
 * purely-negative node (a dead-end, or a rule only ever violated) is
 * `avoid`.
 */
export const LESSON_TIER = {
  preferred: "preferred",
  tentative: "tentative",
  contested: "contested",
  avoid: "avoid",
} as const;
export type LessonTier = (typeof LESSON_TIER)[keyof typeof LESSON_TIER];

/** The stance a `contested` lesson currently leans toward. */
export const LESSON_STANCE = {
  positive: "positive",
  negative: "negative",
} as const;
export type LessonStance = (typeof LESSON_STANCE)[keyof typeof LESSON_STANCE];

export interface LessonEntry {
  /** `pref-<slug>` or `de-<date>-<slug>`. */
  readonly id: string;
  readonly kind: "preference" | "dead-end";
  /** Preference principle or dead-end approach. */
  readonly title: string;
  readonly scope: string | null;
  readonly tier: LessonTier;
  /** Positive decayed mass minus negative decayed mass, rounded to 4dp. */
  readonly signedScore: number;
  readonly positiveMass: number;
  readonly negativeMass: number;
  /** Distinct positive-outcome artifacts corroborating the lesson. */
  readonly corroboration: number;
  /** For `contested` lessons, the recency-decided leaning; else null. */
  readonly stance: LessonStance | null;
  /** ISO timestamp of the most recent contributing outcome, or null. */
  readonly lastOutcomeAt: string | null;
}

export interface ComputeLessonsOptions {
  /** Scoring anchor. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Exponential half-life of the recency decay, in days. Default 30. */
  readonly halfLifeDays?: number;
  /** Distinct-result count required for the `preferred` tier. Default 2. */
  readonly corroborationMin?: number;
  /** Max lessons returned. Default 20. */
  readonly limit?: number;
}

/** Mutable per-node accumulator during the scoring pass. */
interface Accumulator {
  positiveMass: number;
  negativeMass: number;
  readonly positiveArtifacts: Set<string>;
  lastOutcomeMs: number;
}

const EPSILON = 1e-9;

/**
 * Single-event recency weight from the shared continuity decay curve.
 * Modelled as a record with zero access count and no last-access, so
 * `decayWeight` reduces to the pure `0.5^(age/halfLife)` exponential
 * (floored at its `minWeight`) — the same half-life OSB uses for
 * working-memory continuity.
 */
function eventWeight(eventMs: number, nowMs: number, halfLifeDays: number): number {
  return decayWeight({ createdAtMs: eventMs, accessCount: 0, lastAccessAtMs: null }, nowMs, {
    halfLifeDays,
  });
}

/**
 * Fold the preference corpus and the dead-end corpus into one ranked,
 * signed, recency-scored, corroboration-tiered lesson list.
 *
 * Pure read. The caller passes the candidate preferences (already
 * filtered to `confirmed | quarantine`) and the active dead-ends;
 * apply-evidence outcomes are harvested from `Brain/log/`.
 */
export function computeLessons(
  vault: string,
  preferences: ReadonlyArray<BrainPreference>,
  deadEnds: ReadonlyArray<DeadEndEntry>,
  opts: ComputeLessonsOptions = {},
): ReadonlyArray<LessonEntry> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const halfLifeDays = opts.halfLifeDays ?? LESSONS_HALF_LIFE_DAYS_DEFAULT;
  const corroborationMin = opts.corroborationMin ?? LESSONS_CORROBORATION_MIN_DEFAULT;
  const limit = opts.limit ?? LESSONS_LIMIT_DEFAULT;

  // Index the candidate preferences by their normalised id so an
  // apply-evidence row spelled `[[pref-x|principle]]` resolves to one
  // node. Retired rules are excluded upstream and never scored here.
  const prefByKey = new Map<string, BrainPreference>();
  for (const p of preferences) {
    if (
      p.status !== BRAIN_PREFERENCE_STATUS.confirmed &&
      p.status !== BRAIN_PREFERENCE_STATUS.quarantine
    ) {
      continue;
    }
    const key = normaliseWikilinkTarget(p.id);
    if (key !== null) prefByKey.set(key, p);
  }

  const accByKey = new Map<string, Accumulator>();
  const accFor = (key: string): Accumulator => {
    let acc = accByKey.get(key);
    if (acc === undefined) {
      acc = { positiveMass: 0, negativeMass: 0, positiveArtifacts: new Set(), lastOutcomeMs: 0 };
      accByKey.set(key, acc);
    }
    return acc;
  };

  // One pass over every log day, bucketing signed outcomes by pref.
  if (prefByKey.size > 0) scoreApplyEvidence(vault, prefByKey, accFor, nowMs, halfLifeDays);

  const entries: LessonEntry[] = [];

  // Preference-derived lessons.
  for (const [key, pref] of prefByKey) {
    const acc = accByKey.get(key);
    if (acc === undefined) continue; // no outcome evidence → not a lesson yet
    entries.push(
      buildEntry({
        id: pref.id,
        kind: "preference",
        title: pref.principle,
        scope: pref.scope ?? null,
        acc,
        corroborationMin,
      }),
    );
  }

  // Dead-end lessons: one negative outcome stamped at creation. They
  // are inherently `avoid` — a recorded failed approach.
  for (const de of deadEnds) {
    const createdMs = Date.parse(de.created_at);
    if (Number.isNaN(createdMs)) continue;
    const weight = eventWeight(createdMs, nowMs, halfLifeDays);
    const acc: Accumulator = {
      positiveMass: 0,
      negativeMass: weight,
      positiveArtifacts: new Set(),
      lastOutcomeMs: createdMs,
    };
    entries.push(
      buildEntry({
        id: de.id,
        kind: "dead-end",
        title: de.approach,
        scope: null,
        acc,
        corroborationMin,
      }),
    );
  }

  // Rank by salience — the dominant decayed mass — so the strongest
  // signal (positive, negative, or contested) surfaces first. Ties
  // break to the most recent outcome, then to a stable id order.
  entries.sort((a, b) => {
    const sa = Math.max(a.positiveMass, a.negativeMass);
    const sb = Math.max(b.positiveMass, b.negativeMass);
    if (sb !== sa) return sb - sa;
    const ta = a.lastOutcomeAt ? Date.parse(a.lastOutcomeAt) : 0;
    const tb = b.lastOutcomeAt ? Date.parse(b.lastOutcomeAt) : 0;
    if (tb !== ta) return tb - ta;
    return a.id.localeCompare(b.id);
  });

  return Object.freeze(entries.slice(0, limit).map((e) => Object.freeze(e)));
}

/** Walk the log once, accumulating signed apply-evidence per pref. */
function scoreApplyEvidence(
  vault: string,
  prefByKey: ReadonlyMap<string, BrainPreference>,
  accFor: (key: string) => Accumulator,
  nowMs: number,
  halfLifeDays: number,
): void {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return;

  for (const datePrefix of listLogDates(vault)) {
    let parsed;
    try {
      parsed = readLogDay(vault, datePrefix);
    } catch (err) {
      process.stderr.write(
        `warning: lessons: failed to read ${datePrefix}: ${(err as Error).message}\n`,
      );
      continue;
    }
    for (const e of parsed.entries) {
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      const prefField = e.body["preference"];
      if (typeof prefField !== "string") continue;
      const key = normaliseWikilinkTarget(prefField);
      if (key === null) continue;
      const pref = prefByKey.get(key);
      if (pref === undefined) continue;
      // Never harvest rows that predate the pref's existence — that would
      // be a different rule under a reused slug history.
      if (e.timestamp < pref.created_at) continue;
      const eventMs = Date.parse(e.timestamp);
      if (Number.isNaN(eventMs)) continue;
      const result = e.body["result"];
      if (typeof result !== "string") continue;

      const weight = eventWeight(eventMs, nowMs, halfLifeDays);
      const acc = accFor(key);
      acc.lastOutcomeMs = Math.max(acc.lastOutcomeMs, eventMs);
      if (result === BRAIN_APPLY_RESULT.applied) {
        acc.positiveMass += weight;
        const artifact = e.body["artifact"];
        if (typeof artifact === "string" && artifact.trim().length > 0) {
          acc.positiveArtifacts.add(normaliseWikilinkTarget(artifact) ?? artifact.trim());
        }
      } else if (result === BRAIN_APPLY_RESULT.violated || result === BRAIN_APPLY_RESULT.outdated) {
        acc.negativeMass += weight;
      }
    }
  }
}

interface BuildEntryInput {
  readonly id: string;
  readonly kind: "preference" | "dead-end";
  readonly title: string;
  readonly scope: string | null;
  readonly acc: Accumulator;
  readonly corroborationMin: number;
}

function buildEntry(input: BuildEntryInput): LessonEntry {
  const { acc } = input;
  const signed = acc.positiveMass - acc.negativeMass;
  const corroboration = acc.positiveArtifacts.size;

  let tier: LessonTier;
  let stance: LessonStance | null = null;
  if (acc.positiveMass > EPSILON && acc.negativeMass > EPSILON) {
    tier = LESSON_TIER.contested;
    // Recency-wins: the decayed sum already leans toward whichever
    // outcome class is fresher / stronger. Treat a dead-even score as
    // negative — an unresolved conflict is not an endorsement.
    stance = signed > EPSILON ? LESSON_STANCE.positive : LESSON_STANCE.negative;
  } else if (signed > EPSILON) {
    tier = corroboration >= input.corroborationMin ? LESSON_TIER.preferred : LESSON_TIER.tentative;
  } else {
    tier = LESSON_TIER.avoid;
  }

  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    scope: input.scope,
    tier,
    signedScore: round4(signed),
    positiveMass: round4(acc.positiveMass),
    negativeMass: round4(acc.negativeMass),
    corroboration,
    stance,
    lastOutcomeAt: acc.lastOutcomeMs > 0 ? new Date(acc.lastOutcomeMs).toISOString() : null,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ----- Regeneration (mirrors active.ts) ------------------------------------

export interface RegenerateLessonsOptions {
  /** Wall clock for `generated_at`. Defaults to `new Date()`. */
  readonly now?: Date;
}

export interface RegenerateLessonsResult {
  readonly path: string;
  readonly changed: boolean;
  readonly counts: {
    readonly preferred: number;
    readonly tentative: number;
    readonly contested: number;
    readonly avoid: number;
    readonly total: number;
  };
}

/**
 * Regenerate `<vault>/Brain/lessons.md`. Idempotent: the rendered body
 * is compared byte-for-byte against the existing file before writing so
 * a no-op `dream` rerun leaves the file (and its mtime) untouched.
 *
 * Parser failures on individual preference / dead-end files are
 * swallowed and the offending file is omitted, exactly like
 * `regenerateActive` — a single corrupted frontmatter must not blank
 * the whole lessons view. `brain_doctor` is the surface for corruption.
 */
export function regenerateLessons(
  vault: string,
  opts: RegenerateLessonsOptions = {},
): RegenerateLessonsResult {
  const now = opts.now ?? new Date();
  const path = brainLessonsPath(vault);

  const preferences = readActivePreferences(vault);
  const { entries: deadEnds } = listDeadEnds(vault);

  // Tunables from `_brain.yaml:lessons.*`. A malformed config never
  // blocks the digest — fall back to the defaults (doctor's job).
  let halfLifeDays = LESSONS_HALF_LIFE_DAYS_DEFAULT;
  let corroborationMin = LESSONS_CORROBORATION_MIN_DEFAULT;
  let limit = LESSONS_LIMIT_DEFAULT;
  try {
    const cfg = loadBrainConfig(vault);
    if (cfg.lessons) {
      halfLifeDays = cfg.lessons.half_life_days ?? halfLifeDays;
      corroborationMin = cfg.lessons.corroboration_min ?? corroborationMin;
      limit = cfg.lessons.limit ?? limit;
    }
  } catch {
    // intentional fallback — config error is doctor's job to surface
  }

  const lessons = computeLessons(vault, preferences, deadEnds, {
    now,
    halfLifeDays,
    corroborationMin,
    limit,
  });

  const body = renderBody(lessons, { corroborationMin, halfLifeDays });
  const existingBody = readExistingBody(path);
  const changed = existingBody === null || existingBody !== body.trim();
  if (changed) {
    atomicWriteFileSync(path, renderDocument(body, isoSecond(now)));
  }

  const counts = {
    preferred: lessons.filter((l) => l.tier === LESSON_TIER.preferred).length,
    tentative: lessons.filter((l) => l.tier === LESSON_TIER.tentative).length,
    contested: lessons.filter((l) => l.tier === LESSON_TIER.contested).length,
    avoid: lessons.filter((l) => l.tier === LESSON_TIER.avoid).length,
    total: lessons.length,
  };
  return { path, changed, counts };
}

/**
 * Fire-and-warn wrapper around {@link regenerateLessons}, matching
 * `regenerateActiveQuiet`. The lessons digest is a derived view: a
 * failed write (disk full, permissions) must not mask the success of
 * the `dream` pass that triggered it. The next pass retries.
 */
export function regenerateLessonsQuiet(vault: string, opts: RegenerateLessonsOptions = {}): void {
  try {
    regenerateLessons(vault, opts);
  } catch (err) {
    process.stderr.write(`warning: regenerate lessons.md failed: ${(err as Error).message}\n`);
  }
}

// ----- Scan helpers --------------------------------------------------------

function readActivePreferences(vault: string): BrainPreference[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return [];
  const out: BrainPreference[] = [];
  for (const name of readdirSync(dirs.preferences)) {
    if (!name.endsWith(".md")) continue;
    try {
      out.push(parsePreference(join(dirs.preferences, name)));
    } catch {
      // Corrupted / status-folder-mismatched — omit; doctor flags it.
    }
  }
  return out;
}

// ----- Render helpers ------------------------------------------------------

interface RenderMeta {
  readonly corroborationMin: number;
  readonly halfLifeDays: number;
}

function renderBody(lessons: ReadonlyArray<LessonEntry>, meta: RenderMeta): string {
  const out: string[] = [];
  out.push("# Lessons");
  out.push("");
  out.push("Auto-generated by `dream`. Do not edit — changes will be overwritten.");
  out.push("");
  out.push(
    `Signed, recency-decayed outcome corpus (half-life ${meta.halfLifeDays}d). ` +
      `A rule reaches **preferred** once ≥${meta.corroborationMin} distinct results corroborate it.`,
  );
  out.push("");

  if (lessons.length === 0) {
    out.push("_No lessons yet — record apply-evidence outcomes and dead-ends to seed the corpus._");
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.join("\n") + "\n";
  }

  const sections: ReadonlyArray<{ tier: LessonTier; heading: string; blurb: string }> = [
    {
      tier: LESSON_TIER.preferred,
      heading: "Preferred",
      blurb: "Net-positive and corroborated by enough distinct results.",
    },
    {
      tier: LESSON_TIER.tentative,
      heading: "Tentative",
      blurb: "Net-positive but not yet corroborated by enough distinct results.",
    },
    {
      tier: LESSON_TIER.contested,
      heading: "Contested",
      blurb: "Mixed recent evidence — the stance shown is the one recency currently favours.",
    },
    {
      tier: LESSON_TIER.avoid,
      heading: "Avoid",
      blurb: "Dead-ends and rules whose recent evidence is net-negative.",
    },
  ];

  for (const section of sections) {
    const group = lessons.filter((l) => l.tier === section.tier);
    if (group.length === 0) continue;
    out.push(`## ${section.heading} (${group.length})`);
    out.push("");
    out.push(`_${section.blurb}_`);
    out.push("");
    for (const l of group) out.push(renderLine(l));
    out.push("");
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function renderLine(l: LessonEntry): string {
  const tags: string[] = [];
  if (l.scope) tags.push(`scope: ${l.scope}`);
  tags.push(`score: ${formatSigned(l.signedScore)}`);
  if (l.tier === LESSON_TIER.preferred || l.tier === LESSON_TIER.tentative) {
    tags.push(`corroboration: ${l.corroboration}`);
  }
  if (l.tier === LESSON_TIER.contested && l.stance) {
    tags.push(`leaning: ${l.stance}`);
  }
  return `- \`${l.id}\` (${tags.join(", ")}) — ${l.title}`;
}

function formatSigned(n: number): string {
  const fixed = n.toFixed(2);
  return n > 0 ? `+${fixed}` : fixed;
}

function renderDocument(body: string, generatedAt: string): string {
  return [
    "---",
    `kind: ${FRONTMATTER_KIND}`,
    `generated_at: ${generatedAt}`,
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}

function readExistingBody(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const [, body] = parseFrontmatter(path);
    return body;
  } catch {
    return null;
  }
}

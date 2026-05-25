/**
 * `buildBeliefEvolution(index, vault, target)` - per-preference or
 * per-topic chronological view assembled from the `TimelineIndex`
 * plus `Brain/retired/*.md` frontmatter for retirement chain
 * resolution.
 *
 * Transitions are derived from `dream` summary events:
 *   - `pref-id` appears in `new_unconfirmed` -> creation
 *   - `pref-id` appears in `confirmed`       -> promotion
 *   - matching `ret-id` appears in `retired` -> retirement
 *
 * Evidence rows come from `apply-evidence` timeline events filtered
 * to the target id (or any pref/ret matching the topic). Running
 * applied / violated / outdated counts are carried per row.
 *
 * Retirement chain resolution walks `superseded_by` links across
 * `Brain/retired/*.md` with a visited-set cycle guard.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`,
 * Task 4 in `plan.md`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "./../paths.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  type BrainApplyResult,
} from "./../types.ts";
import { extractId } from "./period-common.ts";
import { selectEvents } from "./select-events.ts";
import type { TemporalEvent, TimelineIndex } from "./types.ts";

/** What the caller wants the evolution for. */
export type BeliefEvolutionTarget =
  | { readonly prefId: string }
  | { readonly topic: string };

/** One status-change row. */
export interface BeliefTransition {
  /** ISO-8601 UTC timestamp. */
  readonly at: string;
  /** Transition kind. */
  readonly kind: "creation" | "promotion" | "retirement";
  /** Preference / retired id the transition applies to. */
  readonly prefId: string;
  /** Wikilink the dream summary used (for audit). */
  readonly link: string;
}

/** One evidence row with running counts. */
export interface BeliefEvidenceRow {
  readonly at: string;
  readonly prefId: string;
  readonly result: BrainApplyResult;
  readonly artifact?: string;
  readonly runningApplied: number;
  readonly runningViolated: number;
  readonly runningOutdated: number;
}

/** One retirement record sourced from `Brain/retired/*.md`. */
export interface BeliefRetirement {
  readonly prefId: string;
  readonly retiredAt: string;
  readonly reason?: string;
  readonly retiredBy?: string;
  readonly supersededBy?: string;
  readonly supersedes?: string;
  readonly topic?: string;
}

export interface BeliefEvolutionEnvelope {
  readonly target: BeliefEvolutionTarget;
  readonly transitions: ReadonlyArray<BeliefTransition>;
  readonly evidence: ReadonlyArray<BeliefEvidenceRow>;
  readonly retirements: ReadonlyArray<BeliefRetirement>;
  readonly generatedAt: string;
}

export interface BuildBeliefEvolutionOptions {
  readonly now?: Date;
}

export function buildBeliefEvolution(
  index: TimelineIndex,
  vault: string,
  target: BeliefEvolutionTarget,
  opts: BuildBeliefEvolutionOptions = {},
): BeliefEvolutionEnvelope {
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const targetIdSet = resolveTargetIds(index, vault, target);

  const transitions = collectTransitions(index, targetIdSet);
  const evidence = collectEvidence(index, targetIdSet);
  const retirements = collectRetirements(vault, target, targetIdSet);

  return Object.freeze({
    target,
    transitions: Object.freeze(transitions),
    evidence: Object.freeze(evidence),
    retirements: Object.freeze(retirements),
    generatedAt,
  });
}

/**
 * Resolve the set of pref-* / ret-* ids that the target references.
 * For a prefId target the set is just that id plus its `ret-` sibling.
 * For a topic target we scan every `pref-*` / `ret-*` file with that
 * topic in frontmatter, plus every timeline event grouped under that
 * topic that carries a prefId.
 */
function resolveTargetIds(
  index: TimelineIndex,
  vault: string,
  target: BeliefEvolutionTarget,
): ReadonlySet<string> {
  if ("prefId" in target) {
    const ids = new Set<string>();
    ids.add(target.prefId);
    // pref-foo / ret-foo share the same slug. Treat the pair as the
    // same lifecycle anchor so transitions across the rename are
    // surfaced together.
    if (target.prefId.startsWith("pref-")) {
      ids.add(`ret-${target.prefId.slice("pref-".length)}`);
    } else if (target.prefId.startsWith("ret-")) {
      ids.add(`pref-${target.prefId.slice("ret-".length)}`);
    }
    return ids;
  }
  const ids = new Set<string>();
  const fromIndex = index.eventsByTopic.get(target.topic);
  if (fromIndex !== undefined) {
    for (const ev of fromIndex) {
      if (ev.prefId !== undefined) ids.add(ev.prefId);
    }
  }
  collectTopicIdsFromDisk(vault, target.topic, "preferences", "pref-", ids);
  collectTopicIdsFromDisk(vault, target.topic, "retired", "ret-", ids);
  return ids;
}

function collectTopicIdsFromDisk(
  vault: string,
  topic: string,
  subdir: "preferences" | "retired",
  prefix: "pref-" | "ret-",
  out: Set<string>,
): void {
  const dirs = brainDirs(vault);
  const dir = subdir === "preferences" ? dirs.preferences : dirs.retired;
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const path = join(dir, entry.name);
    let meta: Record<string, unknown>;
    try {
      [meta] = parseFrontmatter(path);
    } catch {
      continue;
    }
    if (meta["topic"] !== topic) continue;
    const id = typeof meta["id"] === "string" ? meta["id"] : null;
    out.add(id ?? entry.name.slice(0, -".md".length));
  }
}

function collectTransitions(
  index: TimelineIndex,
  targetIds: ReadonlySet<string>,
): BeliefTransition[] {
  const dreamEvents = index.eventsByKind.get(BRAIN_LOG_EVENT_KIND.dream) ?? [];
  const out: BeliefTransition[] = [];
  for (const ev of dreamEvents) {
    const summary = ev.dreamSummary;
    if (summary === undefined) continue;
    appendTransitionsFromLinks(
      ev.at,
      summary.newUnconfirmed,
      "creation",
      targetIds,
      out,
    );
    appendTransitionsFromLinks(
      ev.at,
      summary.confirmed,
      "promotion",
      targetIds,
      out,
    );
    appendTransitionsFromLinks(
      ev.at,
      summary.retired,
      "retirement",
      targetIds,
      out,
    );
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

function appendTransitionsFromLinks(
  at: string,
  links: ReadonlyArray<string> | undefined,
  kind: BeliefTransition["kind"],
  targetIds: ReadonlySet<string>,
  out: BeliefTransition[],
): void {
  if (links === undefined) return;
  for (const link of links) {
    const id = extractId(link);
    if (id === undefined) continue;
    if (!matchesTarget(id, targetIds)) continue;
    out.push(
      Object.freeze({
        at,
        kind,
        prefId: id,
        link,
      }),
    );
  }
}

function matchesTarget(
  candidateId: string,
  targetIds: ReadonlySet<string>,
): boolean {
  if (targetIds.has(candidateId)) return true;
  // pref-foo / ret-foo share lifecycle; treat the alternate prefix as
  // matching too so a `retirement` entry against `ret-foo` resolves
  // even when only `pref-foo` was requested.
  if (candidateId.startsWith("pref-")) {
    return targetIds.has(`ret-${candidateId.slice("pref-".length)}`);
  }
  if (candidateId.startsWith("ret-")) {
    return targetIds.has(`pref-${candidateId.slice("ret-".length)}`);
  }
  return false;
}

function collectEvidence(
  index: TimelineIndex,
  targetIds: ReadonlySet<string>,
): BeliefEvidenceRow[] {
  // apply-evidence rows do not carry `topic` themselves - the topic
  // lives on the target preference. So we narrow to the apply-evidence
  // bucket and filter by the resolved `targetIds` set (which contains
  // every pref-* / ret-* the topic / prefId pair points at).
  const candidate = selectEvents(index, {
    kind: BRAIN_LOG_EVENT_KIND.applyEvidence,
  });
  const filtered: TemporalEvent[] = [];
  for (const ev of candidate) {
    if (ev.prefId === undefined) continue;
    if (!matchesTarget(ev.prefId, targetIds)) continue;
    if (ev.result === undefined) continue;
    filtered.push(ev);
  }
  let applied = 0;
  let violated = 0;
  let outdated = 0;
  const out: BeliefEvidenceRow[] = [];
  for (const ev of filtered) {
    if (ev.result === BRAIN_APPLY_RESULT.applied) applied++;
    if (ev.result === BRAIN_APPLY_RESULT.violated) violated++;
    if (ev.result === BRAIN_APPLY_RESULT.outdated) outdated++;
    const row: BeliefEvidenceRow = {
      at: ev.at,
      prefId: ev.prefId!,
      result: ev.result!,
      ...(ev.artifact !== undefined ? { artifact: ev.artifact } : {}),
      runningApplied: applied,
      runningViolated: violated,
      runningOutdated: outdated,
    };
    out.push(Object.freeze(row));
  }
  return out;
}

function collectRetirements(
  vault: string,
  _target: BeliefEvolutionTarget,
  targetIds: ReadonlySet<string>,
): BeliefRetirement[] {
  const dir = brainDirs(vault).retired;
  if (!existsSync(dir)) return [];
  const out: BeliefRetirement[] = [];
  const visited = new Set<string>();
  // Seed queue once per source id. `pref-foo` and `ret-foo` share
  // the slug, so a `pref-` id always pushes its `ret-` sibling too.
  // Topic targets already enumerate every `ret-*` with the topic
  // via `resolveTargetIds`, so a second loop would only feed
  // duplicates (the visited-set guards them out, but the dedup at
  // the seed step avoids the queue grind in the first place).
  const queue: string[] = [];
  for (const id of targetIds) {
    if (id.startsWith("ret-")) queue.push(id);
    if (id.startsWith("pref-")) queue.push(`ret-${id.slice("pref-".length)}`);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    if (visited.has(id)) continue;
    visited.add(id);
    const path = join(dir, `${id}.md`);
    if (!existsSync(path)) continue;
    let meta: Record<string, unknown>;
    try {
      [meta] = parseFrontmatter(path);
    } catch {
      continue;
    }
    const retiredAt = readScalar(meta["retired_at"]);
    if (retiredAt === undefined) continue;
    const supersededByLink = readScalar(meta["superseded_by"]);
    const supersededBy = supersededByLink !== undefined
      ? extractId(supersededByLink)
      : undefined;
    const supersedesLink = readScalar(meta["supersedes"]);
    const supersedes = supersedesLink !== undefined
      ? extractId(supersedesLink)
      : undefined;
    const row: BeliefRetirement = {
      prefId: id,
      retiredAt,
      ...(readScalar(meta["retired_reason"]) !== undefined
        ? { reason: readScalar(meta["retired_reason"])! }
        : {}),
      ...(readScalar(meta["retired_by"]) !== undefined
        ? { retiredBy: readScalar(meta["retired_by"])! }
        : {}),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(readScalar(meta["topic"]) !== undefined
        ? { topic: readScalar(meta["topic"])! }
        : {}),
    };
    out.push(Object.freeze(row));
    // Walk the chain: `supersedes` points to the previous retired
    // record; `superseded_by` to the new active pref (we follow the
    // ret- sibling so we keep enumerating retired records, not active
    // ones).
    if (supersedes !== undefined && supersedes.startsWith("ret-")) {
      queue.push(supersedes);
    }
    if (supersededBy !== undefined && supersededBy.startsWith("pref-")) {
      queue.push(`ret-${supersededBy.slice("pref-".length)}`);
    }
  }
  out.sort((a, b) => (a.retiredAt < b.retiredAt ? -1 : 1));
  return out;
}

function readScalar(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `buildWeeklySynthesis(index, vault, weekEnd, cfg, opts?)` - 7-day
 * deterministic summary used by the weekly-synthesis surface.
 *
 * Shape mirrors `buildDailyBrief` but the window is 7 days back from
 * `weekEnd` (ISO date). On top of the daily envelope the weekly
 * synthesis adds:
 *
 *   - `retired`: list of retire transitions inside the window.
 *   - `contradictions`: combined list of `signal-suppressed` events
 *     plus `apply-evidence` events where the payload `result` is
 *     `"violated"`. Both surfaces signal a clash between the agent's
 *     stated rule and the underlying activity.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`,
 * Task 7 in `plan.md`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { extractWikilinkRichBodies, parseWikilinkRich } from "../link-graph/parse-wikilink.ts";
import { isoSecond } from "./../time.ts";
import type { BrainLogEventKind, ResolvedBrainTemporalConfig } from "./../types.ts";
import { BRAIN_LOG_EVENT_KIND } from "./../types.ts";
import { selectEvents } from "./select-events.ts";
import {
  collectSourcePointers,
  collectTransitions,
  computeVaultDelta,
  countByKind,
  type PeriodStatusTransition,
  type PeriodVaultDelta,
} from "./period-common.ts";
import type { TemporalEvent, TimelineIndex } from "./types.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface WeeklyContradiction {
  readonly at: string;
  readonly kind: "signal-suppressed" | "evidence-violated";
  readonly prefId?: string;
  readonly topic?: string;
  readonly reason?: string;
  readonly artifact?: string;
}

export interface WeeklyRetirement {
  readonly at: string;
  readonly prefId: string;
  readonly link: string;
}

export interface WeeklyTopSource {
  /** Vault-relative path of the nominated note. */
  readonly path: string;
  readonly score: number;
  /** One-line deterministic rationale. */
  readonly why: string;
  /** Per-signal breakdown behind the score. */
  readonly signals: {
    readonly recencyDays: number;
    readonly inboundLinks: number;
    readonly outboundLinks: number;
  };
}

export interface WeeklySynthesisEnvelope {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly eventsByKind: Readonly<Partial<Record<BrainLogEventKind, number>>>;
  readonly statusTransitions: ReadonlyArray<PeriodStatusTransition>;
  readonly retired: ReadonlyArray<WeeklyRetirement>;
  readonly contradictions: ReadonlyArray<WeeklyContradiction>;
  readonly vaultDelta: PeriodVaultDelta;
  readonly sourcePointers: ReadonlyArray<string>;
  readonly generatedAt: string;
  /**
   * Weekly top-source (t_a8d49eae): the single most-developable note
   * of the window - recency + inbound links + link centrality.
   * Absent when no candidate note was modified inside the window, so
   * historic envelopes stay byte-identical.
   */
  readonly topSource?: WeeklyTopSource;
}

export interface BuildWeeklySynthesisOptions {
  /** Wall clock for `generatedAt`; defaults to `new Date()`. */
  readonly now?: Date;
}

export function buildWeeklySynthesis(
  index: TimelineIndex,
  vault: string,
  weekEnd: string,
  _cfg: ResolvedBrainTemporalConfig,
  opts: BuildWeeklySynthesisOptions = {},
): WeeklySynthesisEnvelope {
  // `_cfg` is part of the helper signature for parity
  // with sibling projections and forward compatibility (weekday-
  // alignment overrides will read `_cfg.weekly_start_dow` in a
  // future release); the brief itself is a pure projection over the
  // index and does not re-touch disk.
  const windowEndMs = Date.parse(`${weekEnd}T00:00:00Z`);
  if (!Number.isFinite(windowEndMs)) {
    throw new Error(`buildWeeklySynthesis: invalid weekEnd ${JSON.stringify(weekEnd)}`);
  }
  const windowStartMs = windowEndMs - 7 * ONE_DAY_MS;
  const windowStart = isoSecond(new Date(windowStartMs));
  const windowEndIso = isoSecond(new Date(windowEndMs));
  const generatedAt = (opts.now ?? new Date()).toISOString();

  const events = selectEvents(index, {
    since: windowStart,
    until: windowEndIso,
  });

  const transitions = collectTransitions(events);
  const vaultDelta = computeVaultDelta(events, transitions);
  const retired = transitions
    .filter((t) => t.kind === "retirement")
    .map((t) => Object.freeze({ at: t.at, prefId: t.prefId, link: t.link }));
  const contradictions = collectContradictions(events);
  const topSource = nominateTopSource(vault, windowStartMs, windowEndMs);

  return Object.freeze({
    ...(topSource !== null ? { topSource } : {}),
    windowStart,
    windowEnd: windowEndIso,
    eventsByKind: Object.freeze(countByKind(events)),
    statusTransitions: Object.freeze(transitions),
    retired: Object.freeze(retired),
    contradictions: Object.freeze(contradictions),
    vaultDelta: Object.freeze(vaultDelta),
    sourcePointers: Object.freeze(collectSourcePointers(events)),
    generatedAt,
  });
}

function collectContradictions(events: ReadonlyArray<TemporalEvent>): WeeklyContradiction[] {
  const out: WeeklyContradiction[] = [];
  for (const ev of events) {
    if (ev.kind === BRAIN_LOG_EVENT_KIND.signalSuppressed) {
      out.push(makeContradiction("signal-suppressed", ev));
    } else if (ev.kind === BRAIN_LOG_EVENT_KIND.applyEvidence && ev.result === "violated") {
      out.push(makeContradiction("evidence-violated", ev));
    }
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

function makeContradiction(
  kind: WeeklyContradiction["kind"],
  ev: TemporalEvent,
): WeeklyContradiction {
  return Object.freeze({
    at: ev.at,
    kind,
    ...(ev.prefId !== undefined ? { prefId: ev.prefId } : {}),
    ...(ev.topic !== undefined ? { topic: ev.topic } : {}),
    ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
    ...(ev.artifact !== undefined ? { artifact: ev.artifact } : {}),
  });
}

// ----- Weekly top-source (t_a8d49eae) ---------------------------------------

// Machine-owned content never nominates: logs, signals, machine
// stores, generated digests, and rule files are not "notes worth
// developing further".
const TOP_SOURCE_EXCLUDED_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "Brain/log/",
  "Brain/inbox/",
  "Brain/retired/",
  "Brain/preferences/",
  "Brain/.snapshots/",
  "Brain/snapshots/",
  "Brain/search/",
  "Brain/procedural/",
  "Brain/recurrence/",
  "Brain/truth/",
  "Brain/triggers/",
  "Brain/continuity/",
  "Brain/dead-ends/",
  "Brain/foresight/",
  "Brain/_",
  "Brain/active",
  "Brain/pinned",
]);

const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".open-second-brain",
  ".obsidian",
  ".trash",
  ".stversions",
]);

interface TopSourceCandidate {
  readonly relPath: string;
  readonly mtimeMs: number;
}

function walkMarkdown(vault: string): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "" ? vault : join(vault, rel);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names.toSorted()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let isDir: boolean;
      try {
        isDir = statSync(join(vault, childRel)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (SKIPPED_DIR_NAMES.has(name) || name.startsWith(".")) continue;
        stack.push(childRel);
      } else if (name.endsWith(".md")) {
        out.push(childRel);
      }
    }
  }
  return out.toSorted();
}

function excluded(relPath: string): boolean {
  return TOP_SOURCE_EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function pageNames(relPath: string): string[] {
  const stripped = relPath.endsWith(".md") ? relPath.slice(0, -3) : relPath;
  const slash = stripped.lastIndexOf("/");
  return slash >= 0 ? [stripped, stripped.slice(slash + 1)] : [stripped];
}

/**
 * Nominate the most-developable note of the window: every candidate
 * modified inside [windowStart, windowEnd) scores
 * `0.5*recency + 0.3*inbound/(inbound+3) + 0.2*outbound/(outbound+5)`
 * over the whole-vault link graph. Null when nothing qualified.
 */
function nominateTopSource(
  vault: string,
  windowStartMs: number,
  windowEndMs: number,
): WeeklyTopSource | null {
  const all = walkMarkdown(vault);
  const candidates: TopSourceCandidate[] = [];
  for (const relPath of all) {
    if (excluded(relPath)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(vault, relPath)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= windowStartMs && mtimeMs < windowEndMs) {
      candidates.push({ relPath, mtimeMs });
    }
  }
  if (candidates.length === 0) return null;

  // Inbound counts over the WHOLE vault: links from machine files
  // still count as evidence of centrality, only nomination is scoped.
  const nameToCandidate = new Map<string, string>();
  for (const c of candidates) {
    for (const name of pageNames(c.relPath)) {
      if (!nameToCandidate.has(name)) nameToCandidate.set(name, c.relPath);
    }
  }
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const relPath of all) {
    let content: string;
    try {
      content = readFileSync(join(vault, relPath), "utf8");
    } catch {
      continue;
    }
    let links = 0;
    for (const body of extractWikilinkRichBodies(content)) {
      const target = parseWikilinkRich(body).target;
      if (target === "") continue;
      links++;
      const hit = nameToCandidate.get(target);
      if (hit !== undefined && hit !== relPath) {
        inbound.set(hit, (inbound.get(hit) ?? 0) + 1);
      }
    }
    outbound.set(relPath, links);
  }

  let best: WeeklyTopSource | null = null;
  for (const c of candidates) {
    const recencyDays = Math.max(0, Math.floor((windowEndMs - c.mtimeMs) / (24 * 60 * 60 * 1000)));
    const recency = Math.max(0, 1 - (windowEndMs - c.mtimeMs) / (windowEndMs - windowStartMs));
    const inboundLinks = inbound.get(c.relPath) ?? 0;
    const outboundLinks = outbound.get(c.relPath) ?? 0;
    const score =
      Math.round(
        (0.5 * recency +
          0.3 * (inboundLinks / (inboundLinks + 3)) +
          0.2 * (outboundLinks / (outboundLinks + 5))) *
          10000,
      ) / 10000;
    const candidate: WeeklyTopSource = Object.freeze({
      path: c.relPath,
      score,
      why:
        `Modified ${recencyDays}d before window end with ${inboundLinks} inbound and ` +
        `${outboundLinks} outbound link(s) - the strongest develop-next lead of the window.`,
      signals: Object.freeze({ recencyDays, inboundLinks, outboundLinks }),
    });
    if (best === null || score > best.score || (score === best.score && c.relPath < best.path)) {
      best = candidate;
    }
  }
  return best;
}

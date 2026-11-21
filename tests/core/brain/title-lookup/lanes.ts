/**
 * One adapter per lane whose records a title names (pledges, theses,
 * decisions, obligations), so the table in `strict-lanes.test.ts` runs
 * every cell of the title lookup against every lane. A future lane is one
 * more adapter here.
 *
 * Every adapter speaks in slugs and stored titles: `create` answers the
 * slug the record was written under, `show` the stored title of the page
 * a value reaches (null for none), `act` the slug of the page an update
 * changed (it throws when the value reaches nothing).
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import {
  addPledge,
  fulfillPledge,
  removePledge,
  showPledge,
} from "../../../../src/core/brain/pledges.ts";
import { closeThesis, recordThesis, showThesis } from "../../../../src/core/brain/health/thesis.ts";
import {
  backfillOutcome,
  recordDecision,
  showDecision,
} from "../../../../src/core/brain/decisions/record.ts";
import {
  addObligation,
  completeObligation,
  removeObligation,
  resolveObligationTarget,
  showObligation,
} from "../../../../src/core/brain/obligations.ts";

export const NOW = new Date("2026-07-18T12:00:00Z");
const SOURCE_REL = "notes/meeting.md";
const QUOTE = "Ada asked for a written recap";

export type Readable = (rel: string) => boolean;

export interface TitledLane {
  readonly name: string;
  /** True when the lane's lookups take the caller's reach. */
  readonly reach: boolean;
  /** Write a record titled `title`; `variant` tells apart two records of one title. */
  create(vault: string, title: string, variant?: number): string;
  show(vault: string, value: string, readable?: Readable): string | null;
  act(vault: string, value: string, readable?: Readable): string;
  /** Remove the page a value reaches, answering its slug; absent where the lane has no remove. */
  readonly remove?: (vault: string, value: string, readable?: Readable) => string;
  /** The vault-relative POSIX path of the page at `slug`, as the reach predicate sees it. */
  rel(slug: string): string;
  /**
   * Pages filed beside the record under a name derived from its slug,
   * which an older release filed under the old name too (a decision's
   * review obligation), so a move carries them.
   */
  readonly companions?: (slug: string) => readonly string[];
}

/** A fresh vault every lane can write to. */
export function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "osb-title-lookup-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), `${QUOTE} of the migration steps.\n`, "utf8");
  return vault;
}

export function dropVault(vault: string): void {
  rmSync(vault, { recursive: true, force: true });
}

/** Move the page at `from` to the name `to` (an older release's slug), in place. */
export function moveRecord(vault: string, lane: TitledLane, from: string, to: string): void {
  renameSync(join(vault, lane.rel(from)), join(vault, lane.rel(to)));
  const before = lane.companions?.(from) ?? [];
  const after = lane.companions?.(to) ?? [];
  for (const [i, rel] of before.entries()) {
    if (existsSync(join(vault, rel))) renameSync(join(vault, rel), join(vault, after[i]!));
  }
}

const pledgeLane: TitledLane = {
  name: "pledges",
  reach: true,
  create: (vault, title, variant = 0) =>
    addPledge(vault, {
      title,
      due: `2026-08-${String(10 + variant).padStart(2, "0")}`,
      source: SOURCE_REL,
      evidence: [QUOTE],
      agent: "tester",
      now: NOW,
    }).slug,
  show: (vault, value, readable) =>
    showPledge(vault, { slug: value, ...(readable ? { readable } : {}) })?.title ?? null,
  act: (vault, value, readable) =>
    fulfillPledge(vault, { slug: value, now: NOW, ...(readable ? { readable } : {}) }).slug,
  remove: (vault, value, readable) =>
    removePledge(vault, { slug: value, ...(readable ? { readable } : {}) }).slug,
  rel: (slug) => posix.join("Brain", "pledges", `${slug}.md`),
};

const thesisLane: TitledLane = {
  name: "theses",
  reach: false,
  create: (vault, title) =>
    recordThesis(vault, { statement: title, agent: "tester", now: NOW }).slug,
  show: (vault, value) => showThesis(vault, value)?.statement ?? null,
  act: (vault, value) => closeThesis(vault, value).slug,
  rel: (slug) => posix.join("Brain", "theses", `thesis-${slug}.md`),
};

const decisionLane: TitledLane = {
  name: "decisions",
  reach: true,
  create: (vault, title) =>
    recordDecision(vault, {
      title,
      chosen: "the first option",
      assumption: "It holds.",
      reviewDate: "2026-10-01",
      agent: "tester",
      now: NOW,
    }).record.slug,
  show: (vault, value, readable) =>
    showDecision(vault, value, readable ? { readable } : {})?.title ?? null,
  act: (vault, value, readable) =>
    backfillOutcome(vault, {
      slug: value,
      outcome: "It held.",
      agent: "tester",
      now: NOW,
      ...(readable ? { readable } : {}),
    }).slug,
  rel: (slug) => posix.join("Brain", "decisions", `decision-${slug}.md`),
  companions: (slug) => [posix.join("Brain", "obligations", `review-decision-${slug}.md`)],
};

const obligationLane: TitledLane = {
  name: "obligations",
  reach: true,
  create: (vault, title) =>
    addObligation(vault, { title, cadence: "weekly", agent: "tester", now: NOW }).slug,
  show: (vault, value, readable) =>
    showObligation(vault, resolveObligationTarget(vault, value, readable))?.title ?? null,
  act: (vault, value, readable) =>
    completeObligation(vault, {
      slug: resolveObligationTarget(vault, value, readable),
      now: NOW,
    }).slug,
  remove: (vault, value, readable) => {
    const target = resolveObligationTarget(vault, value, readable);
    removeObligation(vault, target);
    return target.stem;
  },
  rel: (slug) => posix.join("Brain", "obligations", `${slug}.md`),
};

export const TITLED_LANES: readonly TitledLane[] = [
  pledgeLane,
  thesisLane,
  decisionLane,
  obligationLane,
];

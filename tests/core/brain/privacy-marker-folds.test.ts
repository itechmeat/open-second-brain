/**
 * Derived pages inherit an informal privacy marker's reservation
 * (write-honesty review, fold regression).
 *
 * The read roots deny a remote read for a page saying `access: private`
 * (`graph/privacy-markers.ts`), but every page DERIVED from such a page -
 * a preference the dream pass drafts from its signals, a cross-topic rule
 * promoted from its sources, a counterparty-brief item drawn from a
 * pledge - folds the `visibility:` tokens of its inputs. A fold fed only
 * `pageVisibility` never sees the informal claim, so the derived page
 * ships the source's words at default visibility. Each test below runs a
 * marker page through one fold and asks the derived artifact for the
 * reserved token.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { emptyPlan, type ScanResult } from "../../../src/core/brain/dream-plan.ts";
import {
  planCrossTopicRules,
  type ResolvedCrossTopicConfig,
} from "../../../src/core/brain/dream-plan-cross-topic.ts";
import type { RefreshResult } from "../../../src/core/brain/dream-refresh.ts";
import {
  buildCounterpartyBrief,
  type CounterpartyBrief,
  type CounterpartyBriefAbstention,
} from "../../../src/core/brain/counterparty-brief.ts";
import { addPledge } from "../../../src/core/brain/pledges.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { brainConfigPath, preferencePath } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { scanBrain } from "../../../src/core/brain/dream-scan.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  pageVisibility,
  REMOTE_DENY_VISIBILITY_TOKEN,
} from "../../../src/core/graph/visibility.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";

const NOW = new Date("2026-06-05T12:00:00Z");
const SIGNAL_STAMP = "2026-06-01T10:00:00Z";
const AGENT = "claude";
const TOPIC = "release-notes";
const PRINCIPLE = "Quote the budget figure in every release note.";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-marker-folds-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Stamp an informal marker line into a page's frontmatter. */
function stampMarker(path: string, line: string): void {
  atomicWriteFileSync(path, readFileSync(path, "utf8").replace(/^---\n/, `---\n${line}\n`));
}

/** The visibility tokens of the one drafted preference, after a real pass. */
function draftedVisibility(vault: string): ReadonlyArray<string> {
  const report = dream(vault, { now: NOW, agentName: AGENT });
  expect(report.new_unconfirmed).toHaveLength(1);
  const path = preferencePath(vault, report.new_unconfirmed[0]!.slice("pref-".length));
  expect(readFileSync(path, "utf8")).toContain(PRINCIPLE);
  return pageVisibility(parseFrontmatter(path)[0]);
}

describe("the dream pass folds a marker into the preference it drafts", () => {
  function newVault(name: string): string {
    const vault = join(tmp, name);
    const configPath = join(tmp, `${name}.yaml`);
    atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${AGENT}\n`);
    bootstrapBrain(vault, { configPath });
    const yaml = readFileSync(brainConfigPath(vault), "utf8").replace(
      /^ {2}candidate_threshold: \d+$/m,
      "  candidate_threshold: 3",
    );
    atomicWriteFileSync(brainConfigPath(vault), yaml);
    return vault;
  }

  function seed(vault: string, slug: string, marker: boolean): void {
    const { path } = writeSignal(vault, {
      topic: TOPIC,
      signal: "positive",
      agent: AGENT,
      principle: PRINCIPLE,
      created_at: SIGNAL_STAMP,
      date: SIGNAL_STAMP.slice(0, 10),
      slug,
    });
    if (marker) stampMarker(path, "access: private");
  }

  test("one marker signal in the cluster reserves the drafted preference", () => {
    const vault = newVault("promote");
    seed(vault, "a", false);
    seed(vault, "b", true);
    seed(vault, "c", false);
    expect(draftedVisibility(vault)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
  });

  test("rebutting from marker signals reserves the drafted preference", () => {
    const vault = newVault("rebut");
    writePreference(vault, {
      slug: "notes-rule",
      topic: TOPIC,
      principle: "The rule of record for release notes.",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-15T00:00:00Z",
      confirmed_at: "2026-05-08T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      applied_count: 2,
      violated_count: 0,
      last_evidence_at: "2026-06-01T00:00:00Z",
      confidence: "medium",
    });
    // No evidence resolves the active sign, so a unanimous batch reads as
    // a rebuttal and drafts a `-rebut` preference from the signals.
    seed(vault, "a", true);
    seed(vault, "b", true);
    seed(vault, "c", true);
    expect(draftedVisibility(vault)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
  });
});

describe("the cross-topic planner folds a marker into the rule it promotes", () => {
  test("a marker source reserves the promoted rule", () => {
    const vault = join(tmp, "cross-topic");
    const configPath = join(tmp, "cross-topic.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath });
    // Two confirmed sources, different topics, both ownerless, sharing
    // enough principle text to clear the jaccard floor.
    const sources: ReadonlyArray<[string, string, string, boolean]> = [
      ["alpha", "scripts", "prefer bun over node for scripts", true],
      ["beta", "tooling", "prefer bun over node for tooling", false],
    ];
    for (const [slug, topic, principle, marked] of sources) {
      const { path } = writePreference(vault, {
        slug,
        topic,
        principle,
        created_at: "2026-05-01T00:00:00Z",
        unconfirmed_until: "2026-05-15T00:00:00Z",
        confirmed_at: "2026-05-08T00:00:00Z",
        status: "confirmed",
        evidenced_by: [],
        applied_count: 1,
        violated_count: 0,
        last_evidence_at: "2026-06-01T00:00:00Z",
        confidence: "medium",
      });
      if (marked) stampMarker(path, "access: private");
    }
    const scan: ScanResult = scanBrain(vault);
    const refresh: RefreshResult = {
      confirmed: new Set(),
      updated: new Map(),
      bandDrops: [],
      outcomeRegressions: [],
    };
    const config: ResolvedCrossTopicConfig = { minTopics: 2, jaccard: 0.6 };
    const plan = emptyPlan();
    const result = planCrossTopicRules({ scan, refresh, config, ledger: null, now: NOW, plan });
    expect(result.fired).toBe(true);
    expect(plan.crossTopicRules).toHaveLength(1);
    expect(plan.crossTopicRules[0]!.visibility).toContain(REMOTE_DENY_VISIBILITY_TOKEN);
  });
});

describe("the counterparty brief folds a marker into the items it injects", () => {
  const PROMPT = "meet Ada Lovelace to prepare the review";
  let vault: string;
  let entityId: string;

  beforeEach(() => {
    vault = join(tmp, "brief");
    const configPath = join(tmp, "brief.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath });
    entityId = upsertEntity(vault, {
      category: "people",
      name: "Ada Lovelace",
      agent: AGENT,
      now: NOW,
    }).entity.id;
  });

  /** Seed one open pledge to the entity and stamp its page or its source. */
  function seedPledge(title: string, stamp: "pledge" | "source" | null): void {
    const sourceRel = "notes/scratch.md";
    const sourceAbs = join(vault, sourceRel);
    atomicWriteFileSync(
      sourceAbs,
      "---\ntitle: Scratch\n---\n\nThe promise was made in prose here.\n",
    );
    const page = addPledge(vault, {
      title,
      due: "2026-06-10",
      source: sourceRel,
      evidence: ["The promise was made in prose here."],
      counterparties: [entityId],
      agent: AGENT,
      now: NOW,
    });
    const pledgePath = join(vault, "Brain", "pledges", `${page.slug}.md`);
    if (stamp === "pledge") stampMarker(pledgePath, "access: private");
    if (stamp === "source") stampMarker(sourceAbs, "access: private");
  }

  function brief(): CounterpartyBrief | CounterpartyBriefAbstention {
    return buildCounterpartyBrief(vault, {
      text: PROMPT,
      triggers: ["meet"],
      now: NOW,
    });
  }

  test("a pledge page carrying a marker withholds its item", () => {
    seedPledge("Send the review notes", "pledge");
    const result = brief();
    if ("abstain" in result) throw new Error(`unexpected abstention: ${result.abstain}`);
    expect(result.items).toEqual([]);
  });

  test("a cited source page carrying a marker withholds the item", () => {
    seedPledge("Send the review notes", "source");
    const result = brief();
    if ("abstain" in result) throw new Error(`unexpected abstention: ${result.abstain}`);
    expect(result.items).toEqual([]);
  });

  test("control: a pledge whose marker value does not deny still surfaces", () => {
    seedPledge("Send the published notes", null);
    const result = brief();
    if ("abstain" in result) throw new Error(`unexpected abstention: ${result.abstain}`);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.text).toContain("Send the published notes");
  });
});

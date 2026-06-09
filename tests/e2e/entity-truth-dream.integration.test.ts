/**
 * Entity Truth & Self-Improving Dream Suite - end-to-end integration
 * over one vault: atomic decomposition feeding the claim ledger
 * (t_cbd22536 + t_d6849b56 + t_220c313e), conflict and cross-agent
 * collision detection (t_e9692750 + t_f2b225b1), outcome-tied
 * evidence regression (t_d478df53), dead-end recall (t_be62c62d),
 * weekly top-source (t_a8d49eae), and foresight (t_08a79c81).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { decomposeAtomicFacts } from "../../src/core/brain/atomic-facts.ts";
import { applyRecurrenceEvidence } from "../../src/core/brain/recurrence.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { dream } from "../../src/core/brain/dream.ts";
import { recordDeadEnd } from "../../src/core/brain/dead-ends.ts";
import { aggregateQuantities } from "../../src/core/brain/truth/aggregate.ts";
import { detectAgentCollisions } from "../../src/core/brain/truth/collision.ts";
import { computeTruthStateWithConflicts } from "../../src/core/brain/truth/conflicts.ts";
import { claimsFromAssertion } from "../../src/core/brain/truth/ingest.ts";
import { appendClaimEvent, readClaimEvents } from "../../src/core/brain/truth/store.ts";
import { buildForesight } from "../../src/core/brain/temporal/foresight.ts";
import { buildTimelineIndex } from "../../src/core/brain/temporal/build-index.ts";
import { buildWeeklySynthesis } from "../../src/core/brain/temporal/weekly-brief.ts";
import { BRAIN_TEMPORAL_DEFAULTS } from "../../src/core/brain/policy.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { search } from "../../src/core/search/search.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";

const NOW = new Date("2026-06-04T12:00:00Z");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-etd-e2e-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-etd-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("the suite composes end to end on one vault", async () => {
  // -- Atomic decomposition feeds the ledger (3 + 4 + 2) --------------
  const session = [
    "# Budget standup",
    "",
    "I spent 120 USD on hosting last month.",
    "I spent 42 USD on domains last month.",
  ].join("\n");
  for (const assertion of decomposeAtomicFacts(session)) {
    for (const claim of claimsFromAssertion(assertion, {
      entity: "operator",
      agent: "claude-dev-agent",
      ts: "2026-06-01T10:00:00Z",
      source: "[[Brain/notes/budget-standup.md]]",
    })) {
      appendClaimEvent(vault, claim);
    }
  }
  // Two agents independently claim the same entity's employer.
  appendClaimEvent(vault, {
    ts: "2026-06-01T11:00:00Z",
    agent: "claude-dev-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/standup.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-03T11:00:00Z",
    agent: "sales-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/intro-call.md]]",
  });

  const events = readClaimEvents(vault).events;
  expect(events.length).toBe(4);

  // -- Slots, conflicts, aggregation -----------------------------------
  const state = computeTruthStateWithConflicts(events);
  const employer = state.slots.find((s) => s.entity === "alice mason")!;
  expect(employer.contested).toBe(true);
  expect(employer.current.value).toBe("Meta");
  expect(employer.history[0]!.value).toBe("Google");
  expect(state.conflicts).toHaveLength(1);
  expect(state.conflicts[0]!.resolution).toBe("ask_user");

  // Action is no longer derived from prose; quantities aggregate by
  // entity + unit. Both "$120"/"42 USD"-shaped spends combine here.
  const spend = aggregateQuantities(state.slots, {
    entity: "operator",
    unit: "usd",
  });
  expect(spend.total).toBe(162);
  expect(spend.count).toBe(2);

  // -- Cross-agent collision (5) ----------------------------------------
  const collisions = detectAgentCollisions(events, { now: NOW });
  expect(collisions).toHaveLength(1);
  expect(collisions[0]!.entity).toBe("alice mason");
  expect(collisions[0]!.agents).toEqual(["claude-dev-agent", "sales-agent"]);

  // -- Outcome regression (7) -------------------------------------------
  writePreference(vault, {
    slug: "risky-rule",
    topic: "deploys",
    principle: "Always hotfix straight to main",
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: ["[[sig-2026-05-01-risky]]"],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence: BRAIN_CONFIDENCE.low,
    confidence_value: null,
    pinned: false,
  });
  for (const day of [1, 2]) {
    appendApplyEvidence(
      vault,
      {
        pref_id: "pref-risky-rule",
        artifact: `[[Brain/notes/deploy-${day}.md]]`,
        result: "applied",
        agent: "claude-dev-agent",
        outcome: "failure",
      },
      { now: new Date(`2026-06-0${day}T10:00:00Z`) },
    );
  }
  const dreamRun = dream(vault, { now: NOW });
  expect(dreamRun.outcome_regressions).toHaveLength(1);
  expect(dreamRun.outcome_regressions[0]!.id).toBe("pref-risky-rule");

  // -- Dead-end recall (8) ----------------------------------------------
  recordDeadEnd(vault, {
    approach: "Hotfixing straight to main without canary",
    reason: "Production breakage twice in one week",
    agent: "claude-dev-agent",
    now: NOW,
  });
  const dbPath = join(vault, ".open-second-brain", "brain.sqlite");
  const searchConfig = makeConfig({ vault, dbPath });
  await indexVault(searchConfig);
  // FTS is implicit-AND at chunk level: query terms that all appear in
  // the dead-end note's body.
  const recall = await search(searchConfig, { query: "canary breakage" });
  expect(recall.results.some((r) => r.path.startsWith("Brain/dead-ends/"))).toBe(true);

  // -- Weekly top-source (6) ---------------------------------------------
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  const hub = join(vault, "Brain", "notes", "deploy-policy.md");
  writeFileSync(hub, "# Deploy policy\n\nThe canary-first rollout writeup.\n");
  const linker = join(vault, "Brain", "notes", "incident-review.md");
  writeFileSync(linker, "# Incident\n\nSee [[Brain/notes/deploy-policy.md|policy]].\n");
  const inWindow = new Date("2026-06-02T10:00:00Z");
  utimesSync(hub, inWindow, inWindow);
  utimesSync(linker, inWindow, inWindow);
  const weekly = buildWeeklySynthesis(
    buildTimelineIndex(vault, {}),
    vault,
    "2026-06-04",
    BRAIN_TEMPORAL_DEFAULTS,
  );
  expect(weekly.topSource).toBeDefined();
  expect(weekly.topSource!.path).toBe("Brain/notes/deploy-policy.md");
  expect(weekly.topSource!.signals.inboundLinks).toBe(1);

  // -- Foresight (10) ------------------------------------------------------
  for (let i = 0; i < 3; i++) {
    applyRecurrenceEvidence(vault, {
      contentHash: "weekly-review",
      scope: "weekly-review",
      sourceId: `sess-${i}`,
      action: "learn",
      at: new Date(Date.parse("2026-05-14T09:00:00Z") + i * 7 * 24 * 3600 * 1000).toISOString(),
    });
  }
  const foresight = buildForesight(vault, { now: NOW });
  const recurring = foresight.upcoming.find((u) => u.kind === "recurring")!;
  expect(recurring.due).toBe("2026-06-04");
  expect(recurring.title).toContain("weekly-review");
});

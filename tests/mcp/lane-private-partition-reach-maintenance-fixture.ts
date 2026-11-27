/**
 * Seeding helpers of `lane-private-partition-reach-maintenance.test.ts`:
 * a pending skill proposal, the learn sequence of a name a person
 * rejected in private, and a search index for bridge discovery over one
 * private and two open notes. Everything lives in the test's own store.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "bun:test";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { skillProposalPendingPath, skillProposalRejectedPath } from "../../src/core/brain/paths.ts";
import { listPendingSkillProposals } from "../../src/core/brain/skill-proposals.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import {
  laneEntryInPrivate,
  readLaneText,
  writeLanePage,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import type { MCPServer } from "../../src/mcp/server.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION, call, localServer } from "./lane-private-partition-reach-writes-fixture.ts";

const NOW = new Date("2026-11-20T10:00:00Z");

/** A pending proposal page for `slug`; private when `body` carries a private region. */
export function writeProposal(vault: string, slug: string, body: string): void {
  writeLanePage(
    vault,
    skillProposalPendingPath(vault, slug),
    {
      schema_version: 1,
      kind: "brain-skill-proposal",
      id: `prop-${slug}`,
      slug,
      status: "pending",
      pattern_kind: "repeated_action",
      version: "1",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
    `# ${slug}\n\n${body}\n`,
  );
}

/** Session turns of one repeated action, `count` days from `day`. */
function seedTurns(vault: string, action: string, firstDay: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const day = String(firstDay + i).padStart(2, "0");
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: `2026-05-${day}T08:10:00Z`,
      sourceRefs: [{ id: `src-${action}-${day}` }],
      payload: { action, summary: `Run ${action} for batch ${firstDay + i}` },
    });
  }
}

/**
 * A local learn drafts the repeated action; a person rejects it (with a
 * private note when `privately`: the rejected copy is then held in
 * `private`); new turns of the same action arrive. Returns the rejected
 * proposal's id.
 */
export async function seedRejectedName(
  e: LaneEnv,
  local: MCPServer,
  privately: boolean,
): Promise<string> {
  const { vault } = e;
  seedTurns(vault, "zqmaintaction", 1, 4);
  const learned = await call(local, "brain_skill_proposals", {
    operation: "learn",
    min_support: 3,
  });
  expect((JSON.parse(learned) as Record<string, unknown>)["error"]).toBeUndefined();
  const drafted = listPendingSkillProposals(vault).find(
    (p) => p.slug.includes("zqmaintaction") && p.patternKind === "repeated_action",
  );
  expect(drafted).toBeDefined();
  const rejected = await call(local, "brain_skill_proposals", {
    operation: "reject",
    slug: drafted!.slug,
    note: privately ? `not this one ${REGION}` : "not this one",
  });
  expect(rejected).not.toContain("error");
  const path = skillProposalRejectedPath(vault, drafted!.slug);
  expect(laneEntryInPrivate(vault, path)).toBe(privately);
  seedTurns(vault, "zqmaintaction", 10, 4);
  return drafted!.id;
}

/**
 * {@link seedRejectedName} with the rejection in `private`, then `learner`
 * learns. Returns its answer, the pending proposals of the rejected name
 * afterwards (read at local reach) and the rejected proposal's id.
 */
export async function learnRejectedName(
  e: LaneEnv,
  learner: MCPServer,
): Promise<{ answer: string; resurfaced: string[]; rejectedId: string }> {
  const { vault } = e;
  const rejectedId = await seedRejectedName(e, localServer(e), true);
  const answer = await call(learner, "brain_skill_proposals", {
    operation: "learn",
    min_support: 3,
  });
  const resurfaced = listPendingSkillProposals(vault)
    .filter((p) => p.slug.includes("zqmaintaction") && p.patternKind === "repeated_action")
    .map((p) => p.slug);
  return { answer, resurfaced, rejectedId };
}

/**
 * Three notes for bridge discovery (one reserved by its frontmatter, two
 * open), all on one topic, and a search index with embeddings over them.
 * Returns a pair naming the reserved note and a pair of the open notes.
 */
export async function seedBridgeIndex(
  e: LaneEnv,
): Promise<{ privatePair: [string, string]; openPair: [string, string] }> {
  const { vault } = e;
  appendFileSync(
    e.env.configPath,
    [
      "search_semantic_enabled: true",
      "embedding_provider: local",
      "embedding_dimension: 256",
      "",
    ].join("\n"),
  );
  mkdirSync(join(vault, "Notes"), { recursive: true });
  const text =
    "Ship the canary release to one production instance, watch error rates, " +
    "expand the deployment gradually, roll back on regression.";
  writeFileSync(join(vault, "Notes", "alpha-deploy.md"), `# Canary runbook\n\n${text}\n`);
  writeFileSync(join(vault, "Notes", "gamma-deploy.md"), `# Canary steps\n\n${text}\n`);
  writeFileSync(
    join(vault, "Notes", "beta-deploy.md"),
    `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\n# Deployment checklist\n\n${text}\n`,
  );
  await indexVault(resolveSearchConfig({ vault, configPath: e.env.configPath }), {
    embeddings: true,
  });
  return {
    privatePair: ["Notes/alpha-deploy.md", "Notes/beta-deploy.md"],
    openPair: ["Notes/alpha-deploy.md", "Notes/gamma-deploy.md"],
  };
}

/**
 * The operator marks the bridge artifact and the dismissal list private
 * (each rewritten at local reach with a `visibility: [private]` field):
 * both are then held in `private`. Returns their paths.
 */
export function raiseBridgeArtifacts(vault: string): { proposals: string; dismissed: string } {
  const proposals = join(vault, "Brain", "proposals", "bridges.md");
  const dismissed = join(vault, "Brain", "proposals", "bridges-dismissed.json");
  const page = readLaneText(vault, proposals);
  expect(page).not.toBeNull();
  writeLaneText(vault, proposals, page!.replace(/^---\n/, "---\nvisibility: [private]\n"));
  const list = JSON.parse(readLaneText(vault, dismissed) ?? "{}") as Record<string, unknown>;
  writeLaneText(vault, dismissed, JSON.stringify({ ...list, visibility: ["private"] }, null, 2));
  expect(laneEntryInPrivate(vault, proposals)).toBe(true);
  expect(laneEntryInPrivate(vault, dismissed)).toBe(true);
  return { proposals, dismissed };
}

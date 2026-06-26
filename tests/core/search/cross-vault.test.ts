/**
 * Cross-vault union search (Workspace Insight Suite, t_72a22658):
 * one query fans out over the active vault, registered profile vaults,
 * and read-only recall sources; results merge by score with origin
 * labels; a failing origin degrades to a warning, never an error.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProfile } from "../../../src/core/brain/portability/profiles.ts";
import { addRecallSource } from "../../../src/core/brain/portability/recall-sources.ts";
import { listSearchOrigins } from "../../../src/core/brain/portability/origins.ts";
import { searchAcrossVaults } from "../../../src/core/search/cross-vault.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { writeMd } from "../../helpers/search-fixtures.ts";

let tmp: string;
let active: string;
let external: string;
let configPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cross-vault-"));
  active = join(tmp, "active-vault");
  external = join(tmp, "external-vault");
  mkdirSync(join(active, "Brain"), { recursive: true });
  mkdirSync(join(external, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${active}"\n`);

  writeMd(active, "Brain/notes/local-note.md", "# Local\n\nThe griffin nests in the local vault.");
  writeMd(
    external,
    "Brain/notes/external-note.md",
    "# External\n\nThe griffin also visits the external vault aviary.",
  );
  await indexVault(resolveSearchConfig({ vault: active, configPath }));
  await indexVault(resolveSearchConfig({ vault: external, configPath }));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("listSearchOrigins enumerates active, profiles, and sources, deduped by path", () => {
  createProfile(configPath, "work", external);
  createProfile(configPath, "same-as-active", active);
  addRecallSource(configPath, active, "team", external);
  const origins = listSearchOrigins(configPath, active);
  // active first, then the profile; the source duplicates the profile's
  // path and the profile duplicating the active vault is dropped.
  expect(origins.map((o) => o.label)).toEqual(["local", "profile/work"]);
  expect(origins[0]!.kind).toBe("active");
});

test("union search labels results with their origin and merges by score", async () => {
  addRecallSource(configPath, active, "team", external);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
  const labels = new Set(outcome.results.map((r) => r.origin));
  expect(labels).toEqual(new Set(["local", "source/team"]));
  for (const r of outcome.results) {
    expect(r.reasons.some((reason) => reason.startsWith("origin:"))).toBe(true);
  }
  const scores = outcome.results.map((r) => r.score);
  expect([...scores].toSorted((a, b) => b - a)).toEqual(scores);
});

test("an origin without an index degrades to a warning and writes nothing", async () => {
  const bare = join(tmp, "bare-vault");
  mkdirSync(join(bare, "Brain"), { recursive: true });
  addRecallSource(configPath, active, "bare", bare);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
  expect(outcome.results.length).toBeGreaterThan(0);
  expect(outcome.warnings.some((w) => w.includes("source/bare"))).toBe(true);
  // Read-only invariant: the union search never builds an index inside
  // an external vault.
  expect(existsSync(join(bare, ".open-second-brain", "brain.sqlite"))).toBe(false);
});

test("limit applies to the merged result set", async () => {
  addRecallSource(configPath, active, "team", external);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 1 });
  expect(outcome.results).toHaveLength(1);
  expect(outcome.total).toBeGreaterThanOrEqual(2);
});

test("single-origin union (no profiles, no sources) matches plain search shape", async () => {
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 5 });
  expect(outcome.results.length).toBeGreaterThan(0);
  expect(outcome.results.every((r) => r.origin === "local")).toBe(true);
});

// t_fd411665 - cards-mode (disclosure: "cards") must compose with the union:
// each origin returns its hits on `outcome.cards` with `results` empty, and the
// union has to merge the cards, not silently drop them.
test("cards mode: cards from every origin merge, labelled, with results empty", async () => {
  addRecallSource(configPath, active, "team", external);
  const outcome = await searchAcrossVaults(configPath, active, {
    query: "griffin",
    limit: 10,
    disclosure: "cards",
  });
  expect(outcome.results).toHaveLength(0);
  expect(outcome.cards).toBeDefined();
  const labels = new Set((outcome.cards ?? []).map((c) => c.origin));
  expect(labels).toEqual(new Set(["local", "source/team"]));
  for (const c of outcome.cards ?? []) {
    expect(c.reasons.some((reason) => reason.startsWith("origin:"))).toBe(true);
  }
  const scores = (outcome.cards ?? []).map((c) => c.score);
  expect([...scores].toSorted((a, b) => b - a)).toEqual(scores);
});

test("cards mode: limit caps the merged card set", async () => {
  addRecallSource(configPath, active, "team", external);
  const outcome = await searchAcrossVaults(configPath, active, {
    query: "griffin",
    limit: 1,
    disclosure: "cards",
  });
  expect(outcome.cards).toHaveLength(1);
  expect(outcome.results).toHaveLength(0);
  expect(outcome.total).toBeGreaterThanOrEqual(2);
});

test("cards mode: chain-stop gates on the top CARD score and skips remaining origins", async () => {
  addRecallSource(configPath, active, "team", external);
  // Threshold 0: the active origin's cards clear it, so the external origin is
  // never searched. Proves the gate reads the card score when results is empty.
  writeFileSync(
    configPath,
    `vault: "${active}"\nsearch_chain_stop_enabled: true\nsearch_chain_stop_score: 0\n`,
  );
  const outcome = await searchAcrossVaults(configPath, active, {
    query: "griffin",
    limit: 10,
    disclosure: "cards",
  });
  expect((outcome.cards ?? []).every((c) => c.origin === "local")).toBe(true);
  expect(outcome.chainStop?.triggered).toBe(true);
  expect(outcome.chainStop?.stoppedAfter).toBe("local");
  expect(outcome.chainStop?.skipped).toEqual(["source/team"]);
});

// D4 t_23c1b929 - normalized-confidence chain-stop for cross-vault early termination.
function withChainStop(score: number): void {
  // Re-resolve every origin from config.yaml, so the knob reaches the
  // active origin the cross-vault loop gates on.
  writeFileSync(
    configPath,
    `vault: "${active}"\nsearch_chain_stop_enabled: true\nsearch_chain_stop_score: ${score}\n`,
  );
}

test("chain-stop on: a confident active origin skips the remaining origins", async () => {
  addRecallSource(configPath, active, "team", external);
  // Threshold 0: any non-empty origin clears it, so the active origin
  // alone answers and the external origin is never searched.
  withChainStop(0);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
  expect(outcome.results.every((r) => r.origin === "local")).toBe(true);
  expect(outcome.chainStop).toBeDefined();
  expect(outcome.chainStop?.triggered).toBe(true);
  expect(outcome.chainStop?.stoppedAfter).toBe("local");
  expect(outcome.chainStop?.skipped).toEqual(["source/team"]);
});

test("chain-stop gates on the normalized score, never raw: a sub-threshold top does not stop", async () => {
  addRecallSource(configPath, active, "team", external);
  // The active origin's top NORMALIZED score for this fixture is ~0.65,
  // well under 0.9, so the gate must not fire and every origin is searched.
  // The raw FTS/BM25 lane score is far higher than 0.9, so this also proves
  // the gate reads the normalized result score, not the raw lane score.
  withChainStop(0.9);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
  const labels = new Set(outcome.results.map((r) => r.origin));
  expect(labels).toEqual(new Set(["local", "source/team"]));
  expect(outcome.chainStop).toBeUndefined();
});

test("chain-stop off (default) runs every origin bit-identically and records no chainStop", async () => {
  addRecallSource(configPath, active, "team", external);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
  const labels = new Set(outcome.results.map((r) => r.origin));
  expect(labels).toEqual(new Set(["local", "source/team"]));
  expect(outcome.chainStop).toBeUndefined();
});

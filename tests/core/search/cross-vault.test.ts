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
import {
  RETRIEVAL_DEGRADATION,
  RETRIEVAL_DETAIL_IDENTIFIER,
} from "../../../src/core/search/retrieval-trail.ts";
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

  // The active note answers "griffin" completely and "aviary-keeper"
  // only in part: SQLite's tokenizer splits the hyphen, so the row MATCHES
  // on `aviary` + `keeper`, while the coverage engine's containment test
  // looks for the literal term and does not find it. That is what gives
  // the chain-stop test below an origin that genuinely returns rows and
  // genuinely half-answers - see its own comment for why a fixture that
  // returns no rows cannot test that gate at all.
  writeMd(
    active,
    "Brain/notes/local-note.md",
    "# Local\n\nThe griffin nests in the local vault beside the aviary keeper.",
  );
  writeMd(
    external,
    "Brain/notes/external-note.md",
    "# External\n\nThe griffin also visits the external vault aviary-keeper.",
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
  // The failure's own message never reaches this channel: it can name the
  // external index file, and warnings travel verbatim into MCP payloads.
  // What travels instead is the origin label, the typed SearchError code
  // and one fix.
  expect(outcome.warnings.some((w) => w.includes(bare))).toBe(false);
  expect(outcome.warnings.some((w) => w.includes("INDEX_MISSING"))).toBe(true);
  // And the same fact as a code, so a caller does not have to read prose.
  const entry = outcome.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.crossVaultOriginFailed,
  );
  expect(entry?.detail).toEqual({ origin: "source/bare", cause: "INDEX_MISSING" });
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
  // Origins deliberately not searched are a narrowing, and the trail is
  // the first surface that says so - `chainStop` reached no caller.
  const stopped = outcome.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.crossVaultChainStopped,
  );
  expect(stopped?.detail).toEqual({ stoppedAfter: "local", skipped: 1 });
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
  // Origins deliberately not searched are a narrowing, and the trail is
  // the first surface that says so - `chainStop` reached no caller.
  const stopped = outcome.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.crossVaultChainStopped,
  );
  expect(stopped?.detail).toEqual({ stoppedAfter: "local", skipped: 1 });
});

test("chain-stop gates on coverage: an origin that half-answers does not stop the chain", async () => {
  addRecallSource(configPath, active, "team", external);
  // The active origin RETURNS A ROW for this query and covers only half
  // of it: `aviary-keeper` matches its note through the tokenizer's
  // hyphen split, and is not contained in it as a term. Under a 0.9
  // coverage threshold the chain must walk on and find the origin that
  // holds the missing half.
  //
  // The row count is the whole point of the fixture. An earlier version
  // of this test asked for terms the active vault did not have at all, so
  // the origin returned ZERO rows and the gate short-circuited on
  // `hits.length > 0` before reading any threshold - reverting the gate
  // to the old top-score rule left it green. A test of a threshold has to
  // reach the threshold.
  //
  // This is the assertion the old score-based gate could not make. Its
  // quantity was the top NORMALIZED result score, which the keyword lane
  // min-max normalises within each origin's own pool - so it said the same
  // thing about an origin that answered everything and one that answered a
  // fragment, and it meant opposite things under the two fusion modes
  // (unreachable in `linear`, always met in `rrf`).
  // 0.6 rather than 0.9, and the band matters: the active origin's
  // coverage here is 0.5 - the two terms carry equal IDF and one is
  // covered - while its top SCORE is ~0.65, so this threshold sits
  // BETWEEN the two quantities. A threshold above both (0.9) is cleared
  // by neither, which is why the earlier 0.9 version of this test stayed
  // green when the gate was reverted to the score.
  withChainStop(0.6);
  const outcome = await searchAcrossVaults(configPath, active, {
    query: "griffin aviary-keeper",
    limit: 10,
  });
  // The gate was reached with rows in hand…
  expect(outcome.results.some((r) => r.origin === "local")).toBe(true);
  // …and refused them, so the origin holding the other half is searched.
  expect(outcome.chainStop).toBeUndefined();
  expect(new Set(outcome.results.map((r) => r.origin))).toContain("source/team");
  // The union's quality is the best origin's, and the external origin
  // covers the query whole.
  expect(outcome.idfWeightedCoverage).toBe(1);
});

test("chain-stop fires when the first origin covers the question", async () => {
  addRecallSource(configPath, active, "team", external);
  // The mirror of the case above: every significant term of this query is
  // covered by the active origin, so the remaining origins add nothing the
  // caller asked for and the chain stops - which is what the knob has
  // always claimed to do and, on the shipped default fusion mode, never
  // did.
  withChainStop(0.9);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
  expect(outcome.chainStop?.triggered).toBe(true);
  expect(new Set(outcome.results.map((r) => r.origin))).toEqual(new Set(["local"]));
});

/**
 * The trail's `detail` rule is one rule for every lane, and these are the
 * only codes whose identifiers are NAMESPACED: an origin label is
 * `profile/<name>` or `source/<alias>`, the same string the results carry
 * on `origin` and in their `origin:<label>` reason. A test that only ever
 * exercises the trigram lane's `shadow_incomplete` cannot see that, which
 * is how the rule and its writers came to disagree in silence.
 */
test("cross-vault detail values are identifiers under the trail's shared rule", async () => {
  const other = join(tmp, "other-vault");
  mkdirSync(join(other, "Brain"), { recursive: true });
  writeMd(other, "Brain/notes/other-note.md", "# Other\n\nThe aviary keeper feeds the griffin.");
  await indexVault(resolveSearchConfig({ vault: other, configPath }));
  const bare = join(tmp, "bare-vault");
  mkdirSync(join(bare, "Brain"), { recursive: true });
  addRecallSource(configPath, active, "bare", bare);
  addRecallSource(configPath, active, "team", external);
  addRecallSource(configPath, active, "other", other);
  withChainStop(0);

  // "feeds" is absent from the active vault, so the union walks past it:
  // source/bare cannot be read, source/other answers confidently, and
  // source/team is deliberately skipped - one origin-failed entry and one
  // chain-stopped entry, each keyed by a namespaced origin label.
  const outcome = await searchAcrossVaults(configPath, active, { query: "feeds", limit: 10 });

  const degraded = outcome.retrievalTrail?.degraded ?? [];
  const codes = degraded.map((d) => d.code);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.crossVaultOriginFailed);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.crossVaultChainStopped);
  const values = degraded.flatMap((d) => Object.values(d.detail ?? {}));
  // The shape the trigram-only assertion could never reach.
  expect(values.some((v) => typeof v === "string" && v.includes("/"))).toBe(true);
  for (const value of values) {
    if (typeof value === "number") {
      expect(Number.isFinite(value)).toBe(true);
      continue;
    }
    expect(value).toMatch(RETRIEVAL_DETAIL_IDENTIFIER);
  }
});

test("chain-stop off (default) runs every origin bit-identically and records no chainStop", async () => {
  addRecallSource(configPath, active, "team", external);
  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
  const labels = new Set(outcome.results.map((r) => r.origin));
  expect(labels).toEqual(new Set(["local", "source/team"]));
  expect(outcome.chainStop).toBeUndefined();
});

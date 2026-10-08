/**
 * Serve-with-correction coupling on the search pipeline
 * (truth-correctable-time-aware, Task 18).
 *
 * The post-rank retired-row branch consumes `couplingVerdict`: a
 * retired-but-serveable row is served only beside its resolved, readable
 * chain-tip correction and is dropped otherwise. Correction content pulled
 * in re-runs the full caller filter set (status, visibility scope, agent
 * scope, reach), closing the recorded gap where polarity-pulled successors
 * bypassed visibility and agent scope. With no retired rows the pool is
 * unchanged, and tombstoned rows stay dropped by the status filter before
 * the predicate runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let config: ResolvedSearchConfig;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("post-rank-coupling"));
  config = makeConfig({ vault, dbPath });
});

afterEach(() => cleanup());

/** A page frontmatter block plus body, written vault-relative. */
function page(rel: string, frontmatter: ReadonlyArray<string>, body: string): void {
  const head = frontmatter.length === 0 ? "" : `---\n${frontmatter.join("\n")}\n---\n`;
  writeMd(vault, rel, `${head}\n${body}\n`);
}

const CORRECTION_REASON_PREFIX = "correction_for:";

function paths(results: ReadonlyArray<{ readonly path: string }>): string[] {
  return results.map((r) => r.path).toSorted();
}

/** A result's stable projection: everything the wall clock does not own. */
function stable(r: { path: string; reasons: ReadonlyArray<string> }): {
  path: string;
  reasons: ReadonlyArray<string>;
} {
  return {
    path: r.path,
    reasons: r.reasons.filter((reason) => !reason.startsWith("recency:")),
  };
}

describe("post-rank coupling", () => {
  test("a retired-but-serveable row is served beside its chain-tip correction", async () => {
    page("predecessor.md", ['superseded_by: "[[mid-step]]"'], "falcon migration corridor map.");
    page("mid-step.md", ['superseded_by: "[[correction-tip]]"'], "waypoint ledger for the survey.");
    page("correction-tip.md", [], "settled wing morphology measurements.");
    await indexVault(config);

    // Only the predecessor matches the query, so the chain tip can only
    // arrive by coupling pull-in, never by its own rank.
    const out = await search(config, { query: "falcon migration corridor", limit: 10 });
    expect(out.results.some((r) => r.path === "predecessor.md")).toBe(true);
    const tip = out.results.find((r) => r.path === "correction-tip.md");
    expect(tip).toBeDefined();
    expect(tip!.reasons).toContain(`${CORRECTION_REASON_PREFIX} predecessor.md`);
    // The non-tip mid step is not the correction; only the tip is pulled
    // in by coupling. (mid-step itself arrives through the polarity
    // phase's successor pull-in, and stays: its own chain tip is the same
    // readable correction, so it is served coupled too.)
    const mid = out.results.find((r) => r.path === "mid-step.md");
    if (mid !== undefined) {
      expect(mid!.reasons.some((reason) => reason.startsWith(CORRECTION_REASON_PREFIX))).toBe(
        false,
      );
    }
  });

  test("a retired row whose chain tip is unresolved is dropped fail-closed", async () => {
    page("orphan-predecessor.md", ['superseded_by: "[[ghost-page]]"'], "alloy composition table.");
    await indexVault(config);

    const out = await search(config, { query: "alloy composition table", limit: 10 });
    expect(out.results.some((r) => r.path === "orphan-predecessor.md")).toBe(false);
  });

  test("a retired row is dropped when its correction is outside the caller's agent scope", async () => {
    page(
      "scoped-predecessor.md",
      ['superseded_by: "[[private-correction]]"'],
      "nickel plating bath recipe.",
    );
    page("private-correction.md", ["owner: agent-a"], "revised nickel plating bath recipe.");
    await indexVault(config);

    const scoped = await search(config, {
      query: "nickel plating bath recipe",
      limit: 10,
      agentScope: "agent-b",
    });
    expect(scoped.results.some((r) => r.path === "scoped-predecessor.md")).toBe(false);
    expect(scoped.results.some((r) => r.path === "private-correction.md")).toBe(false);

    const unscoped = await search(config, { query: "nickel plating bath recipe", limit: 10 });
    expect(paths(unscoped.results)).toEqual(["private-correction.md", "scoped-predecessor.md"]);
  });

  test("a retired row is dropped when its correction is outside the caller's visibility scope", async () => {
    page(
      "tagged-predecessor.md",
      ['superseded_by: "[[tagged-correction]]"'],
      "harbor depth survey.",
    );
    page("tagged-correction.md", ["visibility: internal"], "revised harbor depth survey.");
    await indexVault(config);

    const inside = await search(config, {
      query: "harbor depth survey",
      limit: 10,
      visibility: ["internal"],
    });
    expect(paths(inside.results)).toEqual(["tagged-correction.md", "tagged-predecessor.md"]);

    const outside = await search(config, {
      query: "harbor depth survey",
      limit: 10,
      visibility: ["external"],
    });
    expect(outside.results.some((r) => r.path === "tagged-predecessor.md")).toBe(false);
    expect(outside.results.some((r) => r.path === "tagged-correction.md")).toBe(false);
  });

  test("a tombstoned retired row stays dropped even though its correction is readable", async () => {
    page(
      "tombstoned-predecessor.md",
      ["_status: tombstoned", 'superseded_by: "[[correction-tip]]"'],
      "aperture coupling constant, retracted.",
    );
    page("correction-tip.md", [], "revised aperture coupling constant.");
    await indexVault(config);

    const out = await search(config, { query: "aperture coupling constant", limit: 10 });
    expect(out.results.some((r) => r.path === "tombstoned-predecessor.md")).toBe(false);
    expect(paths(out.results)).toEqual(["correction-tip.md"]);
  });

  test("a pool with no retired rows is unchanged: no drops and no coupling provenance", async () => {
    page("plain-a.md", [], "orchard pruning in early spring.");
    page("plain-b.md", [], "orchard irrigation schedules.");
    await indexVault(config);

    const first = await search(config, { query: "orchard", limit: 10 });
    const second = await search(config, { query: "orchard", limit: 10 });
    expect(paths(first.results)).toEqual(["plain-a.md", "plain-b.md"]);
    for (const r of first.results) {
      expect(r.reasons.some((reason) => reason.startsWith(CORRECTION_REASON_PREFIX))).toBe(false);
    }
    // Recency scores carry the wall clock, so two runs compare on the
    // stable projection only: which rows, in which order, with which
    // non-clock provenance. The pin is the absence of coupling edits.
    expect(first.results.map(stable)).toEqual(second.results.map(stable));
  });
});

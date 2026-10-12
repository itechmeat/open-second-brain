/**
 * `brain_search` surfaces the explainable-recall `reasons` array on
 * every result. Exercises the tool through the same handler path the
 * MCP server uses, against a freshly indexed scratch vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

/** A round commit token shared by the partition probes; assembled from parts. */
const COMMIT_TOKEN = fakeCredential("drt", "-3-abc");

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-reasons-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-reasons-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "alpha.md"),
    "---\ntitle: Alpha\n---\n\nThe quick brown fox jumps over the lazy dog.\n",
  );
  ctx = { vault, configPath };
  const config = resolveSearchConfig({ vault, configPath: ctx.configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search reasons", () => {
  test("every result carries a non-empty reasons array", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search");
    expect(tool).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool!.handler(ctx as any, { query: "quick fox" })) as {
      results: Array<{ reasons: string[] }>;
      total: number;
    };
    expect(out.total).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(Array.isArray(r.reasons)).toBe(true);
      expect(r.reasons.length).toBeGreaterThan(0);
      // keyword-only scratch vault → at least the bm25 layer is present.
      expect(r.reasons.some((x) => x.startsWith("fts5_bm25"))).toBe(true);
    }
  });
});

// ----- Iterative cache-key compatibility (recall-quality wave, lane A) ----

/**
 * The query-cache key composition is a documented compatibility surface
 * (cache-slot.ts header): the iterative fields may join ONLY as a
 * mode-on suffix appended to the config fingerprint, so plain rows keep
 * their pre-wave keys byte-identical, a plan leg and a commit leg never
 * collide with each other or with a plain row, and a flag-without-knob
 * request stays keyed exactly like a plain one. The single-use token
 * registry rides the same table with its own TTL.
 */
describe("brain_search iterative cache keys", () => {
  const planHash = "plan-hash-stable";
  const policy = { explicit: false, wantSemantic: false };

  async function keyFor(opts: Record<string, unknown>): Promise<string> {
    const { Store } = await import("../../src/core/search/store.ts");
    const { probeQueryCache } = await import("../../src/core/search/pipeline/cache-slot.ts");
    const config = resolveSearchConfig({ vault, configPath: ctx.configPath });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const probe = probeQueryCache({
        store,
        config,
        opts: opts as unknown as Parameters<typeof probeQueryCache>[0]["opts"],
        limit: 10,
        policy,
        sessionFocus: null,
        tuned: null,
        planHash,
      });
      if (probe.slot === null) throw new Error("cache probe returned no slot");
      return probe.slot.key;
    } finally {
      await store.close();
    }
  }

  test("the mode-on suffix partitions plan, commit and plain rows; off-mode keys are unchanged", async () => {
    // The suffix exists only when the mode is actually on, so this test
    // runs with the operator's knob on (env-mirrored like its siblings).
    const saved = process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] = "true";
    try {
      await partitionedKeys();
    } finally {
      if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
      else process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] = saved;
    }
  });

  async function partitionedKeys(): Promise<void> {
    const base = { query: "quick fox", iterative: false };
    const plain = await keyFor({ query: "quick fox" });
    // Flag off and flag-absent key identically: no suffix bytes exist.
    expect(await keyFor(base)).toBe(plain);
    const plan = await keyFor({ query: "quick fox", iterative: true });
    const commit = await keyFor({
      query: "quick fox",
      iterative: true,
      iterativeToken: COMMIT_TOKEN,
      iterativePayload: { evidence: [1], subQueries: ["q"] },
    });
    const commitOtherPayload = await keyFor({
      query: "quick fox",
      iterative: true,
      iterativeToken: COMMIT_TOKEN,
      iterativePayload: { evidence: [2], subQueries: ["q"] },
    });
    // Three disjoint rows: plain, plan, commit - and a different payload
    // is a different commit key.
    expect(plan).not.toBe(plain);
    expect(commit).not.toBe(plain);
    expect(commit).not.toBe(plan);
    expect(commitOtherPayload).not.toBe(commit);
  }

  test("a flag without the operator's knob is keyed exactly like a plain row", async () => {
    // The default config has the iterative knob OFF, so the mode is inert
    // end to end: no suffix, the plain key.
    const plain = await keyFor({ query: "quick fox" });
    const flagged = await keyFor({ query: "quick fox", iterative: true });
    expect(flagged).toBe(plain);
  });

  test("a minted round token validates, claims once, and releases back to retryable", async () => {
    const { Store } = await import("../../src/core/search/store.ts");
    const {
      claimIterativeToken,
      iterativeTokenSpent,
      mintIterativeToken,
      readIterativeTokenRecord,
      releaseIterativeToken,
    } = await import("../../src/core/search/pipeline/cache-slot.ts");
    const config = resolveSearchConfig({ vault, configPath: ctx.configPath });
    const store = await Store.open(config, { mode: "read", loadVec: false });
    try {
      const now = 1_750_000_000_000;
      // A nonce-mint-shaped token, assembled from parts (never a literal).
      const token = fakeCredential("drt-3-", "5f1e", "2d3c4b5a69788796a5b4");
      expect(iterativeTokenSpent(store, config, token, now)).toBe(false);
      expect(readIterativeTokenRecord(store, config, token, now)).toBeNull();
      // The plan phase files the pause digest and the recorded round
      // count under the nonce token; the commit reads the row back and
      // validates its replayed state against the digest, then replays
      // exactly the recorded rounds.
      expect(
        mintIterativeToken(
          store,
          config,
          token,
          { pauseDigest: "pausedigest-01", rounds: 2, stopReason: "round_cap" },
          now,
        ),
      ).toBe(true);
      expect(readIterativeTokenRecord(store, config, token, now)).toEqual({
        pauseDigest: "pausedigest-01",
        rounds: 2,
        stopReason: "round_cap",
      });
      expect(iterativeTokenSpent(store, config, token, now)).toBe(false);
      // The claim is insert-once: the second racing commit's claim loses,
      // and the spent marker outrides the mint row it sits beside.
      expect(claimIterativeToken(store, config, token, now)).toBe(true);
      expect(claimIterativeToken(store, config, token, now)).toBe(false);
      expect(iterativeTokenSpent(store, config, token, now)).toBe(true);
      expect(readIterativeTokenRecord(store, config, token, now)).toEqual({
        pauseDigest: "pausedigest-01",
        rounds: 2,
        stopReason: "round_cap",
      });
      // A failed round releases its own claim: the token reads unspent
      // and its mint row (the retry's validation source) survives.
      releaseIterativeToken(store, token);
      expect(iterativeTokenSpent(store, config, token, now)).toBe(false);
      expect(readIterativeTokenRecord(store, config, token, now)).toEqual({
        pauseDigest: "pausedigest-01",
        rounds: 2,
        stopReason: "round_cap",
      });
      // Every registry row dies with the TTL: a token whose plan phase
      // expired can be neither validated nor replayed.
      const ttlMs = config.recall.cacheTtlSeconds * 1000;
      expect(iterativeTokenSpent(store, config, token, now + ttlMs + 1)).toBe(false);
      expect(readIterativeTokenRecord(store, config, token, now + ttlMs + 1)).toBeNull();
    } finally {
      await store.close();
    }
  });
});

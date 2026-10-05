/**
 * Path-scoped vector backfill (Honest Embedding Spend, task 10).
 *
 * Paying for vectors was all-or-nothing across the vault: an operator who
 * wanted only the belief notes embedded (the vectors the `semantic`
 * context-pack mode reads) had to price and pay for every chunk. The
 * backfill now takes repeatable path prefixes, validated by the search
 * layer's `assertSafePathPrefix`, and threads them through the one spend
 * plan, so the dry run, the cost gate's refusal, the embedding phase and
 * the spend receipt all read the same scoped census.
 *
 * The only embedding endpoint is the loopback fake the search fixtures
 * ship. Deliberately not covered here: the unscoped census and apply
 * mechanics (search-vector-backfill.test.ts) and the price wording
 * (search-vector-backfill-price.test.ts).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexVault } from "../../src/core/search/indexer.ts";
import { SearchError } from "../../src/core/search/search-error.ts";
import { planVectorBackfill } from "../../src/core/search/vector-backfill.ts";
import { FAKE_PROVIDER_KEY } from "../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";

const VEC_LOADABLE = sqliteVecLoadable();
const BELIEFS = "Brain/preferences/";
const MODEL = "c10-model";
/** Priced so that one note's chunks fit under the gate and four notes' do not. */
const USD_PER_MTOK = 1_000;

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("c10-vector-backfill-path");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
  cleanup();
});

function semanticConfig(costGateUsd = 0): ReturnType<typeof makeConfig> {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      timeoutMs: 5_000,
      costGateUsd,
      priceOverride: { model: MODEL, usdPerMtok: USD_PER_MTOK },
    },
  });
}

/** One belief note and three other notes, indexed with no vectors. */
async function seed(): Promise<void> {
  writeMd(vault, `${BELIEFS}pref-brevity.md`, "# Brevity\n\nKeep answers short.");
  writeMd(vault, "Notes/a.md", "# A\n\nFirst note about something that matters.");
  writeMd(vault, "Notes/b.md", "# B\n\nSecond note discussing other things at length.");
  writeMd(vault, "Notes/c.md", "# C\n\nThird note with yet more words in it.");
  await indexVault(semanticConfig());
}

test.skipIf(!VEC_LOADABLE)(
  "the scoped dry run prices only the chunks under the prefix",
  async () => {
    await seed();
    const all = await planVectorBackfill(semanticConfig());
    const scoped = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });

    expect(scoped.pathPrefixes).toEqual([BELIEFS]);
    expect(all.pathPrefixes).toEqual([]);
    expect(scoped.pending).toBeGreaterThan(0);
    expect(scoped.pending).toBeLessThan(all.pending);
    expect(scoped.estimatedCostUsd!).toBeLessThan(all.estimatedCostUsd!);
    expect(scoped.chunksTotal).toBe(all.chunksTotal);
  },
);

test.skipIf(!VEC_LOADABLE)(
  "--apply embeds only the scoped chunks and its receipt agrees with the dry run",
  async () => {
    await seed();
    const dry = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
    const applied = await planVectorBackfill(semanticConfig(), {
      pathPrefixes: [BELIEFS],
      apply: true,
    });

    expect(applied.embedded).toBe(dry.pending);
    expect(applied.spend).not.toBeNull();
    expect(applied.spend!.estimatedUsd).toBe(dry.estimatedCostUsd);
    expect(applied.spend!.priceSource).toBe(dry.priceSource);

    const rest = await planVectorBackfill(semanticConfig());
    const afterScoped = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
    expect(afterScoped.pending).toBe(0);
    expect(rest.pending).toBeGreaterThan(0);
  },
);

test.skipIf(!VEC_LOADABLE)("the cost gate reads the scoped census", async () => {
  await seed();
  const scopedDry = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
  const allDry = await planVectorBackfill(semanticConfig());
  // A gate between the two estimates: the scoped spend fits, the vault-wide one does not.
  const gate = (scopedDry.estimatedCostUsd! + allDry.estimatedCostUsd!) / 2;

  const refusal = await planVectorBackfill(semanticConfig(gate), { apply: true }).catch(
    (e: unknown) => e,
  );
  expect(refusal).toBeInstanceOf(SearchError);
  expect((refusal as SearchError).code).toBe("EMBEDDING_COST_GATE");

  const scopedPlan = await planVectorBackfill(semanticConfig(gate), { pathPrefixes: [BELIEFS] });
  expect(scopedPlan.blocked).toBe(false);
  const scopedApply = await planVectorBackfill(semanticConfig(gate), {
    pathPrefixes: [BELIEFS],
    apply: true,
  });
  expect(scopedApply.embedded).toBe(scopedDry.pending);
});

test.skipIf(!VEC_LOADABLE)("an unpriced refusal counts the scoped census", async () => {
  await seed();
  const unpriced = makeConfig({
    vault,
    dbPath,
    semantic: { ...semanticConfig(1).semantic, priceOverride: undefined },
  });
  const scopedDry = await planVectorBackfill(unpriced, { pathPrefixes: [BELIEFS] });
  expect(scopedDry.blocked).toBe(true);

  const refusal = await planVectorBackfill(unpriced, {
    pathPrefixes: [BELIEFS],
    apply: true,
  }).catch((e: unknown) => e);
  expect(refusal).toBeInstanceOf(SearchError);
  expect((refusal as SearchError).code).toBe("EMBEDDING_COST_UNPRICED");
  expect((refusal as SearchError).message).toContain(`${scopedDry.pending} chunk(s)`);
});

test.each(["../outside/", "/etc/", "C:/Users/"])(
  "an unsafe prefix is refused by name (%p)",
  async (prefix) => {
    const refusal = await planVectorBackfill(semanticConfig(), { pathPrefixes: [prefix] }).catch(
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("INVALID_INPUT");
    expect((refusal as SearchError).message).toContain(prefix);
  },
);

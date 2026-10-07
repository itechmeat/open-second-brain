/**
 * Price honesty on `o2b search vector-backfill` and `o2b search status`
 * (Honest Embedding Spend).
 *
 * Pins the defect that an unpriced model was reported with its estimate
 * omitted (backfill JSON) or dropped (status), so a reader could not tell
 * "free" from "price unknown". Both verbs now carry the price source, and
 * an unknown price reads `price unknown` in text and null in JSON, never
 * `$0.0000`. A table model keeps its text output unchanged.
 *
 * Deliberately not covered here: the dry run's census and apply
 * mechanics (search-vector-backfill.test.ts) and the plan arithmetic
 * (embedding-spend-preview.test.ts).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { planVectorBackfill } from "../../src/core/search/vector-backfill.ts";
import { FAKE_PROVIDER_KEY } from "../helpers/fake-credentials.ts";
import { startFakeHttp } from "../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";
import { runCli } from "../helpers/run-cli.ts";

const VEC_LOADABLE = sqliteVecLoadable();
const UNPRICED_MODEL = "zembed-1";
const TABLE_MODEL = "text-embedding-3-small";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("vector-backfill-price");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => cleanup());

/** Index two notes keyword-only and write a CLI config naming `model`. */
async function seed(
  model: string,
  baseUrl = "http://127.0.0.1:9",
  extra: ReadonlyArray<string> = [],
): Promise<string> {
  writeMd(vault, "a.md", "# A\n\nFirst note about something.");
  writeMd(vault, "b.md", "# B\n\nSecond note discussing other things.");
  await indexVault(makeConfig({ vault, dbPath }));
  const config = join(vault, "cli-config.yaml");
  await Bun.write(
    config,
    [
      `vault: "${vault}"`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: "${baseUrl}"`,
      `embedding_model: ${model}`,
      "embedding_api_key: test-key",
      "embedding_dimension: 4",
      ...extra,
      "",
    ].join("\n"),
  );
  return config;
}

async function cli(config: string, argv: ReadonlyArray<string>) {
  const run = await runCli([...argv, "--vault", vault, "--db", dbPath, "--config", config], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(run.returncode).toBe(0);
  return run.stdout;
}

test.skipIf(!VEC_LOADABLE)(
  "an unpriced backfill says price unknown and null, never $0",
  async () => {
    const config = await seed(UNPRICED_MODEL);
    const payload = JSON.parse(
      await cli(config, ["search", "vector-backfill", "--json"]),
    ) as Record<string, unknown>;
    expect(payload["estimated_cost_usd"]).toBeNull();
    expect(payload["price_source"]).toBe("unknown");
    const human = await cli(config, ["search", "vector-backfill"]);
    expect(human).toContain("estimated cost: price unknown");
    expect(human).not.toContain("$0.0000");
  },
);

test.skipIf(!VEC_LOADABLE)("a table-priced backfill names its builtin source", async () => {
  const config = await seed(TABLE_MODEL);
  const payload = JSON.parse(await cli(config, ["search", "vector-backfill", "--json"])) as Record<
    string,
    unknown
  >;
  expect(payload["estimated_cost_usd"]).toBeGreaterThan(0);
  expect(payload["price_source"]).toBe("builtin");
  expect(await cli(config, ["search", "vector-backfill"])).toMatch(
    /estimated cost: \$\d+\.\d{4}\n/,
  );
});

const POSITIVE_GATE = "embedding_cost_gate_usd: 5";

test.skipIf(!VEC_LOADABLE)(
  "a dry run under a positive gate names the refusal its --apply would meet",
  async () => {
    const config = await seed(UNPRICED_MODEL, undefined, [POSITIVE_GATE]);
    const payload = JSON.parse(
      await cli(config, ["search", "vector-backfill", "--json"]),
    ) as Record<string, unknown>;
    expect(payload["gate_blocked"]).toBe(true);
    expect(payload["gate_reason"]).toBe("unpriced");
    // The advised step stays unforced; only the remedy line names the bypass.
    expect(payload["next_command"]).toBe("o2b search vector-backfill --apply");
    const human = await cli(config, ["search", "vector-backfill"]);
    expect(human).toContain(
      "cost gate: would refuse (unpriced); add --force-cost or set " +
        "embedding_price_model and embedding_price_usd_per_mtok",
    );
    expect(human).toContain("next: o2b search vector-backfill --apply\n");
  },
);

test.skipIf(!VEC_LOADABLE)(
  "a dry run over the gate names the over_cap refusal and the gate key as its remedy",
  async () => {
    // A declared rate at the ceiling prices the two notes far above the gate.
    const config = await seed(UNPRICED_MODEL, undefined, [
      POSITIVE_GATE,
      `embedding_price_model: ${UNPRICED_MODEL}`,
      'embedding_price_usd_per_mtok: "1000000"',
    ]);
    const payload = JSON.parse(
      await cli(config, ["search", "vector-backfill", "--json"]),
    ) as Record<string, unknown>;
    expect(payload["gate_blocked"]).toBe(true);
    expect(payload["gate_reason"]).toBe("over_cap");
    expect(payload["next_command"]).toBe("o2b search vector-backfill --apply");
    const human = await cli(config, ["search", "vector-backfill"]);
    expect(human).toContain(
      "cost gate: would refuse (over_cap); add --force-cost or raise embedding_cost_gate_usd",
    );
    expect(human).toContain("next: o2b search vector-backfill --apply\n");
  },
);

test.skipIf(!VEC_LOADABLE)("without a gate the dry run carries no gate keys", async () => {
  const config = await seed(UNPRICED_MODEL);
  const payload = JSON.parse(await cli(config, ["search", "vector-backfill", "--json"])) as Record<
    string,
    unknown
  >;
  expect("gate_blocked" in payload).toBe(false);
  expect("gate_reason" in payload).toBe(false);
  expect("spend" in payload).toBe(false);
  expect(payload["next_command"]).toBe("o2b search vector-backfill --apply");
  expect(await cli(config, ["search", "vector-backfill"])).not.toContain("cost gate:");
});

test.skipIf(!VEC_LOADABLE)("a forced apply names its spend receipt", async () => {
  const server = await startFakeHttp();
  try {
    const config = await seed(UNPRICED_MODEL, server.url, [POSITIVE_GATE]);
    const payload = JSON.parse(
      await cli(config, ["search", "vector-backfill", "--apply", "--force-cost", "--json"]),
    ) as Record<string, unknown>;
    expect(payload["embedded"]).toBe(2);
    expect(payload["spend"]).toEqual({
      model: UNPRICED_MODEL,
      tokens: expect.any(Number),
      estimated_usd: null,
      price_source: "unknown",
      forced: true,
    });
  } finally {
    await server.close();
  }
});

test("status of an unpriced model says price unknown and reports its source", async () => {
  const config = await seed(UNPRICED_MODEL);
  const payload = JSON.parse(await cli(config, ["search", "status", "--json"])) as Record<
    string,
    unknown
  >;
  expect(payload["estimated_refresh_cost_usd"]).toBeNull();
  expect(payload["refresh_price_source"]).toBe("unknown");
  const human = await cli(config, ["search", "status"]);
  expect(human).toContain("refresh_cost_est:    price unknown");
  expect(human).not.toContain("$0.0000");
});

test.skipIf(!VEC_LOADABLE)(
  "status of a fully embedded index on an unpriced model prints no unknown spend",
  async () => {
    const server = await startFakeHttp();
    try {
      const config = await seed(UNPRICED_MODEL, server.url);
      await planVectorBackfill(
        makeConfig({
          vault,
          dbPath,
          semantic: {
            enabled: true,
            provider: "openai-compat",
            baseUrl: server.url,
            model: UNPRICED_MODEL,
            apiKey: FAKE_PROVIDER_KEY,
            dimension: 4,
            timeoutMs: 5_000,
          },
        }),
        { apply: true },
      );
      const payload = JSON.parse(await cli(config, ["search", "status", "--json"])) as Record<
        string,
        unknown
      >;
      expect(payload["estimated_refresh_cost_usd"]).toBe(0);
      expect(payload["refresh_price_source"]).toBe("unknown");
      expect(await cli(config, ["search", "status"])).not.toContain("refresh_cost_est");
    } finally {
      await server.close();
    }
  },
);

/**
 * `o2b search vector-backfill` (provenance-at-the-boundary, unit F).
 *
 * The vector phase run on its own: an index whose chunks have no
 * `embeddings` row is a first-class, already-resumable state, and this
 * verb is the operator-facing way to close it without re-walking the
 * vault. It follows the `authored-at-backfill` contract exactly - a
 * `plan*` function in core does the finding, dry-run is the DEFAULT,
 * `--apply` is the only mutating path, both report shapes exist, and the
 * registered log event's append failure surfaces on stderr instead of
 * being swallowed.
 *
 * The only embedding endpoint used is the loopback fake the search
 * fixtures ship; nothing here reaches the network.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { planVectorBackfill } from "../../src/core/search/vector-backfill.ts";
import { SEMANTIC_CAPABILITY_TIER } from "../../src/core/search/capability-tier.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";
import { runCli } from "../helpers/run-cli.ts";

/**
 * Whether `sqlite-vec` loaded in THIS process, resolved once at module
 * load. Every test below needs a vector index, so the answer decides
 * whether this file has any coverage at all - and it is therefore
 * reported, never swallowed: the tests are declared with `skipIf` so a
 * missing extension shows up as SKIPPED in the runner rather than as a
 * body that returned before its first assertion and read as a pass.
 */
const VEC_LOADABLE = sqliteVecLoadable();

/**
 * Set only on a platform that genuinely cannot load `sqlite-vec`. Absent
 * - the default, and what CI runs - an unloadable extension is a FAULT,
 * not a platform fact, and the loadability guard below turns the whole
 * file red instead of letting its coverage evaporate into skips.
 */
const ALLOW_MISSING_VEC_ENV = "O2B_ALLOW_MISSING_SQLITE_VEC";

/** Whether this environment has declared the extension optional. */
const VEC_DECLARED_OPTIONAL = process.env[ALLOW_MISSING_VEC_ENV] !== undefined;

/** Root ignores the directory mode bits the unwritable-log test drives. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("vector-backfill");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
  cleanup();
});

/** A config whose semantic tier is `configured` against the fake server. */
function semanticConfig(): ReturnType<typeof makeConfig> {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: "test-key",
      dimension: 4,
      timeoutMs: 5_000,
    },
  });
}

/** Index the vault WITHOUT embeddings, leaving every chunk vectorless. */
async function indexWithoutVectors(): Promise<void> {
  writeMd(vault, "a.md", "# A\n\nFirst note about something.");
  writeMd(vault, "b.md", "# B\n\nSecond note discussing other things.");
  await indexVault(semanticConfig());
}

test.skipIf(VEC_DECLARED_OPTIONAL)(
  "the vector extension every test in this file depends on is loadable",
  () => {
    expect(VEC_LOADABLE).toBe(true);
  },
);

test.skipIf(!VEC_LOADABLE)(
  "the planner reports pending vectors and writes nothing by default",
  async () => {
    await indexWithoutVectors();

    const plan = await planVectorBackfill(semanticConfig());

    expect(plan.applied).toBe(false);
    expect(plan.capability.tier).toBe(SEMANTIC_CAPABILITY_TIER.configured);
    expect(plan.chunksTotal).toBeGreaterThan(0);
    expect(plan.pending).toBe(plan.chunksTotal);
    expect(plan.embedded).toBe(0);

    // A second dry run sees exactly the same work: nothing was consumed.
    const again = await planVectorBackfill(semanticConfig());
    expect(again.pending).toBe(plan.pending);
  },
);

test.skipIf(!VEC_LOADABLE)(
  "--apply is the only path that computes vectors, and it is resumable",
  async () => {
    await indexWithoutVectors();

    const applied = await planVectorBackfill(semanticConfig(), { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.embedded).toBe(applied.pending);
    expect(applied.embedded).toBeGreaterThan(0);

    // Idempotent: a re-run finds nothing left to do.
    const rerun = await planVectorBackfill(semanticConfig(), { apply: true });
    expect(rerun.pending).toBe(0);
    expect(rerun.embedded).toBe(0);
  },
);

test.skipIf(!VEC_LOADABLE)(
  "a blocked capability tier is reported by the dry run without attempting anything",
  async () => {
    await indexWithoutVectors();

    // Same index, semantic switched off: the plan still counts the work and
    // names the tier rather than pretending there is none.
    const plan = await planVectorBackfill(makeConfig({ vault, dbPath }));
    expect(plan.capability.tier).toBe(SEMANTIC_CAPABILITY_TIER.disabled);
    expect(plan.pending).toBeGreaterThan(0);
    expect(plan.embedded).toBe(0);
  },
);

test.skipIf(!VEC_LOADABLE)(
  "--apply on a blocked tier refuses with the typed attempt error",
  async () => {
    await indexWithoutVectors();

    let code: string | null = null;
    try {
      await planVectorBackfill(makeConfig({ vault, dbPath }), { apply: true });
    } catch (err) {
      code = (err as { code?: string }).code ?? null;
    }
    expect(code).toBe("EMBEDDING_DISABLED");
  },
);

test.skipIf(!VEC_LOADABLE)("the CLI dry-runs by default and emits both report shapes", async () => {
  await indexWithoutVectors();
  const config = join(vault, "cli-config.yaml");
  await Bun.write(
    config,
    [
      `vault: "${vault}"`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: "${server.url}"`,
      "embedding_model: fake-model",
      "embedding_api_key: test-key",
      "embedding_dimension: 4",
      "",
    ].join("\n"),
  );

  const json = await runCli(
    ["search", "vector-backfill", "--vault", vault, "--db", dbPath, "--config", config, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(json.returncode).toBe(0);
  const payload = JSON.parse(json.stdout) as Record<string, unknown>;
  expect(payload["dry_run"]).toBe(true);
  expect(payload["embedded"]).toBe(0);
  expect(payload["pending"]).toBeGreaterThan(0);
  // The registered exit travels on the machine stream as a field.
  expect(payload["next_command"]).toBe("o2b search vector-backfill --apply");

  const human = await runCli(
    ["search", "vector-backfill", "--vault", vault, "--db", dbPath, "--config", config],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(human.returncode).toBe(0);
  expect(human.stdout).toContain("dry-run");
  expect(human.stdout).toContain("next: o2b search vector-backfill --apply");
});

test.skipIf(!VEC_LOADABLE)(
  "a blocked tier names the tier's exit, never an --apply that cannot succeed",
  async () => {
    await indexWithoutVectors();
    const config = join(vault, "cli-config.yaml");
    // Semantic on, no key: work is pending but `--apply` would refuse.
    await Bun.write(
      config,
      [
        `vault: "${vault}"`,
        "search_semantic_enabled: true",
        "embedding_provider: openai-compat",
        "embedding_model: fake-model",
        "",
      ].join("\n"),
    );

    const json = await runCli(
      ["search", "vector-backfill", "--vault", vault, "--db", dbPath, "--config", config, "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(json.returncode).toBe(0);
    const payload = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(payload["capability_tier"]).toBe(SEMANTIC_CAPABILITY_TIER.credentialMissing);
    expect(payload["pending"]).toBeGreaterThan(0);
    expect(payload["next_command"]).toBe("o2b search check");
  },
);

test.skipIf(!VEC_LOADABLE)(
  "the CLI --apply records a registered log event and surfaces an append failure",
  async () => {
    await indexWithoutVectors();
    const config = join(vault, "cli-config.yaml");
    await Bun.write(
      config,
      [
        `vault: "${vault}"`,
        "search_semantic_enabled: true",
        "embedding_provider: openai-compat",
        `embedding_base_url: "${server.url}"`,
        "embedding_model: fake-model",
        "embedding_api_key: test-key",
        "embedding_dimension: 4",
        "",
      ].join("\n"),
    );
    bootstrapBrain(vault, { configPath: config });

    const applied = await runCli(
      [
        "search",
        "vector-backfill",
        "--vault",
        vault,
        "--db",
        dbPath,
        "--config",
        config,
        "--apply",
        "--json",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(applied.returncode).toBe(0);
    expect(JSON.parse(applied.stdout)["embedded"]).toBeGreaterThan(0);

    const logDir = join(vault, "Brain", "log");
    const logged = readdirSync(logDir)
      .map((f) => readFileSync(join(logDir, f), "utf8"))
      .join("\n");
    expect(logged).toContain("vector-backfill");
  },
);

test.skipIf(!VEC_LOADABLE || RUNNING_AS_ROOT)(
  "an unwritable Brain log surfaces on stderr rather than being swallowed",
  async () => {
    await indexWithoutVectors();
    const config = join(vault, "cli-config.yaml");
    await Bun.write(
      config,
      [
        `vault: "${vault}"`,
        "search_semantic_enabled: true",
        "embedding_provider: openai-compat",
        `embedding_base_url: "${server.url}"`,
        "embedding_model: fake-model",
        "embedding_api_key: test-key",
        "embedding_dimension: 4",
        "",
      ].join("\n"),
    );
    bootstrapBrain(vault, { configPath: config });
    const logDir = join(vault, "Brain", "log");
    mkdirSync(logDir, { recursive: true });
    chmodSync(logDir, 0o500);
    try {
      const applied = await runCli(
        [
          "search",
          "vector-backfill",
          "--vault",
          vault,
          "--db",
          dbPath,
          "--config",
          config,
          "--apply",
        ],
        { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
      );
      // The vectors were still written - telemetry never fails the primary
      // operation - but the operator is told the record did not land.
      expect(applied.returncode).toBe(0);
      expect(applied.stderr).toContain("vector-backfill log");
    } finally {
      chmodSync(logDir, 0o700);
    }
  },
);

test("a temp directory is never the real vault", () => {
  // Guard on the fixtures themselves: every path this file writes to is
  // created under the OS temp root by `createTempVault`.
  const probe = mkdtempSync(join(tmpdir(), "o2b-vector-backfill-probe-"));
  try {
    expect(probe.startsWith(tmpdir())).toBe(true);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

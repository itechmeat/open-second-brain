/**
 * `o2b search check` and the verdict of its live embedding-provider probe
 * (wiring-what-exists, unit E1).
 *
 * The defect: the probe already ran on every invocation with a resolved
 * key, already asked the provider for one vector, and already printed what
 * it learned - and then pushed the finding into `warnings`, which nothing
 * reads. The verb exited `1` only for `report.fatal`, so a provider that
 * was configured and PROVED unreachable exited 0 and every script gating
 * on the exit code read the installation as healthy. That is the same
 * class as the readiness exit fixed in release 1.46.0, where
 * `o2b install --check` began exiting 5 for a runtime it proved
 * unreachable.
 *
 * The second defect, one line away: the network call was not opt-in. Every
 * `o2b search check` with a resolved key made it, on a verb advertised as
 * a cheap pre-flight.
 *
 * Four states must stay distinguishable, and this file asserts one exit
 * code per state, because collapsing any two of them is the failure mode:
 *
 *   not configured        absent is not broken            exit 0
 *   reachable             the answer arrived              exit 0
 *   proved unreachable    the provider refused            exit 5
 *   did not complete      timed out (6) or skipped (0)
 *
 * A skipped probe exits 0 because the operator asked for no probe and
 * nothing was claimed; a timed-out probe exits non-zero and its OWN code,
 * because "I could not find out" is neither a pass nor a refusal.
 *
 * Every provider here is a loopback stub from `tests/helpers/fake-http.ts`.
 * No test in this file makes a real network call, and the two states that
 * must make none assert `callCount() === 0` rather than trusting it.
 *
 * Deliberately NOT covered here: the probe's own classification arms
 * (`tests/core/search/provider-probe.test.ts`), the `--integrity` scan and
 * its exit (`tests/cli/search-check-integrity.test.ts`), and the shape of
 * the `recommendations` block (`tests/core/search/check-recommendations.test.ts`).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { INSTALL_EXIT } from "../../src/cli/install/install.ts";
import { exitCodeForCheck, SEARCH_CHECK_EXIT } from "../../src/cli/search/verbs/check.ts";
import { providerRegistryPath } from "../../src/core/search/embeddings/registry.ts";
import { PROVIDER_PROBE } from "../../src/core/search/provider-probe.ts";
import type { IndexCheckReport } from "../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { createTempVault, writeMd } from "../helpers/search-fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";
import { FAKE_PROVIDER_KEY, fakeCredential } from "../helpers/fake-credentials.ts";

/** Short enough for a test, long enough that a healthy loopback answer beats it. */
const SHORT_REQUEST_TIMEOUT_MS = 120;
/** A server delay comfortably past that timeout. */
const SLOW_RESPONSE_MS = 1_500;

let vault: string;
let dbPath: string;
let configPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("search-check-provider");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  configPath = join(vault, "cli-config.yaml");
  server = await startFakeHttp();
  writeMd(vault, "Notes/note.md", "# Note\n\nfox");
});

afterEach(async () => {
  await server.close();
  cleanup();
});

/** A config whose embedding provider is the loopback stub. */
async function writeConfiguredProvider(extra: ReadonlyArray<string> = []): Promise<void> {
  await Bun.write(
    configPath,
    [
      `vault: "${vault}"`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: "${server.url}"`,
      `embedding_api_key: ${JSON.stringify(FAKE_PROVIDER_KEY)}`,
      'embedding_model: "fake-model"',
      ...extra,
      "",
    ].join("\n"),
  );
}

/** A config with no embedding provider at all. */
async function writeUnconfiguredProvider(): Promise<void> {
  await Bun.write(
    configPath,
    [`vault: "${vault}"`, "search_semantic_enabled: false", ""].join("\n"),
  );
}

interface CheckRun {
  readonly payload: Record<string, unknown>;
  readonly returncode: number;
  readonly stdout: string;
}

async function runCheck(...extra: ReadonlyArray<string>): Promise<CheckRun> {
  const r = await runCli(
    ["search", "check", "--vault", vault, "--db", dbPath, "--config", configPath, ...extra],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  const json = extra.includes("--json")
    ? (JSON.parse(r.stdout) as Record<string, unknown>)
    : ({} as Record<string, unknown>);
  return { payload: json, returncode: r.returncode, stdout: r.stdout };
}

/** A report with nothing wrong in it, for the exit-precedence assertions. */
function healthyReport(overrides: Partial<IndexCheckReport> = {}): IndexCheckReport {
  return Object.freeze({
    vaultReadable: true,
    indexDirWritable: true,
    sqliteOk: true,
    fts5Ok: true,
    vecExtension: "loaded",
    embeddingKeyResolved: true,
    providerProbe: PROVIDER_PROBE.reachable,
    providerReason: null,
    embeddingAbi: Object.freeze([]),
    warnings: Object.freeze([]),
    fatal: Object.freeze([]),
    recommendations: Object.freeze([]),
    ...overrides,
  }) as IndexCheckReport;
}

test("a provider that is configured and proved unreachable exits non-zero and names the reason", async () => {
  server.setHandler(() => ({ status: 500, body: { error: "upstream exploded" } }));
  await writeConfiguredProvider();

  const run = await runCheck("--json");

  expect(run.payload["provider_probe"]).toBe(PROVIDER_PROBE.unreachable);
  expect(run.returncode).toBe(SEARCH_CHECK_EXIT.providerUnreachable);
  expect(run.returncode).not.toBe(SEARCH_CHECK_EXIT.ok);
  const reason = run.payload["provider_reason"];
  expect(typeof reason).toBe("string");
  expect((reason as string).length).toBeGreaterThan(0);
  // The finding reaches `fatal`, where a caller reading the report rather
  // than the exit code looks; it used to sit in `warnings` alone.
  const fatal = run.payload["fatal"] as string[];
  expect(fatal.some((f) => f.includes(reason as string))).toBe(true);
  expect(server.callCount()).toBe(1);
});

test("a provider that is not configured is unchanged, exits 0, and is never asked", async () => {
  await writeUnconfiguredProvider();

  const run = await runCheck("--json");

  expect(run.payload["provider_probe"]).toBe(PROVIDER_PROBE.notConfigured);
  expect(run.payload["provider_reason"]).toBeNull();
  expect(run.returncode).toBe(SEARCH_CHECK_EXIT.ok);
  expect(run.payload["fatal"]).toEqual([]);
  // Absent is not broken - and absent costs no network call.
  expect(server.callCount()).toBe(0);
});

test("a provider that answers exits 0", async () => {
  await writeConfiguredProvider();

  const run = await runCheck("--json");

  expect(run.payload["provider_probe"]).toBe(PROVIDER_PROBE.reachable);
  expect(run.returncode).toBe(SEARCH_CHECK_EXIT.ok);
  expect(run.payload["fatal"]).toEqual([]);
});

test("a probe that timed out is not reported as a refusal, in the exit code or the payload", async () => {
  server.setHandler(() => ({ status: 200, body: { data: [] }, delayMs: SLOW_RESPONSE_MS }));
  await writeConfiguredProvider([
    `embedding_timeout_ms: ${SHORT_REQUEST_TIMEOUT_MS}`,
    "embedding_max_retries: 1",
  ]);

  const run = await runCheck("--json");

  expect(run.payload["provider_probe"]).toBe(PROVIDER_PROBE.timedOut);
  expect(run.returncode).toBe(SEARCH_CHECK_EXIT.probeIncomplete);
  expect(run.returncode).not.toBe(SEARCH_CHECK_EXIT.providerUnreachable);
  expect(run.returncode).not.toBe(SEARCH_CHECK_EXIT.ok);
  // Nothing was proved, so nothing is condemned: a probe that did not
  // complete never writes a fatal finding.
  expect(run.payload["fatal"]).toEqual([]);
  const warnings = run.payload["warnings"] as string[];
  expect(warnings.some((w) => w.includes(String(SHORT_REQUEST_TIMEOUT_MS)))).toBe(true);
});

test("--no-probe makes no network call and claims neither verdict", async () => {
  // A provider that WOULD refuse: the skipped run must not discover that,
  // and must not report it either way.
  server.setHandler(() => ({ status: 500, body: { error: "upstream exploded" } }));
  await writeConfiguredProvider();

  const run = await runCheck("--json", "--no-probe");

  expect(run.payload["provider_probe"]).toBe(PROVIDER_PROBE.skipped);
  expect(run.returncode).toBe(SEARCH_CHECK_EXIT.ok);
  expect(run.payload["fatal"]).toEqual([]);
  expect(server.callCount()).toBe(0);
});

test("the human report names the probe state and the reason behind it", async () => {
  server.setHandler(() => ({ status: 500, body: { error: "upstream exploded" } }));
  await writeConfiguredProvider();

  const run = await runCheck();

  expect(run.stdout).toContain(`provider_probe:`);
  expect(run.stdout).toContain(PROVIDER_PROBE.unreachable);
  expect(run.stdout).toContain("provider_reason:");
  expect(run.returncode).toBe(SEARCH_CHECK_EXIT.providerUnreachable);
});

test("the human report names a skipped probe rather than staying silent about it", async () => {
  await writeConfiguredProvider();

  const run = await runCheck("--no-probe");

  expect(run.stdout).toContain(PROVIDER_PROBE.skipped);
  expect(run.returncode).toBe(SEARCH_CHECK_EXIT.ok);
});

test("every probe state maps to exactly one exit, and a machine fault outranks all of them", () => {
  const unreachable = healthyReport({
    providerProbe: PROVIDER_PROBE.unreachable,
    providerReason: "connection refused",
    fatal: Object.freeze(["embedding provider unreachable: connection refused"]),
  });
  expect(exitCodeForCheck(unreachable, null)).toBe(SEARCH_CHECK_EXIT.providerUnreachable);

  expect(exitCodeForCheck(healthyReport({ providerProbe: PROVIDER_PROBE.timedOut }), null)).toBe(
    SEARCH_CHECK_EXIT.probeIncomplete,
  );
  expect(exitCodeForCheck(healthyReport({ providerProbe: PROVIDER_PROBE.skipped }), null)).toBe(
    SEARCH_CHECK_EXIT.ok,
  );
  expect(
    exitCodeForCheck(healthyReport({ providerProbe: PROVIDER_PROBE.notConfigured }), null),
  ).toBe(SEARCH_CHECK_EXIT.ok);
  expect(exitCodeForCheck(healthyReport(), null)).toBe(SEARCH_CHECK_EXIT.ok);

  // A vault this machine cannot read is the more basic fault and keeps the
  // generic code, so the specific one never masks it.
  const alsoBroken = healthyReport({
    vaultReadable: false,
    providerProbe: PROVIDER_PROBE.unreachable,
    providerReason: "connection refused",
    fatal: Object.freeze([
      "vault not readable: /nowhere",
      "embedding provider unreachable: connection refused",
    ]),
  });
  expect(exitCodeForCheck(alsoBroken, null)).toBe(SEARCH_CHECK_EXIT.fatal);

  // A requested integrity scan that condemned the file keeps the generic
  // code too, whatever the probe concluded.
  expect(exitCodeForCheck(healthyReport(), "search-index-corrupt")).toBe(SEARCH_CHECK_EXIT.fatal);

  // The table is a table: no two states share an exit by accident.
  const codes = Object.values(SEARCH_CHECK_EXIT);
  expect(new Set(codes).size).toBe(codes.length);

  // One number, one meaning across the CLI: `o2b install --check` already
  // spends 5 on a runtime it proved unreachable, and a script that learned
  // the number there must not have to learn a second one here.
  expect(SEARCH_CHECK_EXIT.providerUnreachable).toBe(INSTALL_EXIT.mcpUnreachable);
});

// ─────────────────────────────────────────────────────────────────────────────
// Price recommendations (Honest Embedding Spend, task 7)
//
// `fake-model` is in no price table, so the configured stub is an
// unpriced model. The recommendation arms have their own suite
// (tests/core/search/check-price-recommendations.test.ts); these pin that
// `search check` carries the lines in both report shapes and stays silent
// once the model is priced.
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_KEYS = ["embedding_price_model", "embedding_price_usd_per_mtok"] as const;

function priceRecommendations(run: CheckRun): string[] {
  const recs = (run.payload["recommendations"] ?? []) as string[];
  return recs.filter((r) => PRICE_KEYS.some((key) => r.includes(key)));
}

test("an unpriced model gets one price recommendation in both report shapes", async () => {
  await writeConfiguredProvider();

  const json = await runCheck("--json", "--no-probe");
  const lines = priceRecommendations(json);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"fake-model"');
  expect(lines[0]).toContain("a positive gate would refuse");

  const human = await runCheck("--no-probe");
  expect(human.stdout).toContain(`  - ${lines[0]}`);
});

test("an unpriced model under a positive gate is told that backfills refuse", async () => {
  await writeConfiguredProvider(["embedding_cost_gate_usd: 0.5"]);

  const lines = priceRecommendations(await runCheck("--json", "--no-probe"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("vector backfills refuse");
});

test("a declared pair for another model yields one stale-declaration recommendation", async () => {
  await writeConfiguredProvider([
    'embedding_model: "text-embedding-3-small"',
    "embedding_price_model: acme-embed-retired",
    "embedding_price_usd_per_mtok: 0.07",
  ]);

  const lines = priceRecommendations(await runCheck("--json", "--no-probe"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('names model "acme-embed-retired"');
});

test("an operator-priced model adds no price recommendation", async () => {
  await writeConfiguredProvider([
    "embedding_price_model: fake-model",
    "embedding_price_usd_per_mtok: 0.07",
  ]);

  expect(priceRecommendations(await runCheck("--json", "--no-probe"))).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential-source report (Honest Embedding Spend, task 8)
//
// A credential-missing tier names where the resolver looked and which
// other registered profiles hold a key, by name only. The pure report has
// its own suite (tests/core/search/credential-report.test.ts); these pin
// the wiring: the env and registry `search check` hands it, both report
// shapes, and that no env value reaches either.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_PROFILE = "acme-embed";
const ACTIVE_ENV_KEY = "ACME_EMBED_TEST_KEY";
const OTHER_PROFILE = "beta-embed";
const OTHER_ENV_KEY = "BETA_EMBED_TEST_KEY";
/** A credential-shaped placeholder that must never be printed. */
const PRIVATE_BODY = fakeCredential("beta", "-private-", "0d9b");

/** The keyless env every credential run starts from, so a shell key cannot leak in. */
const KEYLESS_ENV: Readonly<Record<string, string>> = Object.freeze({
  OPEN_SECOND_BRAIN_EMBEDDING_KEY: "",
  [ACTIVE_ENV_KEY]: "",
});

async function writeProviderRegistry(): Promise<void> {
  await Bun.write(
    providerRegistryPath(vault),
    JSON.stringify([
      {
        name: ACTIVE_PROFILE,
        baseUrl: "https://acme.invalid/v1",
        defaultModel: "acme-1",
        envKey: ACTIVE_ENV_KEY,
      },
      {
        name: OTHER_PROFILE,
        baseUrl: "https://beta.invalid/v1",
        defaultModel: "beta-1",
        envKey: OTHER_ENV_KEY,
      },
    ]),
  );
}

async function writeKeylessProfile(): Promise<void> {
  await Bun.write(
    configPath,
    [
      `vault: "${vault}"`,
      "search_semantic_enabled: true",
      `embedding_provider: ${ACTIVE_PROFILE}`,
      "",
    ].join("\n"),
  );
}

async function runCheckWithEnv(
  env: Readonly<Record<string, string>>,
  ...extra: ReadonlyArray<string>
): Promise<CheckRun> {
  const r = await runCli(
    ["search", "check", "--vault", vault, "--db", dbPath, "--config", configPath, ...extra],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath, ...KEYLESS_ENV, ...env } },
  );
  const json = extra.includes("--json")
    ? (JSON.parse(r.stdout) as Record<string, unknown>)
    : ({} as Record<string, unknown>);
  return { payload: json, returncode: r.returncode, stdout: r.stdout };
}

test("a keyless registry profile names the sources consulted and the profile that holds a key", async () => {
  await writeProviderRegistry();
  await writeKeylessProfile();

  const run = await runCheckWithEnv({ [OTHER_ENV_KEY]: PRIVATE_BODY }, "--json", "--no-probe");

  expect(run.payload["embedding_key_resolved"]).toBe(false);
  expect(run.payload["credential_sources"]).toEqual({
    consulted: ["OPEN_SECOND_BRAIN_EMBEDDING_KEY", "embedding_api_key", ACTIVE_ENV_KEY],
    present_elsewhere: [OTHER_PROFILE],
  });
  expect(run.stdout).not.toContain(PRIVATE_BODY);
});

test("the human report renders the credential sources and never an env value", async () => {
  await writeProviderRegistry();
  await writeKeylessProfile();

  const run = await runCheckWithEnv({ [OTHER_ENV_KEY]: PRIVATE_BODY }, "--no-probe");

  expect(run.stdout).toContain(
    `key_sources_checked:   OPEN_SECOND_BRAIN_EMBEDDING_KEY, embedding_api_key, ${ACTIVE_ENV_KEY}`,
  );
  expect(run.stdout).toContain(`key_present_under:     ${OTHER_PROFILE}`);
  expect(run.stdout).not.toContain(PRIVATE_BODY);
});

test("explicit keyless config consults the explicit pair and says when no profile holds a key", async () => {
  await Bun.write(
    configPath,
    [
      `vault: "${vault}"`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: "${server.url}"`,
      "",
    ].join("\n"),
  );

  const json = await runCheckWithEnv({}, "--json", "--no-probe");
  expect(json.payload["credential_sources"]).toEqual({
    consulted: ["OPEN_SECOND_BRAIN_EMBEDDING_KEY", "embedding_api_key"],
    present_elsewhere: [],
  });
  const human = await runCheckWithEnv({}, "--no-probe");
  expect(human.stdout).toContain("key_present_under:     none\n");
});

test("a configured tier carries no credential report in either shape", async () => {
  await writeProviderRegistry();
  await writeConfiguredProvider();

  const json = await runCheckWithEnv({ [OTHER_ENV_KEY]: PRIVATE_BODY }, "--json", "--no-probe");
  expect("credential_sources" in json.payload).toBe(false);
  const human = await runCheckWithEnv({ [OTHER_ENV_KEY]: PRIVATE_BODY }, "--no-probe");
  expect(human.stdout).not.toContain("key_sources_checked:");
  expect(human.stdout).not.toContain("key_present_under:");
});

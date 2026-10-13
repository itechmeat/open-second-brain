/**
 * `o2b brain bench memory` (Memory Observability Suite, t_882c396a):
 * memory quality benchmark over a disposable fixture vault.
 *
 * The harness NEVER touches the operator's configured vault: it
 * materializes the fixture into `<runs-dir>/<run-id>/vault` and runs
 * the public search/context-pack APIs there. Deterministic and
 * network-free by default; `bench_judge_cmd` arms the optional
 * external judge. Quality, latency, and context cost stay separate
 * report families (the MemScore lesson).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadBenchFixture } from "../../../core/bench/fixture.ts";
import { LONGMEMEVAL_SUITE_NAME, loadLongMemEvalFixture } from "../../../core/bench/longmemeval.ts";
import { loadLocomoFixture } from "../../../core/bench/locomo.ts";
import { loadReplayBenchFixture } from "../../../core/bench/replay.ts";
import { runMemoryBench } from "../../../core/bench/phases.ts";
import type {
  BenchPinnedKnobs,
  BenchSampleRequest,
  BenchSuiteLoad,
  BenchSuiteRegistration,
} from "../../../core/bench/types.ts";
import { defaultConfigPath, resolveBenchJudgeCmd } from "../../../core/config.ts";
import { CliError, fail, parse } from "../helpers.ts";

const USAGE =
  "usage: o2b brain bench memory --fixture <name|path> [--suite <name>] [--pin <json>] " +
  "[--recall-floor <n>] [--sample-seed <value>] [--sample-cap <n>] " +
  "[--resume <run-id>] [--runs-dir <dir>] [--json]";

const DEFAULT_RUNS_DIR = join(".open-second-brain", "bench-runs");
const REPO_FIXTURE_DIR = join("tests", "fixtures", "bench");

/** A suite name must be safe to echo into errors, reports and run ids. */
const SUITE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The path with no `--suite`: a native fixture loads directly. Not a
 * named suite - it is the byte-identical default the registry must
 * preserve.
 */
const DEFAULT_SUITE_REGISTRATION: BenchSuiteRegistration = Object.freeze({
  loader: (fixturePath: string): BenchSuiteLoad => ({ fixture: loadBenchFixture(fixturePath) }),
  capabilities: Object.freeze({ embeddings: false }),
});

/**
 * Suite registry: maps a `--suite` name to its loader and declared
 * capabilities. This map is the appendable registration point - suite
 * modules add their own entries here (or through
 * {@link registerBenchSuite}), never a new branch in the verb body.
 */
const BENCH_SUITES = new Map<string, BenchSuiteRegistration>([
  [
    "locomo",
    Object.freeze({
      loader: (fixturePath: string): BenchSuiteLoad => ({
        fixture: loadLocomoFixture(fixturePath),
      }),
      capabilities: Object.freeze({ embeddings: false }),
    }),
  ],
  [
    LONGMEMEVAL_SUITE_NAME,
    Object.freeze({
      loader: loadLongMemEvalFixture,
      capabilities: Object.freeze({ embeddings: true, sampling: true }),
    }),
  ],
  [
    "surfacing-replay",
    Object.freeze({
      loader: (fixturePath: string): BenchSuiteLoad => ({
        fixture: loadReplayBenchFixture(fixturePath),
      }),
      capabilities: Object.freeze({ embeddings: false }),
    }),
  ],
]);

/** Register a bench suite. Refuses an invalid or already-taken name. */
export function registerBenchSuite(name: string, registration: BenchSuiteRegistration): void {
  if (!SUITE_NAME_PATTERN.test(name)) {
    throw new Error(`bench suite name is invalid: '${name}'`);
  }
  if (BENCH_SUITES.has(name)) {
    throw new Error(`bench suite already registered: ${name}`);
  }
  BENCH_SUITES.set(name, registration);
}

/** Look up a registered suite by name. */
export function benchSuite(name: string): BenchSuiteRegistration | undefined {
  return BENCH_SUITES.get(name);
}

/** Registered suite names, sorted for stable listings. */
export function benchSuiteNames(): ReadonlyArray<string> {
  return [...BENCH_SUITES.keys()].toSorted();
}

/**
 * The knob names a `--pin` may set. Listed by hand against
 * {@link BenchPinnedKnobs} - the `satisfies` bounds make a renamed or
 * removed member a compile error - because TypeScript types have no
 * runtime keys to reflect on. A NEW member compiles silently until it is
 * listed here; a pin that names it is then refused, which is the loud
 * maintenance path, not a silent one.
 */
const BENCH_PIN_KNOBS = [
  "chunkSize",
  "chunkOverlap",
  "chunkMinSize",
  "keywordWeight",
  "semanticWeight",
  "fusionMode",
  "rrfK",
  "recall",
  "shutdownGraceMs",
  "hybridDeadlineMs",
  "resumeReindex",
  "ftsTokenize",
  "freshen",
  "scopeRules",
  "semantic",
  "rerank",
] as const satisfies ReadonlyArray<keyof BenchPinnedKnobs>;

/**
 * The knobs the harness itself owns: the run's vault identity. A pin may
 * never set them - pointing the bench at the operator's configured vault
 * is the one thing the harness exists to never do.
 */
const BENCH_PIN_HARNESS_KEYS = ["configPath", "dbPath", "vault"] as const satisfies ReadonlyArray<
  keyof BenchPinnedKnobs
>;

/** Member names of the pin's nested knob families, same listing rule. */
const BENCH_PIN_NESTED_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
  semantic: [
    "enabled",
    "provider",
    "baseUrl",
    "model",
    "apiKey",
    "apiKeys",
    "allowInsecureHttp",
    "dimension",
    "timeoutMs",
    "concurrency",
    "batchSize",
    "batchTokens",
    "inputWindowTokens",
    "maxRetries",
    "costGateUsd",
    "priceOverride",
    "queryPrefix",
    "passagePrefix",
    "extraBody",
  ] as const satisfies ReadonlyArray<keyof NonNullable<BenchPinnedKnobs["semantic"]>>,
  rerank: [
    "enabled",
    "kind",
    "baseUrl",
    "model",
    "envKey",
    "apiKey",
    "allowInsecureHttp",
    "topK",
    "minScore",
    "relationalRerankPin",
    "decisionModel",
  ] as const satisfies ReadonlyArray<keyof NonNullable<BenchPinnedKnobs["rerank"]>>,
  recall: [
    "mmrLambda",
    "maxHops",
    "hopDecay",
    "maxExpansionPerHit",
    "recencyShape",
    "recencyScale",
    "recencyAmplitude",
    "intentEnabled",
    "synonymEnabled",
    "synonymMaxTerms",
    "cacheEnabled",
    "cacheTtlSeconds",
    "relationPolarityEnabled",
    "relationalArmEnabled",
    "retrievalTrustGateEnabled",
    "supersedeFadeEnabled",
    "learnedWeightsEnabled",
    "activationEnabled",
    "twoPassEnabled",
    "iterativeRecallEnabled",
    "iterativeRecallMaxRounds",
    "poolMultiplier",
    "poolMaxPerSession",
    "selfTuningEnabled",
    "chainStopEnabled",
    "chainStopScore",
    "trigramPrefilterEnabled",
    "trigramPrefilterMinChunks",
    "trigramPrefilterMaxSelectivity",
    "metadataBoostGateEnabled",
  ] as const satisfies ReadonlyArray<keyof NonNullable<BenchPinnedKnobs["recall"]>>,
  freshen: ["intervalSeconds", "embeddings", "configPath"] as const satisfies ReadonlyArray<
    keyof NonNullable<BenchPinnedKnobs["freshen"]>
  >,
  scopeRules: ["ignore", "include"] as const satisfies ReadonlyArray<
    keyof NonNullable<BenchPinnedKnobs["scopeRules"]>
  >,
};

/**
 * Parse the `--pin` value into a {@link BenchPinnedKnobs} object.
 *
 * Garbage is refused by name: non-JSON, a non-object, a knob the harness
 * owns, an unknown knob, and a nested family that is not an object or
 * names an unknown member. VALUE semantics stay with
 * `resolveSearchConfig`, which applies the pin last and reports its own
 * named errors for a bad provider name or an out-of-range number - this
 * validation refuses shape garbage the resolver would silently ignore,
 * because an ignored override would pin nothing and report a run under a
 * configuration it did not run.
 *
 * An explicit pin REPLACES the default keyword-only pin
 * (`DEFAULT_BENCH_KNOB_PIN`) wholesale: `--pin '{"keywordWeight":0.7}'`
 * alone leaves the semantic lane env-driven, and the run then fails the
 * embeddings-capability gate loudly unless the suite declared it or the
 * pin also carries `"semantic":{"enabled":false}`.
 */
export function parseBenchPinnedKnobs(raw: string): BenchPinnedKnobs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      `brain bench memory: --pin is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("brain bench memory: --pin must be a JSON object of search knobs");
  }
  const pin = parsed as Record<string, unknown>;
  for (const key of Object.keys(pin)) {
    if ((BENCH_PIN_HARNESS_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new CliError(
        `brain bench memory: --pin may not set '${key}' - the harness owns the run's ${key}`,
      );
    }
    if (!(BENCH_PIN_KNOBS as ReadonlyArray<string>).includes(key)) {
      throw new CliError(
        `brain bench memory: --pin has an unknown knob '${key}' (known knobs: ${BENCH_PIN_KNOBS.join(", ")})`,
      );
    }
    const nestedKeys = BENCH_PIN_NESTED_KEYS[key];
    const value = pin[key];
    if (nestedKeys === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CliError(`brain bench memory: --pin '${key}' must be a JSON object`);
    }
    for (const nested of Object.keys(value as Record<string, unknown>)) {
      if (!(nestedKeys as ReadonlyArray<string>).includes(nested)) {
        throw new CliError(
          `brain bench memory: --pin '${key}.${nested}' is not a known knob (known: ${nestedKeys.join(", ")})`,
        );
      }
    }
  }
  return pin as BenchPinnedKnobs;
}

/**
 * Parse the `--recall-floor` value: absent keeps the shipped admission
 * floor; present it must be a positive number, and it becomes part of the
 * run identity (a resumed run whose floor changed fails the guard).
 */
export function parseRecallFloorFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new CliError(
      `brain bench memory: --recall-floor must be a positive number, got '${raw}'`,
    );
  }
  return value;
}

/**
 * Parse the `--sample-seed` value: absent keeps the whole-dataset load;
 * present it must be a non-empty string and pairs with `--sample-cap`.
 * The seed is opaque - the sampler hashes it, so any string works and
 * none is ever interpolated into a run id. The value is passed through
 * UNTRIMMED on purpose: the sampler trims the seed in one place before
 * hashing, so the CLI and the API path hash the same value for the same
 * input. This surface only refuses a blank value by name, before any
 * run state is created.
 */
export function parseSampleSeedFlag(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    throw new CliError(
      `brain bench memory: --sample-seed must be a non-empty string, got '${raw}'`,
    );
  }
  return raw;
}

/**
 * Parse the `--sample-cap` value: absent keeps the whole-dataset load;
 * present it must be a positive integer - the bound on selected
 * questions - and pairs with `--sample-seed`.
 */
export function parseSampleCapFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value <= 0) {
    throw new CliError(`brain bench memory: --sample-cap must be a positive integer, got '${raw}'`);
  }
  return value;
}

export async function cmdBrainBench(argv: string[]): Promise<number> {
  if (argv[0] !== "memory") return fail(USAGE);
  const { flags } = parse(argv.slice(1), {
    fixture: { type: "string" },
    suite: { type: "string" },
    pin: { type: "string" },
    "recall-floor": { type: "string" },
    "sample-seed": { type: "string" },
    "sample-cap": { type: "string" },
    resume: { type: "string" },
    "runs-dir": { type: "string" },
    json: { type: "boolean" },
  });
  const fixtureFlag = typeof flags["fixture"] === "string" ? flags["fixture"].trim() : "";
  if (fixtureFlag === "") return fail(USAGE);
  const suite = typeof flags["suite"] === "string" ? flags["suite"].trim() : "";
  let registration = DEFAULT_SUITE_REGISTRATION;
  if (suite !== "") {
    const known = BENCH_SUITES.get(suite);
    if (known === undefined) {
      return fail(
        `brain bench memory: unknown --suite '${suite}' (supported: ${benchSuiteNames().join(", ")})`,
      );
    }
    registration = known;
  }
  const fixturePath = resolveFixturePath(fixtureFlag);
  if (fixturePath === null) {
    return fail(
      `brain bench memory: fixture not found: ${fixtureFlag} (tried the literal path and ${REPO_FIXTURE_DIR}/${fixtureFlag}.json)`,
    );
  }

  // Sampling flags are LOADER options: validated (pair, values,
  // capability) before the registry dispatch, so a refused request never
  // reaches a loader and a sampling-capable loader receives
  // `BenchSuiteLoadOptions { sample }`.
  const sampleSeed = parseSampleSeedFlag(
    typeof flags["sample-seed"] === "string" ? flags["sample-seed"] : undefined,
  );
  const sampleCap = parseSampleCapFlag(
    typeof flags["sample-cap"] === "string" ? flags["sample-cap"] : undefined,
  );
  if ((sampleSeed === undefined) !== (sampleCap === undefined)) {
    const loneFlag = sampleSeed !== undefined ? "--sample-seed" : "--sample-cap";
    return fail(
      "brain bench memory: --sample-seed and --sample-cap must be given together " +
        `(sampling takes a seed and a cap; got only ${loneFlag})`,
    );
  }
  const sample: BenchSampleRequest | undefined =
    sampleSeed !== undefined && sampleCap !== undefined
      ? { seed: sampleSeed, cap: sampleCap }
      : undefined;
  if (sample !== undefined && registration.capabilities.sampling !== true) {
    return fail(
      "brain bench memory: --sample-seed/--sample-cap need a suite that declares the " +
        "sampling capability; " +
        (suite === "" ? "no --suite was given" : `suite '${suite}' does not declare it`),
    );
  }

  // One dispatch for every suite: the registry entry owns loading and
  // declares what the suite may do; the capabilities and the loader's
  // conversion receipt ride BenchRunOptions.
  const loaded = registration.loader(fixturePath, sample === undefined ? {} : { sample });
  const fixture = loaded.fixture;
  const runsDir = resolve(
    typeof flags["runs-dir"] === "string" && flags["runs-dir"].trim() !== ""
      ? flags["runs-dir"].trim()
      : DEFAULT_RUNS_DIR,
  );
  const resume = typeof flags["resume"] === "string" ? flags["resume"].trim() : undefined;
  const judgeCmd = resolveBenchJudgeCmd(defaultConfigPath());
  // Refusals throw CliError with the offending value named; the
  // dispatcher prints them and exits non-zero.
  const pinFlag = typeof flags["pin"] === "string" ? flags["pin"] : undefined;
  const pinnedKnobs: BenchPinnedKnobs | undefined =
    pinFlag === undefined ? undefined : parseBenchPinnedKnobs(pinFlag);
  const recallFloor = parseRecallFloorFlag(
    typeof flags["recall-floor"] === "string" ? flags["recall-floor"] : undefined,
  );

  const report = await runMemoryBench({
    fixture,
    runsDir,
    ...(suite !== "" ? { suite } : {}),
    capabilities: registration.capabilities,
    ...(pinnedKnobs !== null ? { pinnedKnobs } : {}),
    ...(recallFloor !== undefined ? { recallFloor } : {}),
    ...(sample !== undefined ? { sample } : {}),
    ...(loaded.receipt !== undefined ? { suiteReceipt: loaded.receipt } : {}),
    ...(resume !== undefined && resume !== "" ? { resume } : {}),
    ...(judgeCmd !== undefined ? { judgeCmd } : {}),
  });

  if (flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.quality.passed === report.quality.total ? 0 : 1;
  }
  process.stdout.write(`bench ${report.fixture} run ${report.run_id}\n`);
  process.stdout.write(
    `quality: ${report.quality.passed}/${report.quality.total} (pass rate ${report.quality.pass_rate})\n`,
  );
  process.stdout.write(`latency_ms: avg ${report.latency_ms.avg} max ${report.latency_ms.max}\n`);
  process.stdout.write(
    `context_cost: avg_chars ${report.context_cost.avg_chars} avg_injected_tokens ${report.context_cost.avg_injected_tokens}\n`,
  );
  process.stdout.write(
    `failure_modes: know_to_ask ${report.failure_modes.know_to_ask_failure_rate} ` +
      `false_fire ${report.failure_modes.false_fire_rate} ` +
      `isolation_violations ${report.failure_modes.source_isolation_violations}\n`,
  );
  if (report.longmemeval !== undefined) {
    process.stdout.write(
      `longmemeval: recall_all@5 ${report.longmemeval.recall_all_at_5} ` +
        `abstention_excluded ${report.longmemeval.abstention_excluded}` +
        // Present only on a sampled run, so the whole-dataset line is
        // byte-identical to before. The population rides beside the
        // selected count, so the line shows the share of the dataset
        // the run covers (both fields are written together by the one
        // spread site that emits the sampled family).
        (report.longmemeval.sample_selected !== undefined
          ? ` sample_population ${report.longmemeval.sample_population} sample_selected ${report.longmemeval.sample_selected}`
          : "") +
        "\n",
    );
  }
  process.stdout.write(`judge: ${report.judge.status}\n`);
  for (const question of report.questions) {
    process.stdout.write(
      `  ${question.pass ? "PASS" : "FAIL"}  ${question.id} (${question.category})${question.failure ? ` - ${question.failure}` : ""}\n`,
    );
  }
  return report.quality.passed === report.quality.total ? 0 : 1;
}

function resolveFixturePath(flag: string): string | null {
  if (existsSync(flag)) return flag;
  const repoLocal = join(REPO_FIXTURE_DIR, `${flag}.json`);
  if (existsSync(repoLocal)) return repoLocal;
  return null;
}

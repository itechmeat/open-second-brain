/**
 * The readiness probe that names the provider consent
 * (write-honesty-egress-consent, Lane F).
 *
 * Before this probe, an operator who wrote `search_semantic_enabled:
 * false` and an operator who never configured semantic search at all
 * read the same sentence on the same surface, and neither of them was
 * told what was in their environment. The probe splits those two
 * situations: a recorded decline is named as a decline, with the two
 * spellings it can be written in, and the provider environment variables
 * that are present are listed.
 *
 * BY NAME, never by value: a readiness detail travels into logs, into
 * the JSON payload of `o2b doctor --json --readiness` and into whatever
 * an operator pastes into a bug report. The file asserts the absence of
 * the value in the rendered JSON, not just in the detail string.
 *
 * No test here drops permission bits and none of them reaches the
 * network, so the file runs the same on every platform.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PROBES,
  READINESS_PROBE,
  probeEmbeddingProvider,
  probeLlmKey,
  probeProviderConsent,
  runReadinessProbes,
} from "../../src/core/doctor-readiness.ts";

/** The environment variable whose NAME may be reported and whose VALUE may not. */
const PROVIDER_KEY_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_KEY";

/**
 * A value that stands in for a credential. Assembled at runtime so no
 * source line carries a literal shaped like one, and named `PRIVATE_BODY`
 * so no identifier near it reads as a credential either.
 */
const PRIVATE_BODY = ["PRIVATE", "BODY"].join("-");

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-consent-probe-"));
  configPath = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write the machine configuration the probes read. */
function writeConfig(body: string): void {
  writeFileSync(configPath, `vault: "${tmp}"\n${body}`);
}

/** The probe options every case shares. */
function probeOpts(env: Record<string, string | undefined> = {}) {
  return { vault: tmp, config: configPath, env };
}

describe("the provider-consent readiness probe", () => {
  test("is registered in the probe registry and in the default set", () => {
    expect(READINESS_PROBE.providerConsent).toBe("provider_consent");
    const registered = DEFAULT_PROBES.map((probe) => probe.name);
    expect(registered).toContain(READINESS_PROBE.providerConsent);
  });

  test("a declined vault is named as a decline, with both spellings", async () => {
    writeConfig("search_semantic_enabled: false\n");
    const verdict = await probeProviderConsent(probeOpts());
    expect(verdict.status).toBe("skipped");
    expect(verdict.detail).toContain("search_semantic_enabled=false");
    expect(verdict.detail).toContain("embedding_provider=disabled");
  });

  test("the present provider environment variables are listed BY NAME", async () => {
    writeConfig("search_semantic_enabled: false\n");
    const verdict = await probeProviderConsent(probeOpts({ [PROVIDER_KEY_ENV]: PRIVATE_BODY }));
    expect(verdict.detail).toContain(PROVIDER_KEY_ENV);
    // …and the VALUE never appears, in the detail or anywhere else.
    expect(verdict.detail).not.toContain(PRIVATE_BODY);
  });

  test("a configuration that records no decision says so, without a decline", async () => {
    // No body at all: writeConfig already prepends the vault line, and a
    // second one would be a duplicate key the config reader never wrote.
    writeConfig("");
    const verdict = await probeProviderConsent(probeOpts());
    expect(verdict.status).toBe("skipped");
    expect(verdict.detail).not.toContain("search_semantic_enabled=false");
    expect(verdict.detail).not.toContain("embedding_provider=disabled");
  });

  test("the present provider environment variables are listed on the no-decision arm too", async () => {
    // The env census travels with every arm: an operator who set the key
    // in the environment and never wrote a decision needs to see that
    // the key is there all the same.
    writeConfig("");
    const verdict = await probeProviderConsent(probeOpts({ [PROVIDER_KEY_ENV]: PRIVATE_BODY }));
    expect(verdict.status).toBe("skipped");
    expect(verdict.detail).toContain(PROVIDER_KEY_ENV);
    expect(verdict.detail).not.toContain(PRIVATE_BODY);
  });

  test("a registered profile's env-key name is listed when a variable of that name is present", async () => {
    // A registry profile keeps its credential in an OPERATOR-NAMED
    // variable (envKey in Brain/search/embedding-providers.json), which
    // no OPEN_SECOND_BRAIN_* prefix reaches. The probe reads the NAMES
    // out of the registry and reports the ones present - never values.
    const profileEnv = "OPENROUTER_API_KEY";
    mkdirSync(join(tmp, "Brain", "search"), { recursive: true });
    writeFileSync(
      join(tmp, "Brain", "search", "embedding-providers.json"),
      JSON.stringify([
        {
          name: "openrouter",
          baseUrl: "https://openrouter.invalid/v1",
          defaultModel: "acme/embed-1",
          envKey: profileEnv,
        },
      ]),
    );
    writeConfig("search_semantic_enabled: false\n");
    const verdict = await probeProviderConsent(probeOpts({ [profileEnv]: PRIVATE_BODY }));
    expect(verdict.status).toBe("skipped");
    expect(verdict.detail).toContain(profileEnv);
    expect(verdict.detail).not.toContain(PRIVATE_BODY);
    // A profile name whose variable is absent lists nothing.
    const without = await probeProviderConsent(probeOpts());
    expect(without.detail).not.toContain(profileEnv);
  });

  test("the rerank environment is part of the census", async () => {
    // The rerank resolver spells its settings with their own prefix, and
    // its credential lives in the variable `search_rerank_env_key`
    // NAMES - both were invisible to a probe that read the embedding
    // prefix alone.
    const rerankCredentialEnv = "MY_RERANK_KEY";
    writeConfig(`search_semantic_enabled: false\nsearch_rerank_env_key: ${rerankCredentialEnv}\n`);
    const verdict = await probeProviderConsent(
      probeOpts({
        OPEN_SECOND_BRAIN_SEARCH_RERANK_MODEL: "acme/rerank-1",
        [rerankCredentialEnv]: PRIVATE_BODY,
      }),
    );
    expect(verdict.status).toBe("skipped");
    expect(verdict.detail).toContain("OPEN_SECOND_BRAIN_SEARCH_RERANK_MODEL");
    expect(verdict.detail).toContain(rerankCredentialEnv);
    expect(verdict.detail).not.toContain(PRIVATE_BODY);
  });

  test("a record that cannot be read is unknown, not a skipped decision", async () => {
    // A DIRECTORY in the config's place: the resolver fails that arm
    // closed to declined, but the probe could not measure whether a
    // decision exists, which is the `unknown` vocabulary - the CLI's
    // own "could not measure" - and never a clean skip.
    mkdirSync(configPath, { recursive: true });
    const verdict = await probeProviderConsent(probeOpts());
    expect(verdict.status).toBe("unknown");
    expect(verdict.detail).toContain("could not be read");
    // The counts follow the verdict: a broken machine configuration is
    // 0 failed but also 0 skipped-for-this-probe and 1 unknown.
    const report = await runReadinessProbes(probeOpts());
    expect(report.unknown).toBeGreaterThan(0);
    const consent = report.probes.find((p) => p.name === READINESS_PROBE.providerConsent);
    expect(consent?.status).toBe("unknown");
  });

  test("the value of a present environment variable never reaches the JSON output", async () => {
    writeConfig("search_semantic_enabled: false\n");
    const report = await runReadinessProbes(probeOpts({ [PROVIDER_KEY_ENV]: PRIVATE_BODY }));
    const json = JSON.stringify(report);
    expect(json).toContain(PROVIDER_KEY_ENV);
    expect(json).not.toContain(PRIVATE_BODY);
  });

  test("every probe in the default set carries a non-empty detail", async () => {
    writeConfig("search_semantic_enabled: false\n");
    const report = await runReadinessProbes(probeOpts());
    for (const probe of report.probes) {
      expect(`${probe.name}: ${probe.detail.trim().length > 0}`).toBe(`${probe.name}: true`);
    }
    // The default entry point really consumes the default set: the report
    // the CLI's `--readiness` flag runs through lists exactly the default
    // probes, in order - a probe dropped from ( or reordered out of ) the
    // run fails here rather than vanishing silently.
    expect(report.probes.map((probe) => probe.name)).toEqual(
      DEFAULT_PROBES.map((probe) => probe.name),
    );
  });
});

describe("the skipped arm of the key probe is split", () => {
  test("a declined vault is reported as a decline, not as a bare 'disabled'", async () => {
    writeConfig("search_semantic_enabled: false\n");
    const verdict = await probeLlmKey(probeOpts());
    expect(verdict.status).toBe("skipped");
    expect(verdict.detail).toContain("provider consent declined");
    expect(verdict.detail).not.toBe("semantic search disabled; no model API key required");
  });

  test("a configuration that records no decision keeps the existing sentence", async () => {
    writeConfig("");
    const verdict = await probeLlmKey(probeOpts());
    expect(verdict.status).toBe("skipped");
    // Byte-identical to the sentence this probe has always reported.
    expect(verdict.detail).toBe("semantic search disabled; no model API key required");
  });
});

describe("the embedding probe reports a decline as skipped", () => {
  test("a declined vault reports skipped with the decline sentence", async () => {
    writeConfig("search_semantic_enabled: false\n");
    const verdict = await probeEmbeddingProvider(probeOpts());
    expect(verdict.status).toBe("skipped");
    expect(verdict.detail).toContain("provider consent declined");
    expect(verdict.detail).toContain("search_semantic_enabled=false");
  });

  test("a genuine provider load failure still reports fail", async () => {
    writeConfig(
      "search_semantic_enabled: true\nembedding_provider: openai-compat\nembedding_api_key: fake-key\n",
    );
    const verdict = await probeEmbeddingProvider(probeOpts());
    expect(verdict.status).toBe("fail");
    expect(verdict.detail).toContain("provider failed to load");
    expect(verdict.detail).toContain("embedding_base_url is required");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_PROBES,
  DEFAULT_READINESS_TIMEOUT_MS,
  READINESS_PROBE,
  READINESS_STATUS,
  READINESS_STATUSES,
  ReadinessTimeoutError,
  isReadinessStatus,
  probeEmbeddingProvider,
  probeInstalledRuntimes,
  probeLlmKey,
  probeRegisteredCommands,
  probeRuntimeAdapterWiring,
  probeWritebackContract,
  runReadinessProbes,
  withReadinessTimeout,
} from "../../src/core/doctor-readiness.ts";
import { buildPayload } from "../../src/core/install/payload.ts";
import { serializeMcpServerTable } from "../../src/core/install/grok-config.ts";
import { registerAllAdapters } from "../../src/core/install/adapters/all.ts";
import { manifestPath } from "../../src/core/install/manifest.ts";

// The probes read the embedding config through `resolveSearchConfig`, which
// consults `process.env` before the config file. Clear the embedding env keys
// per test so a developer shell pointing at a real provider cannot leak in.
const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC",
  "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
  "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
  "OPEN_SECOND_BRAIN_EMBEDDING_MODEL",
  "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
  "OPEN_SECOND_BRAIN_EMBEDDING_DIM",
];

let tmp: string;
let home: string;
let configPath: string;
let origEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-readiness-"));
  home = mkdtempSync(join(tmpdir(), "o2b-readiness-home-"));
  configPath = join(tmp, "config.yaml");
  origEnv = {};
  for (const k of ENV_KEYS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(body: string): void {
  writeFileSync(configPath, `vault: "${tmp}"\n${body}`);
}

/** The install-state probe's fixed inputs: this vault, this fake HOME. */
function installedRuntimeOpts() {
  return { vault: tmp, config: configPath, home, cwd: tmp, env: {} };
}

/** Write the sidecar install manifest verbatim (valid JSON or not). */
function writeInstallManifest(body: string): void {
  const path = manifestPath(tmp);
  mkdirSync(join(tmp, ".open-second-brain"), { recursive: true });
  writeFileSync(path, body);
}

/** A client config whose Open Second Brain entries carry the given command word. */
function clientConfig(
  path: string,
  command: unknown,
  topKey = "mcpServers",
  extraEntry: Record<string, unknown> = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        [topKey]: {
          "open-second-brain": { command, args: ["mcp", "--vault", tmp], ...extraEntry },
          "open-second-brain-writer": {
            command,
            args: ["mcp", "--writer-only", "--vault", tmp],
            ...extraEntry,
          },
        },
      },
      null,
      2,
    ),
  );
}

/** The manifest entry shape the install layer records for `target`. */
function manifestEntry(
  target: string,
  recordedConfigPath: string | null,
  operation = "json-merge",
): Record<string, unknown> {
  return {
    target,
    applied_at: new Date().toISOString(),
    operation,
    config_path: recordedConfigPath,
    owned_keys:
      recordedConfigPath === null ? [] : ["open-second-brain", "open-second-brain-writer"],
  };
}

function writeManifestEntries(installs: Record<string, unknown>): void {
  writeInstallManifest(JSON.stringify({ schema_version: 1, installs }));
}

describe("probeLlmKey", () => {
  test("skipped when semantic search is disabled", async () => {
    writeConfig("");
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("skipped");
    expect(v.detail.toLowerCase()).toContain("disabled");
  });

  test("skipped for a provider that needs no key", async () => {
    writeConfig("search_semantic_enabled: true\nembedding_provider: local\n");
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("skipped");
    expect(v.detail.toLowerCase()).toContain("no api key");
  });

  test("pass when a key-requiring provider has a resolvable key", async () => {
    writeConfig(
      "search_semantic_enabled: true\n" +
        "embedding_provider: openai-compat\n" +
        "embedding_base_url: https://example.invalid/v1\n" +
        "embedding_model: test-model\n" +
        'embedding_api_key: "sk-test-123"\n',
    );
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("pass");
  });

  test("fail with reason when a key-requiring provider has no key", async () => {
    writeConfig(
      "search_semantic_enabled: true\n" +
        "embedding_provider: openai-compat\n" +
        "embedding_base_url: https://example.invalid/v1\n" +
        "embedding_model: test-model\n",
    );
    const v = await probeLlmKey({ vault: tmp, config: configPath });
    expect(v.status).toBe("fail");
    expect(v.detail.toLowerCase()).toContain("key");
  });
});

describe("probeEmbeddingProvider", () => {
  test("skipped when semantic search is disabled", async () => {
    writeConfig("");
    const v = await probeEmbeddingProvider({ vault: tmp, config: configPath });
    expect(v.status).toBe("skipped");
  });

  test("pass for the offline local provider with model and dims", async () => {
    writeConfig("search_semantic_enabled: true\nembedding_provider: local\n");
    const v = await probeEmbeddingProvider({ vault: tmp, config: configPath });
    expect(v.status).toBe("pass");
    expect(v.detail).toContain("local");
    // Model name and a positive dimension both appear in the detail.
    expect(v.detail).toMatch(/\d+ dim/);
  });
});

describe("ReadinessStatus vocabulary", () => {
  test("the guard accepts every declared status and rejects the empty string", () => {
    for (const status of READINESS_STATUSES) {
      expect(`${status}: ${isReadinessStatus(status)}`).toBe(`${status}: true`);
    }
    expect(isReadinessStatus("")).toBe(false);
    expect(isReadinessStatus("ok")).toBe(false);
    expect(isReadinessStatus(undefined)).toBe(false);
  });

  test("members and values are in bijection, with no duplicates", () => {
    const values = Object.values(READINESS_STATUS);
    expect(new Set(values).size).toBe(values.length);
    expect([...READINESS_STATUSES].toSorted()).toEqual(values.toSorted());
  });

  test("`unknown` is a member, and it is not a synonym for any other", () => {
    expect(READINESS_STATUS.unknown).toBe("unknown");
    expect(READINESS_STATUSES).toContain(READINESS_STATUS.unknown);
    expect(READINESS_STATUS.unknown).not.toBe(READINESS_STATUS.skipped);
    expect(READINESS_STATUS.unknown).not.toBe(READINESS_STATUS.pass);
  });
});

describe("probeRuntimeAdapterWiring", () => {
  test("pass: the adapter registry is populated and the payload wires", async () => {
    writeConfig("");
    const v = await probeRuntimeAdapterWiring({ vault: tmp, config: configPath });
    expect(v.status).toBe("pass");
    expect(v.detail).toMatch(/adapter/);
  });

  test("its detail claims a construction check, never an install one", async () => {
    // The defect this replaced: "N runtime adapter(s) wired" on a machine
    // where nothing is installed, which reads as an install verdict.
    writeConfig("");
    const v = await probeRuntimeAdapterWiring({ vault: tmp, config: configPath });
    expect(v.detail).toContain("no disk state read");
    expect(v.detail).toContain(READINESS_PROBE.installedRuntimes);
  });
});

describe("probeInstalledRuntimes", () => {
  test("an empty install manifest is skipped, never a pass", async () => {
    writeConfig("");
    const v = await probeInstalledRuntimes(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.skipped);
    expect(v.status).not.toBe(READINESS_STATUS.pass);
    expect(v.detail).toContain("not-installed");
  });

  test("an unreadable install manifest is unknown, with the reason", async () => {
    writeConfig("");
    writeInstallManifest("{ this is not json");
    const v = await probeInstalledRuntimes(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.unknown);
    expect(v.detail.length).toBeGreaterThan(0);
    expect(v.detail).toContain("corrupted JSON");
  });

  test("a drifted target fails, naming the target and its fix hint", async () => {
    writeConfig("");
    // A manifest entry for cursor whose config file was deleted: the
    // adapter's own verify() calls that drift.
    writeInstallManifest(
      JSON.stringify({
        schema_version: 1,
        installs: {
          cursor: {
            target: "cursor",
            applied_at: new Date().toISOString(),
            operation: "json-merge",
            config_path: join(home, ".cursor", "mcp.json"),
            owned_keys: [],
          },
        },
      }),
    );
    const v = await probeInstalledRuntimes(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.fail);
    expect(v.detail).toContain("cursor");
    expect(v.detail).toContain("o2b install --target cursor --apply");
  });

  test("a genuinely installed target passes, so the mapping is not stuck", async () => {
    writeConfig("");
    const registry = registerAllAdapters();
    const adapter = registry.get("cursor")!;
    const env = {
      vault: tmp,
      home,
      cwd: tmp,
      env: {} as Record<string, string>,
      now: new Date(),
    };
    const payload = buildPayload({ vault: tmp, agent_name: null, timezone: null });
    adapter.apply(adapter.plan(payload, env), payload, env, {
      dryRun: false,
      force: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    const v = await probeInstalledRuntimes(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.pass);
    expect(v.detail).toContain("cursor");
  });
});

describe("withReadinessTimeout", () => {
  test("resolves when the function finishes within budget", async () => {
    const out = await withReadinessTimeout(async () => 42, 1000, "unit");
    expect(out).toBe(42);
  });

  test("rejects with a typed timeout error when the budget is exceeded", async () => {
    await expect(
      withReadinessTimeout(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
        5,
        "unit",
      ),
    ).rejects.toBeInstanceOf(ReadinessTimeoutError);
  });
});

describe("runReadinessProbes", () => {
  test("runs every default probe and reports a failed count and durations", async () => {
    writeConfig("search_semantic_enabled: true\nembedding_provider: local\n");
    // cwd pins the workspace the writeback-contract probe audits: without
    // it the run would read the checkout's real instruction files and the
    // fixture's "nothing failed" expectation would depend on the host.
    const report = await runReadinessProbes({ vault: tmp, config: configPath, home, cwd: tmp });
    expect(report.probes.length).toBe(Object.keys(READINESS_PROBE).length);
    const names = report.probes.map((p) => p.name);
    expect(names).toContain(READINESS_PROBE.llmKey);
    expect(names).toContain(READINESS_PROBE.embeddingProvider);
    expect(names).toContain(READINESS_PROBE.runtimeAdapterWiring);
    expect(names).toContain(READINESS_PROBE.installedRuntimes);
    for (const p of report.probes) {
      expect(p.durationMs).toBeGreaterThanOrEqual(0);
      // Never a silent pass: every probe carries an explicit status, and
      // no status is a blank claim.
      expect(`${p.name}: ${isReadinessStatus(p.status)}`).toBe(`${p.name}: true`);
      expect(p.detail.trim().length).toBeGreaterThan(0);
    }
    // local provider needs no key -> llm_key skipped, embedding_provider pass,
    // wiring pass, installed runtimes skipped; nothing failed.
    expect(report.failed).toBe(0);
  });

  test("a verdict with a blank detail becomes unknown rather than a bare claim", async () => {
    const muteProbe = {
      name: "mute_unit_probe",
      fn: async () => ({ status: READINESS_STATUS.pass, detail: "   " }),
    };
    const report = await runReadinessProbes({ vault: tmp, config: configPath }, [muteProbe]);
    expect(report.probes[0]!.status).toBe(READINESS_STATUS.unknown);
    expect(report.probes[0]!.detail).toContain("mute_unit_probe");
  });

  test("an unknown verdict is not counted as a failure", async () => {
    const unknownProbe = {
      name: "unknown_unit_probe",
      fn: async () => ({ status: READINESS_STATUS.unknown, detail: "could not measure: no disk" }),
    };
    const report = await runReadinessProbes({ vault: tmp, config: configPath }, [unknownProbe]);
    expect(report.probes[0]!.status).toBe(READINESS_STATUS.unknown);
    expect(report.failed).toBe(0);
    expect(report.unknown).toBe(1);
  });

  test("a probe that exceeds the per-check timeout does not hang, and is not a failure", async () => {
    // An injected probe that sleeps past a tiny budget must surface with a
    // "timed out" reason rather than blocking the run - and that reason is a
    // fact about the probe's reach, never about the surface it was pointed at.
    const slowProbe = {
      name: "slow_unit_probe",
      fn: () =>
        new Promise<{ status: "pass"; detail: string }>((resolve) =>
          setTimeout(() => resolve({ status: "pass", detail: "eventually" }), 100),
        ),
    };
    const report = await runReadinessProbes(
      { vault: tmp, config: configPath, perCheckTimeoutMs: 5 },
      [slowProbe],
    );
    expect(report.failed).toBe(0);
    expect(report.unknown).toBe(1);
    expect(report.probes[0]!.status).toBe(READINESS_STATUS.unknown);
    expect(report.probes[0]!.detail.toLowerCase()).toContain("timed out");
  });

  test("a probe that did not answer is distinguishable from one that ran and failed", async () => {
    // The two run in the same batch so the comparison is between two
    // verdicts of one report, not between two runs of one probe.
    const slowProbe = {
      name: "slow_unit_probe",
      fn: () =>
        new Promise<{ status: "pass"; detail: string }>((resolve) =>
          setTimeout(() => resolve({ status: "pass", detail: "eventually" }), 100),
        ),
    };
    const brokenProbe = {
      name: "broken_unit_probe",
      fn: async () => ({
        status: READINESS_STATUS.fail,
        detail: "the surface answered, and the answer was a refusal",
      }),
    };
    const report = await runReadinessProbes(
      { vault: tmp, config: configPath, perCheckTimeoutMs: 5 },
      [slowProbe, brokenProbe],
    );
    const [timedOut, broken] = report.probes;
    expect(timedOut!.status).not.toBe(broken!.status);
    expect(timedOut!.status).toBe(READINESS_STATUS.unknown);
    expect(broken!.status).toBe(READINESS_STATUS.fail);
    // Nor is the unanswered probe folded into the healthy answer.
    expect(timedOut!.status).not.toBe(READINESS_STATUS.pass);
    expect(report.failed).toBe(1);
    expect(report.unknown).toBe(1);
  });

  test("a probe that throws claims nothing about the surface it could not read", async () => {
    // An exception escaping a probe body is evidence about the probe, not
    // about the surface: the run never got an answer to classify.
    const throwingProbe = {
      name: "throwing_unit_probe",
      fn: async (): Promise<{ status: "pass"; detail: string }> => {
        throw new Error("EACCES: permission denied");
      },
    };
    const report = await runReadinessProbes({ vault: tmp, config: configPath }, [throwingProbe]);
    expect(report.probes[0]!.status).toBe(READINESS_STATUS.unknown);
    expect(report.probes[0]!.detail).toContain("EACCES");
    expect(report.failed).toBe(0);
    expect(report.unknown).toBe(1);
  });

  test("exposes a sane default per-check timeout constant", () => {
    expect(DEFAULT_READINESS_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("probeRegisteredCommands", () => {
  /**
   * The probe reads install.lock.json (`readManifest`) and re-reads every
   * recorded `config_path`, so each test pins its own manifest plus the
   * client configs it names. Bare-name legs get a PATH that resolves
   * nothing (`opts.env`), so a developer shell cannot flip a verdict.
   */
  const noPathEnv = { PATH: "/nonexistent-osb-probe-bin" };

  test("an absent install manifest is skipped, never a pass", async () => {
    writeConfig("");
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.skipped);
    expect(v.detail).toContain("nothing to probe");
  });

  test("an unreadable install manifest is unknown, naming the manifest fault", async () => {
    writeConfig("");
    writeInstallManifest("{ this is not json");
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.unknown);
    expect(v.detail).toContain("manifest");
  });

  test("entries whose registered command resolves pass, naming target and command", async () => {
    writeConfig("");
    const launcher = join(tmp, "bin", "o2b");
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "");
    const cursorConfig = join(home, ".cursor", "mcp.json");
    clientConfig(cursorConfig, launcher);
    writeManifestEntries({ cursor: manifestEntry("cursor", cursorConfig) });
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.pass);
    expect(v.detail).toContain("cursor");
    expect(v.detail).toContain(launcher);
  });

  test("a proved-absent command path fails with the o2b install recovery line", async () => {
    writeConfig("");
    const stale = join(tmp, "bin", "gone-o2b");
    const cursorConfig = join(home, ".cursor", "mcp.json");
    clientConfig(cursorConfig, stale);
    writeManifestEntries({ cursor: manifestEntry("cursor", cursorConfig) });
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.fail);
    expect(v.detail).toContain("cursor");
    expect(v.detail).toContain("does not exist");
    expect(v.detail).toContain("o2b install cursor --apply");
  });

  test("a bare name that does not resolve is unknown and never a fail", async () => {
    writeConfig("");
    const cursorConfig = join(home, ".cursor", "mcp.json");
    clientConfig(cursorConfig, "o2b");
    writeManifestEntries({ cursor: manifestEntry("cursor", cursorConfig) });
    const v = await probeRegisteredCommands({ ...installedRuntimeOpts(), env: noPathEnv });
    expect(v.status).toBe(READINESS_STATUS.unknown);
    expect(v.status).not.toBe(READINESS_STATUS.fail);
    expect(v.detail).toContain("spawn PATH");
  });

  test("a config_path of null is skipped with a named nothing-to-probe verdict", async () => {
    writeConfig("");
    writeManifestEntries({ pi: manifestEntry("pi", null, "symlink") });
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.skipped);
    expect(v.detail).toContain("pi");
    expect(v.detail).toContain("nothing to probe");
  });

  test("a recorded config that no longer exists is unknown, not a fail", async () => {
    writeConfig("");
    const missing = join(home, ".cursor", "mcp.json");
    writeManifestEntries({ cursor: manifestEntry("cursor", missing) });
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.unknown);
    expect(v.detail).toContain(missing);
  });

  test("a config without an Open Second Brain command entry is skipped per-entry, naming the file", async () => {
    writeConfig("");
    const aiderConf = join(home, ".aider.conf.yml");
    mkdirSync(dirname(aiderConf), { recursive: true });
    writeFileSync(aiderConf, "model: gpt-4o\n");
    writeManifestEntries({ aider: manifestEntry("aider", aiderConf, "managed-block") });
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.skipped);
    expect(v.detail).toContain("aider");
    expect(v.detail).toContain(aiderConf);
  });

  test("the opencode array-command shape is extracted and probed", async () => {
    writeConfig("");
    const launcher = join(tmp, "bin", "o2b");
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "");
    const config = join(home, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(
      config,
      JSON.stringify({
        mcp: {
          "open-second-brain": { type: "local", command: [launcher, "mcp"], enabled: true },
        },
      }),
    );
    writeManifestEntries({ opencode: manifestEntry("opencode", config) });
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.pass);
    expect(v.detail).toContain("opencode");
    expect(v.detail).toContain(launcher);
  });

  test("the grok/codex TOML shape is extracted and a missing runner script fails", async () => {
    writeConfig("");
    const bun = join(tmp, "bin", "bun");
    mkdirSync(dirname(bun), { recursive: true });
    writeFileSync(bun, "");
    const script = join(tmp, "old-repo", "src", "cli", "main.ts");
    const toml = join(home, ".grok", "config.toml");
    mkdirSync(dirname(toml), { recursive: true });
    writeFileSync(
      toml,
      // Serialize through the product's own TOML writer - byte for byte
      // what `o2b install grok --apply` records. A template that inlines
      // the raw platform paths is NOT valid TOML on Windows: a basic
      // string's backslash is an escape sequence, so `C:\Users\...` fails
      // the value parse and the probe can only answer "malformed"
      // (unknown) - it never reaches the command it was meant to judge.
      serializeMcpServerTable("open-second-brain", {
        command: bun,
        args: ["run", script, "mcp", "--vault", tmp],
      }) +
        serializeMcpServerTable("open-second-brain-writer", {
          command: bun,
          args: ["run", script, "mcp", "--writer-only", "--vault", tmp],
        }),
    );
    writeManifestEntries({ grok: manifestEntry("grok", toml, "managed-block") });
    const v = await probeRegisteredCommands(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.fail);
    expect(v.detail).toContain("grok");
    expect(v.detail).toContain(script);
    expect(v.detail).toContain("o2b install grok --apply");
  });

  test("the aggregate is worst-of fail over unknown, skipped and pass", async () => {
    writeConfig("");
    const launcher = join(tmp, "bin", "o2b");
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "");
    const staleConfig = join(home, ".cursor", "mcp.json");
    clientConfig(staleConfig, join(tmp, "bin", "gone-o2b"));
    const bareConfig = join(home, ".kiro", "mcp.json");
    clientConfig(bareConfig, "o2b");
    const okConfig = join(home, ".gemini", "settings.json");
    clientConfig(okConfig, launcher);
    const aiderConf = join(home, ".aider.conf.yml");
    mkdirSync(dirname(aiderConf), { recursive: true });
    writeFileSync(aiderConf, "model: gpt-4o\n");
    writeManifestEntries({
      cursor: manifestEntry("cursor", staleConfig),
      kiro: manifestEntry("kiro", bareConfig),
      "gemini-cli": manifestEntry("gemini-cli", okConfig),
      aider: manifestEntry("aider", aiderConf, "managed-block"),
    });
    const v = await probeRegisteredCommands({ ...installedRuntimeOpts(), env: noPathEnv });
    expect(v.status).toBe(READINESS_STATUS.fail);
    for (const target of ["cursor", "kiro", "gemini-cli", "aider"]) {
      expect(v.detail).toContain(target);
    }
    // The winning bucket's census travels with the verdict.
    expect(v.detail).toContain("1 pass");
    expect(v.detail).toContain("1 fail");
    expect(v.detail).toContain("1 unknown");
    expect(v.detail).toContain("1 skipped");
  });

  test("the probe is registered in DEFAULT_PROBES beside installed_runtimes", () => {
    const names = DEFAULT_PROBES.map((p) => p.name);
    expect(names).toContain(READINESS_PROBE.registeredCommands);
    expect(names.indexOf(READINESS_PROBE.registeredCommands)).toBe(
      names.indexOf(READINESS_PROBE.installedRuntimes) + 1,
    );
  });

  test("a default readiness run includes the probe verdict", async () => {
    writeConfig("");
    const report = await runReadinessProbes({ vault: tmp, config: configPath, home });
    const probe = report.probes.find((p) => p.name === READINESS_PROBE.registeredCommands);
    expect(probe).toBeDefined();
    expect(probe!.status).toBe(READINESS_STATUS.skipped);
  });
});

describe("probeWritebackContract", () => {
  /**
   * The probe audits the workspace agent-instruction file(s) at
   * `opts.cwd`, so each test writes its candidates into `tmp` (which
   * `installedRuntimeOpts` already passes as cwd). A managed block whose
   * body carries every contract clause is the conforming fixture.
   */
  const CONFORMING_BLOCK = [
    "# >>> open-second-brain managed >>>",
    "Memory write gate: write every durable fact you learn to the Open Second",
    "Brain in the same turn, as an atomic fact, through the note tools;",
    "@osb set mutations require guardrails.marker_writeback in _brain.yaml.",
    "# <<< open-second-brain managed <<<",
  ].join("\n");

  test("no agent-instruction file in the workspace is skipped, naming what was checked", async () => {
    writeConfig("");
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.skipped);
    expect(v.detail).toContain("nothing installed");
    expect(v.detail).toContain("AGENTS.md");
  });

  test("a present file without the managed block is skipped, naming file and recovery", async () => {
    writeConfig("");
    const agents = join(tmp, "AGENTS.md");
    writeFileSync(agents, "# Workspace\n\nplain instructions\n");
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.skipped);
    expect(v.detail).toContain(agents);
    expect(v.detail).toContain("managed block is not installed");
    expect(v.detail).toContain("0 fail");
    expect(v.detail).toContain("ambient write-back managed block");
  });

  test("a managed block without the gate clauses fails naming the missing piece", async () => {
    writeConfig("");
    writeFileSync(
      join(tmp, "AGENTS.md"),
      [
        "# >>> open-second-brain managed >>>",
        "use the open-second-brain note tools",
        "# <<< open-second-brain managed <<<",
      ].join("\n"),
    );
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.fail);
    expect(v.detail).toContain("missing");
  });

  test("a conforming file passes", async () => {
    writeConfig("");
    writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.pass);
    expect(v.detail).toContain("AGENTS.md");
  });

  test("a symlinked instruction file is unknown, never a fail", async () => {
    writeConfig("");
    const real = join(tmp, "real-instructions.md");
    writeFileSync(real, "no block here\n");
    symlinkSync(real, join(tmp, "AGENTS.md"));
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.unknown);
    expect(v.status).not.toBe(READINESS_STATUS.fail);
    expect(v.detail).toContain("symbolic link");
  });

  test("a candidate path that cannot be read as a file is unknown with the reason", async () => {
    writeConfig("");
    mkdirSync(join(tmp, "AGENTS.md"));
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.unknown);
    expect(v.detail).toContain("could not");
  });

  test("the aggregate is worst-of fail over unknown and pass, with the census", async () => {
    writeConfig("");
    // A lone begin marker: a block that was installed and then broken.
    writeFileSync(join(tmp, "AGENTS.md"), "# >>> open-second-brain managed >>>\nhalf a block\n");
    const real = join(tmp, "claude-target.md");
    writeFileSync(real, "irrelevant\n");
    symlinkSync(real, join(tmp, "CLAUDE.md"));
    writeFileSync(join(tmp, "GEMINI.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.fail);
    expect(v.detail).toContain("1 pass");
    expect(v.detail).toContain("1 fail");
    expect(v.detail).toContain("1 unknown");
    expect(v.detail).toContain("0 skipped");
  });

  test("one conforming file among absent peers passes - absent is not a violation", async () => {
    writeConfig("");
    writeFileSync(join(tmp, "AGENTS.md"), `# W\n\n${CONFORMING_BLOCK}\n`);
    const v = await probeWritebackContract(installedRuntimeOpts());
    expect(v.status).toBe(READINESS_STATUS.pass);
    expect(v.detail).toContain("2 skipped");
  });

  test("the probe is registered in DEFAULT_PROBES beside registered_commands", () => {
    const names = DEFAULT_PROBES.map((p) => p.name);
    expect(names).toContain(READINESS_PROBE.writebackContract);
    expect(names.indexOf(READINESS_PROBE.writebackContract)).toBe(
      names.indexOf(READINESS_PROBE.registeredCommands) + 1,
    );
  });

  test("a default readiness run includes the probe verdict", async () => {
    writeConfig("");
    const report = await runReadinessProbes({
      vault: tmp,
      config: configPath,
      home,
      cwd: tmp,
    });
    const probe = report.probes.find((p) => p.name === READINESS_PROBE.writebackContract);
    expect(probe).toBeDefined();
    expect(probe!.status).toBe(READINESS_STATUS.skipped);
  });
});

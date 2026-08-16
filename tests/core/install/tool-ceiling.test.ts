/**
 * A capped host selects a bounded profile.
 *
 * Cursor publishes a per-workspace ceiling of forty tools across all
 * enabled MCP servers; the full surface advertises a hundred and ten.
 * Before this unit the adapter wrote the full surface anyway and the
 * host silently dropped the excess - no error, no note, and no row in
 * `second_brain_capabilities` naming which tools went missing or why.
 *
 * Three things are pinned here, and each one is pinned in the way that
 * makes it hard to pass by accident:
 *
 *   - The census over `RUNTIME_FACTS` is DERIVED, not hand-listed, and
 *     its pinned counts are an EQUALITY. A future row that declares a
 *     ceiling has no way to skip the check, and a tool added to a
 *     bounded profile moves the advertised count off its pin rather
 *     than quietly creeping back over the host's limit.
 *   - The advertised count is computed the way the SERVER computes it -
 *     `buildToolTable` under the resolved surface, then
 *     `evaluateToolCapabilities`, then the `hidden` filter `tools/list`
 *     applies - so it is what a host actually sees, not what is
 *     registered. Those two numbers differ by a hundred and three under
 *     `catalog`, which is the whole reason the profile fits.
 *   - `unknown` is visible. A host whose limit nobody has published gets
 *     no profile - that is today's behaviour and it is correct - but the
 *     capability report says the ceiling is unchecked and repeats the
 *     written reason, because silence is what let the original defect
 *     survive.
 *   - The flag the payload bakes in is the flag the CLI PARSES. Every
 *     expectation here spells it with the constant, so the constant alone
 *     is no evidence: the last block runs `o2b` on the argv the adapter
 *     writes and reads the surface back off the probe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { runCli } from "../../helpers/run-cli.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { cursorAdapter } from "../../../src/core/install/adapters/cursor.ts";
import { buildPayload } from "../../../src/core/install/payload.ts";
import {
  carriesHostDimensions,
  HOST_TARGET_FLAG,
  TOOL_PROFILE_FLAG,
  payloadForHost,
} from "../../../src/core/install/payload-host.ts";
import {
  INSTALL_TOOL_PROFILE_CONFIG_KEY,
  resolveInstallToolProfile,
} from "../../../src/core/install/settings.ts";
import type { InstallEnv } from "../../../src/core/install/types.ts";
import {
  INSTALL_TARGET_IDS,
  RUNTIME_FACTS,
  TOOL_CEILING_KIND,
  type InstallTargetId,
} from "../../../src/core/runtime/host-facts.ts";
import { CONFIG_ORIGIN } from "../../../src/core/validate.ts";
import { evaluateToolCapabilities } from "../../../src/mcp/capabilities.ts";
import { resolveToolSurface } from "../../../src/mcp/profiles.ts";
import { buildToolTable } from "../../../src/mcp/tools.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-ceiling-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-ceiling-h-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeEnv(overrides: Record<string, string> = {}): InstallEnv {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-vps", VAULT_TIMEZONE: "UTC", ...overrides },
    now: new Date("2026-08-16T12:00:00.000Z"),
  };
}

function makePayload() {
  return buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" });
}

/**
 * What a host LISTS under one profile: the server's own surface build
 * (`src/mcp/server.ts`) followed by the `hidden` filter its
 * `tools/list` handler applies.
 */
function advertisedToolCount(profileName: string): number {
  const surface = resolveToolSurface({ profileName });
  const evaluated = evaluateToolCapabilities(buildToolTable(surface.scope), {
    scope: surface.scope,
    serverName: "open-second-brain",
    ...(surface.window ? { window: surface.window } : {}),
  });
  return evaluated.tools.filter((tool) => tool.hidden !== true).length;
}

/**
 * The advertised count each ceiling-bearing host's resolved profile
 * produces today, as an EQUALITY per target.
 *
 * A floor would let a tool added to `catalog` walk the surface back
 * toward the ceiling without failing anything until it crossed. The key
 * set is required to equal the derived declared-ceiling population
 * below, so a new row cannot be added without pinning its number.
 */
const PINNED_ADVERTISED_TOOLS: Readonly<Record<string, number>> = Object.freeze({
  cursor: 7,
});

/** The targets whose row publishes a number, derived from the table. */
const DECLARED_CEILING_TARGETS: ReadonlyArray<InstallTargetId> = INSTALL_TARGET_IDS.filter(
  (target) => RUNTIME_FACTS[target].toolCeiling.kind === TOOL_CEILING_KIND.declared,
);

/** The targets whose row publishes nothing, derived the same way. */
const UNKNOWN_CEILING_TARGETS: ReadonlyArray<InstallTargetId> = INSTALL_TARGET_IDS.filter(
  (target) => RUNTIME_FACTS[target].toolCeiling.kind === TOOL_CEILING_KIND.unknown,
);

describe("the declared-ceiling census", () => {
  test("is not vacuous: at least one runtime publishes a limit", () => {
    expect(DECLARED_CEILING_TARGETS.length).toBeGreaterThan(0);
  });

  test("every declared ceiling has a pinned advertised count", () => {
    expect(Object.keys(PINNED_ADVERTISED_TOOLS).toSorted()).toEqual(
      [...DECLARED_CEILING_TARGETS].toSorted(),
    );
  });

  for (const target of DECLARED_CEILING_TARGETS) {
    test(`${target}: the resolved profile advertises at or under the published limit`, () => {
      const ceiling = RUNTIME_FACTS[target].toolCeiling;
      if (ceiling.kind !== TOOL_CEILING_KIND.declared) throw new Error("derivation drifted");
      const resolved = resolveInstallToolProfile(
        { vault, configPath: join(home, "config.yaml") },
        target,
      );
      expect(resolved.value).not.toBeNull();
      const advertised = advertisedToolCount(resolved.value!);
      expect(advertised).toBe(PINNED_ADVERTISED_TOOLS[target]!);
      expect(advertised).toBeLessThanOrEqual(ceiling.maxTools);
    });
  }
});

describe("the profile baked into the generated payload", () => {
  test("a capped host carries its profile on the full entry", () => {
    const payload = payloadForHost("cursor", makePayload(), makeEnv());
    expect(payload.full.args).toEqual([
      "mcp",
      "--vault",
      vault,
      TOOL_PROFILE_FLAG,
      "catalog",
      HOST_TARGET_FLAG,
      "cursor",
    ]);
  });

  test("the writer entry keeps its five-tool surface and takes no profile", () => {
    const payload = payloadForHost("cursor", makePayload(), makeEnv());
    expect(payload.writer.args).not.toContain(TOOL_PROFILE_FLAG);
    expect(payload.writer.args).toEqual([
      "mcp",
      "--writer-only",
      "--vault",
      vault,
      HOST_TARGET_FLAG,
      "cursor",
    ]);
  });

  // The three targets that write no MCP command line at all are excluded:
  // `payloadForHost` refuses them by name rather than pretending to bake a
  // dimension into a registration they never generate.
  for (const target of UNKNOWN_CEILING_TARGETS.filter(carriesHostDimensions)) {
    test(`${target}: an unchecked ceiling bakes in no profile`, () => {
      const payload = payloadForHost(target, makePayload(), makeEnv());
      expect(payload.full.args).not.toContain(TOOL_PROFILE_FLAG);
      expect(payload.writer.args).not.toContain(TOOL_PROFILE_FLAG);
    });
  }

  test("a fresh apply reports no drift: verify reconstructs the same args", () => {
    const payload = makePayload();
    const env = makeEnv();
    const opts = {
      dryRun: false,
      force: false,
      stdout: sink(),
      stderr: sink(),
    };
    const plan = cursorAdapter.plan(payload, env);
    cursorAdapter.apply(plan, payload, env, opts);

    const written = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(written.mcpServers["open-second-brain"]!.args).toContain("catalog");
    expect(cursorAdapter.verify(env).status).toBe("ok");
  });
});

/**
 * The generated argv, handed to the program that has to read it.
 *
 * `payload-host.ts` names the flags and `src/cli/main.ts` parses them, and
 * until this block nothing held the two together: every expectation above
 * spells the flag with {@link TOOL_PROFILE_FLAG}, so renaming the constant
 * renamed the expectation with it and left the suite green while every
 * Cursor install reverted from the seven-tool surface to the hundred-and-
 * ten-tool one - the exact defect the file exists to prevent.
 *
 * Running the CLI closes it from both sides. An argument the parser does
 * not know is a usage error, so a renamed flag fails on the exit code; a
 * flag accepted and then ignored would still start the full surface, so it
 * fails on the advertised count. The probe is the same code path the
 * server's `tools/list` runs, which is why the number is comparable to the
 * pin above.
 */
describe("the generated registration is an argv this CLI accepts", () => {
  interface ProbeJson {
    readonly server_name: string;
    readonly capabilities: {
      readonly advertised_tool_count: number;
      readonly host_ceiling: { readonly target: string | null };
    };
  }

  async function probe(args: ReadonlyArray<string>): Promise<ProbeJson> {
    const res = await runCli([...args, "--probe", "--json"], { env: { VAULT_DIR: vault } });
    expect(`exit ${res.returncode}\n${res.stderr}`).toBe("exit 0\n");
    return JSON.parse(res.stdout) as ProbeJson;
  }

  test("the full entry's args select the bounded surface the pin names", async () => {
    const args = payloadForHost("cursor", makePayload(), makeEnv()).full.args;
    const answered = await probe(args);
    expect(answered.server_name).toBe("open-second-brain");
    expect(answered.capabilities.advertised_tool_count).toBe(PINNED_ADVERTISED_TOOLS["cursor"]!);
    expect(answered.capabilities.host_ceiling.target).toBe("cursor");
  });

  test("the writer entry's args are accepted too, and name the same host", async () => {
    const args = payloadForHost("cursor", makePayload(), makeEnv()).writer.args;
    const answered = await probe(args);
    expect(answered.server_name).toBe("open-second-brain-writer");
    expect(answered.capabilities.host_ceiling.target).toBe("cursor");
  });
});

describe("tool-profile precedence, three layers, highest first", () => {
  function source() {
    return { vault, configPath: join(home, "config.yaml") };
  }

  test("the committed vault block beats the host row", () => {
    atomicWriteFileSync(
      brainConfigPath(vault),
      'schema_version: 1\ninstall:\n  tool_profile: "recall"\n',
    );
    expect(resolveInstallToolProfile(source(), "cursor")).toEqual({
      value: "recall",
      origin: CONFIG_ORIGIN.vaultConfig,
    });
  });

  test("the machine-local key beats the host row when the vault says nothing", () => {
    atomicWriteFileSync(join(home, "config.yaml"), `${INSTALL_TOOL_PROFILE_CONFIG_KEY}: minimal\n`);
    expect(resolveInstallToolProfile(source(), "cursor")).toEqual({
      value: "minimal",
      origin: CONFIG_ORIGIN.userConfig,
    });
  });

  test("the host row answers when nothing else does", () => {
    expect(resolveInstallToolProfile(source(), "cursor")).toEqual({
      value: "catalog",
      origin: CONFIG_ORIGIN.default,
    });
  });

  test("a host with no declared profile resolves to no profile at all", () => {
    expect(resolveInstallToolProfile(source(), "kiro")).toEqual({
      value: null,
      origin: CONFIG_ORIGIN.default,
    });
  });
});

describe("the capability report states the ceiling it runs under", () => {
  function report(hostTarget: InstallTargetId | undefined) {
    const surface = resolveToolSurface({ profileName: "catalog" });
    return evaluateToolCapabilities(buildToolTable(surface.scope), {
      scope: surface.scope,
      serverName: "open-second-brain",
      ...(hostTarget !== undefined ? { hostTarget } : {}),
    }).report;
  }

  test("a declared ceiling is reported with its number and its citation", () => {
    const ceiling = report("cursor").host_ceiling;
    expect(ceiling.target).toBe("cursor");
    expect(ceiling.kind).toBe(TOOL_CEILING_KIND.declared);
    expect(ceiling.max_tools).toBe(40);
    expect(ceiling.source).toBe((RUNTIME_FACTS.cursor.toolCeiling as { source: string }).source);
    expect(ceiling.reason).toBeNull();
    expect(ceiling.within_ceiling).toBe(true);
  });

  test("an unchecked ceiling is stated, with the written reason, not left silent", () => {
    const ceiling = report("kiro").host_ceiling;
    expect(ceiling.kind).toBe(TOOL_CEILING_KIND.unknown);
    expect(ceiling.max_tools).toBeNull();
    expect(ceiling.within_ceiling).toBeNull();
    expect(ceiling.reason).toBe((RUNTIME_FACTS.kiro.toolCeiling as { reason: string }).reason);
  });

  test("a server nobody named a host for says so instead of inventing one", () => {
    const ceiling = report(undefined).host_ceiling;
    expect(ceiling.target).toBeNull();
    expect(ceiling.kind).toBe(TOOL_CEILING_KIND.unknown);
    expect(ceiling.reason).toContain(HOST_TARGET_FLAG);
  });

  test("the advertised count is the one a host lists, not the registered one", () => {
    const evaluated = report("cursor");
    expect(evaluated.available_tool_count).toBe(110);
    expect(evaluated.advertised_tool_count).toBe(7);
  });
});

function sink(): NodeJS.WriteStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
}

/**
 * The environment does not parameterise a GENERATED registration.
 *
 * `OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE` used to outrank every other tier
 * here, and the ladder is walked twice: once by `payloadForHost` on the
 * apply path and once by `expectedPayloadFromEnv` on the verify path. A
 * variable set for the first invocation and absent from the next therefore
 * made a CORRECT install report drift, and the fix hint it offered would
 * have rewritten the file to the host row - silently downgrading the
 * profile the operator had asked for. Every surviving tier is a file, and a
 * file is still there on the next invocation.
 */
describe("an environment variable cannot reach the written payload", () => {
  const ENV_KEY = "OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE";

  test("apply writes the host row's profile, not the environment's", () => {
    const env = makeEnv({ [ENV_KEY]: "minimal" });
    const payload = makePayload();
    cursorAdapter.apply(cursorAdapter.plan(payload, env), payload, env, {
      dryRun: false,
      force: false,
      stdout: sink(),
      stderr: sink(),
    });
    const written = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const args = written.mcpServers["open-second-brain"]!.args;
    expect(args).toContain("catalog");
    expect(args).not.toContain("minimal");
  });

  test("a plain --check after an environment-set apply reports no drift", () => {
    const withEnv = makeEnv({ [ENV_KEY]: "minimal" });
    const payload = makePayload();
    cursorAdapter.apply(cursorAdapter.plan(payload, withEnv), payload, withEnv, {
      dryRun: false,
      force: false,
      stdout: sink(),
      stderr: sink(),
    });
    // The second invocation is the operator running `o2b install --check`
    // in a shell that never exported the variable.
    expect(cursorAdapter.verify(makeEnv()).status).toBe("ok");
  });

  test("the resolver itself ignores the variable", () => {
    expect(
      resolveInstallToolProfile({ vault, configPath: join(home, "config.yaml") }, "cursor"),
    ).toEqual({ value: "catalog", origin: CONFIG_ORIGIN.default });
  });
});

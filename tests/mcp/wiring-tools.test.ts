/**
 * `second_brain_wiring` - what this install is wired into.
 *
 * Two readers already answered this and neither was reachable from the
 * MCP surface. `linkedProjectsStatus` reports every registered project
 * link with its pointer state, and had one consumer: the CLI verb
 * `o2b brain project status`. That is the whole gap this view closes -
 * no new health model, no second registry walk.
 *
 * The path policy is the part worth testing hard. The registry is keyed
 * on ABSOLUTE host paths, and an MCP response lands in model context, so
 * every reference here goes through the same `expose_host_paths`
 * contract `vault_path` already obeys. A payload that leaked a project
 * directory would be the same defect the vault-path census exists to
 * prevent, one field over.
 *
 * The hosts view leaks differently: `verify()` composes its `details`
 * and `fix_hint` sentences from `InstallEnv.home`, so the path arrives
 * inside prose no store reference can render. `foldHostHome` folds the
 * home prefix there, and the no-host-path assertion below is over the
 * SERIALISED payload of both views - the census in
 * `tests/core/architecture/vault-path-census.test.ts` is keyed on the
 * field name `vault_path` and cannot see either of these fields.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { Writable } from "node:stream";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { WIRING_TOOL_NAME, WIRING_VIEWS, hostWiringEntry } from "../../src/mcp/wiring-tools.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";
import {
  projectsRegistryPath,
  registerLinkedProject,
  writeVaultPointer,
  VAULT_POINTER_FILE,
} from "../../src/core/brain/portability/pointer.ts";
import { INSTALLATION_SECRET_ENV_KEY, VAULT_STORE_REF_PREFIX } from "../../src/core/config.ts";
import { VAULT_NOT_CONFIGURED_REASON, buildInstallEnv } from "../../src/core/install/env.ts";
import { defaultRegistry } from "../../src/core/install/registry.ts";
import "../../src/core/install/adapters/all.ts";
import {
  HOST_PROBE_RESULT,
  resetHostProbeRunner,
  setHostProbeRunner,
} from "../../src/core/install/host-probe.ts";
import { VERIFY_STATUSES, type InstallEnv } from "../../src/core/install/types.ts";
import {
  codexAdapter,
  resetCodexRunner,
  setCodexRunner,
} from "../../src/core/install/adapters/codex.ts";
import { buildPayload } from "../../src/core/install/payload.ts";

/** Deterministic 32-hex key so `vault://<hex>` is stable across runs. */
const SECRET = "0123456789abcdef0123456789abcdef";

/** The escape hatch that restores raw host paths. */
const EXPOSE_ENV = "OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS";

/** The override `defaultConfigPath` consults before the host home. */
const CONFIG_PATH_ENV = "OPEN_SECOND_BRAIN_CONFIG";

interface Sandbox {
  readonly root: string;
  readonly configPath: string;
  readonly vault: string;
  readonly project: string;
}

let sandbox: Sandbox;
let savedSecret: string | undefined;
let savedExpose: string | undefined;

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "o2b-wiring-"));
  const configPath = join(root, "config", "config.yaml");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(configPath, "vault: \n", "utf8");
  const vault = join(root, "vault");
  const project = join(root, "project");
  mkdirSync(vault, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, configPath, vault, project };
}

beforeEach(() => {
  savedSecret = process.env[INSTALLATION_SECRET_ENV_KEY];
  savedExpose = process.env[EXPOSE_ENV];
  process.env[INSTALLATION_SECRET_ENV_KEY] = SECRET;
  delete process.env[EXPOSE_ENV];
  sandbox = makeSandbox();
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env[INSTALLATION_SECRET_ENV_KEY];
  else process.env[INSTALLATION_SECRET_ENV_KEY] = savedSecret;
  if (savedExpose === undefined) delete process.env[EXPOSE_ENV];
  else process.env[EXPOSE_ENV] = savedExpose;
  rmSync(sandbox.root, { recursive: true, force: true });
});

/** `server` overrides the default context, for the tests about that context. */
async function callWiring(
  args: Record<string, unknown>,
  server: MCPServer = new MCPServer({ vault: sandbox.vault, configPath: sandbox.configPath }),
): Promise<{
  payload?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "wiring-test", version: "0" },
    },
  });
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: WIRING_TOOL_NAME, arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };
  if (response.error) return { error: response.error };
  return { payload: JSON.parse(response.result!.content[0]!.text) };
}

describe("second_brain_wiring registration", () => {
  test("is in the full tool table and in neither reduced scope", () => {
    expect(buildToolTable("full").find((t) => t.name === WIRING_TOOL_NAME)).toBeDefined();
    expect(buildToolTable("writer").find((t) => t.name === WIRING_TOOL_NAME)).toBeUndefined();
    const catalog = buildToolTable("catalog").find((t) => t.name === WIRING_TOOL_NAME);
    expect(catalog?.hidden).toBe(true);
  });

  test("view is required, and an absent one names the accepted members", async () => {
    const { error } = await callWiring({});
    expect(error?.code).toBe(INVALID_PARAMS);
    for (const view of WIRING_VIEWS) expect(error?.message).toContain(view);
  });

  test("an unknown view is refused by name rather than defaulted", async () => {
    const { error } = await callWiring({ view: "everything" });
    expect(error?.code).toBe(INVALID_PARAMS);
    expect(error?.message).toContain("everything");
  });
});

describe("view=projects", () => {
  test("reports one entry per registered link with its pointer state", async () => {
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    writeVaultPointer(sandbox.project, sandbox.vault);
    const { payload } = await callWiring({ view: "projects" });
    expect(payload!["view"]).toBe("projects");
    const projects = payload!["projects"] as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ pointer: "ok", vault_exists: true });
  });

  test("an empty registry is an empty list, not an error", async () => {
    const { payload } = await callWiring({ view: "projects" });
    expect(payload!["projects"]).toEqual([]);
  });

  test("each of the four pointer states is reported as itself", async () => {
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    const missing = await callWiring({ view: "projects" });
    expect((missing.payload!["projects"] as Array<Record<string, unknown>>)[0]!["pointer"]).toBe(
      "missing",
    );

    writeFileSync(join(sandbox.project, VAULT_POINTER_FILE), "{ not json", "utf8");
    const malformed = await callWiring({ view: "projects" });
    expect((malformed.payload!["projects"] as Array<Record<string, unknown>>)[0]!["pointer"]).toBe(
      "malformed",
    );

    const other = join(sandbox.root, "other-vault");
    mkdirSync(other, { recursive: true });
    writeVaultPointer(sandbox.project, other);
    const mismatch = await callWiring({ view: "projects" });
    expect((mismatch.payload!["projects"] as Array<Record<string, unknown>>)[0]!["pointer"]).toBe(
      "mismatch",
    );
  });

  test("a vault that no longer exists is reported, not hidden", async () => {
    const gone = join(sandbox.root, "removed-vault");
    mkdirSync(gone, { recursive: true });
    registerLinkedProject(sandbox.configPath, sandbox.project, gone);
    rmSync(gone, { recursive: true, force: true });
    const { payload } = await callWiring({ view: "projects" });
    expect((payload!["projects"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      vault_exists: false,
    });
  });
});

describe("view=projects path policy", () => {
  test("no absolute host path appears anywhere in the serialised payload", async () => {
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    writeVaultPointer(sandbox.project, sandbox.vault);
    const { payload } = await callWiring({ view: "projects" });
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(sandbox.project);
    expect(serialised).not.toContain(sandbox.vault);
    expect(serialised).toContain(VAULT_STORE_REF_PREFIX);
  });

  test("with expose_host_paths on, the raw paths are what the operator asked for", async () => {
    process.env[EXPOSE_ENV] = "true";
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    const { payload } = await callWiring({ view: "projects" });
    const projects = payload!["projects"] as Array<Record<string, unknown>>;
    expect(projects[0]!["project_ref"]).toBe(sandbox.project);
    expect(projects[0]!["vault_ref"]).toBe(sandbox.vault);
  });

  test("a config that cannot be read renders the reason, never the raw path", async () => {
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    // The secret keys the reference and lives in the config; an
    // unreadable config leaves the reference unresolvable, and the
    // contract forbids degrading to the path the reference hides.
    delete process.env[INSTALLATION_SECRET_ENV_KEY];
    // A directory where the config file belongs: `discoverConfig`
    // refuses a path that is not a regular file, which is the one
    // ConfigReadError branch a test can stage without depending on the
    // running user being unable to read a chmod-ed file.
    rmSync(sandbox.configPath, { force: true });
    mkdirSync(sandbox.configPath, { recursive: true });
    const { payload } = await callWiring({ view: "projects" });
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(sandbox.project);
    const projects = payload!["projects"] as Array<Record<string, unknown>>;
    expect(projects[0]!["project_ref"]).toHaveProperty("error");
  });

  test("a registry damaged by hand reads as no links, exactly as the CLI verb does", async () => {
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    writeFileSync(projectsRegistryPath(sandbox.configPath), "{ broken", "utf8");
    const { payload } = await callWiring({ view: "projects" });
    // `listLinkedProjects` passes `tolerateParseError`, so this view
    // answers what `o2b brain project status` answers. It is core's
    // tolerance, not this view's: a tool that refused where the verb
    // tolerates would be the second answer this file exists to avoid.
    expect(payload!["projects"]).toEqual([]);
  });

  test("a server given no config path reads the machine default, not an empty list", async () => {
    // The view used to answer `[]` here, which reports "nothing is
    // linked" for a box whose registry is full - and disagreed with
    // `view=hosts` in the same tool, which has always defaulted. The
    // default is redirected through the env override `defaultConfigPath`
    // consults first, since `os.homedir()` cannot be moved in-process.
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    writeVaultPointer(sandbox.project, sandbox.vault);
    process.env[CONFIG_PATH_ENV] = sandbox.configPath;
    try {
      const server = new MCPServer({ vault: sandbox.vault });
      const { payload } = await callWiring({ view: "projects" }, server);
      expect((payload!["projects"] as unknown[]).length).toBe(1);
    } finally {
      delete process.env[CONFIG_PATH_ENV];
    }
  });
});

/** How a folded sentence names the host home; see `foldHostHome`. */
const FOLDED_HOME = "~";

/** The identity a staged registration is written under. */
const STAGE_AGENT = "wiring-test";

/** The timezone a staged registration is written under. */
const STAGE_TIMEZONE = "UTC";

/**
 * A codex registration this build wrote, under `home`.
 *
 * An unstaged target verifies to "no install manifest entry" - a
 * sentence carrying no path at all - so a path assertion over it would
 * pass for the wrong reason. An absent binary sends `apply` down the
 * file-writing path, so the registration exists as a real artifact.
 *
 * LEAVES both runners stubbed, because `verify()` consults them too -
 * an unstubbed host probe would spawn whatever `codex` binary the test
 * machine happens to have. Every caller resets them in its own
 * `finally`; a caller that wants a different probe answer overrides it.
 */
function stageCodexInstall(home: string, vault: string): InstallEnv {
  const installEnv: InstallEnv = {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: STAGE_AGENT, VAULT_TIMEZONE: STAGE_TIMEZONE },
    now: new Date(),
  };
  const payload = buildPayload({ vault, agent_name: STAGE_AGENT, timezone: STAGE_TIMEZONE });
  setCodexRunner({
    available: () => false,
    run: () => {
      throw new Error("the adapter must not spawn codex when it reported the binary absent");
    },
  });
  setHostProbeRunner({
    available: () => false,
    run: () => {
      throw new Error("the probe must not spawn when it reported the binary absent");
    },
  });
  const sink = new Writable({ write: (_c, _e, cb) => cb() }) as unknown as NodeJS.WriteStream;
  codexAdapter.apply(codexAdapter.plan(payload, installEnv), payload, installEnv, {
    dryRun: false,
    force: false,
    stdout: sink,
    stderr: sink,
  });
  return installEnv;
}

describe("view=hosts", () => {
  test("reports one entry per registered adapter", async () => {
    const { payload } = await callWiring({ view: "hosts" });
    expect(payload!["view"]).toBe("hosts");
    const hosts = payload!["hosts"] as Array<Record<string, unknown>>;
    expect(hosts.map((h) => h["target"])).toEqual([...defaultRegistry.targets()]);
    for (const host of hosts) {
      expect([...VERIFY_STATUSES] as string[]).toContain(host["status"] as string);
      expect(Array.isArray(host["details"])).toBe(true);
      expect(host).toHaveProperty("fix_hint");
    }
  });

  test("it is the same verify() answer, over the same registry and env", async () => {
    // Not "an equivalent aggregate": the same call over the same
    // registry with the same env, so one implementation of connector
    // health cannot become two that disagree. The env is built through
    // `buildInstallEnv` - the constructor `o2b install` now shares - so
    // splitting that constructor again fails here.
    const env = buildInstallEnv({ vault: sandbox.vault, configPath: sandbox.configPath });
    const policy = { configPath: sandbox.configPath };
    const direct = defaultRegistry.list().map((adapter) => adapter.verify(env));
    const { payload } = await callWiring({ view: "hosts" });
    const hosts = payload!["hosts"] as Array<Record<string, unknown>>;
    expect(hosts).toEqual(direct.map((r) => hostWiringEntry(r, env.home, policy)));
  });

  test("the serialised payload of neither view carries this process's home", async () => {
    // The cheap end-to-end guard. It is not the one with teeth - an
    // install-free home verifies to "no install manifest entry", a
    // sentence with no path in it - so the folding assertions below
    // stage a registration first.
    for (const view of WIRING_VIEWS) {
      const { payload } = await callWiring({ view });
      expect(JSON.stringify(payload)).not.toContain(homedir());
    }
  });

  test("adapter prose folds the host home instead of naming it", () => {
    const home = mkdtempSync(join(sandbox.root, "fold-home-"));
    const installEnv = stageCodexInstall(home, sandbox.vault);
    try {
      const entry = hostWiringEntry(codexAdapter.verify(installEnv), home, {
        configPath: sandbox.configPath,
      });
      const details = (entry["details"] as string[]).join("; ");
      // Staged, so the sentence names a file: the assertion below is
      // about WHICH form that name takes, not about its absence.
      expect(details).toContain(`${FOLDED_HOME}/.codex/`);
      expect(details).not.toContain(home);
    } finally {
      resetHostProbeRunner();
      resetCodexRunner();
    }
  });

  test("`expose_host_paths` restores the raw path in that same sentence", () => {
    // The escape hatch is ONE flag for both mechanisms: the config that
    // un-hashes `vault_path` un-folds the adapter prose with it.
    const home = mkdtempSync(join(sandbox.root, "expose-home-"));
    const installEnv = stageCodexInstall(home, sandbox.vault);
    process.env[EXPOSE_ENV] = "1";
    try {
      const entry = hostWiringEntry(codexAdapter.verify(installEnv), home, {
        configPath: sandbox.configPath,
      });
      expect((entry["details"] as string[]).join("; ")).toContain(`${home}/.codex/`);
    } finally {
      delete process.env[EXPOSE_ENV];
      resetHostProbeRunner();
      resetCodexRunner();
    }
  });

  test("an unresolved vault is refused by name, not reported as ten clean targets", async () => {
    const server = new MCPServer({ vault: "", configPath: sandbox.configPath });
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "wiring-test", version: "0" },
      },
    });
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: WIRING_TOOL_NAME, arguments: { view: "hosts" } },
    })) as {
      result?: { content: ReadonlyArray<{ text: string }> };
      error?: { code: number; message: string };
    };
    expect(response.error?.message).toContain(VAULT_NOT_CONFIGURED_REASON);
    // The code docs/mcp.md gives for this refusal, alongside the one it
    // gives for a bad `view`.
    expect(response.error?.code).toBe(INVALID_PARAMS);
    expect(response.result).toBeUndefined();
  });
  test("a probe that cannot run reaches the payload as its named reason, not an ok", () => {
    // The branch needs an INSTALLED target verified against a specific
    // host home, and `os.homedir()` here does not follow a later
    // `process.env.HOME`, so the home the view resolves cannot be
    // redirected in-process. The env is therefore built by hand, as the
    // adapter suites do, and the assertion is over the view's own
    // mapping of the real `verify()` answer - the deep-equality test
    // above is what ties that mapping to the env the view builds.
    const home = mkdtempSync(join(sandbox.root, "probe-home-"));
    const installEnv = stageCodexInstall(home, sandbox.vault);
    try {
      // The host binary answers, and refuses.
      setHostProbeRunner({
        available: () => true,
        run: () => ({ exitCode: 4, stdout: "", stderr: "failed to load configuration\n" }),
      });
      const entry = hostWiringEntry(codexAdapter.verify(installEnv), home, {
        configPath: sandbox.configPath,
      });
      const details = (entry["details"] as string[]).join("; ");
      expect(details).toContain("exited 4");
      expect(details).toContain("failed to load configuration");
      // The skip is NAMED, so nothing here reads as a host-confirmed
      // registration.
      expect(details).not.toContain(HOST_PROBE_RESULT.answered);
      expect(entry["target"]).toBe(codexAdapter.target);
    } finally {
      resetHostProbeRunner();
      resetCodexRunner();
    }
  });
});

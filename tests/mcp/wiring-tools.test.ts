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
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { WIRING_TOOL_NAME, WIRING_VIEWS } from "../../src/mcp/wiring-tools.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";
import {
  projectsRegistryPath,
  registerLinkedProject,
  writeVaultPointer,
  VAULT_POINTER_FILE,
} from "../../src/core/brain/portability/pointer.ts";
import { INSTALLATION_SECRET_ENV_KEY, VAULT_STORE_REF_PREFIX } from "../../src/core/config.ts";

/** Deterministic 32-hex key so `vault://<hex>` is stable across runs. */
const SECRET = "0123456789abcdef0123456789abcdef";

/** The escape hatch that restores raw host paths. */
const EXPOSE_ENV = "OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS";

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

async function callWiring(args: Record<string, unknown>): Promise<{
  payload?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  const server = new MCPServer({ vault: sandbox.vault, configPath: sandbox.configPath });
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

  test("a registry damaged by hand degrades to the entries it can read", async () => {
    registerLinkedProject(sandbox.configPath, sandbox.project, sandbox.vault);
    writeFileSync(projectsRegistryPath(sandbox.configPath), "{ broken", "utf8");
    const { payload } = await callWiring({ view: "projects" });
    // Same tolerance `listLinkedProjects` already has: an unreadable
    // registry is zero links, never a thrown handler.
    expect(payload!["projects"]).toEqual([]);
  });
});

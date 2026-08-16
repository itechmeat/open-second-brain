/**
 * Ownership is WRITTEN, or it is not a boundary.
 *
 * `integrity.owner_scope_delivery` withholds a preference whose
 * `owner:` frontmatter names another agent, and every read-side surface
 * honours it. Nothing wrote the field. Every production writer omitted
 * `owner`, so `pageOwner` returned `null` for every page ever produced
 * by this product, `isOwnerVisible` was trivially true, and the gate
 * filtered a population that could not exist. A predicate over an empty
 * set is a label, not a boundary.
 *
 * This file is the enforcement: with the gate switched on, a preference
 * created through any production writer carries the server-resolved
 * agent identity as its owner; with the gate off, not one byte moves.
 *
 * Two properties are load-bearing and asserted separately:
 *
 *   - ownership is stamped at CREATION only. A rewrite carries the
 *     existing owner forward and never re-owns, so a dream pass run by
 *     one agent cannot quietly transfer another agent's memories, and a
 *     page created before the gate was switched on stays shared.
 *   - the identity is SERVER-resolved. No test in this file passes an
 *     `owner` argument to reach the withholding assertion; the vault is
 *     written entirely through shipped surfaces.
 */

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { deriveFact } from "../../../src/core/brain/derived-fact.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import { brainConfigPath, brainDirs, preferencePath } from "../../../src/core/brain/paths.ts";
import { brainConfigKnownKeys } from "../../../src/core/brain/policy.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { writePreferenceTxn } from "../../../src/core/brain/preference-txn.ts";
import {
  collectPreferences,
  type OwnerScopeDelivery,
} from "../../../src/core/brain/preferences-collect.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";
import { GATE_MODE } from "../../../src/core/integrity/stamp.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { changedPaths, digestVaultFiles, digestVaultTree } from "../../helpers/vault-digest.ts";
import { runCli } from "../../helpers/run-cli.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/** Wall clock every core writer in this file is pinned to. */
const NOW = new Date("2026-05-10T00:00:00Z");
/** The identity the ambient config resolves to, i.e. what a writer stamps. */
const SELF = "agent-self";
/** A second identity, used to prove the withholding is not vacuous. */
const OTHER = "agent-other";

/**
 * Env this file owns. `HOME` is pinned per test file by convention
 * (nothing pins it globally) and the identity vars are cleared so the
 * developer's own install cannot decide what a writer stamps.
 */
const OWNED_ENV = [
  "HOME",
  "VAULT_AGENT_NAME",
  "VAULT_DIR",
  "VAULT_TIMEZONE",
  "OPEN_SECOND_BRAIN_CONFIG",
] as const;

let tmp: string;
let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-owner-stamp-"));
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  for (const key of OWNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["HOME"] = home;
  resetVaultIdentityPins();
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A bare vault: Brain directories and a `_brain.yaml`, nothing else. */
function makeVault(name: string, gate: string | null, agent = SELF): string {
  const vault = join(tmp, name);
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  atomicWriteFileSync(
    brainConfigPath(vault),
    `schema_version: 1\n${gate === null ? "" : `integrity:\n  owner_scope_delivery: ${gate}\n`}`,
  );
  const configPath = join(tmp, `${name}-config.yaml`);
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${agent}\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  return vault;
}

/** The `owner:` a preference file carries on disk, or `null`. */
function ownerOf(vault: string, slug: string): string | null {
  return parsePreference(preferencePath(vault, slug)).owner ?? null;
}

/** Minimal valid preference input; never carries an `owner`. */
function prefInput(slug: string): Parameters<typeof writePreference>[1] {
  return {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
  };
}

/** A gate verdict that actually withholds, i.e. `fail` with a scope. */
function enforcing(scope: string): OwnerScopeDelivery {
  return { mode: GATE_MODE.fail, enforcedScope: scope, requestedScope: scope };
}

/**
 * Every core writer that creates a preference, driven once, under a
 * pinned clock. The two feedback surfaces are excluded here and covered
 * by their own tests: both stamp `new Date()` into the signal they write
 * alongside the preference, so two runs can never be byte-identical.
 */
function writeThroughEveryCoreWriter(vault: string): void {
  writePreference(vault, prefInput("direct"));
  writePreferenceTxn(vault, prefInput("txn"), []);
  writePreference(vault, prefInput("premise"));
  deriveFact(
    vault,
    {
      slug: "derived",
      topic: "derived",
      principle: "a derived rule",
      level: "deduced",
      premises: ["pref-premise"],
    },
    { now: NOW },
  );
  writePreference(vault, { ...prefInput("merge-keep"), topic: "merge" });
  writePreference(vault, { ...prefInput("merge-drop"), topic: "merge" });
  mergePreferences(vault, "pref-merge-keep", "pref-merge-drop", { now: NOW, agentName: SELF });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; structuredContent: Record<string, unknown> }> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "owner-stamp", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
  return response.result;
}

// ----- The gate on: every production writer stamps ---------------------------

test("gate fail: every core preference writer stamps the resolved identity", () => {
  const vault = makeVault("stamped", GATE_MODE.fail);
  writeThroughEveryCoreWriter(vault);

  for (const slug of ["direct", "txn", "derived"]) {
    expect(`${slug}=${ownerOf(vault, slug)}`).toBe(`${slug}=${SELF}`);
  }
});

test("gate warn: ownership is written so the operator can watch what fail would remove", () => {
  const vault = makeVault("warned", GATE_MODE.warn);
  writePreference(vault, prefInput("direct"));

  expect(ownerOf(vault, "direct")).toBe(SELF);
});

test("gate fail: the MCP feedback writer stamps the server-resolved identity", async () => {
  const vault = makeVault("mcp", GATE_MODE.fail);
  const configPath = process.env["OPEN_SECOND_BRAIN_CONFIG"] as string;
  const result = await callTool(new MCPServer({ vault, configPath }), "brain_feedback", {
    topic: "mcp-topic",
    signal: "positive",
    principle: "A rule recorded through the MCP writer.",
    force_confirmed: true,
  });

  expect(result.isError).toBe(false);
  expect(ownerOf(vault, "mcp-topic")).toBe(SELF);
});

test("gate fail: the CLI feedback writer stamps the server-resolved identity", async () => {
  const vault = makeVault("cli", GATE_MODE.fail);
  const configPath = process.env["OPEN_SECOND_BRAIN_CONFIG"] as string;
  const run = await runCli(
    [
      "brain",
      "feedback",
      "--vault",
      vault,
      "--topic",
      "cli-topic",
      "--signal",
      "positive",
      "--principle",
      "A rule recorded through the CLI writer.",
      "--force-confirmed",
    ],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath, HOME: home } },
  );

  expect(`exit ${run.returncode}\n${run.stderr}`).toBe("exit 0\n");
  expect(ownerOf(vault, "cli-topic")).toBe(SELF);
});

// ----- Creation-only: a rewrite never re-owns --------------------------------

test("a rewrite carries the existing owner forward and never transfers ownership", () => {
  const vault = makeVault("carry", GATE_MODE.fail, OTHER);
  writePreference(vault, prefInput("owned"));
  expect(ownerOf(vault, "owned")).toBe(OTHER);

  // A second agent rewrites the same preference. Ownership must not move.
  atomicWriteFileSync(
    process.env["OPEN_SECOND_BRAIN_CONFIG"] as string,
    `vault: ${vault}\nagent_name: ${SELF}\n`,
  );
  writePreference(vault, { ...prefInput("owned"), principle: "rewritten" }, { overwrite: true });
  expect(ownerOf(vault, "owned")).toBe(OTHER);
});

test("a page that predates the gate stays shared when the gate is switched on", () => {
  const vault = makeVault("legacy", GATE_MODE.off);
  writePreference(vault, prefInput("legacy"));
  expect(ownerOf(vault, "legacy")).toBeNull();

  appendFileSync(brainConfigPath(vault), `integrity:\n  owner_scope_delivery: ${GATE_MODE.fail}\n`);
  writePreference(vault, { ...prefInput("legacy"), principle: "rewritten" }, { overwrite: true });
  expect(ownerOf(vault, "legacy")).toBeNull();
});

test("merge keeps the surviving preference's owner instead of stripping it", () => {
  const vault = makeVault("merged", GATE_MODE.fail);
  writeThroughEveryCoreWriter(vault);

  expect(ownerOf(vault, "merge-keep")).toBe(SELF);
});

test("an explicit caller-supplied owner still wins over the resolved identity", () => {
  const vault = makeVault("explicit", GATE_MODE.fail);
  writePreference(vault, { ...prefInput("explicit"), owner: OTHER });

  expect(ownerOf(vault, "explicit")).toBe(OTHER);
});

// ----- The gate off: not one byte moves --------------------------------------

test("gate off: two vaults written by the same script are byte-identical and ownerless", () => {
  const first = makeVault("digest-a", GATE_MODE.off);
  writeThroughEveryCoreWriter(first);
  const second = makeVault("digest-b", GATE_MODE.off);
  writeThroughEveryCoreWriter(second);

  // `_brain.yaml` names the vault only through the config file outside
  // the tree, so the two trees are comparable file-for-file.
  expect(digestVaultTree(second)).toBe(digestVaultTree(first));
  expect(changedPaths(digestVaultFiles(first), digestVaultFiles(second))).toEqual([]);

  const dir = brainDirs(first).preferences;
  for (const file of collectPreferences(dir).entries) {
    expect(`${file.name}: ${readFileSync(file.path, "utf8")}`).not.toContain("\nowner:");
  }
});

test("gate off vs gate fail: the only files that differ are the preferences", () => {
  const off = makeVault("off-tree", GATE_MODE.off);
  writeThroughEveryCoreWriter(off);
  const on = makeVault("on-tree", GATE_MODE.fail);
  writeThroughEveryCoreWriter(on);

  // `retired/` is in the expected set on purpose: `moveToRetired` copies
  // every inherited field, so retiring an owner-private memory must not
  // publish it. Nothing else in the tree may move.
  const differing = changedPaths(digestVaultFiles(off), digestVaultFiles(on)).filter(
    (path) => path !== "Brain/_brain.yaml",
  );
  expect(
    differing.filter(
      (path) => !path.startsWith("Brain/preferences/") && !path.startsWith("Brain/retired/"),
    ),
  ).toEqual([]);
  expect(differing.length).toBeGreaterThan(0);
});

// ----- No new config key ------------------------------------------------------

test("owner stamping adds no config key: the integrity block is unchanged", () => {
  const known = brainConfigKnownKeys();
  expect([...(known.subKeys.get("integrity") ?? [])].toSorted()).toEqual([
    "embedding_abi",
    "owner_scope_delivery",
    "pack_validity_seconds",
  ]);
});

// ----- The boundary, on a vault written entirely through production surfaces ---

test("withholding works on a vault no test-only owner argument ever touched", async () => {
  const vault = makeVault("two-agents", GATE_MODE.fail, SELF);
  const selfConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"] as string;
  bootstrapBrain(vault, { configPath: selfConfig });

  await callTool(new MCPServer({ vault, configPath: selfConfig }), "brain_feedback", {
    topic: "self-rule",
    signal: "positive",
    principle: "A rule only the first agent may read.",
    force_confirmed: true,
  });

  const otherConfig = join(tmp, "other-config.yaml");
  atomicWriteFileSync(otherConfig, `vault: ${vault}\nagent_name: ${OTHER}\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = otherConfig;
  await callTool(new MCPServer({ vault, configPath: otherConfig }), "brain_feedback", {
    topic: "other-rule",
    signal: "positive",
    principle: "A rule only the second agent may read.",
    force_confirmed: true,
  });

  const dir = brainDirs(vault).preferences;
  const asSelf = collectPreferences(dir, { ownerScope: enforcing(SELF) });
  const asOther = collectPreferences(dir, { ownerScope: enforcing(OTHER) });

  expect(asSelf.entries.map((e) => e.pref.id)).toEqual(["pref-self-rule"]);
  expect(asOther.entries.map((e) => e.pref.id)).toEqual(["pref-other-rule"]);
  expect(asSelf.hiddenByOwnerScope).toBe(1);
});

// ----- An identity that cannot be reduced to a token is a refusal --------------

test("an unusable resolved identity refuses the write instead of hiding the page", () => {
  const vault = makeVault("blank-identity", GATE_MODE.fail);
  process.env["VAULT_AGENT_NAME"] = "   ";

  expect(() => writePreference(vault, prefInput("blank"))).toThrow(/owner/i);
});

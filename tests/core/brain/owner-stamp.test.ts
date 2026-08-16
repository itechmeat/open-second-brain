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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { deriveFact } from "../../../src/core/brain/derived-fact.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import { brainConfigPath, brainDirs, preferencePath } from "../../../src/core/brain/paths.ts";
import { brainConfigKnownKeys } from "../../../src/core/brain/policy.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { PLACEHOLDER_AGENT_VALUES } from "../../../src/core/agent-identity.ts";
import { ownerStampFor } from "../../../src/core/graph/agent-scope.ts";
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

  // REWRITTEN, not appended: `makeVault` already emitted an `integrity:`
  // block for the `off` gate, and appending a second one produces a
  // duplicate top-level key - i.e. a config the parser rejects. That is
  // the F5 condition, not this test's subject, and a writer now refuses
  // it rather than inferring an owner from a file it could not read.
  atomicWriteFileSync(
    brainConfigPath(vault),
    `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${GATE_MODE.fail}\n`,
  );
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

/**
 * F4: an unconfigured install must not become a real owner named `agent`.
 *
 * `resolveAgentName` never fails - it returns `UNCONFIGURED_AGENT_NAME`,
 * the literal `"agent"` - and `ownerStampFor` accepted it, so a vault
 * with the gate on and no `agent_name` accumulated preferences owned by
 * `agent` while `refuseOwnerScopeRequest` refused every caller asking to
 * be answered as `agent` because that name is unverifiable. The two
 * halves must agree: the predicate that refuses the placeholder as an
 * identity is the one that prevents it becoming an owner.
 */
test("gate fail: the placeholder identity refuses the write instead of owning the page", () => {
  const vault = join(tmp, "unconfigured");
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  atomicWriteFileSync(
    brainConfigPath(vault),
    `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${GATE_MODE.fail}\n`,
  );
  // A config with NO `agent_name`: the state `resolveAgentName` answers
  // with the placeholder.
  const configPath = join(tmp, "unconfigured-config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;

  expect(() => writePreference(vault, prefInput("unowned"))).toThrow(/placeholder/i);
  expect(existsSync(preferencePath(vault, "unowned"))).toBe(false);
});

test("every placeholder identity is refused as an owner, not just the bare default", () => {
  for (const name of PLACEHOLDER_AGENT_VALUES) {
    expect(`${name} -> ${String(ownerStampFor(name))}`).toBe(`${name} -> null`);
  }
  // A real name still stamps, so the refusal is not a blanket one.
  expect(ownerStampFor("claude-vps-agent")).toBe("claude-vps-agent");
});

/**
 * F5: an unreadable `_brain.yaml` silently switched stamping ON, forever.
 *
 * `loadIntegrityConfigSafe`'s strict fallback is scoped to READERS - "the
 * unreadable config cannot loosen a gate, it can only close one" - and a
 * writer was wired to it. Strict here means STAMP, so one bad token in
 * the YAML made every new preference carry an owner the operator never
 * asked for, and ownership is carried forward, so the pages outlived the
 * repair of the typo.
 */
test("an unreadable Brain config refuses the write rather than inferring an owner", () => {
  const vault = makeVault("unreadable-config", GATE_MODE.off);
  atomicWriteFileSync(brainConfigPath(vault), "schema_version: 1\nintegrity: [ this is not yaml\n");

  let message = "";
  try {
    writePreference(vault, prefInput("guessed"));
  } catch (err) {
    message = (err as Error).message;
  }
  // Explicit on both counts: it names the unreadable config, and it says
  // the writer will not guess - never a silent stamp, never a silent skip.
  expect(message).toContain("Brain/_brain.yaml");
  expect(existsSync(preferencePath(vault, "guessed"))).toBe(false);
});

test("an ABSENT Brain config still writes, ownerless, as the documented default", () => {
  // The other half of the reader/writer split: absent is not unreadable.
  const vault = join(tmp, "no-config");
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  const configPath = join(tmp, "no-config-config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${SELF}\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;

  writePreference(vault, prefInput("defaulted"));
  expect(ownerOf(vault, "defaulted")).toBeNull();
});

/**
 * A3: the writer census - "every production writer stamps" measured, not
 * listed.
 *
 * The claim above this line used to be held true by
 * {@link writeThroughEveryCoreWriter}, a HAND-WRITTEN list of four
 * writers. `import-claude-memory.ts` renders its own frontmatter and
 * calls `atomicWriteFileSync` directly, so it was not on the list, never
 * reached `withResolvedOwner`, and shipped every imported memory
 * ownerless into a gated vault. A list is the failure mode this release
 * is about.
 *
 * The population is SYNTACTIC and read off source: a module that both
 * builds a preference path and writes bytes is a preference writer. Each
 * one must reach the shared ownership resolution - `writePreference`,
 * `writePreferenceTxn` or `resolvedOwnerFor` - or carry an entry here
 * saying what it does instead. Never both, never neither.
 */
const PREFERENCE_PATH_BUILDERS = ["preferencePath(", "retiredPath("];
const FS_BYTE_WRITES = [
  "atomicWriteFileSync(",
  "writeFileSync(",
  "appendFileSync(",
  "renameSync(",
  "copyFileSync(",
  "cpSync(",
  "writeFrontmatterAtomic(",
];
/** The three entry points that resolve ownership for a new preference. */
const OWNERSHIP_RESOLVERS = ["writePreference(", "writePreferenceTxn(", "resolvedOwnerFor("];

/** Modules in the syntactic population that write no preference bytes. */
const NO_PREFERENCE_BYTES: Readonly<Record<string, string>> = Object.freeze({
  "src/core/brain/write-batch.ts":
    "builds a preference path only to ASSERT the target exists before an apply-evidence " +
    "operation; every byte it writes goes to a caller-named note path.",
  "src/core/brain/pin.ts":
    "flips ONE existing frontmatter field on an EXISTING page (`{...meta, pinned}`) and never " +
    "creates one, so the `owner:` already on disk is preserved by construction - the same " +
    "outcome the carry-forward branch of the resolver produces, reached without re-deriving it.",
  "src/core/brain/health/remediation.ts":
    "re-stamps ONE derived frontmatter field (`_content_hash`) on an EXISTING page by spreading " +
    "the parsed metadata, so ownership travels untouched and nothing new is created.",
});

test("every module that writes preference bytes reaches the ownership resolver", async () => {
  const { readFileSync: readFile } = await import("node:fs");
  const { lexSource } = await import("../../helpers/source-lexer.ts");
  const root = join(import.meta.dir, "..", "..", "..", "src");

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );
  const offenders: string[] = [];
  for (const abs of walk(root)) {
    const rel = abs.slice(abs.indexOf("src/"));
    if (rel === "src/core/brain/preference.ts") continue; // the resolver's own home
    const code = lexSource(readFile(abs, "utf8")).code;
    const buildsPath = PREFERENCE_PATH_BUILDERS.some((p) => code.includes(p));
    const writesBytes = FS_BYTE_WRITES.some((p) => code.includes(p));
    if (!buildsPath || !writesBytes) continue;
    if (OWNERSHIP_RESOLVERS.some((p) => code.includes(p))) continue;
    if (rel in NO_PREFERENCE_BYTES) continue;
    offenders.push(rel);
  }

  expect(
    offenders,
    "each of these writes preference bytes without reaching the ownership resolver; " +
      "route it through one, or declare it in NO_PREFERENCE_BYTES with a reason",
  ).toEqual([]);
});

test("the claude-memory importer stamps the resolved identity like every other writer", async () => {
  const vault = makeVault("imported", GATE_MODE.fail);
  const memoryDir = join(tmp, "memory");
  mkdirSync(memoryDir, { recursive: true });
  atomicWriteFileSync(
    join(memoryDir, "feedback_probe.md"),
    "---\ntype: feedback\nname: feedback probe\ndescription: An imported rule.\n---\n\nscope: writing\n",
  );

  const { importClaudeMemory } = await import("../../../src/core/brain/import-claude-memory.ts");
  const result = importClaudeMemory({
    vault,
    memoryDir,
    mode: "apply",
    now: NOW,
    allowArbitraryMemoryPath: true,
  });
  expect(result.applied.length).toBe(1);

  expect(ownerOf(vault, "feedback-probe")).toBe(SELF);
});

test("with the gate off the importer writes no owner at all", async () => {
  const vault = makeVault("imported-off", GATE_MODE.off);
  const memoryDir = join(tmp, "memory-off");
  mkdirSync(memoryDir, { recursive: true });
  atomicWriteFileSync(
    join(memoryDir, "feedback_probe.md"),
    "---\ntype: feedback\nname: feedback probe\ndescription: An imported rule.\n---\n\nscope: writing\n",
  );

  const { importClaudeMemory } = await import("../../../src/core/brain/import-claude-memory.ts");
  importClaudeMemory({
    vault,
    memoryDir,
    mode: "apply",
    now: NOW,
    allowArbitraryMemoryPath: true,
  });
  expect(ownerOf(vault, "feedback-probe")).toBeNull();
});

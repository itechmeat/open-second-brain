/**
 * Identity is resolved, never echoed (a-label-is-not-a-boundary, U2).
 *
 * The defect this file exists to catch: with
 * `integrity.owner_scope_delivery` set to `fail` - the mode that reads as
 * "isolate owners" - a caller read ANY owner's private memories by naming
 * that owner in `agent_scope`. `coerceAgentScope` returned the argument
 * unconditionally and `resolveOwnerScopeDelivery` enforced exactly that
 * argument, so the scope the gate enforced was the one the caller asked
 * for, never the one the caller is. Measured before the fix, on the
 * fixture below: `brain_context_pack {agent_scope: "agent-a"}` called as
 * `agent-b` returned `pref-owned-by-a` - the very page the same call with
 * the caller's own scope withheld.
 *
 * Three things are pinned here:
 *
 *   1. the refusal itself, under `fail`, naming both owners;
 *   2. that nothing else moved - no scope, own scope, `warn` and `off`
 *      all answer exactly as they did;
 *   3. that the argument has ONE reader in `src/mcp`, derived from the
 *      source rather than listed here, so a tool cannot opt out of the
 *      check by reading `agent_scope` itself again. Four tools did
 *      exactly that before this unit.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { AGENT_SCOPE_ARG_NAME } from "../../src/mcp/coerce.ts";
import {
  OWNER_SCOPE_GATE_KEY,
  OWNER_SCOPE_REFUSAL,
  OWNER_SCOPE_REFUSALS,
  isOwnerScopeRefusal,
} from "../../src/mcp/owner-scope-refusal.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
/** The private page: delivered to its owner, withheld from everyone else. */
const PRIVATE_ID = "pref-owned-by-a";
/** The ownerless page: delivered to every scope, so it proves a call answered. */
const SHARED_ID = "pref-shared";

/**
 * An identity every write surface already rejects as a guess
 * (`PLACEHOLDER_AGENT_VALUES`), and the literal bottom of the identity
 * chain in `resolveAgentName`. A server holding this holds no identity.
 */
const UNCONFIGURED_IDENTITY = "agent";

/** The tool-table property a caller-supplied writer identity arrives in. */
const AGENT_ARG_NAME = "agent";

/**
 * Tools that accept a caller-supplied writer identity and stamp it onto
 * the record. Derived from the tool table below, never listed - a
 * hand-written list is the defect this release is about. The count is
 * pinned so a tool joining or leaving the set is a decision somebody
 * makes on purpose.
 */
const AGENT_ARGUMENT_TOOL_COUNT = 21;

/** Tools that accept a caller-supplied owner scope, derived the same way. */
const AGENT_SCOPE_TOOL_COUNT = 13;

const TOOLS = buildToolTable("full");
const tool = (name: string): ToolDefinition => {
  const found = TOOLS.find((t) => t.name === name);
  expect(found, `no such tool: ${name}`).toBeDefined();
  return found!;
};

/** Names of the tools whose input schema declares `property`. */
function toolsDeclaring(property: string): string[] {
  return TOOLS.filter((t) => {
    const properties = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    return Object.hasOwn(properties, property);
  })
    .map((t) => t.name)
    .toSorted();
}

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-owner-refusal-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-owner-refusal-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${OWNER_B}\n`);
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  // Written before any gate exists, so the owner is the one this fixture
  // states rather than one a write-time gate stamped.
  makePref("shared");
  makePref("owned-by-a", OWNER_A);
  ctx = { vault, configPath, repoRoot: null, agentName: OWNER_B };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function setGate(mode: string): void {
  writeFileSync(
    brainConfigPath(vault),
    `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${mode}\n`,
  );
}

function makePref(slug: string, owner?: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...(owner !== undefined ? { owner } : {}),
  });
}

/** Invoke a tool AS `agentName`, exactly as the server's seam does. */
async function call(
  name: string,
  args: Record<string, unknown>,
  agentName: string = OWNER_B,
): Promise<string> {
  return JSON.stringify(await tool(name).handler({ ...ctx, agentName }, args));
}

/** The message a rejected call carried, or `null` when it answered. */
async function refusalOf(
  name: string,
  args: Record<string, unknown>,
  agentName: string = OWNER_B,
): Promise<string | null> {
  return call(name, args, agentName).then(
    () => null,
    (e: unknown) => (e as Error).message,
  );
}

const PACK_ARGS = { max_tokens: 4000 };

// ----- the refusal ----------------------------------------------------------

test("a foreign agent_scope under a failing gate is refused, not answered", async () => {
  setGate(GATE_MODE.fail);
  const message = await refusalOf("brain_context_pack", { ...PACK_ARGS, agent_scope: OWNER_A });

  expect(message).not.toBeNull();
  // The refusal diagnoses itself: the typed member, both owners, the gate
  // that made the identity authoritative, and the two things it did NOT
  // do (answer as agent-a, or narrow to agent-b behind the caller's back).
  expect(message).toContain(OWNER_SCOPE_REFUSAL.foreignOwner);
  expect(message).toContain(AGENT_SCOPE_ARG_NAME);
  expect(message).toContain(OWNER_A);
  expect(message).toContain(OWNER_B);
  expect(message).toContain(OWNER_SCOPE_GATE_KEY);
  // And nothing crossed: a refusal is not a payload.
  expect(message).not.toContain(PRIVATE_ID);
});

test("a server with no resolved identity refuses any owner scope it cannot check", async () => {
  setGate(GATE_MODE.fail);
  const message = await refusalOf(
    "brain_context_pack",
    { ...PACK_ARGS, agent_scope: OWNER_A },
    UNCONFIGURED_IDENTITY,
  );

  expect(message).toContain(OWNER_SCOPE_REFUSAL.unresolvedIdentity);
  expect(message).not.toContain(PRIVATE_ID);
  // Distinct from the foreign-owner case: an unconfigured server is not a
  // caller that asked for somebody else, and reading it as one would blame
  // the caller for the operator's missing setting.
  expect(message).not.toContain(OWNER_SCOPE_REFUSAL.foreignOwner);
});

test("the refusal reaches every kind of surface that accepts the argument", async () => {
  setGate(GATE_MODE.fail);
  const surfaces: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
    { name: "brain_context_pack", args: PACK_ARGS },
    { name: "brain_pre_compress_pack", args: { top_k: 10 } },
    { name: "brain_brief", args: { view: "morning" } },
    { name: "brain_anticipatory_context", args: { session_id: "sess-1" } },
    { name: "brain_retrieval_plan", args: { question: "lattice widgets" } },
    // Not gated by `owner_scope_delivery` today, and refused all the same:
    // the argument means the caller's own owner under `fail`, on every
    // surface that takes it.
    { name: "brain_agent_query", args: { kind: "preference" } },
    { name: "brain_search_by_source", args: { source_file: "sources/paper.md" } },
  ];

  const outcomes = await Promise.all(
    surfaces.map(async (s) => ({
      name: s.name,
      message: await refusalOf(s.name, { ...s.args, agent_scope: OWNER_A }),
    })),
  );
  for (const { name, message } of outcomes) {
    expect(message, `${name} must refuse a foreign owner scope`).toContain(
      OWNER_SCOPE_REFUSAL.foreignOwner,
    );
  }
});

// ----- what did not move ----------------------------------------------------

test("a caller naming its own identity is answered, and still isolated", async () => {
  setGate(GATE_MODE.fail);
  const out = await call("brain_context_pack", { ...PACK_ARGS, agent_scope: OWNER_B });
  expect(out).toContain(SHARED_ID);
  expect(out).not.toContain(PRIVATE_ID);

  const asOwner = await call("brain_context_pack", { ...PACK_ARGS, agent_scope: OWNER_A }, OWNER_A);
  expect(asOwner).toContain(PRIVATE_ID);
});

test("a caller supplying no scope is unaffected", async () => {
  setGate(GATE_MODE.fail);
  const out = await call("brain_context_pack", PACK_ARGS);
  expect(out).toContain(SHARED_ID);
  expect(out).not.toContain(PRIVATE_ID);
});

test("with the gate off or at warn, a foreign scope is answered exactly as before", async () => {
  for (const mode of [GATE_MODE.off, GATE_MODE.warn]) {
    setGate(mode);
    const out = await call("brain_context_pack", { ...PACK_ARGS, agent_scope: OWNER_A });
    // Neither mode withholds anything, so a foreign scope delivers nothing
    // an absent one would not, and refusing would break `warn`'s purpose.
    expect(out, `gate ${mode}`).toContain(PRIVATE_ID);
  }
});

test("a vault with no gate configured at all is unaffected", async () => {
  const out = await call("brain_context_pack", { ...PACK_ARGS, agent_scope: OWNER_A });
  expect(out).toContain(PRIVATE_ID);
});

test("a blank scope narrows nothing, so it is not a conflict", async () => {
  setGate(GATE_MODE.fail);
  const out = await call("brain_context_pack", { ...PACK_ARGS, agent_scope: "   " });
  expect(out).toContain(PRIVATE_ID);
});

// ----- the vocabulary -------------------------------------------------------

test("the refusal vocabulary is closed and its guard rejects a near miss", () => {
  expect(OWNER_SCOPE_REFUSALS).toEqual([
    OWNER_SCOPE_REFUSAL.unresolvedIdentity,
    OWNER_SCOPE_REFUSAL.foreignOwner,
  ]);
  for (const member of OWNER_SCOPE_REFUSALS) expect(isOwnerScopeRefusal(member)).toBe(true);
  for (const outsider of ["", "refused", OWNER_A, null, undefined, 42, {}]) {
    expect(isOwnerScopeRefusal(outsider)).toBe(false);
  }
});

// ----- the enumerations, derived from the source ----------------------------

/** Every `.ts` file under `src/mcp`, the tool surface's whole tree. */
function mcpSources(): string[] {
  const root = join(import.meta.dir, "..", "..", "src", "mcp");
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(root, entry))
    .toSorted();
}

test("the owner-scope argument has exactly one reader in src/mcp", () => {
  const literal = new RegExp(`["']${AGENT_SCOPE_ARG_NAME}["']`);
  const readers = mcpSources().filter((path) => literal.test(readFileSync(path, "utf8")));
  const repoRoot = join(import.meta.dir, "..", "..");
  // One seam, named once. Before this unit four tools spelled the
  // argument themselves and would have kept the echo the seam removes;
  // a fifth is now a build failure rather than a silent opt-out.
  expect(readers.map((p) => relative(repoRoot, p))).toEqual(["src/mcp/coerce.ts"]);
});

test("every tool declaring agent_scope is covered by that one seam", () => {
  const declaring = toolsDeclaring(AGENT_SCOPE_ARG_NAME);
  expect(declaring.length).toBe(AGENT_SCOPE_TOOL_COUNT);
  for (const name of declaring) {
    const property = (tool(name).inputSchema as { properties: Record<string, { type?: unknown }> })
      .properties[AGENT_SCOPE_ARG_NAME];
    expect(property?.type, `${name}.${AGENT_SCOPE_ARG_NAME}`).toBe("string");
  }
});

/**
 * The write side of the same echo: 21 tools accept a caller-supplied
 * `agent` and stamp it verbatim. That is `passthrough`, shipped and
 * ungated, and this unit does not gate it - `brain_generation_reports`
 * uses the same argument as a LIST FILTER, so a blanket refusal at the
 * seam would change a read as well as a write. What this pins is the
 * population a gate would have to cover, derived from the tool table so
 * it cannot drift the way a hand-written list does.
 */
test("the tools that stamp a caller-supplied agent are enumerated from the tool table", () => {
  const declaring = toolsDeclaring(AGENT_ARG_NAME);
  expect(declaring.length).toBe(AGENT_ARGUMENT_TOOL_COUNT);
  // Disjoint from the scope population: one names who writes, the other
  // names who may read, and conflating them is how a label becomes a
  // boundary in prose only.
  const scoped = new Set(toolsDeclaring(AGENT_SCOPE_ARG_NAME));
  expect(declaring.filter((name) => scoped.has(name))).toEqual([]);
});

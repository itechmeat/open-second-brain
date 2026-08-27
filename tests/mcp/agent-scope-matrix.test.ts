/**
 * Owner-scope isolation regression matrix (context-integrity-gates,
 * Unit A / Task 8).
 *
 * Before this wave, `isOwnerVisible` — the vault's ONLY isolation rule —
 * had two callers, and every other content-returning MCP surface
 * bypassed it. The defect was not any single missing filter; it was that
 * nothing enumerated the surfaces, so each new one silently opted out.
 *
 * This file is that enumeration. Every tool in the table is classified
 * exactly once, and the three buckets are asserted to partition the tool
 * table exactly — in BOTH directions. A new tool therefore fails this
 * test until someone classifies it, and a removed tool fails it until
 * someone deletes the entry. That is the mechanism; the per-surface
 * assertions below are what it protects.
 *
 * ## What the partition was worth on its own (a-label-is-not-a-boundary, U3)
 *
 * Nothing. `SCOPED_SURFACES` carried behavioural tests; the other two
 * buckets carried a name and, in one of them, a prose reason nothing
 * read. A sweep against a two-owner vault under
 * `integrity.owner_scope_delivery: fail` found TEN classified-as-safe
 * tools returning another owner's artifact ids, paths, titles and body
 * prose. A bucket whose membership claim is never executed is a label,
 * and the release this unit belongs to is about what a label is worth.
 *
 * So both unasserted buckets now carry `{name, args, reason}`: the
 * arguments that DRIVE the tool, and a written reason for the
 * classification. {@link assertProbeEntry} refuses an entry without
 * them at module load, and {@link ProbeEntry} refuses one at
 * `bun run typecheck`, so the bucket cannot regrow as a bare name list.
 * Every entry is then driven against one two-owner fixture and its
 * response — or the message it threw — is asserted to carry no marker
 * unique to the other owner's artifacts.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig, search } from "../../src/core/search/index.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { brainActivePath, brainConfigPath, brainDirs } from "../../src/core/brain/paths.ts";
import { regenerateActive } from "../../src/core/brain/active.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { runHygieneScan } from "../../src/core/brain/hygiene/scan.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { OWNER_SCOPE_REFUSAL } from "../../src/mcp/owner-scope-refusal.ts";
import {
  CROSS_OWNER_MARKER,
  HUB_ID,
  LOG_EVENT_DATE,
  NEUTRAL_SIGNAL_SLUG,
  OWNER_A,
  OWNER_B,
  PROBE,
  PROBE_ENTRIES,
  PROBE_ENTRY_COUNT,
  PROBE_RECIPE_COUNT,
  PROBE_TERMS,
  PROBE_TWO_SIDED_COUNT,
  QUERY,
  REASON,
  REASONS_REACHING_OWNER_CONTENT,
  SCOPE_SOURCE,
  SCOPED_SURFACES,
  SHARED_ID,
  SHARED_TITLE,
  SHARED_TOPIC,
  REASON_MIN_CHARS,
  assertProbeEntry,
  probeLabel,
  type ProbeCall,
} from "../helpers/tool-probe-catalogue.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

/**
 * HOME is pinned for THIS file, and nothing pins it globally.
 *
 * `resolveDeviceId`, `resolveAgentName` and the profile writer all fall
 * back to the operator's real `~/.config/open-second-brain/config.yaml`
 * when a call supplies no explicit config path, and the isolation probe
 * below drives every writer in the tool table. A global pin would hide
 * the config-reading behaviour other suites exist to exercise, so the
 * file that needs the pin sets it - at module scope, which runs before
 * any test body and before any of these tools is ever called.
 */
process.env["HOME"] = mkdtempSync(join(tmpdir(), "o2b-scope-matrix-home-"));

const TOOLS = buildToolTable("full");
const tool = (name: string): ToolDefinition => {
  const found = TOOLS.find((t) => t.name === name);
  expect(found, `no such tool: ${name}`).toBeDefined();
  return found!;
};

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-scope-matrix-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scope-matrix-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${OWNER_B}\n`);
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "owned-a.md"),
    `---\nowner: ${OWNER_A}\n---\n\n${QUERY} ${PROBE_TERMS} owned by a\n`,
  );
  writeFileSync(join(vault, "notes", "shared.md"), `# Shared\n\n${QUERY} ${PROBE_TERMS} shared\n`);
  makePref("shared");
  makePref("owned-by-a", OWNER_A);
  ctx = { vault, configPath, repoRoot: null, agentName: OWNER_B };
  await indexVault(resolveSearchConfig({ vault, configPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function setGate(mode: string | null): void {
  const body = mode === null ? "" : `integrity:\n  owner_scope_delivery: ${mode}\n`;
  writeFileSync(brainConfigPath(vault), `schema_version: 1\n${body}`);
}

function makePref(
  slug: string,
  owner?: string,
  overrides: Partial<Parameters<typeof writePreference>[1]> = {},
): void {
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
    ...overrides,
  });
}

/**
 * Invoke a tool AS `agentName`. Argument-scoped surfaces read the scope
 * from `args`; `brain_context` takes no arguments and can only read the
 * server identity, so the identity is varied alongside the argument and
 * each surface picks up whichever source it declares.
 */
async function call(
  name: string,
  args: Record<string, unknown>,
  agentName: string = OWNER_B,
): Promise<string> {
  return JSON.stringify(await tool(name).handler({ ...ctx, agentName }, args));
}

/** Vault-relative paths a listing surface returned. */
function pagePaths(result: { pages: Array<{ path: string }> }): string[] {
  return result.pages.map((p) => p.path);
}

/** Entry ids a source-trace surface returned. */
function entryIds(result: { entries: Array<{ id: string }> }): string[] {
  return result.entries.map((e) => e.id);
}

/** Contribution ids a provenance surface returned, sorted. */
function contributionIds(result: { contributions: Array<{ id: string }> }): string[] {
  return result.contributions.map((c) => c.id).toSorted();
}

// ----- the mechanism --------------------------------------------------------

test("the matrix classifies every tool exactly once", () => {
  const classified = [...SCOPED_SURFACES.map((s) => s.name), ...PROBE_ENTRIES.map((s) => s.name)];
  expect(new Set(classified).size).toBe(classified.length);

  const actual = TOOLS.map((t) => t.name).toSorted();
  // Both directions: a NEW tool fails until it is classified, and a
  // REMOVED tool fails until its entry is deleted.
  expect(classified.toSorted()).toEqual(actual);
});

test("the tool count is unchanged: an argument was added, never a tool", () => {
  expect(TOOLS.length).toBe(113);
});

test("every argument-scoped surface declares agent_scope in its input schema", () => {
  for (const surface of SCOPED_SURFACES) {
    const schema = tool(surface.name).inputSchema as {
      properties?: Record<string, unknown>;
    };
    const declared = Object.keys(schema.properties ?? {});
    if (surface.source === SCOPE_SOURCE.argument) {
      expect(declared, `${surface.name} must accept agent_scope`).toContain("agent_scope");
    } else {
      expect(declared, `${surface.name} takes no arguments`).toEqual([]);
    }
  }
});

test("brain_context keeps its no-argument contract and reads the server identity", () => {
  const schema = tool("brain_context").inputSchema as Record<string, unknown>;
  expect(schema["additionalProperties"]).toBe(false);
  expect(Object.keys((schema["properties"] ?? {}) as Record<string, unknown>)).toEqual([]);
});

// ----- gated preference-backed surfaces -------------------------------------

const GATED_CALLS: ReadonlyArray<{
  readonly name: string;
  readonly args: (scope: string | null) => Record<string, unknown>;
}> = [
  { name: "brain_context", args: () => ({}) },
  {
    name: "brain_context_pack",
    args: (s) => ({ max_tokens: 4000, ...(s === null ? {} : { agent_scope: s }) }),
  },
  {
    name: "brain_pre_compress_pack",
    args: (s) => ({ top_k: 10, ...(s === null ? {} : { agent_scope: s }) }),
  },
  {
    name: "brain_brief",
    args: (s) => ({ view: "morning", ...(s === null ? {} : { agent_scope: s }) }),
  },
  {
    name: "brain_anticipatory_context",
    args: (s) => ({ session_id: "sess-1", ...(s === null ? {} : { agent_scope: s }) }),
  },
];

for (const surface of GATED_CALLS) {
  test(`${surface.name}: gate off delivers every owner's memory`, async () => {
    setGate(GATE_MODE.off);
    expect(await call(surface.name, surface.args(OWNER_B), OWNER_B)).toContain("owned-by-a");
  });

  test(`${surface.name}: gate fail withholds another owner's memory`, async () => {
    setGate(GATE_MODE.fail);
    const out = await call(surface.name, surface.args(OWNER_B), OWNER_B);
    expect(out).not.toContain("owned-by-a");
    expect(out).toContain("shared");
  });

  test(`${surface.name}: gate fail keeps the owner's own memory`, async () => {
    setGate(GATE_MODE.fail);
    expect(await call(surface.name, surface.args(OWNER_A), OWNER_A)).toContain("owned-by-a");
  });
}

/**
 * A3: a per-request visibility filter must never drive a shared write.
 *
 * `brain_context` used to reach `regenerateActive(vault, { agentScope })`,
 * and `regenerateActive` WRITES `Brain/active.md`. Under `fail` a call from
 * agent-b therefore rewrote the shared file without agent-a's memories -
 * and `hooks/active-inject.ts` injects that same file into every agent's
 * SessionStart, while `resources.ts` regenerates it unscoped. The file
 * thrashed and an agent could lose its own memories from session start.
 */
test("brain_context scopes what it returns without narrowing active.md", async () => {
  setGate(GATE_MODE.fail);
  regenerateActive(vault);
  const activePath = brainActivePath(vault);
  const before = readFileSync(activePath, "utf8");
  expect(before).toContain("owned-by-a");

  const out = await call("brain_context", {}, OWNER_B);
  expect(out).not.toContain("owned-by-a");
  expect(out).toContain("shared");

  // The SHARED file is untouched: same bytes, still carrying every owner.
  expect(readFileSync(activePath, "utf8")).toBe(before);
});

test("brain_context creates active.md unscoped on a vault that has none", async () => {
  setGate(GATE_MODE.fail);
  const activePath = brainActivePath(vault);
  rmSync(activePath, { force: true });

  await call("brain_context", {}, OWNER_B);
  expect(readFileSync(activePath, "utf8")).toContain("owned-by-a");
});

/**
 * A6: `agent_scope` is declared once for the whole `brain_brief` tool, but
 * only two of its seven views thread it. The other five returned
 * preference ids (`weekly.retired[].prefId`, the operator dashboard's
 * ranked actions) to a caller that believed it was scoped. An argument a
 * tool accepts and silently ignores is exactly the failure mode this wave
 * exists to remove, so those views refuse it.
 */
test("brain_brief refuses agent_scope on the views that cannot honour it", async () => {
  const views = ["daily", "weekly", "monthly", "operator", "today"];
  const outcomes = await Promise.all(
    views.map((view) =>
      call("brain_brief", { view, agent_scope: OWNER_B }).then(
        () => null,
        (e: unknown) => (e as Error).message,
      ),
    ),
  );
  for (const [i, message] of outcomes.entries()) {
    expect(message, `view=${views[i]}`).toContain(
      `brain_brief view=${views[i]} cannot honour 'agent_scope'`,
    );
  }
});

test("brain_brief still serves those views without the argument", async () => {
  const served = await Promise.all(
    ["daily", "weekly", "monthly", "today"].map((view) => call("brain_brief", { view })),
  );
  for (const out of served) expect(typeof out).toBe("string");
});

/**
 * This test used to drive the same tool twice from ONE caller - `agent-b`
 * - naming `agent-a` once and itself once, and asserted that naming
 * `agent-a` returned MORE items. It passed, and what it pinned was the
 * leak: under `fail` the gate enforced the scope the caller asked for,
 * so a caller selected which owner's private memory it received
 * (a-label-is-not-a-boundary, U2). The count difference is still the
 * measurement, but each caller now names only itself, and the crossing
 * call is refused by name rather than counted.
 */
test("brain_retrieval_plan counts only the memories its caller may see", async () => {
  setGate(GATE_MODE.fail);
  const asA = JSON.parse(
    await call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_A }, OWNER_A),
  );
  const asB = JSON.parse(
    await call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_B }, OWNER_B),
  );
  expect(asA.allocation.item_count).toBeGreaterThan(asB.allocation.item_count);
});

test("brain_retrieval_plan refuses a caller that names another owner", async () => {
  setGate(GATE_MODE.fail);
  await expect(
    call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_A }, OWNER_B),
  ).rejects.toThrow(OWNER_SCOPE_REFUSAL.foreignOwner);
});

// ----- ungated search-backed surfaces ---------------------------------------

test("brain_search_expand refuses another owner's chunk as if it were absent", async () => {
  const config = resolveSearchConfig({ vault, configPath: ctx.configPath ?? undefined });
  const hit = (await search(config, { query: QUERY, limit: 20 })).results.find(
    (r) => r.path === "notes/owned-a.md",
  );
  expect(hit).toBeDefined();

  expect(await call("brain_search_expand", { chunk_id: hit!.chunkId })).toContain(
    "notes/owned-a.md",
  );
  await expect(
    call("brain_search_expand", { chunk_id: hit!.chunkId, agent_scope: OWNER_B }),
  ).rejects.toThrow(`chunk not found: ${hit!.chunkId}`);
});

test("second_brain_query excludes another owner's pages from the listing", async () => {
  const unscoped = JSON.parse(await call("second_brain_query", { limit: 500 }));
  const scoped = JSON.parse(await call("second_brain_query", { limit: 500, agent_scope: OWNER_B }));
  expect(pagePaths(unscoped)).toContain("notes/owned-a.md");
  expect(pagePaths(unscoped)).toContain("Brain/preferences/pref-owned-by-a.md");
  expect(pagePaths(scoped)).not.toContain("notes/owned-a.md");
  expect(pagePaths(scoped)).not.toContain("Brain/preferences/pref-owned-by-a.md");
  // The shared pages survive, and the reported total is the visible one -
  // a count that still included the hidden pages would leak their number.
  expect(pagePaths(scoped)).toContain("notes/shared.md");
  expect(scoped.total_pages).toBe(scoped.pages.length);
  expect(scoped.total_pages).toBeLessThan(unscoped.total_pages);
});

/**
 * A5/A8: the listing must fail CLOSED on an unreadable page, matching
 * `brain_search_by_source` and the ranked search path. Empty frontmatter
 * from a failed read is byte-indistinguishable from a genuinely ownerless
 * page, so without the walk's diagnostic sink an owner-tagged page becomes
 * shared the moment its file stops being readable.
 */
test("second_brain_query hides a page it cannot read from a scoped caller", async () => {
  const target = join(vault, "notes", "owned-a.md");
  chmodSync(target, 0o000);
  try {
    const scoped = JSON.parse(
      await call("second_brain_query", { limit: 500, agent_scope: OWNER_B }),
    );
    expect(pagePaths(scoped)).not.toContain("notes/owned-a.md");
    expect(pagePaths(scoped)).toContain("notes/shared.md");
  } finally {
    chmodSync(target, 0o644);
  }
});

test("brain_search_by_source excludes another owner's derived pages", async () => {
  const sourceFile = "sources/paper.md";
  const derived = join(vault, "Brain", "sources");
  mkdirSync(derived, { recursive: true });
  writeFileSync(
    join(derived, "src-owned-a.md"),
    `---\nid: src-owned-a\nowner: ${OWNER_A}\nsource_path: ${sourceFile}\n---\n\nderived for a\n`,
  );
  writeFileSync(
    join(derived, "src-shared.md"),
    `---\nid: src-shared\nsource_path: ${sourceFile}\n---\n\nderived for everyone\n`,
  );

  const unscoped = JSON.parse(await call("brain_search_by_source", { source_file: sourceFile }));
  const scoped = JSON.parse(
    await call("brain_search_by_source", { source_file: sourceFile, agent_scope: OWNER_B }),
  );
  expect(entryIds(unscoped).toSorted()).toEqual(["src-owned-a", "src-shared"]);
  expect(entryIds(scoped)).toEqual(["src-shared"]);
  expect(scoped.total).toBe(1);
});

test("brain_agent_query excludes another owner's preference contributions", async () => {
  // A preference contribution only surfaces once its evidence signals
  // exist, because the contribution's agents are read from them.
  for (const slug of ["shared", "owned-by-a"]) {
    writeSignal(vault, {
      topic: slug,
      signal: "positive",
      agent: "agent-x",
      principle: `principle for ${slug}`,
      created_at: "2026-05-01T00:00:00Z",
      date: "2026-05-01",
      slug,
    });
  }

  const unscoped = JSON.parse(await call("brain_agent_query", { kind: "preference" }));
  const scoped = JSON.parse(
    await call("brain_agent_query", { kind: "preference", agent_scope: OWNER_B }),
  );
  expect(contributionIds(unscoped)).toEqual(["pref-owned-by-a", "pref-shared"]);
  expect(contributionIds(scoped)).toEqual(["pref-shared"]);
  expect(scoped.total_matched).toBe(1);
});

/**
 * A5: the roster must be folded from the SAME filtered set the
 * contributions are. Built independently of the owner filter it reported
 * a correct `total_matched` beside an `available_agents` entry naming the
 * withheld preference's topic verbatim and counting it - which is the
 * existence leak the boundary exists to prevent.
 *
 * The evidence signal carries a DIFFERENT topic from the preference it
 * evidences, so the preference's topic can only reach the roster through
 * the preference contribution itself.
 */
test("brain_agent_query's roster names only what the caller may see", async () => {
  writeSignal(vault, {
    topic: "neutral-topic",
    signal: "positive",
    agent: "agent-y",
    principle: "principle for the neutral signal",
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug: "secret-pref",
  });
  makePref("secret-pref", OWNER_A);

  const rosterFor = (result: {
    available_agents: Array<{ id: string; topics: string[]; contribution_count: number }>;
  }): { topics: string[]; contribution_count: number } => {
    const entry = result.available_agents.find((a) => a.id === "agent-y");
    expect(entry).toBeDefined();
    return entry!;
  };

  const unscoped = rosterFor(JSON.parse(await call("brain_agent_query", {})));
  expect(unscoped.topics).toEqual(["neutral-topic", "secret-pref"]);
  expect(unscoped.contribution_count).toBe(2);

  const scoped = rosterFor(JSON.parse(await call("brain_agent_query", { agent_scope: OWNER_B })));
  expect(scoped.topics).toEqual(["neutral-topic"]);
  expect(scoped.contribution_count).toBe(1);
});

test("brain_file_context and brain_deep_synthesis exclude another owner's page", async () => {
  const cases = [
    { name: "brain_file_context", args: { file_path: join(vault, "notes", PROBE), min_bytes: 0 } },
    { name: "brain_deep_synthesis", args: { topic: QUERY } },
  ];
  // Both calls per case are issued together: they share no state, and a
  // sequential await here is only a slower way to reach the same result.
  const outcomes = await Promise.all(
    cases.map(async ({ name, args }) => ({
      name,
      unscoped: await call(name, args),
      scoped: await call(name, { ...args, agent_scope: OWNER_B }),
    })),
  );
  for (const { name, unscoped, scoped } of outcomes) {
    expect(unscoped, `${name} unscoped`).toContain("notes/owned-a.md");
    expect(scoped, `${name} scoped`).not.toContain("notes/owned-a.md");
    expect(scoped, `${name} scoped`).toContain("notes/shared.md");
  }
});

// ----- the isolation probe --------------------------------------------------

/**
 * Insert extra frontmatter lines and extra body text into an artifact the
 * shipped writer produced.
 *
 * The writers accept no `title` and no body, and the probe needs both: a
 * title is the only term `findUnlinkedMentions` matches on, and a body is
 * where `auditMoc` reads a hub's outbound cluster from. Patching the
 * writer's own output keeps every schema-owned field exactly as the
 * writer spelled it.
 */
function patchArtifact(rel: string, frontmatter: ReadonlyArray<string>, body: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  expect(close, `${rel} has no frontmatter block`).toBeGreaterThan(0);
  const head = frontmatter.length === 0 ? "" : `\n${frontmatter.join("\n")}`;
  const tail = body.length === 0 ? "" : `\n${body}\n`;
  writeFileSync(abs, text.slice(0, close) + head + text.slice(close) + tail);
}

/**
 * The two-owner fixture every {@link PROBE_ENTRIES} entry is driven
 * against.
 *
 * Additive to `beforeEach`, not a replacement for it: the per-surface
 * tests above pin exact ids and exact counts over the smaller vault, and
 * a fixture that grew under them would move those numbers for reasons
 * that have nothing to do with what they assert.
 *
 * Every artifact seeded here that belongs to {@link OWNER_A} carries
 * {@link CROSS_OWNER_MARKER} in its id, so a surface that names one -
 * as an id, a path, a topic, a title or a line of prose - fails the
 * probe without the probe having to know which field it used.
 *
 * The forced full index at the end is a precondition, not a habit:
 * `brain_scaffold_stub action=list` refuses on an incrementally-indexed
 * vault (`notes/scaffold-stub.ts` `partial_resolution`) and returns no
 * targets at all, which would read as a clean probe over a surface that
 * never ran.
 */
async function seedTwoOwnerFixture(): Promise<void> {
  const ownedPref = `${CROSS_OWNER_MARKER}-a`;
  const ownedPref2 = `${CROSS_OWNER_MARKER}-a2`;
  const ownedPrefOnSharedTopic = `${CROSS_OWNER_MARKER}-a3`;
  const ownedPrefDuplicate = `${CROSS_OWNER_MARKER}-a4`;

  // The evidence signal is deliberately NEUTRAL-named and ownerless: a
  // signal carries no `owner:` anywhere in this product (`signal.ts` has
  // no such field), so a marker inside one would be a marker inside a
  // SHARED artifact and every `not.toContain` below would be asserting
  // against something the caller is entitled to read.
  writeSignal(vault, {
    topic: NEUTRAL_SIGNAL_SLUG,
    signal: "positive",
    agent: OWNER_A,
    principle: "principle for the neutral evidence signal",
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug: NEUTRAL_SIGNAL_SLUG,
    source: [`[[${SHARED_ID}]]`],
  });

  // `applied_count: 0` is what the hygiene scan's usefulness detector
  // measures, and the finding it emits names the preference by id.
  const unused = { evidenced_by: [`[[sig-2026-05-01-${NEUTRAL_SIGNAL_SLUG}]]`], applied_count: 0 };
  makePref(ownedPref, OWNER_A, unused);
  makePref(ownedPref2, OWNER_A, { applied_count: 0 });
  // A THIRD owner-A preference carrying `ownedPref2`'s principle
  // verbatim, so the dedup detector nominates that pair for a MERGE -
  // the one hygiene action with an applier behind it. Without an
  // applicable finding, `mode=apply` returns nothing but opaque hashes
  // and the probe cannot see whether it wrote across the boundary.
  // Same TOPIC as well as the same principle: `findMergeCandidates`
  // buckets by `(topic, scope)` and only compares inside a bucket, so a
  // duplicate principle under a different topic is never nominated.
  makePref(ownedPrefDuplicate, OWNER_A, {
    applied_count: 0,
    topic: ownedPref2,
    principle: `principle for ${ownedPref2}`,
  });
  // Owner-A's preference on the SHARED topic: the artifact a topic
  // fan-out reaches without the caller ever naming it.
  makePref(ownedPrefOnSharedTopic, OWNER_A, { topic: SHARED_TOPIC });
  makePref("hub");

  // The shared preference gains the title the mention scanner matches on;
  // the owner-A preference gains a body that spells that title in raw
  // prose, which is the unlinked mention that must not cross.
  patchArtifact(`Brain/preferences/${SHARED_ID}.md`, [`title: ${SHARED_TITLE}`], "");
  patchArtifact(
    `Brain/preferences/pref-${ownedPref}.md`,
    [`supersedes: "[[${SHARED_ID}]]"`],
    `See [[${SHARED_ID}]]. Also ${SHARED_TITLE} ${CROSS_OWNER_MARKER} here.`,
  );
  // A shared hub whose outbound cluster names both owner-A members plus a
  // target that does not exist: `wellCovered`/`fragile` classify the two
  // that resolve, `candidateMissing` names the one that does not.
  patchArtifact(
    `Brain/preferences/${HUB_ID}.md`,
    [],
    `Hub. [[pref-${ownedPref}]] [[pref-${ownedPref2}]] [[${SHARED_ID}]] [[missing-shared-member]]`,
  );

  writeFileSync(
    join(brainDirs(vault).retired, `ret-${CROSS_OWNER_MARKER}-a.md`),
    [
      "---",
      "kind: brain-retired",
      `id: ret-${CROSS_OWNER_MARKER}-a`,
      `owner: ${OWNER_A}`,
      "created_at: 2026-05-01T00:00:00Z",
      "tags: []",
      `topic: ${CROSS_OWNER_MARKER}-a`,
      "principle: retired principle",
      "provenance: observed",
      "retired_at: 2026-05-03T00:00:00Z",
      `retired_by: "[[${SHARED_ID}]]"`,
      "retired_reason: superseded-by-context",
      "_status: retired",
      "_evidenced_by: []",
      "---",
      "",
      `See [[${SHARED_ID}]] and ${SHARED_TITLE} ${CROSS_OWNER_MARKER}.`,
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(vault, "notes", `${CROSS_OWNER_MARKER}-a.md`),
    `---\nowner: ${OWNER_A}\n---\n\n${QUERY} ${PROBE_TERMS} [[missing-${CROSS_OWNER_MARKER}-target]]\n`,
  );

  for (const slug of [ownedPref, ownedPrefOnSharedTopic]) {
    appendLogEvent(
      vault,
      {
        timestamp: `${LOG_EVENT_DATE}T00:00:00Z`,
        eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
        body: {
          path: `Brain/preferences/pref-${slug}.md`,
          preference: `[[pref-${slug}]]`,
          result: "applied",
        },
      },
      { deviceId: "" },
    );
  }

  await indexVault(resolveSearchConfig({ vault, configPath: ctx.configPath ?? undefined }), {
    force: true,
  });
}

/**
 * Drive one recipe and return everything the caller would see.
 *
 * A thrown message counts: a refusal that quotes the artifact it choked
 * on discloses exactly as much as a successful response would, and this
 * repository has already shipped one of those (`schema_inspect view=lint`
 * naming a host path in its parse error).
 */
async function probeResponse(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    return await call(name, args, OWNER_B);
  } catch (err) {
    return `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Resolve a recipe's arguments against the seeded fixture. */
function probeArgs(recipe: ProbeCall): Record<string, unknown> {
  return typeof recipe.args === "function" ? recipe.args(vault) : recipe.args;
}

test("the probe's own fixture puts the marker in front of an unscoped caller", async () => {
  setGate(GATE_MODE.off);
  await seedTwoOwnerFixture();
  // Without this, every `not.toContain` below would pass on a fixture that
  // simply never produced the rows - the failure mode recon named when it
  // said several clean sweeps were clean because the fixture was empty.
  expect(await probeResponse("brain_backlinks", { id: SHARED_ID })).toContain(CROSS_OWNER_MARKER);
});

/**
 * Wall-clock ceiling for one probe.
 *
 * Above bun's 5s default because two entries do real work before they can
 * answer - `brain_codegraph_report` walks the in-scope project and
 * `brain_review_candidates` runs a full dry-run consolidation pass - and
 * a probe that times out reports a leak that is not there.
 */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * The differential: gate OFF versus gate FAIL, per recipe.
 *
 * A one-sided probe cannot fail. `off` discloses a SUPERSET of what
 * `fail` discloses, so a recipe that does not surface the marker
 * unscoped can never surface it scoped either - and a sweep of the
 * previous, one-recipe-per-tool version found 81 of 96 entries in
 * exactly that state, naming artifacts the fixture never created or
 * driving an empty lane. Every one of them read as a clean isolation
 * result over a call that was never isolating anything.
 *
 * So both directions are asserted, and which direction depends on the
 * recipe's own reason:
 *
 *   - {@link REASON.ownerFiltered} claims the call REACHES owner-taggable
 *     artifacts and filters them. Both halves are executed: the marker
 *     MUST appear with the gate off, and MUST NOT with the gate on. The
 *     first half is what stops the second from being vacuous.
 *   - every other reason in {@link REASON} claims the call cannot name
 *     an owner-private artifact at all - a session lane, an ownerless
 *     lane, a catalog, a caller-named artifact, a writer's echo, an
 *     aggregate with no per-artifact identity. That claim is executed
 *     directly: the marker must be absent even with the gate OFF, where
 *     nothing is hidden. A recipe that surfaces it there has a FALSE
 *     reason, and the fix is to filter the surface and move it to
 *     `ownerFiltered` - never to widen the reason.
 *
 * The exemption from the two-sided form is therefore an explicit,
 * enumerated set ({@link REASONS_REACHING_OWNER_CONTENT}) read off the
 * classification each recipe already carries, not a silence.
 *
 * `fail` runs FIRST so the isolation assertion sees the pristine
 * fixture: several recipes are writers, and the reachability half must
 * not be what decides whether the boundary held.
 */
for (const entry of PROBE_ENTRIES) {
  for (const [index, recipe] of entry.calls.entries()) {
    const label = probeLabel(entry.name, recipe, index);
    const reaches = REASONS_REACHING_OWNER_CONTENT.has(recipe.reason);
    test(
      `${label}: ${reaches ? "reaches owner content and withholds it" : "reaches no owner content"}`,
      async () => {
        await seedTwoOwnerFixture();

        setGate(GATE_MODE.fail);
        const scoped = await probeResponse(entry.name, probeArgs(recipe));
        expect(scoped, `${label} under fail\n${recipe.reason}`).not.toContain(CROSS_OWNER_MARKER);

        setGate(GATE_MODE.off);
        const unscoped = await probeResponse(entry.name, probeArgs(recipe));
        if (reaches) {
          expect(unscoped, `${label} under off\n${recipe.reason}`).toContain(CROSS_OWNER_MARKER);
        } else {
          expect(unscoped, `${label} under off\n${recipe.reason}`).not.toContain(
            CROSS_OWNER_MARKER,
          );
        }
      },
      PROBE_TIMEOUT_MS,
    );
  }
}

/**
 * F1: `apply` planned against the UNFILTERED report.
 *
 * The probe above catches the disclosure - the applier's `detail` names
 * both merged ids - but not the WRITE, which is the worse half: a caller
 * whose scan correctly returned nothing could still retire another
 * owner's preference by handing `apply` an id it had never been shown.
 * Finding ids are `sha256(sorted targets).slice(0, 12)`, so they are
 * derivable rather than secret and withholding them was never the
 * boundary.
 */
test("brain_hygiene apply cannot execute a finding the same caller's scan withheld", async () => {
  await seedTwoOwnerFixture();
  setGate(GATE_MODE.fail);

  const hidden = runHygieneScan(vault, { now: new Date() }).findings.filter((f) =>
    f.targets.some((t) => t.includes(CROSS_OWNER_MARKER)),
  );
  expect(hidden.length, "the fixture must produce findings over owner-A artifacts").toBeGreaterThan(
    0,
  );
  const ids = hidden.map((f) => f.id);

  const scan = JSON.parse(await call("brain_hygiene", { mode: "scan" }, OWNER_B));
  expect(JSON.stringify(scan)).not.toContain(CROSS_OWNER_MARKER);

  const applied = JSON.parse(await call("brain_hygiene", { mode: "apply", ids }, OWNER_B));
  expect(applied.applied).toEqual([]);
  expect(applied.changed).toBe(0);

  // The artifacts are still on disk, still owned, still unmerged.
  for (const slug of [`${CROSS_OWNER_MARKER}-a2`, `${CROSS_OWNER_MARKER}-a4`]) {
    expect(existsSync(join(vault, "Brain", "preferences", `pref-${slug}.md`))).toBe(true);
  }
});

/**
 * F1, second half: the dry run was an existence oracle.
 *
 * A hidden finding came back as `excluded_review:[id]` and an id nobody
 * ever issued came back as `unknown_ids:[id]`, so a caller could
 * enumerate the hidden population one derived id at a time without ever
 * being shown a finding. IDENTICAL TO ABSENT is the convention
 * `preferences-collect.ts` states; this is it, executed.
 */
test("a withheld hygiene finding id answers exactly as an id nobody issued", async () => {
  await seedTwoOwnerFixture();
  setGate(GATE_MODE.fail);

  const hiddenId = runHygieneScan(vault, { now: new Date() }).findings.find((f) =>
    f.targets.some((t) => t.includes(CROSS_OWNER_MARKER)),
  )!.id;
  const inventedId = "dedup:000000000000";

  const withheld = JSON.parse(
    await call("brain_hygiene", { mode: "apply", ids: [hiddenId], dry_run: true }, OWNER_B),
  );
  const absent = JSON.parse(
    await call("brain_hygiene", { mode: "apply", ids: [inventedId], dry_run: true }, OWNER_B),
  );

  expect(withheld.unknown_ids).toEqual([hiddenId]);
  expect(withheld.excluded_review).toEqual([]);
  // Same shape, same fields, same emptiness - only the echoed id differs.
  expect({ ...withheld, unknown_ids: [] }).toEqual({ ...absent, unknown_ids: [] });
});

/**
 * F3: the verdict was folded over findings the arrays no longer carried.
 *
 * `verdict: watch` beside four empty arrays tells the caller that a
 * hidden artifact tripped a detector - the existence leak with the
 * evidence removed.
 */
test("brain_health's verdict is folded over the findings it actually returns", async () => {
  await seedTwoOwnerFixture();

  setGate(GATE_MODE.off);
  const unscoped = JSON.parse(await call("brain_health", {}, OWNER_B));
  expect(unscoped.verdict).not.toBe("clean");
  expect(JSON.stringify(unscoped)).toContain(CROSS_OWNER_MARKER);

  setGate(GATE_MODE.fail);
  const scoped = JSON.parse(await call("brain_health", {}, OWNER_B));
  const named =
    scoped.contradictions.length + scoped.stale_claims.length + scoped.batch_inflation.length;
  if (named === 0 && scoped.concept_gaps.length === 0) {
    expect(scoped.verdict).toBe("clean");
  }
  expect(JSON.stringify(scoped)).not.toContain(CROSS_OWNER_MARKER);
});

/**
 * The probe's own shape, pinned as equalities.
 *
 * Three numbers are quoted outside this file - `docs/architecture.md`,
 * `docs/mcp.md` and the release notes all state how much of the tool
 * surface is really driven - and a number quoted in prose with nothing
 * keeping it true is the defect this whole release is about. The
 * two-sided count is the load-bearing one: it is how many recipes prove
 * their own reachability before asserting withholding, and the release
 * before this one shipped a probe where that number was effectively one.
 *
 * Raising any of these is ordinary; lowering the two-sided count means a
 * surface stopped being exercised, which is exactly the regression a
 * floor would have let through.
 */
test("the probe's population and its two-sided share are what the docs say", () => {
  const recipes = PROBE_ENTRIES.flatMap((entry) => entry.calls);
  const twoSided = recipes.filter((r) => REASONS_REACHING_OWNER_CONTENT.has(r.reason));
  expect(PROBE_ENTRIES.length).toBe(PROBE_ENTRY_COUNT);
  expect(recipes.length).toBe(PROBE_RECIPE_COUNT);
  expect(twoSided.length).toBe(PROBE_TWO_SIDED_COUNT);
});

test("a bucket entry without call recipes is refused", () => {
  expect(() => assertProbeEntry("NON_CONTENT", "brain_backlinks")).toThrow(
    "every entry must be a {name, calls} record",
  );
  expect(() => assertProbeEntry("NON_CONTENT", { name: "brain_backlinks", calls: [] })).toThrow(
    "has no 'calls'",
  );
  expect(() =>
    assertProbeEntry("NON_CONTENT", {
      name: "brain_backlinks",
      calls: [{ reason: REASON.ownerFiltered }],
    }),
  ).toThrow("has a call with no 'args'");
  expect(() =>
    assertProbeEntry("NON_CONTENT", {
      name: "brain_backlinks",
      calls: [{ args: {}, reason: "metadata" }],
    }),
  ).toThrow(`at least ${REASON_MIN_CHARS} characters`);
});

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
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig, search } from "../../src/core/search/index.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
const QUERY = "lattice widgets";
/** Probe path whose derived query terms appear verbatim in every note. */
const PROBE = "lattice.md";
const PROBE_TERMS = `${PROBE} lattice`;

/** How a surface learns which agent is asking. */
const SCOPE_SOURCE = Object.freeze({
  /** An explicit `agent_scope` input argument. */
  argument: "argument",
  /** `ServerContext.agentName`, for a surface that takes no arguments. */
  serverIdentity: "server-identity",
} as const);

type ScopeSource = (typeof SCOPE_SOURCE)[keyof typeof SCOPE_SOURCE];

interface ScopedSurface {
  readonly name: string;
  readonly source: ScopeSource;
  /**
   * True when isolation is behind `integrity.owner_scope_delivery`.
   * Preference-backed surfaces are gated (their scope may be defaulted
   * from the server identity, which would narrow a vault that never
   * opted in). Search-backed surfaces are not: their scope only ever
   * arrives as an explicit per-call argument, so honouring it cannot
   * narrow anything the caller did not ask to narrow.
   */
  readonly gated: boolean;
}

/** Content-returning tools that consult the ownership rule. */
const SCOPED_SURFACES: ReadonlyArray<ScopedSurface> = [
  { name: "brain_context", source: SCOPE_SOURCE.serverIdentity, gated: true },
  { name: "brain_context_pack", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_pre_compress_pack", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_anticipatory_context", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_brief", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_retrieval_plan", source: SCOPE_SOURCE.argument, gated: true },
  { name: "brain_query", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_search", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_search_expand", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_file_context", source: SCOPE_SOURCE.argument, gated: false },
  { name: "brain_deep_synthesis", source: SCOPE_SOURCE.argument, gated: false },
];

/**
 * Tools that return vault content but are NOT owner-scoped after this
 * wave. Listed with a reason so the gap is recorded rather than
 * forgotten — this is the honest half of the matrix.
 */
const UNSCOPED_CONTENT: ReadonlyArray<{ readonly name: string; readonly reason: string }> = [
  { name: "brain_search_by_source", reason: "source-keyed recall; not in this wave's scope" },
  { name: "brain_session_grep", reason: "session transcript lane, not owner-taggable pages" },
  { name: "brain_session_expand", reason: "session transcript lane, not owner-taggable pages" },
  { name: "brain_session_summary", reason: "session transcript lane, not owner-taggable pages" },
  { name: "brain_session_describe", reason: "session transcript lane, not owner-taggable pages" },
  { name: "brain_note_history", reason: "per-note git history for a path the caller names" },
  { name: "brain_artifact_get", reason: "replays a payload this process already returned" },
  { name: "second_brain_query", reason: "facade over brain_search; not in this wave's scope" },
  { name: "brain_agent_query", reason: "agent-authored view; not in this wave's scope" },
  {
    name: "brain_pre_compact_extract",
    reason: "extracts from caller-supplied text, not the vault",
  },
  { name: "brain_memory_bridge", reason: "cross-vault bridge; not in this wave's scope" },
  { name: "brain_recall_gate", reason: "verdict over a caller-supplied question, no bodies" },
];

/** Everything else: metadata, analytics, maintenance, writers, catalog. */
const NON_CONTENT: ReadonlyArray<string> = [
  "brain_agenda",
  "brain_agent_diff",
  "brain_analytics",
  "brain_append_note",
  "brain_apply_evidence",
  "brain_audit",
  "brain_backlinks",
  "brain_benchmark",
  "brain_bridges",
  "brain_claims",
  "brain_clusters",
  "brain_codegraph_report",
  "brain_context_pack_outcome",
  "brain_context_presets",
  "brain_context_receipts",
  "brain_create_note",
  "brain_dead_ends",
  "brain_decision",
  "brain_delete_by_source",
  "brain_derive_fact",
  "brain_diarize",
  "brain_distill_source",
  "brain_doctor",
  "brain_dream",
  "brain_entity",
  "brain_eval",
  "brain_event_trace",
  "brain_feedback",
  "brain_foresight",
  "brain_generation_reports",
  "brain_health",
  "brain_hygiene",
  "brain_idea_discovery",
  "brain_idea_lineage",
  "brain_ingest_batch_plan",
  "brain_ingest_source",
  "brain_intake_entities",
  "brain_intent_review",
  "brain_intention",
  "brain_knowledge_gaps",
  "brain_labels",
  "brain_lifecycle",
  "brain_maintenance",
  "brain_mcp_landscape",
  "brain_moc_audit",
  "brain_note",
  "brain_obligation",
  "brain_observed_use",
  "brain_pinned_context",
  "brain_procedural_graph",
  "brain_procedural_memory",
  "brain_recall_feedback",
  "brain_recall_telemetry",
  "brain_recurrence",
  "brain_research_report",
  "brain_retention",
  "brain_review_candidates",
  "brain_route_metrics",
  "brain_secrets",
  "brain_session_checkpoint",
  "brain_skill_proposals",
  "brain_sources",
  "brain_stale_scan",
  "brain_status",
  "brain_switch_vault",
  "brain_tension",
  "brain_tiers",
  "brain_token_impact",
  "brain_trigger",
  "brain_truth",
  "brain_tune",
  "brain_unlinked_mentions",
  "brain_update_note",
  "brain_watchdog",
  "brain_write_batch",
  "brain_write_session",
  "get_skill",
  "list_skills",
  "schema_apply_mutations",
  "schema_inspect",
  "second_brain_capabilities",
  "second_brain_status",
  "skills_attach",
  "tool_hydrate",
  "vault_health",
];

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

// ----- the mechanism --------------------------------------------------------

test("the matrix classifies every tool exactly once", () => {
  const classified = [
    ...SCOPED_SURFACES.map((s) => s.name),
    ...UNSCOPED_CONTENT.map((s) => s.name),
    ...NON_CONTENT,
  ];
  expect(new Set(classified).size).toBe(classified.length);

  const actual = TOOLS.map((t) => t.name).toSorted();
  // Both directions: a NEW tool fails until it is classified, and a
  // REMOVED tool fails until its entry is deleted.
  expect(classified.toSorted()).toEqual(actual);
});

test("the tool count is unchanged: an argument was added, never a tool", () => {
  expect(TOOLS.length).toBe(108);
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

test("brain_retrieval_plan counts only the memories its caller may see", async () => {
  setGate(GATE_MODE.fail);
  const asA = JSON.parse(
    await call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_A }),
  );
  const asB = JSON.parse(
    await call("brain_retrieval_plan", { question: QUERY, agent_scope: OWNER_B }),
  );
  expect(asA.allocation.item_count).toBeGreaterThan(asB.allocation.item_count);
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

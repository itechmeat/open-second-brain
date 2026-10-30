/**
 * Frozen-surface parity guard for the Brain MCP tool set.
 *
 * v1.0.0 froze the public MCP surface; this test pins the exact tool
 * names BRAIN_TOOLS advertises so the per-domain module split (and any
 * future registry change) is provably name-set-preserving. A failure
 * here means the public surface changed - that requires a deliberate
 * major/minor release decision, not a refactor.
 *
 * Deliberate surface changes so far: v1.3.0 added `brain_hygiene` and
 * `brain_anticipatory_context` (continuity-hygiene-freshness suite); v1.7.0
 * added `brain_intake_entities`, `brain_ingest_source`,
 * `brain_research_report`, and `brain_derive_fact` (Knowledge Provenance
 * suite); the codegraph-and-MCP operational-readability release added
 * `brain_codegraph_report` (read-only codegraph partner report); the
 * Hindsight brain-loop ops release added `brain_generation_reports`
 * (inbound, opt-in LLM generation tracing); the calendar-integration
 * release added `brain_agenda` (deterministic agenda synthesis over
 * caller-provided events) and `brain_obligation` (recurring obligations
 * with a cadence-driven next-due date); the memory-subsystem-alignment
 * release added `brain_memory_bridge` (the Hermes on_memory_write host
 * bridge — persists native built-in-memory writes as durable
 * host_memory_write continuity records); the dashboard-context-trace
 * release added `brain_event_trace` (joins logged Brain events to the
 * continuity records attached to them by shared correlation ids); the
 * context-pack-economics-observability release added
 * `brain_route_metrics` (route-level MCP tool latency read over opt-in
 * `mcp_route_latency` continuity records) and `brain_token_impact` (durable
 * token-impact ledger: tokenizer-exact prompt-token deltas kept strictly
 * separate from a modeled, outcome-calibrated inference-avoidance estimate)
 * and `brain_context_pack_outcome` (agent-operable outcome loop: a compact
 * per-sample outcome row keeping the exact/modeled/observed token signals
 * strictly separate, composing the token-impact ledger's calibration); the
 * memory-signal-provenance-lifecycle release added `brain_ingest_batch_plan`
 * (deterministic large-folder ingest planner: skips unchanged sources via the
 * content-hash manifest and shards the remainder into size+count-bounded
 * batches for parallel-subagent dispatch); the recall-trust-and-write-surface
 * release added `brain_update_note` and `brain_append_note` (single-operation
 * batches over the atomic write-batch core, kernel 2) and `brain_write_batch`
 * (the general all-or-nothing multi-operation write surface, kernel 2's second
 * consumer); the knowledge-intake-and-consolidation release added
 * `brain_diarize` (subject diarization); the
 * retrieval-quality-and-context-delivery release added `brain_retrieval_plan`
 * (the shadow-only retrieval advisor: composes query plan, context-pack
 * density, token-impact ledger, and route latency into a read-only
 * per-question plan, exposing no mutating parameters); the
 * wiring-what-exists release added `brain_note_lifecycle` (rename, move,
 * archive and delete for note FILES - the first MCP verb that removes a
 * user note, behind a dry-run default, an explicit confirm, a count guard
 * over inbound references, and a recoverability verdict that says the
 * archive it took does not cover a note living outside `Brain/`) and
 * `brain_scaffold_stub` (the unresolved wikilink targets the search index
 * holds, and the verb that materialises a note for one - the list REFUSES
 * a missing or partially-resolved index rather than reporting zero); the
 * salience-lifecycle-enrichment release added three: `brain_expire` (set,
 * change or clear the `expiration_date` of one signal or preference by id
 * - the mutation half of a field that until now could only be declared at
 * creation, kept off `brain_lifecycle` because every action there
 * addresses its subject by a note PATH and the path envelope refuses the
 * `Brain/` root these artifacts live under), `brain_extract_signals` (the
 * batch counterpart to regex fact extraction: hands the calling agent one
 * session's user turns inside a needs-llm-step envelope and writes the
 * validated answer as speculative `source_type: auto_extract` inbox
 * signals), and `brain_design_note` (the one-shot sibling of the panel
 * lane: a read-only grounding pass over tension, decision and truth
 * records, one envelope, and a committed note under `Brain/decisions/`);
 * the storage-lifecycle release added `brain_receipts` (receipt
 * compaction: a read-only per-shard scan of the continuity and metrics
 * receipt ledgers, and the explicit-shard fold behind a count guard and
 * a recovery point - deliberately disjoint from the context-compaction
 * vocabulary) and `brain_storage` (the storage report: the per-surface
 * measured-or-refused byte census, the forecast and tier against the
 * configured cap, and the usage sample each invocation records; the
 * vault-wide measurement answers measured: false below local reach); the
 * dated-commitments release added `brain_pledge` (one-off pledge CRUD over
 * `Brain/pledges/` pages: add with evidence quotes verified against the
 * cited source at write time, fulfill, list, show, remove) and
 * `brain_intake_pledges` (the agent-executed extraction intake over the
 * same family: typed pledge extractions posted against a source page,
 * validated whole before any write, counterparty names anchored
 * server-side against the canonical entity registry).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";
import { MCPServer, type JsonRpcRequest } from "../../src/mcp/server.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";

const FROZEN_BRAIN_TOOL_NAMES = [
  "brain_agenda",
  "brain_agent_diff",
  "brain_agent_query",
  "brain_analytics",
  "brain_anticipatory_context",
  "brain_append_note",
  "brain_apply_evidence",
  "brain_audit",
  "brain_backlinks",
  "brain_benchmark",
  "brain_bridges",
  "brain_brief",
  "brain_claims",
  "brain_clusters",
  "brain_codegraph_report",
  "brain_context",
  "brain_context_pack",
  "brain_context_pack_outcome",
  "brain_context_presets",
  "brain_context_receipts",
  "brain_create_note",
  "brain_dead_ends",
  "brain_decision",
  "brain_deep_synthesis",
  "brain_delete_by_source",
  "brain_derive_fact",
  "brain_design_note",
  "brain_diarize",
  "brain_distill_source",
  "brain_doctor",
  "brain_dream",
  "brain_entity",
  "brain_event_trace",
  "brain_expire",
  "brain_extract_signals",
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
  "brain_intake_pledges",
  "brain_intent_review",
  "brain_intention",
  "brain_knowledge_gaps",
  "brain_labels",
  "brain_lifecycle",
  "brain_maintenance",
  "brain_mcp_landscape",
  "brain_memory_bridge",
  "brain_moc_audit",
  "brain_note",
  "brain_note_history",
  "brain_note_lifecycle",
  "brain_obligation",
  "brain_observed_use",
  "brain_pinned_context",
  "brain_pledge",
  "brain_pre_compact_extract",
  "brain_pre_compress_pack",
  "brain_procedural_graph",
  "brain_procedural_memory",
  "brain_query",
  "brain_recall_telemetry",
  "brain_receipts",
  "brain_recurrence",
  "brain_research_report",
  "brain_retention",
  "brain_retrieval_plan",
  "brain_review_candidates",
  "brain_route_metrics",
  "brain_scaffold_stub",
  "brain_search_by_source",
  "brain_secrets",
  "brain_session_checkpoint",
  "brain_session_describe",
  "brain_session_expand",
  "brain_session_grep",
  "brain_session_summary",
  "brain_skill_proposals",
  "brain_sources",
  "brain_stale_scan",
  "brain_status",
  "brain_storage",
  "brain_switch_vault",
  "brain_tension",
  "brain_tiers",
  "brain_token_impact",
  "brain_trigger",
  "brain_truth",
  "brain_tune",
  "brain_unlinked_mentions",
  "brain_update_note",
  "brain_write_batch",
  "brain_write_destinations",
  "brain_write_session",
  "brain_writes",
] as const;

/**
 * The `kind: "write"` half of the frozen BRAIN_TOOLS surface, pinned
 * beside the name list so the read/write partition cannot drift in
 * either direction. The read half is the complement: every frozen name
 * not listed here must classify `read`, and no name outside the frozen
 * list may appear.
 *
 * The rule is write-mode-dominant (`src/mcp/tool-contract.ts`): a tool
 * that CAN write is `write`. Every entry was verified against its
 * handler, and three recon-seeded entries were corrected the other way:
 *
 *   - `brain_retention` and `brain_review_candidates` are READ. Their
 *     planners fold read-only reports (`buildRetentionReview`; `dream`
 *     with `dryRun: true`, which performs no writes per dream.ts), and
 *     their own descriptions say so ("never deletes or moves
 *     artifacts", "Mutates nothing").
 *   - `brain_entity` is READ: `view` is `get | list` only - the CRUD
 *     halves moved to the CLI and the write-batch kernels.
 *
 * Writers the seed list missed, each verified at its handler:
 * `brain_doctor` (repair+apply), `brain_tiers` (restore/accept),
 * `brain_secrets` (run executes an allowlisted command),
 * `brain_pinned_context` (write/append/clear), `brain_obligation`
 * (add/done/remove), `brain_dead_ends` (record), `brain_skill_proposals`
 * (accept/reject), `brain_procedural_memory` (mark_used/mark_outcome),
 * `brain_recurrence` (learn/forget/purge_source),
 * `brain_procedural_graph` and `brain_claims` (rebuild persists the
 * projection), `brain_deep_synthesis` and `brain_idea_discovery`
 * (triggers=true enqueues into the trigger queue),
 * `brain_pre_compact_extract` (extracts into continuity storage),
 * `brain_anticipatory_context` (refresh persists the warm cache),
 * `brain_ingest_batch_plan` (clears its checkpoint on a drained resume),
 * `brain_generation_reports` (action=record), `brain_session_summary`
 * and `brain_session_checkpoint` (write operations), `brain_token_impact`
 * (record) and `brain_context_pack_outcome` (post) - both gated ledger
 * writes - and `brain_delete_by_source`.
 *
 * Round-4 OCR-review corrections, each verified at its handler chain and
 * reclassified read -> write under write-mode-dominant (a tool that CAN
 * write is `write`; an opt-in or defaulted write still counts):
 * `brain_context` (the bootstrap path calls `regenerateActive`, which
 * writes the shared `Brain/active.md` when absent or stale),
 * `brain_brief` (view=digest persists the window snapshot under
 * `Brain/reports/` through `captureReportDelta` when report snapshots
 * are enabled), and `brain_analytics` (every attention_flows operation
 * lists flows first, seeding `Brain/attention-flows/open-loops.md`
 * through `ensureDefaultAttentionFlows` on a vault without it). The
 * same review reclassified `brain_search`, which lives outside this
 * slice - see the full-table pin below.
 *
 * Deliberately READ despite a fail-soft observability append (metrics
 * appends are accepted loss under concurrency, per the stdio
 * parallel-reads design, not gated writes): `brain_storage` (usage
 * sample), `brain_benchmark` (recall_benchmark metric),
 * `brain_context_pack` / `brain_pre_compress_pack` (opt-in context
 * receipts), `brain_recall_telemetry` (opt-in emit).
 */
const FROZEN_BRAIN_WRITE_TOOL_NAMES = [
  "brain_analytics",
  "brain_anticipatory_context",
  "brain_append_note",
  "brain_apply_evidence",
  "brain_bridges",
  "brain_brief",
  "brain_claims",
  "brain_clusters",
  "brain_context",
  "brain_context_pack_outcome",
  "brain_create_note",
  "brain_dead_ends",
  "brain_decision",
  "brain_deep_synthesis",
  "brain_delete_by_source",
  "brain_derive_fact",
  "brain_design_note",
  "brain_distill_source",
  "brain_doctor",
  "brain_dream",
  "brain_expire",
  "brain_extract_signals",
  "brain_feedback",
  "brain_generation_reports",
  "brain_hygiene",
  "brain_idea_discovery",
  "brain_ingest_batch_plan",
  "brain_ingest_source",
  "brain_intake_entities",
  "brain_intake_pledges",
  "brain_intention",
  "brain_labels",
  "brain_lifecycle",
  "brain_maintenance",
  "brain_memory_bridge",
  "brain_note",
  "brain_note_lifecycle",
  "brain_obligation",
  "brain_observed_use",
  "brain_pinned_context",
  "brain_pledge",
  "brain_pre_compact_extract",
  "brain_procedural_graph",
  "brain_procedural_memory",
  "brain_receipts",
  "brain_recurrence",
  "brain_research_report",
  "brain_scaffold_stub",
  "brain_secrets",
  "brain_session_checkpoint",
  "brain_session_summary",
  "brain_skill_proposals",
  "brain_switch_vault",
  "brain_tension",
  "brain_tiers",
  "brain_token_impact",
  "brain_trigger",
  "brain_truth",
  "brain_tune",
  "brain_update_note",
  "brain_write_batch",
  "brain_write_session",
] as const;

/**
 * The `kind: "write"` half of the FULL registry (`buildToolTable("full")`),
 * pinned for the same reason and in the same shape as the Brain slice
 * above - both directions, so a move without re-pinning fails and a stale
 * pin fails too.
 *
 * Derived from the Brain-slice pin instead of retyped: the full table
 * CONTAINS `BRAIN_TOOLS`, so every Brain writer must classify `write`
 * here as well, and retyping sixty-odd names a second time is exactly how
 * the two pins drift apart under maintenance (the round-4 review had to
 * correct four tools in both lists in lockstep). Deriving keeps the
 * full-table pin independent where it matters: the Brain names stay
 * independently pinned against `BRAIN_TOOLS` itself by the slice test
 * above, and this pin stays independently sensitive to the writers that
 * live OUTSIDE `BRAIN_TOOLS` - exactly where a silent flip to `read`
 * would park a mutator on the stdio transport's concurrent read path:
 *
 *   - `brain_watchdog` - EVERY run appends its audit record under
 *     `Brain/log/` (failing that, `.open-second-brain/watchdog-audit/`),
 *     probe or not; `remediate=true` additionally creates the missing
 *     Brain directories;
 *   - `brain_recall_feedback` - records one event receipt plus bounded
 *     weights;
 *   - `brain_search` - writes the reinforce ledger, records activation
 *     access events by default (events plus the derived state), and
 *     appends the opt-in recall-telemetry and query-demand ledgers -
 *     ranking state later searches read back, not accepted-loss appends;
 *   - `schema_apply_mutations` - applies schema edits.
 *
 * The read half is the complement: every registered name not listed here
 * must classify `read`.
 */
const FROZEN_FULL_TABLE_WRITE_TOOL_NAMES = [
  ...FROZEN_BRAIN_WRITE_TOOL_NAMES,
  "brain_recall_feedback",
  "brain_search",
  "brain_watchdog",
  "schema_apply_mutations",
] as const;

describe("BRAIN_TOOLS frozen surface", () => {
  test("advertises exactly the v1.x tool-name set", () => {
    const names = BRAIN_TOOLS.map((t) => t.name).toSorted();
    expect(names).toEqual([...FROZEN_BRAIN_TOOL_NAMES]);
  });

  test("has no duplicate tool names", () => {
    const names = BRAIN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool carries a handler and an input schema", () => {
    for (const tool of BRAIN_TOOLS) {
      expect(typeof tool.handler).toBe("function");
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

describe("read/write classification", () => {
  /** Every registered tool, not just the Brain slice: the walk is over the full table. */
  const FULL_TABLE: ReadonlyArray<ToolDefinition> = buildToolTable("full");

  test("every registered tool carries kind read or write (registry-guard walk)", () => {
    const unclassified = FULL_TABLE.filter((t) => t.kind !== "read" && t.kind !== "write");
    expect(unclassified.map((t) => `${t.name}: ${String(t.kind)}`)).toEqual([]);
  });

  test("the write half is exactly the pinned partition (both directions)", () => {
    const writes = BRAIN_TOOLS.filter((t) => t.kind === "write")
      .map((t) => t.name)
      .toSorted();
    const pinned = [...FROZEN_BRAIN_WRITE_TOOL_NAMES].toSorted();
    // A deliberately wrong entry fails one direction or the other, so the
    // pin is sensitive to moves in both ways: a tool that starts writing
    // without re-pinning fails the equality, and so does a stale pin.
    expect(writes).toEqual(pinned);
  });

  test("the read half is the exact complement of the pinned writes", () => {
    const reads = BRAIN_TOOLS.filter((t) => t.kind === "read")
      .map((t) => t.name)
      .toSorted();
    const complement = FROZEN_BRAIN_TOOL_NAMES.filter(
      (name) => !(FROZEN_BRAIN_WRITE_TOOL_NAMES as readonly string[]).includes(name),
    ).toSorted();
    expect(reads).toEqual(complement);
  });

  test("the full table's write half is exactly the pinned partition (both directions)", () => {
    const writes = FULL_TABLE.filter((t) => t.kind === "write")
      .map((t) => t.name)
      .toSorted();
    const pinned = [...FROZEN_FULL_TABLE_WRITE_TOOL_NAMES].toSorted();
    // The same two-way sensitivity as the Brain-slice pin, over the table
    // the transports actually classify against. The registry-guard walk
    // above only checks that `kind` is a valid value, so without this pin
    // a silent flip of one of the four writers outside BRAIN_TOOLS
    // (`brain_watchdog`, `brain_recall_feedback`, `brain_search`,
    // `schema_apply_mutations`) to `read` would pass the suite - and park
    // a mutator on the concurrent read path this partition exists to
    // prevent. A stale pin fails the same equality the other way.
    expect(writes).toEqual(pinned);
  });
});

/**
 * The write classifier's fail-closed branches, unit-tested at the server
 * the transports consult. `MCPServer.classifiesWrite` decides the stdio
 * transport's write gate, and its rule is that every failure to KNOW is a
 * write - the gate only ever costs serialization, while a guessed "read"
 * could run a mutator beside another dispatch. Each of those escape
 * hatches is pinned here, beside the partition it guards.
 */
describe("MCPServer.classifiesWrite fail-closed gates", () => {
  const tempVaults: string[] = [];

  afterEach(() => {
    while (tempVaults.length > 0) rmSync(tempVaults.pop()!, { recursive: true, force: true });
  });

  function serverWithVault(): MCPServer {
    const dir = mkdtempSync(join(tmpdir(), "osb-write-classifier-"));
    tempVaults.push(dir);
    return new MCPServer({ vault: dir });
  }

  function callFrame(params: unknown): JsonRpcRequest {
    return { jsonrpc: "2.0", id: 1, method: "tools/call", params };
  }

  test("a tools/call it cannot name is a write: absent params, absent name, non-string name", () => {
    const server = serverWithVault();
    expect(server.classifiesWrite({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBe(true);
    expect(server.classifiesWrite(callFrame({}))).toBe(true);
    expect(server.classifiesWrite(callFrame({ arguments: {} }))).toBe(true);
    expect(server.classifiesWrite(callFrame({ name: 42 }))).toBe(true);
    expect(server.classifiesWrite(callFrame({ name: null }))).toBe(true);
  });

  test("an unknown tool name is a write, not a parallelizable refusal", () => {
    const server = serverWithVault();
    expect(server.classifiesWrite(callFrame({ name: "no_such_tool" }))).toBe(true);
  });

  test("everything that is not a tools/call is a read", () => {
    const server = serverWithVault();
    expect(server.classifiesWrite({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
    expect(server.classifiesWrite({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBe(false);
    expect(server.classifiesWrite({ jsonrpc: "2.0", id: 3, method: "resources/read" })).toBe(false);
  });

  test("a known read classifies read and a known write classifies write", () => {
    const server = serverWithVault();
    expect(server.classifiesWrite(callFrame({ name: "second_brain_status", arguments: {} }))).toBe(
      false,
    );
    expect(server.classifiesWrite(callFrame({ name: "brain_note", arguments: {} }))).toBe(true);
  });

  test("a hand-built definition that carries no kind is gated as a write", () => {
    const server = serverWithVault();
    // `kind` is required on ToolDefinition, so a definition without one
    // reached this table only by casting the field away - exactly the
    // hand-built case the classifier must fail closed on.
    const handBuilt = {
      name: "hand_built_untyped",
      description: "a definition that lost its kind",
      inputSchema: { type: "object" },
      handler: async () => ({}),
    } as unknown as ToolDefinition;
    (server as unknown as { tools: ToolDefinition[] }).tools = [...server.tools, handBuilt];
    expect(server.classifiesWrite(callFrame({ name: "hand_built_untyped" }))).toBe(true);
  });
});

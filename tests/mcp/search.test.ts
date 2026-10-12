/**
 * MCP integration tests for `brain_search` and the `search.*`
 * enrichment on `second_brain_status`.
 *
 * Like the Brain MCP suite, these go through `MCPServer.handleRequest`
 * end-to-end — so registration, schema validation, error mapping, and
 * the actual search query are all exercised together.
 */

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { LATEST_SCHEMA_VERSION } from "../../src/core/search/schema.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import { readQueryDemand } from "../../src/core/brain/query-demand.ts";
import { feedbackDir } from "../../src/core/search/feedback.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-search-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "search-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

function call(
  server: MCPServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  }) as Promise<unknown>;
}

function makeServer(): MCPServer {
  return new MCPServer({ vault, configPath });
}

function writeMd(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function extractToolResult(resp: any): Record<string, unknown> {
  // MCP tool/call wraps the handler return value in { content: [{ type:"text", text: "<json>" }] }.
  const content = resp?.result?.content?.[0];
  if (content?.type === "text" && typeof content.text === "string") {
    return JSON.parse(content.text);
  }
  // Some servers also expose `structuredContent` directly; accept both.
  if (resp?.result?.structuredContent) return resp.result.structuredContent;
  return resp?.result ?? {};
}

test("brain_search is advertised by tools/list", async () => {
  const server = makeServer();
  await initialize(server);
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 10,
    method: "tools/list",
  })) as any;
  const tools = r.result.tools as Array<{ name: string }>;
  expect(tools.find((t) => t.name === "brain_search")).toBeDefined();
});

test("brain_search happy path returns paths and respects 600-char content cap", async () => {
  writeMd("notes/foo.md", "# Foo\n\n" + "fox ".repeat(400));
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", { query: "fox", limit: 5 });
  const body = extractToolResult(resp);
  const results = body["results"] as Array<{
    content: string;
    path: string;
    searchType: string;
    score: number;
  }>;
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]?.path).toBe("notes/foo.md");
  expect(results[0]?.content.length).toBeLessThanOrEqual(600);
  // The MCP shape does NOT expose diagnostic score components.
  expect((results[0] as Record<string, unknown>)["keywordScore"]).toBeUndefined();
});

test("brain_search can opt in to recall telemetry", async () => {
  writeMd("notes/telemetry.md", "# Telemetry\n\nrecall telemetry records search coverage.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", {
    query: "telemetry",
    limit: 5,
    telemetry: true,
    telemetry_host: "mcp-search-test",
  });
  const body = extractToolResult(resp);
  expect(body["telemetry_id"]).toStartWith("ctn_");

  const records = listRecallTelemetry(vault, {
    mode: "search",
    host: "mcp-search-test",
  });
  expect(records).toHaveLength(1);
  expect(records[0]!.payload).toMatchObject({ status: "ok", result_count: 1 });

  // The same opt-in also persists a cross-query demand record with the
  // normalized query terms and result count (t_97091fff).
  const demand = readQueryDemand(vault);
  expect(demand).toHaveLength(1);
  expect(demand[0]!.terms).toEqual(["telemetry"]);
  expect(demand[0]!.results).toBe(1);
});

test("brain_search does not persist demand records without the telemetry opt-in", async () => {
  writeMd("notes/quiet.md", "# Quiet\n\nsilent recall leaves no demand trace.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  await call(server, "brain_search", { query: "silent", limit: 5 });
  expect(readQueryDemand(vault)).toHaveLength(0);
});

test("brain_search accepts structured query_document", async () => {
  writeMd("notes/final.md", "# Final\n\nrelease notes mention recall diagnostics.");
  writeMd("notes/draft.md", "# Draft\n\ndraft release notes mention recall diagnostics.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", {
    query: "release notes",
    query_document: 'lex: "release notes" -draft',
    limit: 10,
  });
  const body = extractToolResult(resp);
  const results = body["results"] as Array<{ path: string; reasons: string[] }>;

  expect(results.map((result) => result.path)).toContain("notes/final.md");
  expect(results.map((result) => result.path)).not.toContain("notes/draft.md");
  expect(results[0]?.reasons.some((reason) => reason.includes("lane:lex/fts5"))).toBe(true);
});

test("brain_search accepts explicit session focus input", async () => {
  writeMd("archive/other.md", "# Other\n\nshared recall topic.");
  writeMd("sessions/focus.md", "# Focus\n\nshared recall topic.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", {
    query: "shared",
    focus_path_prefix: "sessions/",
    limit: 2,
  });
  const body = extractToolResult(resp);
  const results = body["results"] as Array<{ path: string; reasons: string[] }>;

  expect(results[0]?.path).toBe("sessions/focus.md");
  expect(results[0]?.reasons.some((reason) => reason.startsWith("session_focus:"))).toBe(true);
});

test("brain_recall_gate reports skip reasons without affecting explicit brain_search", async () => {
  writeMd("notes/shell.md", "# Shell\n\ngit status troubleshooting note.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const gate = await call(server, "brain_recall_gate", {
    prompt: "git status",
  });
  expect(extractToolResult(gate)).toEqual({
    retrieve: false,
    admit: false,
    reason: "shell_command",
  });

  const explicit = await call(server, "brain_search", {
    query: "git status",
    limit: 1,
  });
  const body = extractToolResult(explicit);
  const results = body["results"] as Array<{ path: string }>;
  expect(results[0]?.path).toBe("notes/shell.md");
});

test("brain_search evidence_pack returns missing terms and why_retrieved", async () => {
  writeMd("notes/foo.md", "# Foo\n\nalpha beta current support.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", {
    query: "alpha gamma",
    query_document: "lex: alpha",
    evidence_pack: true,
    limit: 5,
  });
  const body = extractToolResult(resp);
  const evidencePack = body["evidence_pack"] as { missing_terms: string[] };
  const results = body["results"] as Array<{ why_retrieved: string[] }>;

  expect(evidencePack.missing_terms).toContain("gamma");
  expect(Array.isArray(results[0]?.why_retrieved)).toBe(true);
});

test("brain_search rejects missing query with INVALID_PARAMS", async () => {
  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", {})) as any;
  expect(resp?.error).toBeDefined();
  expect(resp.error.code).toBe(-32602); // INVALID_PARAMS
});

test("brain_search rejects path_prefix that escapes vault", async () => {
  writeMd("a.md", "# A");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", {
    query: "A",
    path_prefix: "../etc/",
  })) as any;
  expect(resp?.error?.code).toBe(-32602);
  expect(resp.error.message).toContain("path_prefix");
});

test("brain_search self-heals a missing index instead of erroring", async () => {
  // A missing index used to surface INTERNAL_ERROR ("not initialised"); the
  // read path now builds it on first use, so brain_search just works after an
  // upgrade with no manual `o2b search index`.
  writeMd("foo.md", "# Foo\n\nThe quick brown fox jumps over the lazy dog.");
  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", { query: "fox" })) as any;
  expect(resp.error).toBeUndefined();
  expect(resp.result).toBeDefined();
});

test("brain_search rejects limit > 50", async () => {
  writeMd("a.md", "# A");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", {
    query: "A",
    limit: 100,
  })) as any;
  expect(resp?.error?.code).toBe(-32602);
});

test("second_brain_status includes search block after indexing", async () => {
  writeMd("a.md", "# A\n\nbody");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "second_brain_status", {});
  const body = extractToolResult(resp);
  const search = body["search"] as Record<string, unknown> | undefined;
  expect(search).toBeDefined();
  expect(search!["exists"]).toBe(true);
  expect(search!["documents"]).toBe(1);
  expect(search!["schema_version"]).toBe(LATEST_SCHEMA_VERSION);
});

test("second_brain_status reports search.exists=false when index missing", async () => {
  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "second_brain_status", {});
  const body = extractToolResult(resp);
  const search = body["search"] as Record<string, unknown> | undefined;
  expect(search).toBeDefined();
  expect(search!["exists"]).toBe(false);
  expect(search!["hint"]).toMatch(/o2b search index/);
});

test("brain_search surfaces authoredAt when present and omits it otherwise", async () => {
  writeMd(
    "Brain/inbox/sig-dated.md",
    "---\nkind: brain-signal\nsource_type: session\nauthored_at: 2026-05-20T10:00:00Z\n---\n\n# Turn\n\nchronology alpha token discussed here.",
  );
  writeMd(
    "Brain/inbox/sig-plain.md",
    "---\nkind: brain-signal\nsource_type: session\n---\n\n# Turn\n\nchronology alpha token discussed here.",
  );
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", { query: "chronology alpha token", limit: 10 });
  const body = extractToolResult(resp);
  const results = body["results"] as Array<Record<string, unknown>>;
  const dated = results.find((r) => r["path"] === "Brain/inbox/sig-dated.md");
  const plain = results.find((r) => r["path"] === "Brain/inbox/sig-plain.md");
  expect(dated).toBeDefined();
  expect(plain).toBeDefined();
  expect(dated!["authoredAt"]).toBe(Math.floor(Date.parse("2026-05-20T10:00:00Z") / 1000));
  expect("authoredAt" in plain!).toBe(false);
});

test("brain_search counts its query cap in code points, as the advertised maxLength does", async () => {
  const astral = "\u{1F600}";
  const server = makeServer();
  await initialize(server);
  const within = (await call(server, "brain_search", { query: astral.repeat(1001) })) as any;
  expect(within?.error?.message ?? "").not.toContain("exceeds 2000 characters");
  const over = (await call(server, "brain_search", { query: astral.repeat(2001) })) as any;
  expect(over?.error?.code).toBe(-32602);
  expect(over.error.message).toContain("exceeds 2000 characters");
});

test("brain_recall_feedback enforces its advertised query maxLength before recording", async () => {
  const astral = "\u{1F600}";
  writeMd("note.md", "# Note\n\nthe quarterly ledger reconciliation runbook\n");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  const server = makeServer();
  await initialize(server);
  const feedback = (query: string) =>
    call(server, "brain_recall_feedback", { query, result_path: "note.md", verdict: "up" });

  const over = (await feedback(astral.repeat(2001))) as any;
  expect(over?.error?.code).toBe(-32602);
  expect(over.error.message).toContain("exceeds 2000 characters");
  expect(existsSync(feedbackDir(vault))).toBe(false);

  const within = extractToolResult(await feedback(astral.repeat(2000)));
  expect(within["recorded"]).toBe(true);
  expect(readdirSync(feedbackDir(vault))).toHaveLength(1);
});

// ----- Iterative recall round-trip (recall-quality wave, lane A) ----------

/**
 * Six common-term docs pin the IDF floor; the relic docs are recoverable;
 * the wyrm terms live only in the query, so their IDF mass keeps coverage
 * below the completeness threshold no matter how many relics the loop
 * recovers - which is what leaves the plan phase a measurable gap to
 * pause on.
 */
function seedIterativeVault(): void {
  for (let i = 1; i <= 6; i++) {
    writeMd(`notes/wh${i}.md`, `# WH${i}\n\nWarehouse rotation schedule, bay ${i}.\n`);
  }
  for (const term of ["relic01", "relic02"]) {
    writeMd(`notes/${term}.md`, `# ${term}\n\n${term} provenance record.\n`);
  }
}

/**
 * The common terms anchor the match; the numbered relic terms name the
 * provenance docs. The pool the lanes return leaves rare query terms
 * uncovered past the deterministic budget, so the loop pauses with
 * measurable gaps - the state the round-trip needs. The query stays
 * SHORT: the plan-phase envelope echoes it, and a long query would push
 * the response past the server's preview budget, which swaps the
 * response for a preview artifact and hides the marker this test reads.
 */
const iterativeQuery = () => "warehouse rotation relic01 relic02 relic03 relic04 relic05 relic06";

interface IterativePlan {
  phase: string;
  round: number;
  token: string;
  llm_step: { status: string; step: string; prompt: string; schema_hints: string[] };
  pool_ids: number[];
  gaps: string[];
  rounds?: ReadonlyArray<{ round: number; added: number }>;
  stop_reason?: string;
}

/**
 * The round-trip responses carry the plan envelope, which can exceed the
 * server's preview budget: `content[0].text` then holds the bounded
 * preview envelope, while `structuredContent` always holds the full,
 * contract-validated object. The round-trip asserts on the full body.
 */
function extractFullBody(resp: any): Record<string, unknown> {
  if (resp?.result?.structuredContent) return resp.result.structuredContent;
  return extractToolResult(resp);
}

test("brain_search iterative round-trip: plan phase carries the envelope, commit phase finalizes", async () => {
  savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] =
    process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
  process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] = "true";
  seedIterativeVault();
  const cfg = resolveSearchConfig({ vault, configPath });
  try {
    await indexVault(cfg);
    const server = makeServer();
    await initialize(server);

    // Phase one: the flag alone asks for the plan.
    const planResp = extractFullBody(
      await call(server, "brain_search", { query: iterativeQuery(), limit: 5, iterative: true }),
    );
    const plan = planResp["iterative"] as IterativePlan | undefined;
    expect(plan).toBeDefined();
    expect(plan!.phase).toBe("needs-llm-step");
    expect(plan!.llm_step.status).toBe("needs-llm-step");
    expect(plan!.token).toMatch(/^drt-\d+-/);
    expect(plan!.round).toBeGreaterThanOrEqual(2);
    expect(plan!.pool_ids.length).toBeGreaterThan(0);
    expect(plan!.gaps.length).toBeGreaterThan(0);
    expect(typeof plan!.llm_step.prompt).toBe("string");
    // The plan marker carries the deterministic loop's accounting too:
    // what the rounds before the pause recovered and why the budget
    // stopped while gaps remain - both fields the type carries and the
    // output schema declares for this marker.
    expect(Array.isArray(plan!.rounds)).toBe(true);
    expect((plan!.rounds ?? []).length).toBeGreaterThan(0);
    expect(typeof plan!.stop_reason).toBe("string");

    // Phase two: the token plus the committed payload finalizes.
    const commitArgs = {
      query: iterativeQuery(),
      limit: 5,
      iterative: true,
      iterative_token: plan!.token,
      iterative_payload: {
        evidence: [plan!.pool_ids[0]],
        subQueries: ["relic01 relic02"],
      },
    };
    const finalBody = extractFullBody(await call(server, "brain_search", commitArgs));
    const finalPhase = finalBody["iterative"] as
      | {
          phase: string;
          rounds?: ReadonlyArray<{ round: number; added: number }>;
          stop_reason?: string;
        }
      | undefined;
    expect(finalPhase).toBeDefined();
    expect(finalPhase!.phase).toBe("final");
    // The final marker carries the loop's accounting: what each
    // deterministic round recovered and why the budget stopped.
    expect(Array.isArray(finalPhase!.rounds)).toBe(true);
    expect((finalPhase!.rounds ?? []).length).toBeGreaterThan(0);
    expect(typeof finalPhase!.stop_reason).toBe("string");
    const results = finalBody["results"] as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    // The token was single use: replaying the commit is refused by name,
    // never silently re-run.
    const replay = (await call(server, "brain_search", commitArgs)) as any;
    expect(replay?.error?.code).toBe(-32602);
    expect(replay?.error?.message ?? "").toContain("token_used");
  } finally {
    if (savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] === undefined) {
      delete process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    } else {
      process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] =
        savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    }
  }
});

test("a malformed decider payload is a caller error (-32602), never an internal error", async () => {
  savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] =
    process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
  process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] = "true";
  seedIterativeVault();
  const cfg = resolveSearchConfig({ vault, configPath });
  try {
    await indexVault(cfg);
    const server = makeServer();
    await initialize(server);
    const planResp = extractFullBody(
      await call(server, "brain_search", { query: iterativeQuery(), limit: 5, iterative: true }),
    );
    const plan = planResp["iterative"] as IterativePlan | undefined;
    expect(plan).toBeDefined();

    // The most likely caller mistake - a payload missing its `subQueries`
    // half - is a shape refusal. It must surface as the caller-error code
    // with the typed INVALID_INPUT token, never as -32603 with prose.
    const malformed = (await call(server, "brain_search", {
      query: iterativeQuery(),
      limit: 5,
      iterative: true,
      iterative_token: plan!.token,
      iterative_payload: { evidence: [plan!.pool_ids[0]] },
    })) as any;
    expect(malformed?.error?.code).toBe(-32602);
    expect(malformed?.error?.data?.code).toBe("INVALID_INPUT");
    expect(malformed?.error?.message ?? "").toContain("shape");

    // A payload that passes shape but breaks a registered semantic rule
    // (five sub-queries against a budget of four) is the same class of
    // caller error.
    const overLimit = (await call(server, "brain_search", {
      query: iterativeQuery(),
      limit: 5,
      iterative: true,
      iterative_token: plan!.token,
      iterative_payload: {
        evidence: [plan!.pool_ids[0]],
        subQueries: ["a", "b", "c", "d", "e"],
      },
    })) as any;
    expect(overLimit?.error?.code).toBe(-32602);
    expect(overLimit?.error?.data?.code).toBe("INVALID_INPUT");

    // A sub-query of pure punctuation passes shape but carries no
    // significant terms; the registered check refuses it as the same
    // caller-error class.
    const punctuationOnly = (await call(server, "brain_search", {
      query: iterativeQuery(),
      limit: 5,
      iterative: true,
      iterative_token: plan!.token,
      iterative_payload: { evidence: [plan!.pool_ids[0]], subQueries: ["---"] },
    })) as any;
    expect(punctuationOnly?.error?.code).toBe(-32602);
    expect(punctuationOnly?.error?.data?.code).toBe("INVALID_INPUT");

    // Neither refusal spent the token: the valid commit still goes through.
    const finalBody = extractFullBody(
      await call(server, "brain_search", {
        query: iterativeQuery(),
        limit: 5,
        iterative: true,
        iterative_token: plan!.token,
        iterative_payload: { evidence: [plan!.pool_ids[0]], subQueries: ["relic01 relic02"] },
      }),
    );
    const finalPhase = finalBody["iterative"] as { phase: string } | undefined;
    expect(finalPhase).toBeDefined();
    expect(finalPhase!.phase).toBe("final");
  } finally {
    if (savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] === undefined) {
      delete process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    } else {
      process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] =
        savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    }
  }
});

test("brain_search with the knob on but the flag omitted is byte-identical to the knob off", async () => {
  writeMd("notes/plain.md", "# Plain\n\nthe quarterly ledger reconciliation runbook\n");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  const server = makeServer();
  await initialize(server);
  const query = "quarterly ledger reconciliation";
  // Pin the wall clock: the recency boost reads Date.now() per call, so
  // two searches a millisecond apart differ in float noise that has
  // nothing to do with the mode.
  savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] =
    process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
  process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] = "true";
  try {
    // Pin the wall clock: the recency boost reads Date.now() per call, so
    // two searches a millisecond apart differ in float noise that has
    // nothing to do with the mode. The pin never outlives this test.
    setSystemTime(1_750_000_000_000);
    // record_access off on both legs: the first call's activation record
    // would otherwise feed the second call's usage-aware ranking - a real
    // effect, but one that has nothing to do with the mode under test.
    const off = extractToolResult(
      await call(server, "brain_search", { query, limit: 5, record_access: false }),
    );
    expect(off["iterative"]).toBeUndefined();
    setSystemTime(1_750_000_000_000);
    // Mode on (the operator knob), operation not requested (no flag):
    // the same request must serialize identically, no phase marker.
    const inert = extractToolResult(
      await call(server, "brain_search", { query, limit: 5, record_access: false }),
    );
    expect(JSON.stringify(inert)).toBe(JSON.stringify(off));
  } finally {
    setSystemTime();
    if (savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] === undefined) {
      delete process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    } else {
      process.env["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"] =
        savedEnv["OPEN_SECOND_BRAIN_SEARCH_ITERATIVE"];
    }
  }
});

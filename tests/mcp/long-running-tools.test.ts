/**
 * The MCP tools that can genuinely run for minutes are both bounded and
 * observable (nothing-runs-unwatched, U2).
 *
 * One theme, because a deadline and a progress tick sit at the same
 * boundary: a run worth guarding is a run worth reporting on, and the
 * safeguard checkpoints are where the spine emits.
 *
 * `brain_bridges` and `brain_clusters` call the same two core functions
 * the maintenance lane calls, and both accept a `Safeguard` there -
 * `admin-tools.ts` passes one per task, resolving the budget through
 * `resolveSafeguardTimeoutMs`. The two standalone MCP tools passed
 * nothing at all, so a graph sweep an agent started over MCP had no upper
 * bound on how long it could hold the server. They now resolve the budget
 * the same way the lane does.
 *
 * `brain_dream` was the fourth tool `docs/mcp.md` said was bounded and
 * the one that was not: the commit that added the deadlines and wrote
 * that sentence never touched `feedback-tools.ts`, and this file asserted
 * the deadline for two of the four it names. All four are asserted here
 * now, in both halves - bounded and observed - because the gap survived
 * exactly as long as the test covered half the population the prose did.
 * The lane is the one that does not abort the call: it converts a tripped
 * deadline into a `timed_out` row per task, which is where its deadline
 * is visible.
 *
 * The deadline is exercised through a clock that jumps past any budget on
 * its second reading, which is what `createSafeguard` compares against:
 * the alternative - waiting out a real budget - is measured in the
 * minutes the built-in default allows.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { DREAM_STEP } from "../../src/core/brain/dream-step.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { PROGRESS_META_KEY, PROGRESS_NOTIFICATION_METHOD } from "../../src/mcp/progress.ts";
import type { JsonRpcNotification } from "../../src/mcp/protocol.ts";
import { PROGRESS_SCHEMA } from "../../src/core/brain/progress.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-guard-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-guard-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION },
  });
}

/** The tool-level envelope, whose `isError` carries a thrown core error. */
async function callRaw(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: args },
  })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  return res.result!;
}

function writeLinkedGroup(): void {
  const group = ["team-a", "team-b", "team-c", "team-d"];
  for (const name of group) {
    const others = group
      .filter((g) => g !== name)
      .map((g) => `[[${g}]]`)
      .join(" ");
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nSee ${others}.\n`);
  }
}

/**
 * A clock whose every reading is a full day past the previous one, so any
 * budget `resolveSafeguardTimeoutMs` returns has elapsed by the first
 * checkpoint. `createSafeguard` reads `Date.now` when no clock is
 * injected, which is exactly the path an MCP tool takes.
 */
function jumpingClock(): () => void {
  let tick = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => {
    tick += 1;
    return tick * 86_400_000;
  });
  return () => spy.mockRestore();
}

test("brain_bridges discover aborts once its deadline has passed", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_bridges", { operation: "discover" });
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("bridges");
  } finally {
    restore();
  }
});

test("brain_clusters run aborts once its deadline has passed", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_clusters", { operation: "run" });
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("clusters");
  } finally {
    restore();
  }
});

test("brain_dream run aborts once its deadline has passed", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_dream", { action: "run", dry_run: true });
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("dream");
  } finally {
    restore();
  }
});

test("brain_dream stage aborts once its deadline has passed", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_dream", { action: "stage" });
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("dream");
  } finally {
    restore();
  }
});

test("brain_dream step aborts once its deadline has passed", async () => {
  // The step branch was the one row `docs/mcp.md` marked **none**: it
  // returned `runDreamStep(vault, step)` with no guard, so a single step
  // over a large tree held the server's event loop for its whole
  // duration. It is bounded on the same `dream` budget as every other
  // branch now, and the abort names the operation rather than the step.
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_dream", { action: "run", step: "scan" });
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("dream");
  } finally {
    restore();
  }
});

test("brain_dream step reports the step it runs under a progress token", async () => {
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect(
    (await callWithToken(server, "brain_dream", { action: "run", step: DREAM_STEP.scan })).isError,
  ).toBe(false);
  // The step branch dropped the sink as silently as it dropped the guard.
  expect(operationsIn(frames)).toEqual(new Set(["dream"]));
  // ...and the STAGE is the claim this test's name, its docblock and the
  // `docs/mcp.md` row all make: a step reports under its own name rather
  // than the five stages of a full pass. Asserting only the operation
  // left that claim untested - `dream` is the operation on every branch,
  // so renaming the scan's stage to `plan` kept this green.
  expect(stagesIn(frames)).toEqual(new Set([DREAM_STEP.scan]));
});

test("brain_dream step heal-enrich reports under its own stage too", async () => {
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect(
    (await callWithToken(server, "brain_dream", { action: "run", step: DREAM_STEP.healEnrich }))
      .isError,
  ).toBe(false);
  // The second of the two runnable steps, so the row's parenthetical
  // (`scan` / `heal-enrich`) is covered rather than half-covered.
  expect(operationsIn(frames)).toEqual(new Set(["dream"]));
  expect(stagesIn(frames)).toEqual(new Set([DREAM_STEP.healEnrich]));
});

test("brain_maintenance names the task whose deadline tripped", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  let payload: { tasks: Array<{ name: string; ok: boolean; timed_out?: boolean }> };
  try {
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 4,
      method: "tools/call",
      params: { name: "brain_maintenance", arguments: { operation: "run", force: true } },
    })) as { result?: { isError?: boolean; structuredContent?: unknown } };
    expect(res.result!.isError).toBe(false);
    payload = res.result!.structuredContent as typeof payload;
  } finally {
    restore();
  }
  // The lane converts a tripped deadline into a per-task row rather than
  // an aborted tool call, so the deadline is visible as `timed_out`.
  const dreamTask = payload.tasks.find((t) => t.name === "dream");
  expect(dreamTask).toBeDefined();
  expect(dreamTask!.timed_out).toBe(true);
});

test("brain_review_candidates aborts once its deadline has passed", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_review_candidates", {});
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("dream");
  } finally {
    restore();
  }
});

test("brain_brief view=operator names the deadline its dream pass tripped", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  let payload: { dream_error?: string };
  try {
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 5,
      method: "tools/call",
      params: { name: "brain_brief", arguments: { view: "operator" } },
    })) as { result?: { isError?: boolean; structuredContent?: unknown } };
    // The brief reports the missing half rather than failing the whole
    // dashboard, so the deadline is visible as `dream_error`, not isError.
    expect(res.result!.isError).toBe(false);
    payload = res.result!.structuredContent as typeof payload;
  } finally {
    restore();
  }
  expect(payload.dream_error).toContain("safeguard timeout");
});

test("a live clock leaves all four tools running to completion", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const bridges = await callRaw(server, "brain_bridges", { operation: "discover" });
  expect(bridges.isError).toBe(false);
  const clusters = await callRaw(server, "brain_clusters", { operation: "run" });
  expect(clusters.isError).toBe(false);
  const dreamed = await callRaw(server, "brain_dream", { action: "run", dry_run: true });
  expect(dreamed.isError).toBe(false);
  const lane = await callRaw(server, "brain_maintenance", { operation: "run", force: true });
  expect(lane.isError).toBe(false);
});

// ---------------------------------------------------------------------------
// The same four tools, observed
// ---------------------------------------------------------------------------

/** One field of the progress events a call emitted, deduplicated. */
function fieldIn(frames: JsonRpcNotification[], field: "operation" | "stage"): Set<string> {
  const seen = new Set<string>();
  for (const frame of frames) {
    if (frame.method !== PROGRESS_NOTIFICATION_METHOD) continue;
    const params = frame.params as Record<
      string,
      Record<string, { operation: string; stage: string; schema: string }>
    >;
    const event = params["_meta"]![PROGRESS_META_KEY]!;
    expect(event.schema).toBe(PROGRESS_SCHEMA);
    seen.add(event[field]);
  }
  return seen;
}

/** The operations named by the progress events a call emitted. */
function operationsIn(frames: JsonRpcNotification[]): Set<string> {
  return fieldIn(frames, "operation");
}

/**
 * The stages named by those events.
 *
 * A second reader rather than a wider `operationsIn`, because the two
 * answer different questions: the operation says WHOSE run this is (the
 * lane's dispatch test turns on it), and the stage says WHERE in that run
 * it currently is. The step tests are the ones that need the second.
 */
function stagesIn(frames: JsonRpcNotification[]): Set<string> {
  return fieldIn(frames, "stage");
}

/** A server whose notification frames this test can read back. */
function observedServer(frames: JsonRpcNotification[]): MCPServer {
  return new MCPServer(
    { vault, configPath },
    { sendNotification: (notification) => frames.push(notification) },
  );
}

async function callWithToken(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean }> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 3,
    method: "tools/call",
    params: { name: tool, arguments: args, _meta: { progressToken: `t-${tool}` } },
  })) as { result?: { isError?: boolean } };
  return res.result!;
}

test("brain_bridges reports its scan under a progress token", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect((await callWithToken(server, "brain_bridges", { operation: "discover" })).isError).toBe(
    false,
  );
  expect(operationsIn(frames)).toEqual(new Set(["bridges"]));
});

test("brain_clusters reports its sweeps under a progress token", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect((await callWithToken(server, "brain_clusters", { operation: "run" })).isError).toBe(false);
  expect(operationsIn(frames)).toEqual(new Set(["clusters"]));
});

test("brain_dream reports its consolidation pass under a progress token", async () => {
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect(
    (await callWithToken(server, "brain_dream", { action: "run", dry_run: true })).isError,
  ).toBe(false);
  expect(operationsIn(frames)).toEqual(new Set(["dream"]));
});

test("brain_dream stage reports the pass it runs under a progress token", async () => {
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect((await callWithToken(server, "brain_dream", { action: "stage" })).isError).toBe(false);
  expect(operationsIn(frames)).toEqual(new Set(["dream"]));
});

test("brain_review_candidates reports the pass behind its projection", async () => {
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect((await callWithToken(server, "brain_review_candidates", {})).isError).toBe(false);
  expect(operationsIn(frames)).toEqual(new Set(["dream"]));
});

test("brain_brief view=operator reports its dry-run pass", async () => {
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect((await callWithToken(server, "brain_brief", { view: "operator" })).isError).toBe(false);
  expect(operationsIn(frames)).toEqual(new Set(["dream"]));
});

test("brain_maintenance forwards the sink to every task it dispatches", async () => {
  writeLinkedGroup();
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect(
    (await callWithToken(server, "brain_maintenance", { operation: "run", force: true })).isError,
  ).toBe(false);
  // The lane is a dispatcher, so it speaks with its tasks' voices: each
  // event names the operation that emitted it, never the lane.
  expect(operationsIn(frames)).toEqual(new Set(["dream", "reindex", "bridges", "clusters"]));
});

test("no token leaves every one of them silent", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  await callRaw(server, "brain_bridges", { operation: "discover" });
  await callRaw(server, "brain_clusters", { operation: "run" });
  expect(frames).toEqual([]);
});

// ---------------------------------------------------------------------------
// The prose is derived from the two populations, not asserted beside them
// ---------------------------------------------------------------------------

/**
 * `docs/mcp.md` claims "bounded and observed are now the same population
 * with no exception", and the table under it is the population. That
 * sentence replaced a `**none**` row - a row that had been wrong for a
 * release because nothing checked it - so leaving the replacement as
 * unchecked prose would repeat the failure with better wording.
 *
 * Both sides are read rather than written down: the rows come out of the
 * document and the covered tools come out of THIS file's own calls. A row
 * for a tool nobody drives here fails, and a row that reads `none` in
 * either column fails.
 */
const BOUNDED_TABLE_HEADER = "| tool | long operation it reaches | deadline | reports |";

interface DocRow {
  readonly tool: string;
  readonly subject: string;
  readonly deadline: string;
  readonly reports: string;
}

function boundedTableRows(): ReadonlyArray<DocRow> {
  const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "mcp.md"), "utf8");
  const start = doc.indexOf(BOUNDED_TABLE_HEADER);
  expect(`the bounded table is present: ${start >= 0}`).toBe("the bounded table is present: true");
  const body = doc.slice(start).split("\n\n")[0]!;
  return body
    .split("\n")
    .slice(2) // header and separator
    .filter((line) => line.startsWith("|"))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      return {
        subject: cells[0] ?? "",
        tool: /`(brain_[a-z_]+)`/.exec(cells[0] ?? "")?.[1] ?? "",
        deadline: cells[2] ?? "",
        reports: cells[3] ?? "",
      };
    });
}

/** The tools this file actually drives, read from its own call sites. */
function toolsCoveredHere(): Set<string> {
  const self = readFileSync(import.meta.path, "utf8");
  return new Set(
    [...self.matchAll(/call(?:Raw|WithToken)\(\s*server,\s*"([a-z_]+)"/g)].map((m) => m[1]!),
  );
}

test("every row of the bounded table is bounded, observed, and covered here", () => {
  const rows = boundedTableRows();
  // Non-vacuous: a parse that silently stopped matching would sweep an
  // empty table clean.
  expect(rows.length).toBeGreaterThan(6);

  const unnamed = rows.filter((r) => r.tool === "").map((r) => r.subject);
  expect(unnamed.join("\n")).toBe("");

  // "No exception" is exactly this: no row may say a call is unbounded or
  // unobserved. `**none**` was the spelling the step row used.
  const exceptions = rows
    .filter((r) => /none/i.test(r.deadline) || !/^yes/i.test(r.reports))
    .map((r) => `${r.subject} | ${r.deadline} | ${r.reports}`);
  expect(exceptions.join("\n")).toBe("");

  // And the table may not name a tool this file leaves untested.
  const covered = toolsCoveredHere();
  const untested = [...new Set(rows.map((r) => r.tool))].filter((t) => !covered.has(t));
  expect(untested.toSorted().join("\n")).toBe("");
});

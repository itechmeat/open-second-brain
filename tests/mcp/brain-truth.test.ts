/**
 * `brain_truth` MCP tool (Entity Truth & Self-Improving Dream Suite):
 * ingest one claim, read slots/conflicts from the fold, aggregate
 * exact-match quantities, report cross-agent collisions.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendClaimEvent } from "../../src/core/brain/truth/store.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-truth-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-truth-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
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
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "truth-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name: "brain_truth", arguments: args },
  })) as { result?: { content?: Array<{ text?: string }> }; error?: { message: string } };
  if (res.error !== undefined) throw new Error(res.error.message);
  return JSON.parse(res.result!.content![0]!.text!) as Record<string, unknown>;
}

test("ingest then slots round-trips one claim through the fold", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const ingested = await call(server, {
    operation: "ingest",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/standup.md]]",
  });
  expect(ingested["ok"]).toBe(true);
  expect(ingested["entity"]).toBe("alice mason");

  const slots = await call(server, { operation: "slots" });
  expect(slots["events"]).toBe(1);
  expect((slots["slots"] as Array<{ current: { value: string } }>)[0]!.current.value).toBe(
    "Google",
  );
});

test("conflicts and aggregate read the same ledger", async () => {
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/a.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-10T10:00:00Z",
    agent: "sales-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/b.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-02T10:00:00Z",
    agent: "claude",
    entity: "operator",
    aspect: "hosting spend",
    value: "120",
    valueKind: "quantity",
    quantity: { value: 120, unit: "usd", action: "spent" },
    source: "[[Brain/notes/c.md]]",
  });

  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const conflicts = await call(server, { operation: "conflicts" });
  expect(conflicts["conflicts"]).toHaveLength(1);

  const aggregate = await call(server, { operation: "aggregate", action: "spent", unit: "usd" });
  expect(aggregate["total"]).toBe(120);
  expect(aggregate["count"]).toBe(1);
});

test("unknown operation is an invalid-params error", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  await expect(call(server, { operation: "bogus" })).rejects.toThrow(/operation/);
});

// ----- operation: "events" (truth-correctable-time-aware, Task 8) -----------

interface ClaimEventRow {
  readonly ts: string;
  readonly entity: string;
  readonly aspect: string;
  readonly value: string;
  readonly source: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
}

interface EventsResponse {
  readonly ok: boolean;
  readonly operation: string;
  readonly entity: string | null;
  readonly events: ReadonlyArray<ClaimEventRow>;
  readonly total: number;
  readonly withheld: number;
  readonly truncated: boolean;
}

/**
 * Write a readable source page. The events operation's per-row gate
 * fails closed on a page whose file cannot be read, so an event naming
 * a page that was never written is withheld below local reach - the
 * tests that expect rows served must back them with real pages.
 */
function writeSourcePage(name: string, visibilityLine = ""): void {
  const dir = join(vault, "Brain", "notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `---\nkind: note${visibilityLine}\n---\n\n${name} source page\n`);
}

function seedWindowedLedger(): void {
  for (const name of ["a.md", "b.md", "c.md"]) writeSourcePage(name);
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    validFrom: "2026-06-01",
    validUntil: "2026-09-01",
    source: "[[Brain/notes/a.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-05T09:30:00Z",
    agent: "claude",
    entity: "alice mason",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/b.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-10T12:00:00Z",
    agent: "claude",
    entity: "Project Atlas",
    aspect: "status",
    value: "on track",
    source: "[[Brain/notes/c.md]]",
  });
}

test("events returns rows in stable ascending assertion-ts order with validity fields verbatim", async () => {
  seedWindowedLedger();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, { operation: "events" })) as unknown as EventsResponse;
  expect(body.ok).toBe(true);
  expect(body.operation).toBe("events");
  expect(body.entity).toBe(null);
  expect(body.total).toBe(3);
  expect(body.withheld).toBe(0);
  expect(body.truncated).toBe(false);
  expect(body.events.map((e) => e.ts)).toEqual([
    "2026-06-01T10:00:00Z",
    "2026-06-05T09:30:00Z",
    "2026-06-10T12:00:00Z",
  ]);
  expect(body.events[0]!.entity).toBe("alice mason");
  expect(body.events[0]!.validFrom).toBe("2026-06-01");
  expect(body.events[0]!.validUntil).toBe("2026-09-01");
  expect(body.events[1]!.validFrom).toBeUndefined();
  // The slots response stays byte-identical: `events` there is the count.
  const slots = await call(server, { operation: "slots" });
  expect(slots["events"]).toBe(3);
});

test("events filters by normalized entity composing with the assertion-time window", async () => {
  seedWindowedLedger();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, {
    operation: "events",
    entity: "Alice Mason",
    since: "2026-06-02",
    until: "2026-06-05",
  })) as unknown as EventsResponse;
  // The display-form spelling resolves to the canonical entity, and the
  // day-edge bounds are inclusive: since keeps 06-05, until cuts 06-10.
  expect(body.entity).toBe("alice mason");
  expect(body.events.map((e) => e.ts)).toEqual(["2026-06-05T09:30:00Z"]);
  expect(body.total).toBe(1);
});

test("events pages with limit and reports truncation", async () => {
  seedWindowedLedger();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, { operation: "events", limit: 2 })) as unknown as EventsResponse;
  expect(body.events).toHaveLength(2);
  expect(body.total).toBe(3);
  expect(body.truncated).toBe(true);
  // Tail-following pagination: an advancing `since` never skips a
  // boundary event - it floors into its second, so the boundary row is
  // re-seen (the caller dedups by ts) rather than skipped.
  const tail = (await call(server, {
    operation: "events",
    limit: 2,
    since: body.events[1]!.ts,
  })) as unknown as EventsResponse;
  expect(tail.events.map((e) => e.ts)).toEqual(["2026-06-05T09:30:00Z", "2026-06-10T12:00:00Z"]);
  expect(tail.truncated).toBe(false);
  const past = (await call(server, {
    operation: "events",
    since: "2026-06-06",
  })) as unknown as EventsResponse;
  expect(past.events.map((e) => e.ts)).toEqual(["2026-06-10T12:00:00Z"]);
});

test("events withholds rows naming a page beyond the caller's reach and counts them", async () => {
  writeSourcePage("public.md");
  writeSourcePage("private.md", `\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`);
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/public.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-02T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/private.md]]",
  });
  const remote = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
  await initialize(remote);
  const seen = (await call(remote, { operation: "events" })) as unknown as EventsResponse;
  // A withheld row is counted, never rendered: the caller sees one event
  // and cannot read the withheld one from the response.
  expect(seen.total).toBe(2);
  expect(seen.withheld).toBe(1);
  expect(seen.events.map((e) => e.value)).toEqual(["Google"]);
  expect(JSON.stringify(seen.events)).not.toContain("private.md");
  const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  await initialize(local);
  const localBody = (await call(local, { operation: "events" })) as unknown as EventsResponse;
  expect(localBody.events).toHaveLength(2);
  expect(localBody.withheld).toBe(0);
});

test("events refuses unparseable bounds and invalid limits as invalid params", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  // The shared grammar's refusal surfaces verbatim (the same convention
  // the time-bounds wrapper pins); the message names the offending input.
  await expect(call(server, { operation: "events", since: "not a date" })).rejects.toThrow(
    /not a date/,
  );
  await expect(
    call(server, { operation: "events", since: "2026-06-05", until: "2026-06-01" }),
  ).rejects.toThrow();
  await expect(call(server, { operation: "events", limit: 0 })).rejects.toThrow(/limit/);
  await expect(call(server, { operation: "events", limit: 1.5 })).rejects.toThrow(/limit/);
  await expect(call(server, { operation: "events", limit: "many" })).rejects.toThrow(/limit/);
});

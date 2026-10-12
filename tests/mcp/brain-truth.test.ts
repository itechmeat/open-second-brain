/**
 * `brain_truth` MCP tool (Entity Truth & Self-Improving Dream Suite):
 * ingest one claim, read slots/conflicts from the fold, aggregate
 * exact-match quantities, report cross-agent collisions.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { readClaimEvents, appendClaimEvent } from "../../src/core/brain/truth/store.ts";
import { computeTruthStateWithConflicts } from "../../src/core/brain/truth/conflicts.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { emitContextPackOutcome } from "../../src/core/brain/context-pack-outcome.ts";
import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { continuityLogPath } from "../../src/core/brain/continuity/store.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
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

/**
 * The whole JSON-RPC response, for assertions on the failure CLASS: a
 * handler-mapped refusal answers as a JSON-RPC error carrying the
 * invalid-params code, while an unmapped internal error would arrive as
 * an isError tool result (or an internal_error envelope).
 */
async function callRaw(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{
  error?: { code: number; message: string; data?: { code?: string } };
  result?: { isError?: boolean };
}> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name: "brain_truth", arguments: args },
  })) as {
    error?: { code: number; message: string; data?: { code?: string } };
    result?: { isError?: boolean };
  };
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

test("events answers a caller denied a source page exactly as if the row were absent", async () => {
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
  // The extensionless wikilink spelling names the SAME page: the
  // conventional Obsidian shape the ingest window resolver accepts. A
  // gate that resolves only the .md form fails open for this row.
  appendClaimEvent(vault, {
    ts: "2026-06-03T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Amazon",
    source: "[[Brain/notes/private]]",
  });
  const remote = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
  await initialize(remote);
  const seen = (await call(remote, { operation: "events" })) as unknown as EventsResponse;
  // A withheld row is dropped and NOTHING counts it (the views'
  // identical-to-absent convention): the account covers only rows the
  // caller may read, under either spelling of the same withheld page.
  expect(seen.total).toBe(1);
  expect("withheld" in seen).toBe(false);
  expect(seen.events.map((e) => e.value)).toEqual(["Google"]);
  expect(JSON.stringify(seen)).not.toContain("private");
  const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  await initialize(local);
  const localBody = (await call(local, { operation: "events" })) as unknown as EventsResponse;
  expect(localBody.events).toHaveLength(3);
  expect(localBody.total).toBe(3);
  expect("withheld" in localBody).toBe(false);
  // The identical-answer property, vault against vault: the same remote
  // query over a vault holding only the readable row answers byte for
  // byte what the vault with two extra withheld rows answered, so no
  // pivot (entity, window, limit) can measure the hidden population.
  const b = secondVault();
  try {
    mkdirSync(join(b.vault, "Brain", "notes"), { recursive: true });
    writeFileSync(
      join(b.vault, "Brain", "notes", "public.md"),
      `---\nkind: note\n---\n\npublic.md source page\n`,
    );
    appendClaimEvent(b.vault, {
      ts: "2026-06-01T10:00:00Z",
      agent: "claude",
      entity: "Alice Mason",
      aspect: "employer",
      value: "Google",
      source: "[[Brain/notes/public.md]]",
    });
    const remoteB = new MCPServer(
      { vault: b.vault, configPath: b.configPath },
      { reach: TRANSPORT_REACH.remote },
    );
    await initialize(remoteB);
    const withoutHidden = (await call(remoteB, { operation: "events" })) as unknown as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(withoutHidden)).toBe(JSON.stringify({ ...seen }));
  } finally {
    rmSync(b.configHome, { recursive: true, force: true });
  }
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

// ----- operation: "state" (grounded agent-stated claims, Task 8) ------------

interface StateResponse {
  readonly ok: boolean;
  readonly operation: string;
  readonly committed: ReadonlyArray<ClaimEventRow & { readonly extractor?: string }>;
  readonly ungrounded: ReadonlyArray<{
    readonly subject: string;
    readonly relation: string;
    readonly object: string;
    readonly reasons: ReadonlyArray<string>;
  }>;
}

function seedRegistry(): void {
  upsertEntity(vault, {
    category: "people",
    name: "Alice Mason",
    aliases: ["Alice"],
    agent: "claude",
    now: new Date("2026-06-01T00:00:00Z"),
  });
  upsertEntity(vault, {
    category: "projects",
    name: "Project Atlas",
    aliases: ["Atlas"],
    agent: "claude",
    now: new Date("2026-06-01T00:00:00Z"),
  });
}

test("state commits a grounded agent-stated claim as an agent_stated ledger event", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
    text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
    source: "[[Brain/notes/session.md]]",
  })) as unknown as StateResponse;
  expect(body.ok).toBe(true);
  expect(body.operation).toBe("state");
  expect(body.committed).toHaveLength(1);
  const row = body.committed[0]!;
  expect(row.entity).toBe("alice mason");
  expect(row.aspect).toBe("extends");
  expect(row.value).toBe("Project Atlas");
  expect(row.extractor).toBe("agent_stated");
  expect(row.source).toBe("[[Brain/notes/session.md]]");
  expect(body.ungrounded).toHaveLength(0);
  const [stored] = readClaimEvents(vault).events;
  expect(stored!.extractor).toBe("agent_stated");
});

test("state anchors subjects and objects through registry aliases", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  // The claim names the full label, the text only the alias: anchoring
  // goes through the registry's quality-gated match forms, not string
  // equality between the claim and the text.
  const body = (await call(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "related", object: "Project Atlas" }],
    text: "Alice opened the Atlas kickoff deck this morning.",
    source: "[[Brain/notes/session.md]]",
  })) as unknown as StateResponse;
  expect(body.committed).toHaveLength(1);
  expect(body.committed[0]!.entity).toBe("alice mason");
});

test("state reports ungrounded claims back per claim with reasons and commits the rest", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, {
    operation: "state",
    claims: [
      { subject: "Alice Mason", relation: "related", object: "Project Atlas" },
      { subject: "Alice Mason", relation: "related", object: "Project Osiris" },
    ],
    // The stated label itself is one anchoring form (lane 1's verdict
    // contract), so the ungrounded claim's object must not occur in the
    // text at all - "Osiris" alone is a different, shorter form.
    text: "Alice walked through the Project Atlas plan all morning.",
    source: "[[Brain/notes/session.md]]",
  })) as unknown as StateResponse;
  // Each event is an independent append in an append-only ledger, so the
  // grounded claim commits and only the ungrounded one is reported back.
  expect(body.committed).toHaveLength(1);
  expect(body.committed[0]!.value).toBe("Project Atlas");
  expect(body.ungrounded).toHaveLength(1);
  expect(body.ungrounded[0]!.object).toBe("Project Osiris");
  expect(body.ungrounded[0]!.reasons).toContain("object_unanchored");
  expect(readClaimEvents(vault).events).toHaveLength(1);
});

test("state refuses unknown relations before any write", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  await expect(
    call(server, {
      operation: "state",
      claims: [
        { subject: "Alice Mason", relation: "related", object: "Project Atlas" },
        { subject: "Alice Mason", relation: "invented_by", object: "Project Atlas" },
      ],
      text: "Alice Mason reviewed Project Atlas today.",
      source: "[[Brain/notes/session.md]]",
    }),
  ).rejects.toThrow(/invented_by/);
  // Refuse-before-write: nothing landed, not even the valid claim.
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("state refuses a missing or empty text or source before any write", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const claim = [{ subject: "Alice Mason", relation: "related", object: "Project Atlas" }];
  await expect(
    call(server, {
      operation: "state",
      claims: claim,
      text: "Alice Mason reviewed Project Atlas today.",
    }),
  ).rejects.toThrow(/source/);
  await expect(
    call(server, { operation: "state", claims: claim, source: "[[Brain/notes/a.md]]" }),
  ).rejects.toThrow(/text/);
  await expect(
    call(server, { operation: "state", text: "x", source: "[[Brain/notes/a.md]]" }),
  ).rejects.toThrow(/claims/);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("state normalizes the relation token and resolves its agent override", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "Related", object: "Project Atlas" }],
    text: "Alice Mason and Project Atlas met.",
    source: "[[Brain/notes/session.md]]",
    agent: "scribe-agent",
  })) as unknown as StateResponse;
  expect(body.committed[0]!.aspect).toBe("related");
  expect(readClaimEvents(vault).events[0]!.agent).toBe("scribe-agent");
});

test("state refuses a malformed source window as invalid params, not an internal error", async () => {
  // The stated claim carries no explicit window, so the store resolves
  // one from the source record's frontmatter; an inverted window there
  // raises the store's typed refusal, which the state operation must map
  // exactly as ingest maps it - typed INVALID_PARAMS, never an
  // internal error escaping the handler.
  seedRegistry();
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "notes", "session.md"),
    "---\nkind: note\nvalid_from: 2026-06-01\nvalid_until: 2026-01-01\n---\n\nsession page\n",
  );
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const raw = await callRaw(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "related", object: "Project Atlas" }],
    text: "Alice Mason reviewed Project Atlas today.",
    source: "[[Brain/notes/session.md]]",
  });
  expect(raw.error).toBeDefined();
  expect(raw.error!.code).toBe(-32602);
  expect(raw.error!.data?.code).toBe("invalid_params");
  expect(raw.error!.message).toMatch(/validity window/);
  expect(raw.result?.isError).toBeUndefined();
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

// ----- sub-suite A integration checkpoint (Task 10) -------------------------

test("ingest declares optional validity fields that win over source resolution", async () => {
  writeSourcePage("windowed.md", '\nvalid_from: "2026-01-01"\nvalid_until: "2026-12-31"');
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const explicit = (await call(server, {
    operation: "ingest",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/windowed.md]]",
    valid_from: "2026-06-01",
    valid_until: "2026-09-01",
  })) as unknown as Record<string, unknown>;
  // Explicit input wins outright over the source's own window.
  expect(explicit["valid_from"]).toBe("2026-06-01");
  expect(explicit["valid_until"]).toBe("2026-09-01");
  const [stored] = readClaimEvents(vault).events;
  expect(stored!.validFrom).toBe("2026-06-01");
  expect(stored!.validUntil).toBe("2026-09-01");
});

test("a windowed events call returns events ingested with resolved frozen windows", async () => {
  // No explicit window: ingest resolves the window from the readable
  // source record's frontmatter and freezes it on the event.
  writeSourcePage("from-frontmatter.md", '\nvalid_from: "2026-05-01"\nvalid_until: "2026-08-01"');
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const ingested = await call(server, {
    operation: "ingest",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/from-frontmatter.md]]",
  });
  expect(ingested["ok"]).toBe(true);
  const body = (await call(server, {
    operation: "events",
    entity: "alice mason",
  })) as unknown as EventsResponse;
  expect(body.events).toHaveLength(1);
  expect(body.events[0]!.validFrom).toBe("2026-05-01");
  expect(body.events[0]!.validUntil).toBe("2026-08-01");
  // The succession channel and the events surface agree on the axis
  // rule: two same-slot claims with present, non-intersecting windows
  // classify as succession in the fold (never a conflict, never
  // ask_user - the pinned conflicts response carries neither), and the
  // same events return from the events operation carrying their frozen
  // windows verbatim (contract item 1, one axis rule, two readers).
  appendClaimEvent(vault, {
    ts: "2026-09-02T10:00:00Z",
    agent: "claude",
    entity: "alice mason",
    aspect: "employer",
    value: "Meta",
    validFrom: "2026-09-01",
    // Explicit: the shared source's frontmatter window (until
    // 2026-08-01) would invert against this from-bound if left open.
    validUntil: "2026-12-31",
    source: "[[Brain/notes/from-frontmatter.md]]",
  });
  const fold = computeTruthStateWithConflicts(readClaimEvents(vault).events);
  expect(fold.conflicts).toHaveLength(0);
  expect(fold.successions).toHaveLength(1);
  expect(fold.successions![0]!.predecessor.value).toBe("Google");
  const pinned = (await call(server, { operation: "conflicts" })) as unknown as {
    conflicts: unknown[];
  };
  expect(pinned.conflicts).toHaveLength(0);
  const both = (await call(server, { operation: "events" })) as unknown as EventsResponse;
  // Ascending assertion ts: the fold-predecessor (Google, window closed
  // 2026-08-01) was asserted today by the ingest above; the succession
  // successor (Meta) was back-dated into September.
  expect(both.total).toBe(2);
  expect(both.events.map((e) => e.value)).toEqual(["Meta", "Google"]);
  expect(both.events[0]!.validFrom).toBe("2026-09-01");
  expect(both.events[0]!.validUntil).toBe("2026-12-31");
  expect(both.events[1]!.validFrom).toBe("2026-05-01");
  expect(both.events[1]!.validUntil).toBe("2026-08-01");
});

// ----- withheld-source boundary (reach-gated window resolution) -------------

interface IngestResponse {
  readonly ok: boolean;
  readonly entity: string;
  readonly aspect: string;
  readonly path: string;
  readonly valid_from?: string;
  readonly valid_until?: string;
}

/**
 * A second single-vault fixture beside the beforeEach one, so a response
 * over a vault where the source page exists (withheld) can be compared
 * with the same call over a vault where it does not.
 */
function secondVault(): { vault: string; configPath: string; configHome: string } {
  const vaultB = join(tmp, "vault-b");
  const configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-truth-cfg-b-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vaultB}\nagent_name: claude\n`);
  bootstrapBrain(vaultB, { configPath });
  return { vault: vaultB, configPath, configHome };
}

test("ingest treats a source beyond the caller's reach exactly like an absent one", async () => {
  // Vault A: the source page exists, is withheld below remote reach, and
  // carries the validity frontmatter a remote caller must not read back.
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "notes", "hidden.md"),
    `---\nkind: note\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n` +
      `valid_from: "2026-01-01"\nvalid_until: "2027-01-01"\n---\n\nhidden source page\n`,
  );
  const b = secondVault();
  try {
    const args = {
      operation: "ingest",
      entity: "Alice Mason",
      aspect: "employer",
      value: "Google",
      source: "[[Brain/notes/hidden.md]]",
    };
    const remoteA = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
    const remoteB = new MCPServer(
      { vault: b.vault, configPath: b.configPath },
      { reach: TRANSPORT_REACH.remote },
    );
    await initialize(remoteA);
    await initialize(remoteB);
    const withHidden = (await call(remoteA, args)) as unknown as IngestResponse;
    const withoutPage = (await call(remoteB, args)) as unknown as IngestResponse;
    // Byte-identical once the vault-specific shard path is set aside: no
    // validity keys, no signal distinguishing withheld from absent.
    expect("valid_from" in withHidden).toBe(false);
    expect("valid_until" in withHidden).toBe(false);
    expect("valid_from" in withoutPage).toBe(false);
    expect(JSON.stringify({ ...withHidden, path: null })).toBe(
      JSON.stringify({ ...withoutPage, path: null }),
    );
    // And the frozen event is windowless in both ledgers.
    expect(readClaimEvents(vault).events[0]!.validFrom).toBeUndefined();
    expect(readClaimEvents(vault).events[0]!.validUntil).toBeUndefined();
    expect(readClaimEvents(b.vault).events[0]!.validFrom).toBeUndefined();
    // The gate withholds exactly the unreadable: a readable source's
    // window still resolves for the same remote caller.
    writeSourcePage("shown.md", '\nvalid_from: "2026-05-01"\nvalid_until: "2026-08-01"');
    const shown = (await call(remoteA, {
      operation: "ingest",
      entity: "Alice Mason",
      aspect: "employer",
      value: "Meta",
      source: "[[Brain/notes/shown.md]]",
    })) as unknown as IngestResponse;
    expect(shown["valid_from"]).toBe("2026-05-01");
    expect(shown["valid_until"]).toBe("2026-08-01");
  } finally {
    rmSync(b.configHome, { recursive: true, force: true });
  }
});

test("state treats a source beyond the caller's reach exactly like an absent one", async () => {
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "notes", "hidden.md"),
    `---\nkind: note\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n` +
      `valid_from: "2026-01-01"\nvalid_until: "2027-01-01"\n---\n\nhidden source page\n`,
  );
  const b = secondVault();
  try {
    const args = {
      operation: "state",
      claims: [{ subject: "Alice Mason", relation: "related", object: "Project Atlas" }],
      text: "Alice Mason and Project Atlas met this morning.",
      source: "[[Brain/notes/hidden.md]]",
    };
    const remoteA = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
    const remoteB = new MCPServer(
      { vault: b.vault, configPath: b.configPath },
      { reach: TRANSPORT_REACH.remote },
    );
    await initialize(remoteA);
    await initialize(remoteB);
    const withHidden = (await call(remoteA, args)) as unknown as StateResponse;
    const withoutPage = (await call(remoteB, args)) as unknown as StateResponse;
    // The assertion ts is per call, so it is set aside with the rest of
    // what names the call rather than the answer; every source-derived
    // byte must agree.
    const stripTs = (body: StateResponse): string =>
      JSON.stringify({
        ...body,
        committed: body.committed.map(({ ts: _ts, ...rest }) => rest),
      });
    expect(withHidden.committed).toHaveLength(1);
    expect(withoutPage.committed).toHaveLength(1);
    expect(stripTs(withHidden)).toBe(stripTs(withoutPage));
    expect(withHidden.committed[0]!.validFrom).toBeUndefined();
    expect(withHidden.committed[0]!.validUntil).toBeUndefined();
    expect(readClaimEvents(vault).events[0]!.validFrom).toBeUndefined();
    expect(readClaimEvents(b.vault).events[0]!.validFrom).toBeUndefined();
  } finally {
    rmSync(b.configHome, { recursive: true, force: true });
  }
});

// ----- boundary discipline (malformed window is a param error) --------------

test("ingest refuses a malformed validity bound as invalid params, not an internal error", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  for (const bad of [
    { valid_from: "garbage" },
    { valid_until: "also garbage" },
    { valid_from: "2026-09-01", valid_until: "2026-06-01" },
  ]) {
    const raw = await callRaw(server, {
      operation: "ingest",
      entity: "Alice Mason",
      aspect: "employer",
      value: "Google",
      source: "[[Brain/notes/standup.md]]",
      ...bad,
    });
    // The sibling mistyped inputs (limit, since/until) answer as typed
    // INVALID_PARAMS; a mistyped validity bound is the same failure
    // class, never an internal error.
    expect(raw.error).toBeDefined();
    expect(raw.error!.code).toBe(-32602);
    expect(raw.error!.data?.code).toBe("invalid_params");
    expect(raw.error!.message).toMatch(/valid[FU]/);
    expect(raw.result?.isError).toBeUndefined();
  }
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

// ----- state sample_id + provenance-hydrated reads (answer-trust, B4) -----

interface ClaimProvenanceRow {
  readonly sample_id: string;
  readonly receipt: {
    readonly id: string;
    readonly created_at: string;
    readonly trigger: string | null;
    readonly items: ReadonlyArray<{ readonly id: string; readonly path?: string }>;
    readonly withheld: boolean;
  } | null;
  readonly outcome: {
    readonly id: string;
    readonly first_pass_success: boolean | null;
    readonly evidence_verdict?: string;
  } | null;
  readonly timestamp_inverted: boolean;
}

test("state accepts a sample_id and echoes it on each committed claim", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
    text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
    source: "[[Brain/notes/session.md]]",
    sample_id: "rcpt-2026-0601-abcd",
  })) as unknown as StateResponse;
  expect(body.ok).toBe(true);
  expect(body.committed).toHaveLength(1);
  expect((body.committed[0] as unknown as { sample_id?: string }).sample_id).toBe(
    "rcpt-2026-0601-abcd",
  );
  const [stored] = readClaimEvents(vault).events;
  expect(stored!.sample_id).toBe("rcpt-2026-0601-abcd");
});

test("state refuses a non-string sample_id as invalid params", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const raw = await callRaw(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
    text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
    source: "[[Brain/notes/session.md]]",
    sample_id: 42,
  });
  expect(raw.error).toBeDefined();
  expect(raw.error!.code).toBe(-32602);
  expect(raw.error!.message).toMatch(/sample_id/);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("state refuses a blank sample_id through the named refusal, before any write", async () => {
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  // A blank id is a named refusal, never coerced to absent.
  const raw = await callRaw(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
    text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
    source: "[[Brain/notes/session.md]]",
    sample_id: "   ",
  });
  expect(raw.error).toBeDefined();
  expect(raw.error!.code).toBe(-32602);
  expect(raw.error!.message).toMatch(/sample_id/);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("state refuses an over-long or control-character sample_id, naming the limit", async () => {
  // L2.1 regression: the same shape check the core boundaries apply -
  // at most 256 characters, no control characters - mapped to the same
  // invalid-params failure class as the blank-id refusal.
  seedRegistry();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  for (const bad of ["r".repeat(300), "rcpt\u0000-1", "rcpt\u0007-1"]) {
    const raw = await callRaw(server, {
      operation: "state",
      claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
      text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
      source: "[[Brain/notes/session.md]]",
      sample_id: bad,
    });
    expect(raw.error).toBeDefined();
    expect(raw.error!.code).toBe(-32602);
    expect(raw.error!.message).toMatch(
      /sample_id must be a non-empty string of at most 256 characters without control characters/,
    );
  }
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("events hydrate provenance for claims carrying a sample_id", async () => {
  seedRegistry();
  writeSourcePage("session.md");
  // The receipt item's path is filtered at the caller's reach, and a
  // path naming no page fails closed like any unreadable one - back the
  // item with a real page so the join may unfold it.
  writeSourcePage("alpha.md");
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  // An explicit past stamp: a defaulted `now` receipt can land up to a
  // second AFTER the claim's floored assertion stamp, which is a genuine
  // timestamp inversion the join must flag - the fixture keeps the
  // receipt unambiguously before the claim.
  const receipt = emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-02T09:00:00.000Z" },
    items: [{ id: "note-alpha", path: "Brain/notes/alpha.md", tokens: 40 }],
    finalText: "the final answer text",
  });
  await call(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
    text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
    source: "[[Brain/notes/session.md]]",
    sample_id: receipt.id,
  });
  const body = (await call(server, { operation: "events" })) as unknown as {
    events: ReadonlyArray<ClaimEventRow & { sample_id?: string; provenance?: ClaimProvenanceRow }>;
  };
  expect(body.events).toHaveLength(1);
  const row = body.events[0]!;
  expect(row.sample_id).toBe(receipt.id);
  expect(row.provenance).toBeDefined();
  expect(row.provenance!.sample_id).toBe(receipt.id);
  // Receipt known.
  expect(row.provenance!.receipt).not.toBeNull();
  expect(row.provenance!.receipt!.id).toBe(receipt.id);
  expect(row.provenance!.receipt!.items).toEqual([
    { id: "note-alpha", path: "Brain/notes/alpha.md" },
  ]);
  // Outcome unknown - absent, never invented.
  expect(row.provenance!.outcome).toBeNull();
  expect(row.provenance!.timestamp_inverted).toBe(false);
});

test("events leave claims without a sample_id exactly as today", async () => {
  seedRegistry();
  writeSourcePage("session.md");
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  await call(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
    text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
    source: "[[Brain/notes/session.md]]",
  });
  const body = (await call(server, { operation: "events" })) as unknown as {
    events: ReadonlyArray<Record<string, unknown>>;
  };
  expect(body.events).toHaveLength(1);
  expect("provenance" in body.events[0]!).toBe(false);
  expect("sample_id" in body.events[0]!).toBe(false);
});

test("events hydrate a posted outcome row with its first-pass and evidence verdicts", async () => {
  seedRegistry();
  writeSourcePage("session.md");
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const receipt = emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "context_pack" },
    items: [{ id: "note-alpha", path: "Brain/notes/alpha.md", tokens: 40 }],
    finalText: "the final answer text",
  });
  const posted = emitContextPackOutcome(
    vault,
    { sampleId: receipt.id, firstPassSuccess: false, repairRequired: true },
    true,
  );
  expect(posted).not.toBeNull();
  await call(server, {
    operation: "state",
    claims: [{ subject: "Alice Mason", relation: "extends", object: "Project Atlas" }],
    text: "Alice Mason said the Atlas extension plan refines Project Atlas scope.",
    source: "[[Brain/notes/session.md]]",
    sample_id: receipt.id,
  });
  const body = (await call(server, { operation: "events" })) as unknown as {
    events: ReadonlyArray<{ provenance?: ClaimProvenanceRow }>;
  };
  const provenance = body.events[0]!.provenance!;
  expect(provenance.outcome).not.toBeNull();
  expect(provenance.outcome!.first_pass_success).toBe(false);
  expect(provenance.outcome!.evidence_verdict).toBe("unclaimed");
});

test("two claims sharing a sample_id carry per-event inversion flags", async () => {
  // H2 regression: the inversion flag compares EACH claim's own ts
  // against the claimed receipt's created_at. Resolving per sample_id
  // instead of per event let one page row's verdict overwrite the
  // other's in the per-id map, so with one claim stated before its
  // receipt and one after, both rows rendered the same flag - the
  // earlier claim's inversion disappeared. Resolution is per event now,
  // attached by page position; the page itself still renders in the
  // ledger's ts-ascending order, so the flag must follow each row's ts
  // whichever way the ledger was appended.
  const receiptAt = "2026-06-02T09:00:00.000Z";

  const pageInversionFlags = async (
    server: MCPServer,
  ): Promise<ReadonlyArray<{ ts: string; inverted: boolean }>> => {
    const body = (await call(server, { operation: "events" })) as unknown as {
      events: ReadonlyArray<{ ts: string; provenance?: ClaimProvenanceRow }>;
    };
    expect(body.events).toHaveLength(2);
    return body.events.map((event) => ({
      ts: event.ts,
      inverted: event.provenance?.timestamp_inverted === true,
    }));
  };

  // Order 1: the inverted claim appended first.
  writeSourcePage("a.md");
  const receipt = emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "context_pack", createdAt: receiptAt },
    items: [{ id: "note-a", path: "Brain/notes/a.md", tokens: 40 }],
    finalText: "the final answer text",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-02T08:00:00Z",
    agent: "claude",
    entity: "Entity Early",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/a.md]]",
    sample_id: receipt.id,
  });
  appendClaimEvent(vault, {
    ts: "2026-06-02T10:00:00Z",
    agent: "claude",
    entity: "Entity Late",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/a.md]]",
    sample_id: receipt.id,
  });
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  expect(await pageInversionFlags(server)).toEqual([
    { ts: "2026-06-02T08:00:00Z", inverted: true },
    { ts: "2026-06-02T10:00:00Z", inverted: false },
  ]);

  // Order 2: the inverted claim appended last, in a fresh ledger.
  const b = secondVault();
  try {
    mkdirSync(join(b.vault, "Brain", "notes"), { recursive: true });
    writeFileSync(join(b.vault, "Brain", "notes", "a.md"), "---\nkind: note\n---\n\na page\n");
    const receiptB = emitContextReceipt(b.vault, {
      options: { host: "mcp", trigger: "context_pack", createdAt: receiptAt },
      items: [{ id: "note-a", path: "Brain/notes/a.md", tokens: 40 }],
      finalText: "the final answer text",
    });
    appendClaimEvent(b.vault, {
      ts: "2026-06-02T10:00:00Z",
      agent: "claude",
      entity: "Entity Late",
      aspect: "employer",
      value: "Meta",
      source: "[[Brain/notes/a.md]]",
      sample_id: receiptB.id,
    });
    appendClaimEvent(b.vault, {
      ts: "2026-06-02T08:00:00Z",
      agent: "claude",
      entity: "Entity Early",
      aspect: "employer",
      value: "Google",
      source: "[[Brain/notes/a.md]]",
      sample_id: receiptB.id,
    });
    const serverB = new MCPServer({ vault: b.vault, configPath: b.configPath });
    await initialize(serverB);
    expect(await pageInversionFlags(serverB)).toEqual([
      { ts: "2026-06-02T08:00:00Z", inverted: true },
      { ts: "2026-06-02T10:00:00Z", inverted: false },
    ]);
  } finally {
    rmSync(b.configHome, { recursive: true, force: true });
  }
});

test("one receipt with an unparseable createdAt degrades per claim, not per page", async () => {
  // M4 regression: the continuity reader validates createdAt on append
  // only, so a hand-edited shard can carry a stamp no append would
  // accept. The events op must still answer ok with every row - the
  // sampled claim names an unreadable receipt and renders it unknown,
  // the unsampled claim renders byte-identically - instead of throwing
  // a plain internal error for the whole page.
  writeSourcePage("session.md");
  const receipt = emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "context_pack", createdAt: "2026-06-02T09:00:00.000Z" },
    items: [{ id: "note-alpha", path: "Brain/notes/alpha.md", tokens: 40 }],
    finalText: "the final answer text",
  });
  const shard = continuityLogPath(vault, receipt.createdAt.slice(0, 7));
  const text = readFileSync(shard, "utf8");
  writeFileSync(
    shard,
    text.replace(
      JSON.stringify(receipt),
      JSON.stringify({ ...receipt, createdAt: "2026-06-garbage" }),
    ),
  );
  appendClaimEvent(vault, {
    ts: "2026-06-02T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/session.md]]",
    sample_id: receipt.id,
  });
  appendClaimEvent(vault, {
    ts: "2026-06-03T10:00:00Z",
    agent: "claude",
    entity: "Bob Doe",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/session.md]]",
  });
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const body = (await call(server, { operation: "events" })) as unknown as {
    ok: boolean;
    events: ReadonlyArray<{
      entity: string;
      provenance?: ClaimProvenanceRow | null;
    }>;
  };
  expect(body.ok).toBe(true);
  expect(body.events).toHaveLength(2);
  const sampled = body.events.find((event) => event.entity === "alice mason")!;
  expect(sampled.provenance).toBeDefined();
  // Receipt unreadable: it renders unknown, never a failed read.
  expect(sampled.provenance!.receipt).toBeNull();
  const unsampled = body.events.find((event) => event.entity === "bob doe")!;
  expect("provenance" in unsampled).toBe(false);
});

// ----- provenance at the caller's reach (answer-trust repair M2/F3) -----

const RULE_RECEIPT_STAMP = "2026-06-02T09:00:00.000Z";

function emitClaimOnReceipt(receiptId: string): void {
  appendClaimEvent(vault, {
    ts: "2026-06-02T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/session.md]]",
    sample_id: receiptId,
  });
}

async function eventsProvenanceAt(
  reach: TransportReach,
): Promise<ReadonlyArray<ClaimProvenanceRow | undefined>> {
  const server = new MCPServer({ vault, configPath }, { reach });
  await initialize(server);
  const body = (await call(server, { operation: "events" })) as unknown as {
    events: ReadonlyArray<{ provenance?: ClaimProvenanceRow }>;
  };
  expect(body.events).toHaveLength(1);
  return body.events.map((event) => event.provenance);
}

test("a rule-only injection receipt answers provenance as an unknown id below local reach", async () => {
  writeSourcePage("session.md");
  const receipt = emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "session_inject", createdAt: RULE_RECEIPT_STAMP },
    items: [{ id: "standing-rules" }, { id: "scoped-rules" }],
    finalText: "constitution and scoped rules",
  });
  emitClaimOnReceipt(receipt.id);
  const [remoteProvenance] = await eventsProvenanceAt(TRANSPORT_REACH.remote);
  // The unknown-id answer: `brain_context_receipts show` refuses this
  // receipt below local reach and `list` leaves it out, so a claim's
  // provenance must not answer for it either - even a withheld-shaped
  // row would confirm the operator's rules were injected.
  expect(remoteProvenance!.receipt).toBeNull();
  expect(JSON.stringify(remoteProvenance)).not.toContain("standing-rules");
  const [localProvenance] = await eventsProvenanceAt(TRANSPORT_REACH.local);
  expect(localProvenance!.receipt).not.toBeNull();
  expect(localProvenance!.receipt!.items).toEqual([
    { id: "standing-rules" },
    { id: "scoped-rules" },
  ]);
});

test("a mixed receipt keeps its non-rule items and drops the rule items below local reach", async () => {
  writeSourcePage("session.md");
  writeSourcePage("alpha.md");
  const receipt = emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "session_inject", createdAt: RULE_RECEIPT_STAMP },
    items: [
      { id: "standing-rules" },
      { id: "note-alpha", path: "Brain/notes/alpha.md", tokens: 40 },
    ],
    finalText: "rules plus a note",
  });
  emitClaimOnReceipt(receipt.id);
  const [remoteProvenance] = await eventsProvenanceAt(TRANSPORT_REACH.remote);
  // Not rule-only, so the receipt stays known - shaped as the receipts
  // surface shapes it, with the rule items and nothing else removed.
  expect(remoteProvenance!.receipt).not.toBeNull();
  expect(remoteProvenance!.receipt!.items).toEqual([
    { id: "note-alpha", path: "Brain/notes/alpha.md" },
  ]);
  const [localProvenance] = await eventsProvenanceAt(TRANSPORT_REACH.local);
  expect(localProvenance!.receipt!.items).toEqual([
    { id: "standing-rules" },
    { id: "note-alpha", path: "Brain/notes/alpha.md" },
  ]);
});

test("a receipt item whose path is withheld at the caller's reach leaves the provenance", async () => {
  writeSourcePage("session.md");
  writeSourcePage("alpha.md");
  writeSourcePage("secret.md", `\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`);
  const receipt = emitContextReceipt(vault, {
    options: { host: "mcp", trigger: "context_pack", createdAt: RULE_RECEIPT_STAMP },
    items: [
      { id: "note-secret", path: "Brain/notes/secret.md" },
      { id: "note-alpha", path: "Brain/notes/alpha.md" },
    ],
    finalText: "two notes",
  });
  emitClaimOnReceipt(receipt.id);
  const [remoteProvenance] = await eventsProvenanceAt(TRANSPORT_REACH.remote);
  // The same visibility rule the event rows of this report are gated
  // by, applied to the items the join unfolds: a path the caller may
  // not read drops exactly like a row naming it would.
  expect(remoteProvenance!.receipt!.items).toEqual([
    { id: "note-alpha", path: "Brain/notes/alpha.md" },
  ]);
  expect(JSON.stringify(remoteProvenance)).not.toContain("secret");
  const [localProvenance] = await eventsProvenanceAt(TRANSPORT_REACH.local);
  expect(localProvenance!.receipt!.items).toEqual([
    { id: "note-secret", path: "Brain/notes/secret.md" },
    { id: "note-alpha", path: "Brain/notes/alpha.md" },
  ]);
});

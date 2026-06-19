/**
 * MCP Resources end-to-end tests.
 *
 * The resource surface is dispatched through the same JSON-RPC pipeline
 * as `tools/call`. We exercise:
 *   - `initialize` reports the `resources` capability
 *   - `resources/list` returns the two concrete URIs
 *   - `resources/templates/list` returns the three templates
 *   - `resources/read` succeeds for each shape and fails cleanly on
 *     unknown URIs / missing files / malformed slug-or-date arguments.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainActivePath, logPath, preferencePath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { regenerateActive } from "../../src/core/brain/active.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-res-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-res-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeServer(): MCPServer {
  return new MCPServer({ vault, configPath });
}

async function initialize(server: MCPServer): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "resources-test", version: "0" },
    },
  });
}

async function listResources(server: MCPServer): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "resources/list",
    params: {},
  });
}

async function listTemplates(server: MCPServer): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 3,
    method: "resources/templates/list",
    params: {},
  });
}

async function read(server: MCPServer, uri: string): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 4,
    method: "resources/read",
    params: { uri },
  });
}

describe("MCP resources — capabilities and discovery", () => {
  test("initialize reports the resources capability", async () => {
    const server = makeServer();
    const r = await initialize(server);
    expect(r.result.capabilities.resources).toEqual({
      listChanged: false,
      subscribe: false,
    });
  });

  test("resources/list returns the concrete URIs with metadata", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await listResources(server);
    const uris = r.result.resources.map((x: any) => x.uri).toSorted();
    expect(uris).toEqual(["osb://digest/latest", "osb://preferences/active", "osb://status"]);
    for (const desc of r.result.resources) {
      expect(desc.mimeType).toBe("text/markdown");
      expect(typeof desc.name).toBe("string");
      expect(typeof desc.description).toBe("string");
    }
  });

  test("resources/templates/list returns the templated URIs", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await listTemplates(server);
    const templates = r.result.resourceTemplates.map((t: any) => t.uriTemplate).toSorted();
    expect(templates).toEqual([
      "osb://backlinks/{id}",
      "osb://log/{date}",
      "osb://preference/{id}",
      "osb://topic/{slug}",
    ]);
  });
});

describe("MCP resources — read osb://preferences/active", () => {
  test("returns the active.md body", async () => {
    writePreference(vault, {
      slug: "rule-a",
      topic: "rule-a",
      principle: "Be tidy",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 5,
      violated_count: 0,
      last_evidence_at: "2026-05-09T00:00:00Z",
      confidence: "medium",
    });
    regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });

    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://preferences/active");
    expect(r.result.contents).toHaveLength(1);
    const c = r.result.contents[0];
    expect(c.uri).toBe("osb://preferences/active");
    expect(c.mimeType).toBe("text/markdown");
    expect(c.text).toContain("pref-rule-a");
    expect(c.text).toContain("Be tidy");
  });

  test("regenerates active.md on demand when missing", async () => {
    // Fresh vault with prefs but no dream → active.md does not exist
    // yet. The first read should produce it.
    writePreference(vault, {
      slug: "rule-b",
      topic: "rule-b",
      principle: "Stay calm",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-05-09T00:00:00Z",
      confidence: "low",
    });

    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://preferences/active");
    expect(r.result.contents[0].text).toContain("pref-rule-b");
  });
});

describe("MCP resources — read osb://digest/latest", () => {
  test("returns rendered digest markdown (empty window is non-empty markdown)", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://digest/latest");
    expect(r.result.contents[0].mimeType).toBe("text/markdown");
    expect(typeof r.result.contents[0].text).toBe("string");
    expect(r.result.contents[0].text.length).toBeGreaterThan(0);
  });
});

describe("MCP resources — read osb://preference/{id}", () => {
  test("returns the active pref body, accepting bare slug or prefixed id", async () => {
    writePreference(vault, {
      slug: "named-rule",
      topic: "named-rule",
      principle: "Body",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-09T00:00:00Z",
      confidence: "low",
    });
    const server = makeServer();
    await initialize(server);
    const slug = await read(server, "osb://preference/named-rule");
    const prefixed = await read(server, "osb://preference/pref-named-rule");
    expect(slug.result.contents[0].text).toContain("named-rule");
    expect(prefixed.result.contents[0].text).toBe(slug.result.contents[0].text);
  });

  test("falls back to retired/<id> when active is gone", async () => {
    // Drop a retired stub directly.
    const retiredDir = join(vault, "Brain", "retired");
    writeFileSync(
      join(retiredDir, "ret-old-thing.md"),
      `---
kind: brain-retired
id: ret-old-thing
_status: retired
retired_at: 2026-05-10T00:00:00Z
retired_reason: rebutted
retired_by: "[[Brain/log/2026-05-10]]"
created_at: 2026-05-01T00:00:00Z
tags: [brain, brain/retired]
topic: old-thing
principle: A stale rule
_evidenced_by: []
_applied_count: 0
_violated_count: 0
_last_evidence_at: null
_confidence: low
pinned: false
---

Body.
`,
      "utf8",
    );

    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://preference/old-thing");
    expect(r.result.contents[0].text).toContain("retired_reason: rebutted");
  });

  test("missing id raises a tool error", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://preference/does-not-exist");
    expect(r.error).toBeDefined();
    expect(r.error.message).toContain("no preference or retired entry");
  });

  test("malformed slug raises INVALID_PARAMS", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://preference/..");
    expect(r.error).toBeDefined();
    // validateSlug throws "slug must not contain '..' traversal".
    expect(r.error.message.toLowerCase()).toMatch(/slug|invalid|traversal/);
  });
});

describe("MCP resources — read osb://topic/{slug}", () => {
  test("returns a markdown summary of signals + current preference", async () => {
    writeSignal(vault, {
      topic: "tidy",
      signal: "negative",
      agent: "claude",
      principle: "Be tidy",
      created_at: "2026-05-14T10:00:00Z",
      date: "2026-05-14",
      slug: "first",
      scope: "writing",
    });
    writePreference(vault, {
      slug: "tidy",
      topic: "tidy",
      principle: "Be tidy",
      created_at: "2026-05-14T11:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-2026-05-14-first]]"],
    });
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://topic/tidy");
    const text = r.result.contents[0].text as string;
    expect(text).toContain("# Brain topic: tidy");
    expect(text).toContain("pref-tidy");
    expect(text).toContain("sig-2026-05-14-first");
    // The steelman section is always present; here a negative signal
    // exists, so it grounds the objection rather than the unconfirmed
    // status.
    expect(text).toContain("## Strongest objection");
    expect(text).toContain("sig-2026-05-14-first");
    expect(text).toContain("contested");
  });
});

describe("MCP resources — read osb://log/{date}", () => {
  test("returns the log file body when present", async () => {
    const path = logPath(vault, "2026-05-14");
    writeFileSync(path, "# Brain Log — 2026-05-14\n\nhello\n", "utf8");

    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://log/2026-05-14");
    expect(r.result.contents[0].text).toContain("hello");
  });

  test("missing date raises a tool error", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://log/2026-05-14");
    expect(r.error).toBeDefined();
    expect(r.error.message).toContain("no log file for date");
  });

  test("malformed date raises INVALID_PARAMS", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://log/not-a-date");
    expect(r.error).toBeDefined();
  });
});

describe("MCP resources — read osb://status", () => {
  test("returns markdown with counts and activity sections", async () => {
    writePreference(vault, {
      slug: "alpha",
      topic: "alpha",
      principle: "Rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 1,
    });

    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://status");
    const text = r.result.contents[0].text as string;
    expect(text).toContain("# Brain status");
    expect(text).toContain("## Counts");
    expect(text).toContain("preferences: 1");
    expect(text).toContain("confirmed: 1");
    expect(text).toContain("## Activity");
  });
});

describe("MCP resources — read osb://backlinks/{id}", () => {
  test("renders count + grouped sources for a referenced pref", async () => {
    writePreference(vault, {
      slug: "target",
      topic: "t",
      principle: "Target rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 1,
    });
    writePreference(vault, {
      slug: "source",
      topic: "s",
      principle: "Source rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: ["[[pref-target]]"],
      applied_count: 1,
    });

    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://backlinks/pref-target");
    const text = r.result.contents[0].text as string;
    expect(text).toContain("# Backlinks to `pref-target`");
    expect(text).toContain("Total inbound references:");
    expect(text).toContain("pref-source");
  });

  test("renders zero-state message for targets with no backlinks", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://backlinks/pref-nothing");
    const text = r.result.contents[0].text as string;
    expect(text).toContain("# Backlinks to `pref-nothing`");
    expect(text).toContain("Total inbound references: 0");
    expect(text).toContain("_No inbound references found._");
  });
});

describe("MCP resources — unknown URI", () => {
  test("returns INVALID_PARAMS for an unsupported scheme", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "http://example.com/x");
    expect(r.error).toBeDefined();
    expect(r.error.message).toContain("unsupported resource uri");
  });

  test("returns INVALID_PARAMS for an unrecognised osb:// shape", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await read(server, "osb://nonsense/x");
    expect(r.error).toBeDefined();
  });

  test("rejects non-string uri argument", async () => {
    const server = makeServer();
    await initialize(server);
    const r = await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 5,
      method: "resources/read",
      params: { uri: 42 },
    });
    expect(r!.error).toBeDefined();
  });

  // Helper-only branch — silence unused warning.
  void brainActivePath;
  void preferencePath;
});

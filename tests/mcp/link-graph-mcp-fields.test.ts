/**
 * MCP integration coverage for the v0.10.17 link-graph tools.
 * Verifies registration in the full tool scope, JSON-RPC round-trip
 * shape, and INVALID_PARAMS rejection of malformed input.
 *
 * Tools covered (extended as new v0.10.17 consumers ship):
 *   - brain_unlinked_mentions
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-link-graph-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-link-graph-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
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
      clientInfo: { name: "link-graph-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
  id = 9,
): Promise<{
  result?: { content: ReadonlyArray<{ type: string; text: string }> };
  error?: { code: number; message: string };
}> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }) as Promise<{
    result?: { content: ReadonlyArray<{ type: string; text: string }> };
    error?: { code: number; message: string };
  }>;
}

const DERIVED_KEYS = new Set([
  "status",
  "applied_count",
  "violated_count",
  "last_evidence_at",
  "confidence",
  "confidence_value",
  "evidenced_by",
  "contradicted_by",
  "lifecycle",
  "confirmed_at",
]);

function writePref(slug: string, frontmatter: Record<string, string>, body = ""): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    const key = DERIVED_KEYS.has(k) ? `_${k}` : k;
    lines.push(`${key}: ${v}`);
  }
  lines.push("---", "", body);
  writeFileSync(join(vault, "Brain", "preferences", `${slug}.md`), lines.join("\n"));
}

describe("brain_unlinked_mentions registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_unlinked_mentions")).toBeDefined();
  });

  test("NOT in the writer-only scope", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_unlinked_mentions")).toBeUndefined();
  });
});

describe("brain_moc_audit registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_moc_audit")).toBeDefined();
  });

  test("NOT in the writer-only scope", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_moc_audit")).toBeUndefined();
  });
});

describe("brain_moc_audit round trip", () => {
  test("returns bucketed envelope for a qualifying hub", async () => {
    writePref("pref-a", {
      kind: "preference",
      topic: "a",
      status: "confirmed",
      principle: "p",
    });
    writePref("pref-b", {
      kind: "preference",
      topic: "b",
      status: "confirmed",
      principle: "p",
    });
    writePref("pref-c", {
      kind: "preference",
      topic: "c",
      status: "confirmed",
      principle: "p",
    });
    writePref("pref-d", {
      kind: "preference",
      topic: "d",
      status: "confirmed",
      principle: "p",
    });
    writePref("pref-e", {
      kind: "preference",
      topic: "e",
      status: "confirmed",
      principle: "p",
    });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]] [[pref-missing]]",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_moc_audit", { id: "pref-hub" });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["hub_id"]).toBe("pref-hub");
    expect(out["outbound_count"]).toBe(6);
    expect(
      (out["candidate_missing"] as Array<{ id: string }>).some((c) => c.id === "pref-missing"),
    ).toBe(true);
  });

  test("non-MOC hub returns INVALID_PARAMS", async () => {
    writePref(
      "pref-thin",
      { kind: "preference", topic: "t", status: "confirmed", principle: "p" },
      "Just [[pref-a]] and [[pref-b]] here.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_moc_audit", { id: "pref-thin" });
    expect(r.error?.code).toBe(-32602);
  });
});

describe("brain_analytics view=concept_synthesis registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_analytics")).toBeDefined();
  });

  test("NOT in the writer-only scope", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_analytics")).toBeUndefined();
  });
});

describe("brain_analytics view=concept_synthesis round trip", () => {
  test("returns envelope with linkers", async () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subj",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I see [[pref-tgt]] here.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_analytics", {
      view: "concept_synthesis",
      id: "pref-tgt",
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["target_id"]).toBe("pref-tgt");
    expect(out["target_title"]).toBe("Subj");
    expect(out["linkers"].length).toBe(1);
    expect(out["unlinked_mentions"]).toEqual([]);
  });

  test("include_unlinked=true populates unlinked_mentions", async () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    writePref(
      "pref-prose",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "Subject Line shows up here.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_analytics", {
      view: "concept_synthesis",
      id: "pref-tgt",
      include_unlinked: true,
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["unlinked_mentions"].length).toBe(1);
  });

  test("rejects invalid concept synthesis arguments with INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    for (const args of [{ id: "" }, { id: "pref-x", include_unlinked: "yes" }]) {
      const r = await callTool(server, "brain_analytics", { view: "concept_synthesis", ...args });
      expect(r.error?.code).toBe(-32602);
    }
  });
});

describe("brain_unlinked_mentions round trip", () => {
  test("returns mention list for matching prose", async () => {
    writePref("pref-target", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I think about Subject Line often.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", {
      id: "pref-target",
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["target_id"]).toBe("pref-target");
    expect(Array.isArray(out["mentions"])).toBe(true);
    expect(out["mentions"].length).toBe(1);
    expect(out["mentions"][0]["source"]).toBe("pref-linker");
    expect(out["mentions"][0]["term"]).toBe("Subject Line");
  });

  test("empty vault returns empty mentions array", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", {
      id: "pref-missing",
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["mentions"]).toEqual([]);
  });

  test("rejects invalid unlinked mention arguments with INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    for (const args of [
      { id: "" },
      { id: "pref-foo", limit: -1 },
      { id: "pref-foo", limit: "many" },
    ]) {
      const r = await callTool(server, "brain_unlinked_mentions", args);
      expect(r.error?.code).toBe(-32602);
    }
  });
});

describe("brain_unlinked_mentions at remote reach", () => {
  const PREF = { kind: "preference", status: "confirmed", principle: "p" };

  async function mentionsAt(reach: "local" | "remote", id: string): Promise<unknown[]> {
    const server = new MCPServer({ vault, configPath }, { reach });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", { id });
    return JSON.parse(r.result!.content[0]!.text)["mentions"] as unknown[];
  }

  test("a reserved source is dropped and a reserved target answers as absent", async () => {
    writePref("pref-target", { ...PREF, topic: "t", title: "Subject Line" });
    writePref("pref-open", { ...PREF, topic: "o" }, "Open note on Subject Line.");
    writePref(
      "pref-zzsecret",
      { ...PREF, topic: "s", visibility: "[private]" },
      "zzsecret prose about Subject Line.",
    );
    writePref("pref-zzsecrettarget", {
      ...PREF,
      topic: "st",
      title: "Hidden Title",
      visibility: "[private]",
    });
    writePref("pref-mentioner", { ...PREF, topic: "m" }, "Talks about Hidden Title.");

    expect(JSON.stringify(await mentionsAt("local", "pref-target"))).toContain("zzsecret");
    const remote = await mentionsAt("remote", "pref-target");
    expect(JSON.stringify(remote)).not.toContain("zzsecret");
    expect(remote).toHaveLength(1);

    expect(await mentionsAt("local", "pref-zzsecrettarget")).toHaveLength(1);
    expect(await mentionsAt("remote", "pref-zzsecrettarget")).toEqual([]);
  });
});

describe("brain_unlinked_mentions cursor pagination", () => {
  test("the input schema declares a described cursor property", () => {
    const tool = buildToolTable("full").find((t) => t.name === "brain_unlinked_mentions")!;
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number; description?: string }>;
    };
    expect(schema.properties["cursor"]).toMatchObject({ type: "string", maxLength: 32 });
    expect(schema.properties["cursor"]?.description).toBeTruthy();
  });

  test("each page's next_cursor leads to the next and the pages reassemble every mention", async () => {
    writePref("pref-target", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Walk Target",
    });
    for (const slug of ["pref-w1", "pref-w2", "pref-w3"]) {
      writePref(
        slug,
        { kind: "preference", topic: "w", status: "confirmed", principle: "p" },
        "Still thinking about Walk Target here.",
      );
    }
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const total = 3;
    const limit = 2;
    // A server that never ends the walk would hang an unbounded loop;
    // ceil(total / limit) + 1 is one past the walk's own page count.
    const maxSteps = Math.ceil(total / limit) + 1;
    const sources: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < maxSteps; step++) {
      const r = await callTool(server, "brain_unlinked_mentions", {
        id: "pref-target",
        limit,
        ...(cursor !== null ? { cursor } : {}),
      });
      const out = JSON.parse(r.result!.content[0]!.text);
      expect(out["total"]).toBe(total);
      // Guard the walk protocol: an ignored cursor would loop forever.
      const next = out["next_cursor"];
      expect(next === null || typeof next === "string").toBe(true);
      sources.push(...out["mentions"].map((m: { source: string }) => m["source"]));
      cursor = next;
      if (cursor === null) break;
    }
    // The walk ended because the server exhausted the set, not because
    // the step bound fired.
    expect(cursor).toBeNull();
    expect(sources.toSorted()).toEqual(["pref-w1", "pref-w2", "pref-w3"]);
    expect(new Set(sources).size).toBe(3);
  });

  test("a malformed cursor is refused as invalid params", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", {
      id: "pref-x",
      cursor: "!!!",
    });
    expect((r as { error?: { code: number } }).error?.code).toBe(-32602);
  });

  test("a page fetch's scan stops at the page's lookahead bound and the walk still reassembles every mention", async () => {
    writePref("pref-bound-target", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Bound Target",
    });
    // Ten sources carrying two mentions each: the true filtered set (20)
    // sits far past one page's reach, so the answer to page 1 tells
    // whether the scan walked the whole set (total 20) or stopped at the
    // page's own reach (the offset + limit + 1 lookahead bound).
    for (let i = 1; i <= 10; i++) {
      writePref(
        `pref-bound-${i}`,
        { kind: "preference", topic: "b", status: "confirmed", principle: "p" },
        "Bound Target said once.\nBound Target said twice.",
      );
    }
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const first = JSON.parse(
      (
        await callTool(server, "brain_unlinked_mentions", {
          id: "pref-bound-target",
          limit: 2,
        })
      ).result!.content[0]!.text,
    );
    // The scan may stop three mentions in; `total` reports that bound
    // instead of pretending page 1 paid for the whole walk.
    expect(first["total"]).toBe(3);
    expect(first["mentions"]).toHaveLength(2);
    expect(first["next_cursor"]).not.toBeNull();

    // The bound buys the page, never truncation: walking still
    // reassembles all twenty mentions, and the exhausted walk's total is
    // exact. The residual walk is bounded by the whole walk's own page
    // arithmetic so a never-null cursor fails fast instead of hanging.
    const totalMentions = 20;
    const walkLimit = 2;
    const maxSteps = Math.ceil(totalMentions / walkLimit) + 1;
    const sources: string[] = first["mentions"].map(
      (m: { source: string }) => m["source"] as string,
    );
    let cursor = first["next_cursor"] as string | null;
    let lastTotal = first["total"];
    for (let step = 0; step < maxSteps && cursor !== null; step++) {
      const out = JSON.parse(
        (
          await callTool(server, "brain_unlinked_mentions", {
            id: "pref-bound-target",
            limit: walkLimit,
            cursor,
          })
        ).result!.content[0]!.text,
      );
      sources.push(...out["mentions"].map((m: { source: string }) => m["source"]));
      lastTotal = out["total"];
      cursor = out["next_cursor"];
    }
    expect(cursor).toBeNull();
    expect(lastTotal).toBe(20);
    expect(sources).toHaveLength(20);
    expect(new Set(sources).size).toBe(10);
  });
});

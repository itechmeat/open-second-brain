import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-decision-tool-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "decision-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_decision", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("brain_decision tool", () => {
  test("registered in the full tool table", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_decision")).toBeDefined();
  });

  test("records a decision and reads it back with its outcome", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const recorded = payload(
      await call(server, {
        action: "record",
        title: "Adopt Bun runtime",
        chosen: "Bun",
        assumption: "Bun stays compatible",
        review_date: "2026-12-01",
      }),
    );
    expect(recorded["id"]).toBe("decision-adopt-bun-runtime");
    expect(recorded["obligation_created"]).toBe(true);

    const outcome = payload(
      await call(server, { action: "outcome", slug: "adopt-bun-runtime", outcome: "held up" }),
    );
    expect(outcome["outcome"]).toBe("held up");

    const shown = payload(await call(server, { action: "show", slug: "adopt-bun-runtime" }));
    expect(shown["outcome"]).toBe("held up");
  });

  test("similar surfaces a prior decision", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Adopt Bun runtime for CLI",
      chosen: "Bun",
      assumption: "x",
      review_date: "2026-12-01",
    });
    const similar = payload(
      await call(server, {
        action: "similar",
        title: "Adopt Bun runtime for server",
        chosen: "Bun",
      }),
    );
    expect((similar["similar"] as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  test("show surfaces commitment when set and omits it when unset (B3)", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Committed choice",
      chosen: "X",
      assumption: "a",
      review_date: "2026-12-01",
      commitment: "decided",
    });
    await call(server, {
      action: "record",
      title: "Loose choice",
      chosen: "Y",
      assumption: "b",
      review_date: "2026-12-01",
    });
    const withCommitment = payload(
      await call(server, { action: "show", slug: "committed-choice" }),
    );
    expect(withCommitment["commitment"]).toBe("decided");
    const without = payload(await call(server, { action: "show", slug: "loose-choice" }));
    expect("commitment" in without).toBe(false);
  });

  test("rate, list rated, and compare (B2)", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Option A",
      chosen: "A",
      assumption: "x",
      review_date: "2026-12-01",
      rating: 4,
    });
    await call(server, {
      action: "record",
      title: "Option B",
      chosen: "B",
      assumption: "y",
      review_date: "2026-12-01",
    });
    const rated = payload(await call(server, { action: "rate", slug: "option-b", rating: 5 }));
    expect(rated["rating"]).toBe(5);

    const list = payload(await call(server, { action: "list", rated: true }));
    const decisions = list["decisions"] as Array<{ rating: number }>;
    expect(decisions.map((d) => d.rating)).toEqual([5, 4]);

    const compared = payload(
      await call(server, { action: "compare", slugs: ["option-a", "option-b"] }),
    );
    expect((compared["decisions"] as unknown[]).length).toBe(2);
  });

  test("out-of-range rating returns an error", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Option C",
      chosen: "C",
      assumption: "z",
      review_date: "2026-12-01",
    });
    const res = await call(server, { action: "rate", slug: "option-c", rating: 9 });
    expect(res.error).toBeDefined();
  });

  test("history reads decision-change receipts (B4)", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    // A supersede/tombstone emits a decision-change receipt via the hook.
    await call(server, {
      action: "record",
      title: "Old choice",
      chosen: "old",
      assumption: "x",
      review_date: "2026-12-01",
    });
    await call(server, {
      action: "record",
      title: "New choice",
      chosen: "new",
      assumption: "y",
      review_date: "2026-12-01",
    });
    const supersede = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 20,
      method: "tools/call",
      params: {
        name: "brain_lifecycle",
        arguments: {
          action: "supersede",
          predecessor: "Brain/decisions/decision-old-choice.md",
          successor: "decision-new-choice",
        },
      },
    })) as { result?: unknown };
    expect(supersede.result).toBeDefined();

    const history = payload(await call(server, { action: "history" }));
    // Two record creations each emit a decision-record receipt (B4), plus
    // the supersede receipt from the lifecycle hook.
    expect(history["total"]).toBe(3);
    const receipts = history["receipts"] as Array<{ reason_code: string }>;
    const codes = receipts.map((r) => r.reason_code);
    expect(codes.filter((c) => c === "decision-record").length).toBe(2);
    expect(codes).toContain("supersede");
  });

  test("recall is disabled (byte-identical) when unconfigured (B5)", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Adopt Bun runtime",
      chosen: "Bun",
      assumption: "x",
      review_date: "2026-12-01",
      rating: 5,
    });
    const res = payload(await call(server, { action: "recall", prompt: "adopt Bun runtime" }));
    expect(res["enabled"]).toBe(false);
    expect(res["surfaced"]).toBeNull();
    expect(res["text"]).toBe("");
  });

  test("recall resurfaces a rated decision when configured (B5)", async () => {
    process.env["OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION"] = "3";
    try {
      const server = new MCPServer({ vault, configPath: null });
      await initialize(server);
      await call(server, {
        action: "record",
        title: "Adopt Bun runtime for the CLI",
        chosen: "Bun",
        assumption: "x",
        review_date: "2026-12-01",
        rating: 5,
      });
      const res = payload(
        await call(server, { action: "recall", prompt: "should we adopt Bun runtime for the API" }),
      );
      expect(res["enabled"]).toBe(true);
      expect((res["surfaced"] as { slug: string }).slug).toBe("adopt-bun-runtime-for-the-cli");
      expect(res["text"]).toContain("Recalled decision");
    } finally {
      delete process.env["OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION"];
    }
  });

  test("malformed input returns an error result", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const res = await call(server, {
      action: "record",
      title: "x",
      chosen: "y",
      assumption: "z",
      review_date: "not-a-date",
    });
    expect(res.error).toBeDefined();
  });
});

describe("brain_decision open-decision actions", () => {
  test("open parks a question, list_open and show_open read it, resolve mints the page", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const opened = payload(
      await call(server, {
        action: "open",
        title: "Which HTTP client for ingest",
        question: "Which HTTP client should the ingest lane adopt?",
        options: ["bun fetch", "undici"],
        context: "Needs pooling.",
      }),
    );
    expect(opened["id"]).toBe("open-which-http-client-for-ingest");
    expect(opened["status"]).toBe("open");

    const listed = payload(await call(server, { action: "list_open" }));
    expect((listed["open_decisions"] as unknown[]).length).toBe(1);
    expect(listed["unreadable"]).toEqual([]);

    const shown = payload(await call(server, { action: "show_open", id: opened["id"] }));
    expect(shown["question"]).toBe("Which HTTP client should the ingest lane adopt?");
    expect(shown["options"]).toEqual(["bun fetch", "undici"]);

    const resolved = payload(
      await call(server, { action: "resolve", id: opened["id"], choice: "bun fetch" }),
    );
    expect(resolved["decision"]).toBe("decision-which-http-client-for-ingest");

    // The minted page is a real decision page, readable via `show`.
    const page = payload(
      await call(server, { action: "show", slug: "which-http-client-for-ingest" }),
    );
    expect(page["chosen"]).toBe("bun fetch");

    // The open record is terminal now: the open filter shows nothing,
    // and resolving again refuses.
    const after = payload(await call(server, { action: "list_open", status: "open" }));
    expect(after["open_decisions"]).toEqual([]);
    const again = await call(server, {
      action: "resolve",
      id: opened["id"],
      choice: "undici",
    });
    expect(again.error).toBeDefined();
  });

  test("list_open partitions by status and names unreadable records", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const openRec = payload(
      await call(server, {
        action: "open",
        title: "Keep the legacy importer",
        question: "Do we keep the legacy importer?",
        options: ["keep", "drop"],
      }),
    );
    const discardRec = payload(
      await call(server, {
        action: "open",
        title: "Retry budget for ingest",
        question: "Which retry budget for ingest?",
        options: ["3", "5"],
      }),
    );
    payload(await call(server, { action: "discard", id: discardRec["id"], reason: "superseded" }));

    const openList = payload(await call(server, { action: "list_open", status: "open" }));
    expect((openList["open_decisions"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      openRec["id"] as string,
    ]);
    const discarded = payload(await call(server, { action: "list_open", status: "discarded" }));
    expect((discarded["open_decisions"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      discardRec["id"] as string,
    ]);

    // A hand-edited status is confined to its record: named, not fatal,
    // and it never hides the readable sibling.
    const path = join(vault, "Brain", "decisions", `${openRec["id"] as string}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace("status: open", "status: gone"), "utf8");
    const broken = payload(await call(server, { action: "list_open" }));
    expect((broken["open_decisions"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      discardRec["id"] as string,
    ]);
    expect((broken["unreadable"] as unknown[]).length).toBe(1);
  });

  test("resolving a choice outside the enumerated options refuses", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const opened = payload(
      await call(server, {
        action: "open",
        title: "Pick a queue",
        question: "Which queue backs the worker?",
        options: ["postgres", "rabbit"],
      }),
    );
    const res = await call(server, {
      action: "resolve",
      id: opened["id"],
      choice: "kafka",
    });
    expect(res.error).toBeDefined();
  });

  test("no new tool was added: the open actions ride the existing brain_decision tool", async () => {
    const { buildToolTable } = await import("../../src/mcp/tools.ts");
    const table = buildToolTable("full");
    expect(table.find((t) => t.name === "brain_decision")).toBeDefined();
    const action = (
      table.find((t) => t.name === "brain_decision")!.inputSchema as {
        properties: { action: { enum: string[] } };
      }
    ).properties.action.enum;
    for (const wanted of ["open", "list_open", "show_open", "resolve", "discard"]) {
      expect(action).toContain(wanted);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-pay-test-"));
  vault = join(tmp, "vault");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initialize(server: MCPServer) {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(server: MCPServer, name: string, args: Record<string, unknown> = {}) {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  }) as any;
}

describe("payment_memory_init", () => {
  test("creates the layout, policy, and reports the resolved agent", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = await call(server, "payment_memory_init");
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.policy_path).toBe("AI Wiki/policies/spending.md");
    expect(s.policy_status).toBe("created");
    expect(s.created).toContain("AI Wiki/policies");
    for (const sub of ["policies", "payments", "assets", "drafts", "reports"]) {
      expect(existsSync(join(vault, "AI Wiki", sub))).toBe(true);
    }
  });

  test("idempotent re-run skips policy", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_memory_init");
    expect(r.result.structuredContent.policy_status).toBe("skipped");
  });

  test("overwrite=true rewrites the policy", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_memory_init", { overwrite: true });
    expect(r.result.structuredContent.policy_status).toBe("overwritten");
  });
});

describe("payment_receipt_append", () => {
  test("writes a receipt and redacts secrets in raw_output", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_receipt_append", {
      agent: "hermes-vps-agent",
      service: "paysponge/fal",
      status: "success",
      reason: "Generate one original blog header image",
      actual_amount: "0.05",
      currency: "USDC",
      result_ref: "https://fal-cdn.example/img.png",
      result_note: "AI Wiki/assets/blog-header.md",
      raw_output: 'Authorization: Bearer SECRET\n{"api_key": "sk_live_abc"}',
      date: "2026-05-10",
      time: "17:20",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.path.startsWith("AI Wiki/payments/2026-05-10/")).toBe(true);
    expect(s.date).toBe("2026-05-10");
    expect(s.created).toBe("2026-05-10T17:20:00Z");
    const text = readFileSync(join(vault, s.path), "utf8");
    expect(text).toContain("***REDACTED***");
    expect(text).not.toContain("sk_live_abc");
    expect(text).not.toContain("Bearer SECRET");
  });

  test("missing required arg returns INVALID_PARAMS error", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_receipt_append", {
      service: "x/y",
      status: "success",
      // reason missing
    });
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toContain("reason");
  });

  test("overwrite=false on duplicate yields tool-level error", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const args = {
      agent: "h",
      service: "x/y",
      status: "success",
      reason: "dup",
      slug: "dup-1",
      date: "2026-05-10",
      time: "00:00",
    };
    const first = await call(server, "payment_receipt_append", args);
    expect(first.result.isError).toBe(false);
    const second = await call(server, "payment_receipt_append", args);
    expect(second.result.isError).toBe(true);
    expect((second.result.content[0] as { text: string }).text).toContain("already exists");
  });
});

describe("asset_capture", () => {
  test("writes an asset note linked to its source receipt", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "asset_capture", {
      title: "Blog Header: Pay Memory",
      service: "paysponge/fal",
      result_url: "https://fal-cdn.example/img.png",
      source_receipt: "AI Wiki/payments/2026-05-10/fal-blog.md",
      prompt: "A recursive technical illustration",
      used_in: "AI Wiki/drafts/blog-post.md",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    const text = readFileSync(join(vault, s.path), "utf8");
    expect(text).toContain("# Blog Header: Pay Memory");
    expect(text).toContain('source_receipt: "[[AI Wiki/payments/2026-05-10/fal-blog]]"');
    expect(text).toContain("> A recursive technical illustration");
  });
});

describe("payment_report_generate", () => {
  test("aggregates receipts and reports receipts_used", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    for (const slug of ["fal-1", "alpha-1"]) {
      await call(server, "payment_receipt_append", {
        agent: "h",
        service: slug.startsWith("fal") ? "paysponge/fal" : "alpha/translate",
        status: "success",
        reason: `reason-${slug}`,
        actual_amount: "0.03",
        currency: "USDC",
        slug,
        date: "2026-05-10",
        time: "17:20",
      });
    }
    const r = await call(server, "payment_report_generate", {
      date: "2026-05-10",
      title: "Demo Report",
      task: "test task",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.receipts_used).toBe(2);
    const text = readFileSync(join(vault, s.path), "utf8");
    expect(text).toContain("### paysponge/fal");
    expect(text).toContain("### alpha/translate");
  });

  test("rejects bad date format with tool-level error", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_report_generate", { date: "2026.05.10" });
    expect(r.result.isError).toBe(true);
    expect((r.result.content[0] as { text: string }).text).toContain("YYYY-MM-DD");
  });
});

describe("payment_policy_check", () => {
  test("fail-open when policy.json absent", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_policy_check", { service: "x/y" });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.has_policy).toBe(false);
    expect(s.allowed).toBe(true);
    expect(s.status).toBe("allowed");
  });

  test("denies non-allowlisted service", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(vault, "AI Wiki", "policies", "spending.json"),
      JSON.stringify({ allowed_services: ["paysponge/fal"] }),
      "utf8",
    );
    const r = await call(server, "payment_policy_check", { service: "alpha/x" });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.allowed).toBe(false);
    expect(s.rule).toBe("allowed_services");
  });

  test("expected_amount accepts numeric string", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_policy_check", {
      service: "x/y",
      expected_amount: "0.05",
    });
    expect(r.result.isError).toBe(false);
  });

  test("rejects non-numeric expected_amount", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_policy_check", {
      service: "x/y",
      expected_amount: "abc",
    });
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32602);
  });
});

describe("approval workflow MCP tools", () => {
  test("payment_request_approval creates a pending artifact", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    const r = await call(server, "payment_request_approval", {
      service: "paysponge/fal",
      reason: "demo",
      expected_amount: "0.05",
      currency: "USDC",
      slug: "mcp-1",
    });
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.id).toBe("mcp-1");
    expect(s.status).toBe("pending");
    expect(s.path).toBe("AI Wiki/payments/_pending/mcp-1.md");
  });

  test("payment_request_status surfaces metadata", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    await call(server, "payment_request_approval", {
      service: "x/y",
      reason: "demo",
      slug: "mcp-2",
    });
    const r = await call(server, "payment_request_status", { id: "mcp-2" });
    const s = r.result.structuredContent;
    expect(s.status).toBe("pending");
    expect(s.service).toBe("x/y");
    expect(s.reason).toBe("demo");
  });

  test("payment_request_consume requires approval first (tool-level error)", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    await call(server, "payment_memory_init");
    await call(server, "payment_request_approval", {
      service: "x/y",
      reason: "demo",
      slug: "mcp-3",
    });
    const r = await call(server, "payment_request_consume", {
      id: "mcp-3",
      receipt: "AI Wiki/payments/2026-05-10/x.md",
    });
    expect(r.result.isError).toBe(true);
    expect((r.result.content[0] as { text: string }).text).toContain("cannot transition");
  });
});

describe("instructions include the Pay Memory paragraph", () => {
  test("initialize.instructions documents every Pay Memory tool", async () => {
    const server = new MCPServer({ vault });
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } },
    })) as any;
    const text = r.result.instructions as string;
    for (const name of [
      "payment_memory_init",
      "payment_policy_check",
      "payment_request_approval",
      "payment_request_status",
      "payment_request_consume",
      "payment_receipt_append",
      "asset_capture",
      "payment_report_generate",
    ]) {
      expect(text).toContain(name);
    }
  });
});

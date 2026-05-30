import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";
import { runCli } from "../helpers/run-cli.ts";

describe("MCP runtime capability window", () => {
  test("runtime deny withholds a tool and reports the reason", async () => {
    const server = new MCPServer(
      { vault: "/tmp/o2b-runtime-capability-test" },
      { capabilityWindow: { disabledTools: ["second_brain_query"] } },
    );

    const listResponse = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "tools/list",
    })) as any;
    const names = (listResponse.result.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );

    expect(names).toContain("second_brain_capabilities");
    expect(names).not.toContain("second_brain_query");

    const reportResponse = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: "second_brain_capabilities", arguments: {} },
    })) as any;
    const report = reportResponse.result.structuredContent;

    expect(report.scope).toBe("full");
    expect(
      report.available.some((tool: any) => tool.name === "second_brain_status"),
    ).toBe(true);
    expect(report.withheld).toContainEqual({
      name: "second_brain_query",
      reason: "disabled by runtime capability window",
    });
  });

  test("runtime allow list cannot widen writer scope", async () => {
    const server = new MCPServer(
      { vault: "/tmp/o2b-runtime-capability-test" },
      {
        scope: "writer",
        capabilityWindow: {
          allowedTools: ["second_brain_status", "brain_feedback"],
        },
      },
    );

    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "tools/list",
    })) as any;
    const names = (response.result.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );

    expect(names).toContain("brain_feedback");
    expect(names).not.toContain("second_brain_status");
  });

  test("mcp probe json emits capability report", async () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-runtime-capability-vault-"));
    try {
      const result = await runCli(
        [
          "mcp",
          "--vault",
          vault,
          "--probe",
          "--json",
          "--disable-tool",
          "second_brain_query",
        ],
        { env: { OPEN_SECOND_BRAIN_CONFIG: "" } },
      );

      expect(result.returncode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.server_name).toBe("open-second-brain");
      expect(parsed.capabilities.withheld).toContainEqual({
        name: "second_brain_query",
        reason: "disabled by runtime capability window",
      });
      expect(
        parsed.capabilities.available.some(
          (tool: any) => tool.name === "second_brain_status",
        ),
      ).toBe(true);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

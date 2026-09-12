import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { WITHHELD_BLOCK_HEADING } from "../../src/mcp/instruction-segments.ts";
import { runCli } from "../helpers/run-cli.ts";

/** Any path: nothing in these tests reads the vault. */
const VAULT = "/tmp/o2b-runtime-capability-test";

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
    const names = (listResponse.result.tools as Array<{ name: string }>).map((tool) => tool.name);

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
    expect(report.available.some((tool: any) => tool.name === "second_brain_status")).toBe(true);
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
    const names = (response.result.tools as Array<{ name: string }>).map((tool) => tool.name);

    expect(names).toContain("brain_feedback");
    expect(names).not.toContain("second_brain_status");
  });

  test("mcp probe json emits capability report", async () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-runtime-capability-vault-"));
    try {
      const result = await runCli(
        ["mcp", "--vault", vault, "--probe", "--json", "--disable-tool", "second_brain_query"],
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
        parsed.capabilities.available.some((tool: any) => tool.name === "second_brain_status"),
      ).toBe(true);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("the handshake an actual host reads reflects the actual window", () => {
  /** The tool whose guidance the window removes. */
  const WITHHELD = "brain_note";

  /** A server's `initialize.instructions`, as the host receives them. */
  async function handshake(server: MCPServer): Promise<string> {
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "window-test", version: "0" },
      },
    })) as { result: { instructions: string } };
    return response.result.instructions;
  }

  test("a disabled writer loses its guidance and is named as withheld", async () => {
    // Every other test of this rendering calls `buildInstructions` with
    // a report it built itself, so the wire between the server's own
    // capability report and the block it hands the host was unasserted:
    // dropping the window on the way to `buildInstructions` compiled,
    // shipped a handshake instructing a disabled tool, and failed
    // nothing. This drives `initialize` on the server instead.
    const windowed = await handshake(
      new MCPServer(
        { vault: VAULT },
        { scope: "writer", capabilityWindow: { disabledTools: [WITHHELD] } },
      ),
    );
    const open = await handshake(new MCPServer({ vault: VAULT }, { scope: "writer" }));

    expect(open).toContain(`- ${WITHHELD}`);
    const [body, withheldBlock] = windowed.split(WITHHELD_BLOCK_HEADING);
    expect(body).not.toContain(WITHHELD);
    expect(withheldBlock).toContain(WITHHELD);
  });

  test("an unwindowed server carries no withheld block at all", async () => {
    const text = await handshake(new MCPServer({ vault: VAULT }, { scope: "writer" }));
    expect(text).not.toContain(WITHHELD_BLOCK_HEADING);
  });
});

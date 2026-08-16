import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCli } from "../helpers/run-cli.ts";

describe("o2b mcp --scope arg validation", () => {
  test("invalid scope value exits 2 with a clear error", async () => {
    const res = await runCli(["mcp", "--scope", "nope"], { stdin: "" });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("--scope");
    expect(res.stderr).toMatch(/full.*writer|writer.*full/);
  });

  test("missing --scope value exits 2", async () => {
    const res = await runCli(["mcp", "--scope"], { stdin: "" });
    expect(res.returncode).toBe(2);
  });
});

describe("o2b mcp --host-target arg validation", () => {
  test("an unrecognised runtime exits 2 and lists the known ones", async () => {
    const res = await runCli(["mcp", "--host-target", "nope"], { stdin: "" });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("--host-target");
    expect(res.stderr).toContain("cursor");
  });

  test("a known runtime is reported back by the capability probe", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-host-target-"));
    try {
      const res = await runCli(["mcp", "--probe", "--json", "--host-target", "cursor"], {
        stdin: "",
        env: { VAULT_DIR: tmp },
      });
      expect(res.returncode).toBe(0);
      const parsed = JSON.parse(res.stdout) as {
        capabilities: { host_ceiling: { target: string; kind: string; max_tools: number } };
      };
      expect(parsed.capabilities.host_ceiling.target).toBe("cursor");
      expect(parsed.capabilities.host_ceiling.kind).toBe("declared");
      expect(parsed.capabilities.host_ceiling.max_tools).toBe(40);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe("--scope writer with a vault", () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-scope-test-"));
    });
    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    test("--scope writer starts the server and answers tools/list", async () => {
      const init = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      const list = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const res = await runCli(["mcp", "--scope", "writer"], {
        stdin: `${init}\n${list}\n`,
        env: { VAULT_DIR: tmp },
      });
      expect(res.returncode).toBe(0);
      const lines = res.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const names = (lines[1].result.tools as Array<{ name: string }>)
        .map((t) => t.name)
        .toSorted();
      expect(names).toEqual([
        "brain_apply_evidence",
        "brain_context",
        "brain_feedback",
        "brain_note",
        "brain_pinned_context",
      ]);
    });
  });
});

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../helpers/run-cli.ts";

describe("o2b mcp --writer-only alias", () => {
  test("--writer-only without --scope sets scope=writer", async () => {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-wo-"));
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
      const res = await runCli(["mcp", "--writer-only"], {
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
      ]);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--writer-only with --scope full is rejected (exit 2)", async () => {
    const res = await runCli(["mcp", "--writer-only", "--scope", "full"], { stdin: "" });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("--writer-only");
  });

  test("--writer-only with --scope writer is accepted", async () => {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-wo2-"));
      const init = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      const res = await runCli(["mcp", "--writer-only", "--scope", "writer"], {
        stdin: `${init}\n`,
        env: { VAULT_DIR: tmp },
      });
      expect(res.returncode).toBe(0);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("o2b mcp --probe", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-probe-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("--probe with valid vault exits 0 with tool count", async () => {
    const res = await runCli(["mcp", "--probe"], { stdin: "", env: { VAULT_DIR: tmp } });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("mcp probe ok");
    expect(res.stdout).toMatch(/\d+ tools/);
  });

  test("--probe --writer-only reports the writer-scope tool count", async () => {
    const res = await runCli(["mcp", "--probe", "--writer-only"], {
      stdin: "",
      env: { VAULT_DIR: tmp },
    });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("open-second-brain-writer");
    expect(res.stdout).toMatch(/[1-9]\d* tools/);
  });

  test("--probe without vault exits non-zero with FAIL message", async () => {
    const res = await runCli(["mcp", "--probe"], { stdin: "" });
    expect(res.returncode).toBeGreaterThan(0);
    expect(res.stdout).toContain("mcp probe FAIL");
  });
});

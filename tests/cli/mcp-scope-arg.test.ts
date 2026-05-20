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
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      const list = JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
      });
      const res = await runCli(
        ["mcp", "--scope", "writer"],
        { stdin: `${init}\n${list}\n`, env: { VAULT_DIR: tmp } },
      );
      expect(res.returncode).toBe(0);
      const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
      const names = (lines[1].result.tools as Array<{ name: string }>)
        .map((t) => t.name).sort();
      expect(names).toEqual([
        "brain_apply_evidence",
        "brain_context",
        "brain_feedback",
        "brain_note",
      ]);
    });
  });
});

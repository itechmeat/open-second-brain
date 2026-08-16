import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCli } from "../helpers/run-cli.ts";
import { INSTALL_TARGET_IDS, RUNTIME_FACTS } from "../../src/core/runtime/host-facts.ts";

/** Whole tokens: `copilot-cli` contains `pi`, so containment over ids lies. */
function tokensOf(text: string): ReadonlySet<string> {
  return new Set(text.split(/[^A-Za-z0-9_-]+/).filter((token) => token.length > 0));
}

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
    // Every known runtime, not just one of them: the refusal exists to
    // tell the operator what they could have written instead.
    const offered = tokensOf(res.stderr);
    for (const target of INSTALL_TARGET_IDS) {
      expect(`${target} offered: ${offered.has(target)}`).toBe(`${target} offered: true`);
    }
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
      // The number comes from the fact row the server reads, not from a
      // literal copied out of it: the two cannot drift apart here.
      const ceiling = RUNTIME_FACTS.cursor.toolCeiling;
      expect(ceiling.kind).toBe("declared");
      expect(parsed.capabilities.host_ceiling.target).toBe("cursor");
      expect(parsed.capabilities.host_ceiling.kind).toBe(ceiling.kind);
      expect(parsed.capabilities.host_ceiling.max_tools).toBe(
        (ceiling as { maxTools: number }).maxTools,
      );
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

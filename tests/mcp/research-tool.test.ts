/**
 * MCP integration test for `brain_research_report` (Knowledge Provenance
 * suite). The agent supplies title + consulted sources + cited findings; OSB
 * validates the citation contract and writes a dated report page.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { CAPTURE_SCOPE } from "../../src/core/brain/provenance/capture-scope.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { RESEARCH_TOOLS } from "../../src/mcp/brain/research-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-research-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-research-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const handler = RESEARCH_TOOLS[0]!.handler;

describe("brain_research_report", () => {
  test("writes a cited report and returns its path and finding count", async () => {
    const res = await handler(ctx, {
      title: "Survey",
      sources: ["Articles/a.md", "Articles/b.md"],
      findings: [{ statement: "A point", sources: ["Articles/a.md"] }],
    });
    expect(res).toMatchObject({ created: true, finding_count: 1, report_path: expect.any(String) });
  });

  test("rejects an uncited finding with INVALID_PARAMS", async () => {
    await expect(
      handler(ctx, {
        title: "Survey",
        sources: ["Articles/a.md"],
        findings: [{ statement: "no citation", sources: [] }],
      }),
    ).rejects.toThrow(MCPError);
  });

  test("rejects an empty sources list", async () => {
    await expect(
      handler(ctx, {
        title: "Survey",
        sources: [],
        findings: [{ statement: "x", sources: ["Articles/a.md"] }],
      }),
    ).rejects.toThrow(MCPError);
  });
});

/**
 * Per-source capture scopes reach the MCP caller (distilled provenance, D3),
 * aligned with the `sources` the caller passed, in the same order.
 */
describe("brain_research_report - capture_scopes", () => {
  test("one scope per consulted source, in sources order", async () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, "Articles", "held.md"), "# Held\n", "utf8");
    const sources = ["https://example.test/post", "Articles/held.md"];
    const res = (await handler(ctx, {
      title: "Scoped survey",
      sources,
      findings: [{ statement: "A point", sources: ["Articles/held.md"] }],
    })) as Record<string, unknown>;
    expect(res["capture_scopes"]).toEqual([CAPTURE_SCOPE.urlOnly, CAPTURE_SCOPE.fullLocal]);
  });

  test("a vault page withheld at the caller's reach is reported as url-only", async () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes", "secret.md"), "---\nvisibility: private\n---\nbody\n");
    writeFileSync(join(vault, "Notes", "open.md"), "---\ntitle: open\n---\nbody\n");
    const args = {
      title: "Reach",
      sources: ["Notes/secret.md", "Notes/open.md"],
      findings: [{ statement: "A point", sources: ["Notes/open.md"] }],
    };

    const remote = (await handler({ ...ctx, reach: TRANSPORT_REACH.remote }, args)) as Record<
      string,
      unknown
    >;
    expect(remote["capture_scopes"]).toEqual([CAPTURE_SCOPE.urlOnly, CAPTURE_SCOPE.fullLocal]);

    const local = (await handler({ ...ctx, reach: TRANSPORT_REACH.local }, args)) as Record<
      string,
      unknown
    >;
    expect(local["capture_scopes"]).toEqual([CAPTURE_SCOPE.fullLocal, CAPTURE_SCOPE.fullLocal]);
  });
});

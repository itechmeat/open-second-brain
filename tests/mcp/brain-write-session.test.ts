/**
 * `brain_write_session` MCP tool (Agent Write Contract Suite,
 * t_bc36a8a2 + t_0cc6fdff): one tool, op + kind discriminators, the
 * same envelopes as the CLI.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import {
  VISIBILITY_SURFACE_CATEGORY,
  VISIBILITY_SURFACE_KIND,
  VISIBILITY_SURFACE_REGISTRY,
} from "../../src/core/search/visibility-surface-registry.ts";

let tmp: string;
let vault: string;
let configPath: string;

const GOOD = "---\nkind: note\n---\n\n# MCP note\n\nBody.\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-ws-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

function tool() {
  return findTool(buildToolTable("full"), "brain_write_session");
}

test("artifact flow: open -> bad submit -> corrected submit -> done", async () => {
  const opened = (await tool().handler(ctx(), {
    op: "open",
    kind: "artifact",
    target: "Brain/notes/mcp.md",
    agent: "mcp-agent",
  })) as Record<string, unknown>;
  expect(opened["status"]).toBe("needs-llm-step");
  const id = opened["session_id"] as string;

  const bad = (await tool().handler(ctx(), {
    op: "submit",
    session_id: id,
    text: "no frontmatter",
  })) as Record<string, unknown>;
  expect(bad["status"]).toBe("needs-correction");
  expect((bad["errors"] as Array<{ code: string }>).map((e) => e.code)).toContain(
    "frontmatter-missing",
  );

  const done = (await tool().handler(ctx(), {
    op: "submit",
    session_id: id,
    text: GOOD,
  })) as Record<string, unknown>;
  expect(done["status"]).toBe("done");
  expect(readFileSync(join(vault, "Brain", "notes", "mcp.md"), "utf8")).toContain("# MCP note");
});

test("panel flow: open -> persona steps -> synthesis -> committed note", async () => {
  const opened = (await tool().handler(ctx(), {
    op: "open",
    kind: "panel",
    topic: "Adopt MCP sessions",
    personas: ["technical", "risk"],
    agent: "mcp-agent",
  })) as Record<string, unknown>;
  expect(opened["step"]).toBe("persona:technical");
  const id = opened["session_id"] as string;

  await tool().handler(ctx(), { op: "submit", session_id: id, text: "Feasible." });
  await tool().handler(ctx(), { op: "submit", session_id: id, text: "Low risk." });
  const done = (await tool().handler(ctx(), {
    op: "submit",
    session_id: id,
    text: "Adopt.",
  })) as Record<string, unknown>;
  expect(done["status"]).toBe("done");
  expect(readFileSync(join(vault, done["target_path"] as string), "utf8")).toContain(
    "## Synthesis",
  );
});

test("status, list, abandon ops round-trip", async () => {
  const opened = (await tool().handler(ctx(), {
    op: "open",
    kind: "artifact",
    target: "Brain/notes/s.md",
  })) as Record<string, unknown>;
  const id = opened["session_id"] as string;

  const status = (await tool().handler(ctx(), { op: "status", session_id: id })) as Record<
    string,
    unknown
  >;
  expect(status["status"]).toBe("needs-llm-step");

  const list = (await tool().handler(ctx(), { op: "list" })) as Record<string, unknown>;
  expect((list["sessions"] as unknown[]).length).toBe(1);

  const abandoned = (await tool().handler(ctx(), { op: "abandon", session_id: id })) as Record<
    string,
    unknown
  >;
  expect(abandoned["status"]).toBe("failed");
});

test("structured request errors surface as MCP invalid-params", async () => {
  await expect(
    tool().handler(ctx(), { op: "open", kind: "artifact", target: "Brain/preferences/x.md" }),
  ).rejects.toThrow(/target rejected/);
  await expect(tool().handler(ctx(), { op: "bogus" })).rejects.toThrow(/op/);
  await expect(tool().handler(ctx(), { op: "submit" })).rejects.toThrow(/session_id/);
});

test("the tool is advertised in full scope but not writer scope", () => {
  expect(() => findTool(buildToolTable("full"), "brain_write_session")).not.toThrow();
  expect(() => findTool(buildToolTable("writer"), "brain_write_session")).toThrow();
});

test("op=list declares a described cursor property", () => {
  const schema = tool().inputSchema as {
    properties: Record<string, { type?: string; maxLength?: number; description?: string }>;
  };
  expect(schema.properties["cursor"]).toMatchObject({ type: "string", maxLength: 32 });
  expect(schema.properties["cursor"]?.description).toBeTruthy();
});

test("op=list walks by cursor: the pages reassemble every session, the last page is null", async () => {
  const ids: string[] = [];
  for (const name of ["walk-a", "walk-b", "walk-c"]) {
    const opened = (await tool().handler(ctx(), {
      op: "open",
      kind: "artifact",
      target: `Brain/notes/${name}.md`,
    })) as Record<string, unknown>;
    ids.push(opened["session_id"] as string);
  }

  const total = 3;
  const limit = 2;
  // Bound the walk by the page arithmetic: ceil(total/limit) pages plus one
  // slack step, so a next_cursor that never turns null (an ignored or
  // never-exhausting cursor) exhausts the budget and fails here instead of
  // hanging the suite.
  const maxSteps = Math.ceil(total / limit) + 1;
  const walked: string[] = [];
  let cursor: string | null = null;
  for (let step = 0; step < maxSteps; step += 1) {
    const page = (await tool().handler(ctx(), {
      op: "list",
      limit,
      ...(cursor !== null ? { cursor } : {}),
    })) as Record<string, unknown>;
    expect(page["total"]).toBe(total);
    // Guard the walk protocol: an ignored cursor is a shape violation,
    // not a stop condition.
    const next = page["next_cursor"];
    expect(next === null || typeof next === "string").toBe(true);
    walked.push(
      ...(page["sessions"] as ReadonlyArray<Record<string, unknown>>).map(
        (s) => s["session_id"] as string,
      ),
    );
    cursor = next as string | null;
    if (cursor === null) break;
  }
  expect(cursor).toBeNull();
  expect(walked.toSorted()).toEqual(ids.toSorted());
  expect(new Set(walked).size).toBe(3);
});

test("op=list refuses a malformed cursor as invalid params", async () => {
  await expect(tool().handler(ctx(), { op: "list", cursor: "!!!not-base64!!!" })).rejects.toThrow(
    /malformed cursor/,
  );
});

test("op=list's all-agents view is the visibility registry's recorded exclusion, not an oversight", () => {
  // The cursor walk over op=list answers every live agent's sessions
  // (target_path, prompt), where the pre-cursor read bounded a single
  // answer at 500. That is a recorded decision, not a gap: the vault's
  // visibility census classifies this surface as deliberately outside
  // the page-visibility model - write-session records are Brain's own
  // transient queue (TTL-swept, operator-shared; the CLI verb
  // `brain write-session list` prints every agent's sessions
  // unfiltered, and op=status/approve/abandon already addressed any
  // session by id), not general vault notes carrying an `owner:` scope
  // the walk could cross. The pin below fails if that verdict is ever
  // silently reclassified, so the boundary stays an argued decision.
  const entry = VISIBILITY_SURFACE_REGISTRY.find(
    (e) => e.surface === "brain_write_session" && e.kind === VISIBILITY_SURFACE_KIND.mcpTool,
  );
  expect(entry?.category).toBe(VISIBILITY_SURFACE_CATEGORY.excluded);
  expect(entry?.reason).toContain("listWriteSessions");
  expect(entry?.reason).toContain("no visibility check");
});

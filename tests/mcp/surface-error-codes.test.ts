/**
 * Per-surface error codes at the MCP boundary.
 *
 * The boundary seam can only see a class; the surfaces below know a more
 * precise reason and name it in `error.data.code` from the closed registry
 * in `src/mcp/tool-error-codes.ts`. Every message stays byte-identical to
 * the one it replaced, because agents and the Hermes bridge parse it.
 *
 * Handlers are called directly: the precise code is set at the throw, and
 * the seam keeps a thrower-supplied code untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../src/core/brain/triggers/types.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { assertKnownArguments } from "../../src/mcp/argument-guard.ts";
import { AGENT_SCOPE_ARG_NAME, coerceAgentScope } from "../../src/mcp/coerce.ts";
import { OWNER_SCOPE_REFUSAL } from "../../src/mcp/owner-scope-refusal.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { assertNoCallerSuppliedReach, REACH_REFUSAL } from "../../src/mcp/reach-refusal.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";
import { isToolErrorCode } from "../../src/mcp/tool-error-codes.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";

const TOOLS = buildToolTable("full");

/** The `MCPError` a call raised; fails the test when it answered instead. */
async function raised(run: () => unknown): Promise<MCPError> {
  let thrown: unknown;
  try {
    await run();
  } catch (exc) {
    thrown = exc;
  }
  expect(thrown).toBeInstanceOf(MCPError);
  return thrown as MCPError;
}

/** The code a raised error carries, checked against the closed registry. */
function codeOf(err: MCPError): string {
  const code = (err.data as { readonly code?: unknown } | undefined)?.code;
  expect(typeof code).toBe("string");
  expect(isToolErrorCode(code)).toBe(true);
  return code as string;
}

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-surface-codes-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ----- skills -----------------------------------------------------------------

function skillCtx(): ServerContext {
  const skillDir = join(tmp, "skills", "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demonstration skill.\n---\n\n# Demo\n",
  );
  return { vault, configPath: null, repoRoot: tmp };
}

const getSkill = (): ToolDefinition => SKILL_TOOLS.find((t) => t.name === "get_skill")!;

describe("skill errors", () => {
  test("an unknown skill answers unknown_skill", async () => {
    const err = await raised(() => getSkill().handler(skillCtx(), { name: "no-such-skill" }));
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.message).toBe("unknown skill: no-such-skill. Known skills: demo-skill");
    expect(codeOf(err)).toBe("unknown_skill");
  });

  test("a missing skill file answers skill_not_found", async () => {
    const err = await raised(() =>
      getSkill().handler(skillCtx(), { name: "demo-skill", file_path: "missing.md" }),
    );
    expect(err.message).toBe("skill file not found: missing.md");
    expect(codeOf(err)).toBe("skill_not_found");
  });

  test("an escaping skill file path answers skill_invalid_path", async () => {
    const err = await raised(() =>
      getSkill().handler(skillCtx(), { name: "demo-skill", file_path: "../outside.md" }),
    );
    expect(err.message).toBe("skill file path must stay inside the skill directory");
    expect(codeOf(err)).toBe("skill_invalid_path");
  });
});

// ----- workspace refusals ------------------------------------------------------

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
const TRIGGER_NOW = new Date("2099-06-03T10:00:00Z");

function candidate(source: string): InsightCandidate {
  return {
    kind: "contradiction",
    urgency: "high",
    reason: `${source} contradicts pref-other`,
    suggestedAction: "Review the pair",
    sourceArtifacts: [`[[${source}]]`],
    contextSnippets: [],
    cooldownKey: `contradiction:${source}:pref-other`,
  };
}

function workspaceCtx(agentName?: string): ServerContext {
  return { vault, configPath, repoRoot: null, ...(agentName ? { agentName } : {}) };
}

describe("workspace refusals", () => {
  test("an unknown brain_intention operation answers unknown_operation", async () => {
    const err = await raised(() =>
      findTool(TOOLS, "brain_intention").handler(workspaceCtx(), {
        operation: "rename",
        scope: "w",
      }),
    );
    expect(err.message).toBe("brain_intention operation must be one of: set, show, list, move");
    expect(codeOf(err)).toBe("unknown_operation");
  });

  test("an unknown brain_trigger operation answers unknown_operation", async () => {
    const err = await raised(() =>
      findTool(TOOLS, "brain_trigger").handler(workspaceCtx(), { operation: "rename" }),
    );
    expect(err.message).toStartWith("brain_trigger operation must be one of: ");
    expect(codeOf(err)).toBe("unknown_operation");
  });

  test("an unknown trigger status answers invalid_status", async () => {
    const err = await raised(() =>
      findTool(TOOLS, "brain_trigger").handler(workspaceCtx(), {
        operation: "list",
        status: "bogus",
      }),
    );
    expect(err.message).toBe("brain_trigger: unknown status 'bogus'");
    expect(codeOf(err)).toBe("invalid_status");
  });

  test("an absent id and an id the caller may not see answer the same code and message", async () => {
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writePreference(vault, {
      slug: "owned-by-a",
      topic: "owned-by-a",
      principle: "principle for owned-by-a",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-01-owned-by-a]]"],
      confirmed_at: "2026-05-02T00:00:00Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-02T00:00:00Z",
      confidence: BRAIN_CONFIDENCE.high,
      confidence_value: 0.8,
      owner: OWNER_A,
    });
    const { created } = createTriggers(vault, [candidate("pref-owned-by-a")], { now: TRIGGER_NOW });
    const hiddenId = created[0]!.id;
    writeFileSync(
      brainConfigPath(vault),
      `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${GATE_MODE.fail}\n`,
    );
    const absentId = `${hiddenId.slice(0, -4)}zzzz`;
    const trigger = findTool(TOOLS, "brain_trigger");

    const hidden = await raised(() =>
      trigger.handler(workspaceCtx(OWNER_B), { operation: "acknowledge", id: hiddenId }),
    );
    const absent = await raised(() =>
      trigger.handler(workspaceCtx(OWNER_B), { operation: "acknowledge", id: absentId }),
    );

    expect(codeOf(hidden)).toBe("trigger_transition_refused");
    expect(codeOf(absent)).toBe("trigger_transition_refused");
    expect(hidden.message.replace(hiddenId, "<id>")).toBe(absent.message.replace(absentId, "<id>"));
    expect(hidden.data).toEqual(absent.data);
  });
});

// ----- write session ----------------------------------------------------------

const writeSession = (): ToolDefinition => findTool(TOOLS, "brain_write_session");
const sessionCtx = (): ServerContext => ({ vault, configPath, repoRoot: null });

describe("write-session codes", () => {
  test("an op that needs a session but names none answers session_id_required", async () => {
    const err = await raised(() => writeSession().handler(sessionCtx(), { op: "approve" }));
    expect(err.message).toBe("brain_write_session: op 'approve' requires session_id");
    expect(codeOf(err)).toBe("session_id_required");
  });

  test("an unknown session id answers write_session_unknown on every op", async () => {
    const errors = await Promise.all(
      ["approve", "abandon", "status"].map((op) =>
        raised(() => writeSession().handler(sessionCtx(), { op, session_id: "ws-does-not-exist" })),
      ),
    );
    for (const err of errors) {
      expect(err.message).toBe("unknown write-session: ws-does-not-exist");
      expect(codeOf(err)).toBe("write_session_unknown");
    }
  });

  test("a terminal session answers write_session_terminal", async () => {
    const opened = (await writeSession().handler(sessionCtx(), {
      op: "open",
      kind: "artifact",
      target: "Brain/notes/terminal.md",
      agent: "mcp-agent",
    })) as Record<string, unknown>;
    const id = opened["session_id"] as string;
    await writeSession().handler(sessionCtx(), { op: "abandon", session_id: id });

    const err = await raised(() =>
      writeSession().handler(sessionCtx(), { op: "approve", session_id: id }),
    );
    expect(err.message).toStartWith(`write-session ${id} is terminal (`);
    expect(codeOf(err)).toBe("write_session_terminal");
  });

  test("a structured request failure keeps data.errors and no precise code", async () => {
    const err = await raised(() =>
      writeSession().handler(sessionCtx(), {
        op: "open",
        kind: "artifact",
        target: "../outside.md",
        agent: "mcp-agent",
      }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.message).toStartWith("target rejected: ");
    const data = err.data as { readonly errors: ReadonlyArray<unknown> };
    // Byte-identical to v1.65.0: the list alone, so the boundary seam adds
    // its `invalid_params` default after it.
    expect(Object.keys(data)).toEqual(["errors"]);
    expect(data.errors.length).toBeGreaterThan(0);
  });
});

describe("write-session codes at the boundary", () => {
  test("a structured request failure gains the invalid_params default after its errors", async () => {
    const server = new MCPServer({ vault });
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "brain_write_session",
        arguments: { op: "open", kind: "artifact", target: "../outside.md", agent: "mcp-agent" },
      },
    });
    expect(response?.error?.code).toBe(INVALID_PARAMS);
    const data = response?.error?.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["errors", "code"]);
    expect(data["code"]).toBe("invalid_params");
  });
});

// ----- argument guard, reach refusal, owner-scope refusal -----------------------

describe("refusal codes", () => {
  const CLOSED_TOOL: ToolDefinition = {
    name: "demo_tool",
    description: "A demo tool.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "The search text." } },
      additionalProperties: false,
    },
    handler: () => ({}),
  };

  test("an undeclared argument answers unknown_argument with its data unchanged", async () => {
    const err = await raised(() => assertKnownArguments(CLOSED_TOOL, { quiery: "x" }));
    expect(codeOf(err)).toBe("unknown_argument");
    expect(err.data).toEqual({
      tool: "demo_tool",
      unknown_arguments: [{ name: "quiery", suggestion: "query" }],
      declared_arguments: ["query"],
      code: "unknown_argument",
    });
  });

  test("a caller-supplied reach answers its own refusal token", async () => {
    const err = await raised(() => assertNoCallerSuppliedReach(CLOSED_TOOL, { reach: "local" }));
    expect(codeOf(err)).toBe(REACH_REFUSAL);
    const data = err.data as Record<string, unknown>;
    expect(data["refused_arguments"]).toEqual(["reach"]);
    expect(data["tool"]).toBe("demo_tool");
  });

  test("an owner-scope refusal answers the outcome it names", async () => {
    writeFileSync(
      brainConfigPath(vault),
      `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${GATE_MODE.fail}\n`,
    );
    const foreign = await raised(() =>
      coerceAgentScope(
        { vault, agentName: "agent-b" },
        { [AGENT_SCOPE_ARG_NAME]: "agent-a" },
        false,
      ),
    );
    expect(foreign.message).toContain(OWNER_SCOPE_REFUSAL.foreignOwner);
    expect(codeOf(foreign)).toBe(OWNER_SCOPE_REFUSAL.foreignOwner);

    const unresolved = await raised(() =>
      coerceAgentScope({ vault, agentName: "agent" }, { [AGENT_SCOPE_ARG_NAME]: "agent-a" }, false),
    );
    expect(unresolved.message).toContain(OWNER_SCOPE_REFUSAL.unresolvedIdentity);
    expect(codeOf(unresolved)).toBe(OWNER_SCOPE_REFUSAL.unresolvedIdentity);
  });
});

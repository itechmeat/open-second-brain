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

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../src/core/brain/triggers/types.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { assertKnownArguments } from "../../src/mcp/argument-guard.ts";
import { FEEDBACK_TOOLS } from "../../src/mcp/brain/feedback-tools.ts";
import { LIFECYCLE_FILE_TOOLS } from "../../src/mcp/brain/lifecycle-file-tools.ts";
import { AGENT_SCOPE_ARG_NAME, coerceAgentScope } from "../../src/mcp/coerce.ts";
import { OWNER_SCOPE_REFUSAL } from "../../src/mcp/owner-scope-refusal.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { assertNoCallerSuppliedReach, REACH_REFUSAL } from "../../src/mcp/reach-refusal.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";
import { isToolErrorCode } from "../../src/mcp/tool-error-codes.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import { readRpcErrorCode } from "../helpers/tool-error-envelope.ts";

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
    expect(response?.error?.message).toStartWith("target rejected: ");
    // Byte-identical to v1.65.0 up to the default: the handler hands over
    // the list alone, and the boundary seam adds `invalid_params` after it.
    const data = response?.error?.data as {
      readonly errors: ReadonlyArray<unknown>;
      readonly code: string;
    };
    expect(Object.keys(data)).toEqual(["errors", "code"]);
    expect(data.errors.length).toBeGreaterThan(0);
    expect(readRpcErrorCode(response)).toBe("invalid_params");
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

// ----- codes a refusing site supplies itself ------------------------------------

const expireTool = (): ToolDefinition => FEEDBACK_TOOLS.find((t) => t.name === "brain_expire")!;
const stubTool = (): ToolDefinition =>
  LIFECYCLE_FILE_TOOLS.find((t) => t.name === "brain_scaffold_stub")!;

describe("thrower-supplied codes are registry members", () => {
  // The boundary keeps a code the refusing site chose, so each of these
  // producers has to name a registered token itself: a client narrowing
  // `error.data.code` with `isToolErrorCode` would reject anything else.
  test("each brain_expire refusal answers a registered code", async () => {
    bootstrapBrain(vault, { configPath });
    const ctx: ServerContext = { vault, configPath, repoRoot: null };
    const refusal = (args: Record<string, unknown>) =>
      raised(() => expireTool().handler(ctx, args));
    const [badDate, missing, unaddressable] = await Promise.all([
      refusal({ id: "sig-2026-01-01-demo", expires: "soon" }),
      refusal({ id: "sig-2026-01-01-demo", expires: "2026-12-31" }),
      refusal({ id: "not-an-id", expires: "2026-12-31" }),
    ]);
    expect(codeOf(badDate)).toBe("ExpirationValueError");
    expect(codeOf(missing)).toBe("ExpirationTargetNotFoundError");
    expect(codeOf(unaddressable)).toBe("InvalidExpirationTargetError");
  });

  test("an argument of the other brain_scaffold_stub action answers a registered code", async () => {
    const ctx: ServerContext = { vault, configPath, repoRoot: null };
    const err = await raised(() =>
      stubTool().handler(ctx, { action: "list", target: "Foo", apply: true }),
    );
    expect(codeOf(err)).toBe("argument_forbidden");
  });
});

// ----- unknown operations ------------------------------------------------------

describe("every operation-dispatching tool answers unknown_operation", () => {
  // One case per dispatch: the argument that selects the operation, set to
  // a value outside the tool's closed set, and the message the refusal has
  // always carried, which stays byte-identical.
  const BOGUS = "no_such_operation";
  const CASES: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [
      "brain_skill_proposals",
      { operation: BOGUS },
      "brain_skill_proposals: operation must be one of " +
        "learn|list|accept|reject|recover|usage|evidence|page_candidates|page_draft",
    ],
    [
      "brain_procedural_memory",
      { operation: BOGUS },
      "brain_procedural_memory: operation must be one of reconcile|list|mark_used|mark_outcome",
    ],
    [
      "brain_recurrence",
      { operation: BOGUS },
      "brain_recurrence: operation must be one of list|show|learn|forget|purge_source",
    ],
    [
      "brain_procedural_graph",
      { operation: BOGUS },
      "brain_procedural_graph: operation must be one of rebuild|show|hints",
    ],
    [
      "brain_obligation",
      // `slug` is read before the last branch, so the refusal needs one.
      { operation: BOGUS, slug: "demo" },
      "brain_obligation operation must be one of: add, done, list, show, remove",
    ],
    [
      "brain_context_receipts",
      { operation: BOGUS },
      "brain_context_receipts: operation must be list, show, or summary",
    ],
    [
      "brain_context_presets",
      { operation: BOGUS },
      "brain_context_presets: operation must be show, suggest, or diff",
    ],
    [
      "brain_write_session",
      { op: BOGUS },
      `brain_write_session: op must be open|submit|approve|abandon|status|list, got '${BOGUS}'`,
    ],
    [
      "brain_pinned_context",
      { operation: BOGUS },
      "brain_pinned_context operation must be one of: read, write, append, clear",
    ],
    [
      "brain_session_summary",
      { operation: BOGUS },
      "brain_session_summary: operation must be write|get|list",
    ],
    ["brain_benchmark", { operation: BOGUS }, "brain_benchmark: operation must be run"],
    ["brain_tune", { operation: BOGUS }, "brain_tune: operation must be run|status|reset"],
    [
      "brain_recall_telemetry",
      { operation: BOGUS },
      "brain_recall_telemetry: operation must be list, summary, gate_list, gate_summary, observed_reuse, or cost",
    ],
    [
      "brain_route_metrics",
      { operation: BOGUS },
      "brain_route_metrics: operation must be list or summary",
    ],
    [
      "brain_token_impact",
      { operation: BOGUS },
      "brain_token_impact: operation must be record, outcome, list, or summary",
    ],
    [
      "brain_context_pack_outcome",
      { operation: BOGUS },
      "brain_context_pack_outcome: operation must be post, list, or summary",
    ],
    [
      "brain_analytics",
      { view: "attention_flows", operation: BOGUS },
      "brain_analytics view=attention_flows: operation must be one of list|evaluate|render",
    ],
    [
      "brain_bridges",
      { operation: BOGUS },
      "brain_bridges: operation must be discover|list|accept|dismiss",
    ],
    ["brain_clusters", { operation: BOGUS }, "brain_clusters: operation must be run|list"],
    [
      "brain_truth",
      { operation: BOGUS },
      "brain_truth: operation must be ingest|slots|conflicts|aggregate|collisions|events|state",
    ],
    ["brain_dead_ends", { operation: BOGUS }, "brain_dead_ends: operation must be record|list"],
    [
      "brain_claims",
      { operation: BOGUS },
      "brain_claims: 'operation' must be one of current, at, history, replaced, contests, rebuild",
    ],
    [
      "brain_generation_reports",
      { action: BOGUS },
      "brain_generation_reports: action must be record, list, or summary",
    ],
    [
      "brain_labels",
      { operation: BOGUS },
      "brain_labels: operation must be assign|remove|show|suggest",
    ],
    ["brain_tiers", { operation: BOGUS }, "brain_tiers: operation must be check|restore|accept"],
    ["brain_secrets", { operation: BOGUS }, "brain_secrets: operation must be list|run"],
    ["brain_maintenance", { operation: BOGUS }, "brain_maintenance: operation must be run|status"],
    [
      "brain_dream",
      { action: BOGUS },
      "brain_dream: action must be run|stage|validate|apply|retriage|discard|list",
    ],
    [
      "brain_tension",
      { action: BOGUS },
      "brain_tension: 'action' must be one of detect, list, show, confirm, dismiss, resolve, verify",
    ],
    [
      "brain_decision",
      { action: BOGUS },
      "brain_decision: 'action' must be one of record, outcome, rate, show, list, compare, similar, history, recall",
    ],
    [
      "brain_lifecycle",
      { action: BOGUS },
      "brain_lifecycle: 'action' must be one of tombstone, supersede, temporal-replace, tip, curator, correct",
    ],
    ["brain_writes", { action: BOGUS }, "brain_writes: 'action' must be one of list, plan_revert"],
    [
      "brain_note_lifecycle",
      { action: BOGUS },
      "brain_note_lifecycle: 'action' must be one of rename, move, archive, delete",
    ],
    [
      "brain_scaffold_stub",
      { action: BOGUS },
      "brain_scaffold_stub: 'action' must be one of list, write",
    ],
  ];

  for (const [tool, args, message] of CASES) {
    test(`${tool} answers unknown_operation with its message unchanged`, async () => {
      const err = await raised(() => findTool(TOOLS, tool).handler(workspaceCtx(), args));
      expect(err.message).toBe(message);
      expect(codeOf(err)).toBe("unknown_operation");
    });
  }

  test("the table covers every tool whose schema declares a dispatch enum", () => {
    // Derived from the catalog, so a new dispatcher that forgets the shared
    // code fails here instead of shipping (brain_claims was found by hand).
    const covered = new Set<string>([
      ...CASES.map(([tool]) => tool),
      // pinned by the workspace refusal tests above
      "brain_intention",
      "brain_trigger",
    ]);
    // A host write whose `action` refusal keeps the pinned `invalid_action`.
    const exempt = new Set<string>(["brain_memory_bridge"]);
    const declared = TOOLS.filter((tool) => {
      const props =
        (tool.inputSchema as { readonly properties?: Record<string, { readonly enum?: unknown }> })
          .properties ?? {};
      return ["operation", "op", "action"].some((arg) => Array.isArray(props[arg]?.enum));
    }).map((tool) => tool.name);
    expect(declared.filter((name) => !covered.has(name) && !exempt.has(name))).toEqual([]);
  });

  test("a write batch operation of an unknown kind answers unknown_operation", async () => {
    const err = await raised(() =>
      findTool(TOOLS, "brain_write_batch").handler(workspaceCtx(), {
        operations: [{ op: BOGUS, path: "notes/x.md" }],
      }),
    );
    expect(err.message).toStartWith("brain_write_batch: operations[0].op must be one of ");
    expect(codeOf(err)).toBe("unknown_operation");
  });
});

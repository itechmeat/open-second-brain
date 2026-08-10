/**
 * `Brain/standing-rules.md` is uneditable by inheritance, and this suite
 * is the assertion rather than the mechanism.
 *
 * The file lives under the Brain machinery root, whose first path
 * segment {@link resolveNoteTarget} refuses outright, and all four
 * caller-named write tools - `brain_create_note`, `brain_update_note`,
 * `brain_append_note`, `brain_write_batch` - resolve their target
 * through that one envelope. Choosing the directory was the entire
 * enforcement decision; what is left to prove is that the four really do
 * share the envelope and that the on-disk bytes survive the attempt.
 *
 * The scope of the claim is stated honestly in `standing-rules.ts`: this
 * is the caller-named write class, which is the boundary the write-site
 * census maintains. It is not a claim that no module in this process can
 * open the file.
 *
 * The last case is the other half of the property: a tool table that
 * NAMED the file - in a tool name, a description, or an input-schema
 * property description - would be advertising a target the envelope then
 * refuses, which is how an agent learns to keep trying.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { CreateNoteError, resolveNoteTarget } from "../../src/core/brain/notes/create-note.ts";
import {
  assertStandingRulesNotTargeted,
  StandingRulesWriteRefusedError,
} from "../../src/core/brain/standing-rules.ts";
import { BRAIN_STANDING_RULES_FILE } from "../../src/core/brain/path-constants.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const RULES_REL = `Brain/${BRAIN_STANDING_RULES_FILE}`;
const RULES_BYTES = "Never force-push to main.\nAsk before deleting anything under Archive/.\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-standing-uneditable-"));
  vault = join(tmp, "vault");
  for (const dir of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", dir), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  writeFileSync(join(vault, RULES_REL), RULES_BYTES, "utf8");
  configHome = mkdtempSync(join(tmpdir(), "o2b-standing-uneditable-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface CallOutcome {
  readonly error?: { readonly message?: string };
  readonly result?: { readonly isError?: boolean; readonly content?: ReadonlyArray<unknown> };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "uneditable-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as CallOutcome;
}

/** Serialized response text, whichever channel the refusal came back on. */
function outcomeText(out: CallOutcome): string {
  return JSON.stringify(out);
}

function onDiskBytes(): string {
  return readFileSync(join(vault, RULES_REL), "utf8");
}

/** The four tools that address a note by a path the caller names. */
const CALLER_NAMED_WRITE_TOOLS: ReadonlyArray<{
  readonly tool: string;
  readonly args: Record<string, unknown>;
}> = Object.freeze([
  { tool: "brain_create_note", args: { path: RULES_REL, content: "OVERWRITTEN" } },
  { tool: "brain_update_note", args: { path: RULES_REL, content: "OVERWRITTEN" } },
  { tool: "brain_append_note", args: { path: RULES_REL, content: "OVERWRITTEN" } },
  {
    tool: "brain_write_batch",
    args: { operations: [{ op: "update_note", path: RULES_REL, content: "OVERWRITTEN" }] },
  },
]);

describe("Brain/standing-rules.md is uneditable through every caller-named write tool", () => {
  for (const { tool, args } of CALLER_NAMED_WRITE_TOOLS) {
    test(`${tool} refuses the path and leaves the bytes unchanged`, async () => {
      const out = await callTool(tool, args);
      const text = outcomeText(out);
      // Refused, however this tool reports refusals, and refused for the
      // REASON that makes the file safe rather than for an incidental one.
      expect(text).not.toContain("OVERWRITTEN");
      expect(text).toContain(RULES_REL);
      expect(text).toContain("Brain machinery root");
      // And the file the operator wrote is byte-for-byte what it was.
      expect(onDiskBytes()).toBe(RULES_BYTES);
    });
  }

  test("the note-target resolver refuses the path with the excluded code", () => {
    let thrown: unknown;
    try {
      resolveNoteTarget(vault, RULES_REL);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CreateNoteError);
    expect((thrown as CreateNoteError).code).toBe("excluded");
    expect((thrown as CreateNoteError).message).toContain(RULES_REL);
  });

  test("no tool name, description, or schema property description mentions the file", () => {
    const offenders: string[] = [];
    for (const tool of buildToolTable("full")) {
      const places: Array<[string, string]> = [
        [`${tool.name} (name)`, tool.name],
        [`${tool.name} (description)`, tool.description],
      ];
      for (const [label, text] of places) {
        if (text.includes(BRAIN_STANDING_RULES_FILE)) offenders.push(label);
      }
      for (const [prop, description] of schemaDescriptions(tool.inputSchema)) {
        if (description.includes(BRAIN_STANDING_RULES_FILE)) {
          offenders.push(`${tool.name}.${prop}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The one caller-named write surface that does NOT go through
 * `resolveNoteTarget`: `brain_labels` resolves its path with
 * `resolveNotePath`, which checks containment and symlinks and nothing
 * else, and `assignNoteLabel` then rewrites frontmatter with overwrite -
 * so the inherited refusal did not cover it and an agent could mint the
 * dimension it needed itself. The guard below is named and narrow: it
 * refuses this one path, and it says which file it is protecting.
 */
describe("brain_labels cannot rewrite the standing-rules file", () => {
  const LABEL_ATTEMPTS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
    { operation: "assign", path: RULES_REL, dimension: "status", value: "draft" },
    { operation: "remove", path: RULES_REL, dimension: "status" },
  ]);

  for (const args of LABEL_ATTEMPTS) {
    test(`${String(args["operation"])} is refused and the bytes survive`, async () => {
      const out = await callTool("brain_labels", args);
      // An ERROR, not a result: `remove` used to succeed vacuously on a
      // file with no labels, which reported the path back as if the tool
      // had operated on it. And the message has to NAME the file, so a
      // vocabulary complaint cannot pass for this refusal.
      expect(out.result).toBeUndefined();
      expect(out.error?.message ?? "").toContain(BRAIN_STANDING_RULES_FILE);
      expect(onDiskBytes()).toBe(RULES_BYTES);
    });
  }

  test("the guard refuses the path directly and names the file", () => {
    let thrown: unknown;
    try {
      assertStandingRulesNotTargeted(vault, RULES_REL, "test surface");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StandingRulesWriteRefusedError);
    expect((thrown as Error).message).toContain(BRAIN_STANDING_RULES_FILE);
  });

  test("the guard lets every other note through", () => {
    // Narrow by construction: several legitimate callers write into
    // `Brain/` through the same resolver (marker write-back, tombstones,
    // temporal replace), so this guard names one file and no directory.
    expect(() =>
      assertStandingRulesNotTargeted(vault, "Brain/preferences/pref-x.md", "test surface"),
    ).not.toThrow();
  });
});

/**
 * Every `description` string reachable from an input schema, paired with
 * the property path that carries it. Walks nested objects and array
 * items rather than only the top level, because a batch tool hides its
 * per-operation properties one level down.
 */
function schemaDescriptions(schema: unknown, path = ""): Array<[string, string]> {
  if (typeof schema !== "object" || schema === null) return [];
  const out: Array<[string, string]> = [];
  const node = schema as Record<string, unknown>;
  const description = node["description"];
  if (typeof description === "string" && path.length > 0) out.push([path, description]);
  const properties = node["properties"];
  if (typeof properties === "object" && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      out.push(...schemaDescriptions(value, path.length > 0 ? `${path}.${key}` : key));
    }
  }
  out.push(...schemaDescriptions(node["items"], path.length > 0 ? `${path}[]` : "[]"));
  return out;
}

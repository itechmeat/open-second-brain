/**
 * Census: no tool result hands a remote caller an absolute path of this
 * machine (design D14, `src/mcp/brain/device-path.ts`). Every registered
 * tool is called at remote reach, once per value of its operation-like
 * enum argument, with arguments built from its input schema, on an
 * unswitched machine with a vault and on a switched one, and every
 * listed resource is read. Every string of every answer (the structured
 * result, the JSON text block, nested check messages, warnings, error
 * frames, resource bodies) that mentions a path under the fixture's
 * parent (vault, store, state, config and home all hang off it) is a
 * leak. A new field or message that names a host path fails here without
 * a test of its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";

import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { forgetMachineStateCache } from "../../src/core/state/machine-state.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  resetVaultIdentityPins();
  forgetMachineStateCache();
});

/** Tools left out, each with the reason. */
const SKIPPED: Readonly<Record<string, string>> = {};

/** Arguments a tool needs to reach the branch that answers with its paths. */
const SAMPLE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  brain_feedback: { topic: "census", signal: "positive", principle: "Name no host path." },
  brain_pinned_context: { operation: "write", content: "census" },
  brain_note: { text: "census note" },
};

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
};

function sampleOf(schema: Schema | undefined): unknown {
  if (schema?.enum !== undefined) return schema.enum[0];
  const type = Array.isArray(schema?.type) ? schema!.type[0] : schema?.type;
  switch (type) {
    case "string":
      return "census";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "census";
  }
}

/** One argument set per value of the tool's first enum-typed property, else one. */
function argumentSets(tool: ToolDefinition): Array<Record<string, unknown>> {
  const schema = tool.inputSchema as Schema;
  const props = schema.properties ?? {};
  const base: Record<string, unknown> = {};
  for (const name of schema.required ?? []) base[name] = sampleOf(props[name]);
  Object.assign(base, SAMPLE_ARGS[tool.name] ?? {});
  const selector = Object.entries(props).find(
    ([name, prop]) =>
      prop.enum !== undefined && ["operation", "action", "view", "mode"].includes(name),
  );
  if (selector === undefined) return [base];
  const [name, prop] = selector;
  const sets = prop.enum!.map((value) => ({ ...base, [name]: value }));
  const sample = SAMPLE_ARGS[tool.name]?.[name];
  return sample === undefined ? sets : [{ ...base }, ...sets.filter((s) => s[name] !== sample)];
}

async function answer(server: MCPServer, name: string, args: Record<string, unknown>) {
  return await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

/** Every string value below `value`, JSON text blocks parsed too. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        strings(JSON.parse(trimmed), out);
      } catch {
        // prose that happens to open with a brace
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

function leaksOf(e: StoreEnv, label: string, reply: unknown, out: Set<string>): void {
  const roots = [...new Set([e.parent, realpathSync(e.parent)])];
  for (const value of strings(reply)) {
    const root = roots.find((r) => value.includes(r));
    if (root === undefined) continue;
    const at = value.indexOf(root);
    out.add(`${label}: ${value.slice(Math.max(0, at - 40), at + root.length + 60)}`);
  }
}

async function leaks(e: StoreEnv): Promise<string[]> {
  const server = new MCPServer(
    { vault: e.vault, configPath: e.configPath },
    { reach: TRANSPORT_REACH.remote },
  );
  const out = new Set<string>();
  for (const tool of server.tools) {
    if (SKIPPED[tool.name] !== undefined) continue;
    for (const args of argumentSets(tool)) {
      leaksOf(e, tool.name, await answer(server, tool.name, args), out);
    }
  }
  const listed = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/list",
    params: {},
  })) as { result: { resources: Array<{ uri: string }> } };
  expect(listed.result.resources.length).toBeGreaterThan(0);
  for (const { uri } of listed.result.resources) {
    const reply = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri },
    });
    leaksOf(e, uri, reply, out);
  }
  return [...out];
}

describe("remote path census", () => {
  test("no tool answers a remote caller with a host path, before the switch", async () => {
    env = makeStoreEnv("osb-remote-census-legacy-");
    expect(await leaks(env)).toEqual([]);
  }, 120_000);

  test("no tool answers a remote caller with a host path, once switched", async () => {
    env = makeStoreEnv("osb-remote-census-store-", { dualWrite: false });
    switchDevice(env.storeRoot);
    expect(await leaks(env)).toEqual([]);
  }, 120_000);
});

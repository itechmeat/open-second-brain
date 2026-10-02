/**
 * The harness a scoped rule matches is server-derived, and that is
 * measured.
 *
 * The scoped standing rules render the file for the harness that
 * LAUNCHED this server (`o2b mcp --harness`, written by the packager or
 * installer, falling back to `--host-target`). A harness a caller could
 * name in a tool argument would let any caller pick which operator rules
 * it is shown, so no MCP tool input schema, in any tool scope or surface
 * profile, may declare a property whose key spells it. The directory the layer lives in is also never advertised:
 * a tool description naming it would point agents at a target every
 * write path refuses.
 */

import { describe, expect, test } from "bun:test";
import { BRAIN_SCOPED_RULES_DIR } from "../../../src/core/brain/path-constants.ts";
import { TOOL_SURFACE_PROFILES } from "../../../src/mcp/profiles.ts";
import { TOOL_SCOPES, type ToolScope } from "../../../src/mcp/tool-contract.ts";
import { buildToolTable } from "../../../src/mcp/tools.ts";

/** Any property key spelling the harness, in any case or position. */
function isHarnessKey(key: string): boolean {
  return /harness/i.test(key);
}

/**
 * Every live tool table a server can advertise: each tool scope, and the
 * scope behind each named surface profile (a profile only narrows it).
 */
function liveToolTables(): ReadonlyArray<{ readonly label: string; readonly scope: ToolScope }> {
  return [
    ...TOOL_SCOPES.map((scope) => ({ label: `scope ${scope}`, scope })),
    ...Object.entries(TOOL_SURFACE_PROFILES).map(([name, profile]) => ({
      label: `profile ${name}`,
      scope: profile.scope,
    })),
  ];
}

/** Every property key reachable from a JSON schema, with its path. */
function schemaPropertyKeys(schema: unknown, path = ""): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const out: string[] = [];
  const properties = node["properties"];
  if (typeof properties === "object" && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      const here = path.length > 0 ? `${path}.${key}` : key;
      out.push(here, ...schemaPropertyKeys(value, here));
    }
  }
  for (const nested of ["items", "anyOf", "oneOf", "allOf"]) {
    const value = node[nested];
    if (Array.isArray(value)) {
      for (const item of value) out.push(...schemaPropertyKeys(item, path));
    } else {
      out.push(...schemaPropertyKeys(value, path));
    }
  }
  return out;
}

describe("no caller can name the harness", () => {
  test("no live tool input schema declares a harness property in any scope or profile", () => {
    const offenders: string[] = [];
    for (const { label, scope } of liveToolTables()) {
      for (const tool of buildToolTable(scope)) {
        for (const keyPath of schemaPropertyKeys(tool.inputSchema)) {
          const leaf = keyPath.split(".").at(-1) ?? keyPath;
          if (isHarnessKey(leaf)) offenders.push(`${label}: ${tool.name}.${keyPath}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the key check catches every spelling of the harness", () => {
    for (const key of ["harness", "harness_id", "harnessId", "harness_name", "launch_harness"]) {
      expect(isHarnessKey(key)).toBe(true);
    }
    expect(isHarnessKey("host_target")).toBe(false);
  });

  test("no tool description names the scoped rules directory", () => {
    const needle = `${BRAIN_SCOPED_RULES_DIR}/`;
    const offenders: string[] = [];
    for (const tool of buildToolTable("full")) {
      if (tool.name.includes(needle)) offenders.push(`${tool.name} (name)`);
      if (tool.description.includes(needle)) offenders.push(`${tool.name} (description)`);
      if (JSON.stringify(tool.inputSchema).includes(needle)) {
        offenders.push(`${tool.name} (input schema)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

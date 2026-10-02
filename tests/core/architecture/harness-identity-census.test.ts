/**
 * The harness a scoped rule matches is server-derived, and that is
 * measured.
 *
 * The scoped standing rules render the file for the harness that
 * LAUNCHED this server (`o2b mcp --harness`, written by the packager or
 * installer, falling back to `--host-target`). A harness a caller could
 * name in a tool argument would let any caller pick which operator rules
 * it is shown, so no MCP tool input schema may declare a property
 * spelling it. The directory the layer lives in is also never advertised:
 * a tool description naming it would point agents at a target every
 * write path refuses.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BRAIN_SCOPED_RULES_DIR } from "../../../src/core/brain/path-constants.ts";
import { buildToolTable } from "../../../src/mcp/tools.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function readTree(rel: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(join(REPO_ROOT, rel));
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `harness` itself or any `*_harness` / `*Harness` property key. */
function isHarnessKey(key: string): boolean {
  return key === "harness" || key.endsWith("_harness") || key.endsWith("Harness");
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
  test("no live tool input schema declares a harness property", () => {
    const offenders: string[] = [];
    for (const tool of buildToolTable("full")) {
      for (const keyPath of schemaPropertyKeys(tool.inputSchema)) {
        const leaf = keyPath.split(".").at(-1) ?? keyPath;
        if (isHarnessKey(leaf)) offenders.push(`${tool.name}.${keyPath}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no schema property declaration under src/mcp spells the harness", () => {
    // The source half, for schemas a scope or profile hides from the
    // full table: a declaration is a key at the start of a line opening
    // an object, the shape every schema in this tree uses.
    const re = /^\s*(?:"|')?([A-Za-z_]*(?:harness|Harness))(?:"|')?\s*:\s*\{/gm;
    const offenders: string[] = [];
    for (const file of readTree("src/mcp")) {
      for (const match of file.text.matchAll(re)) {
        const key = match[1] ?? "";
        if (isHarnessKey(key)) offenders.push(`${file.path}: ${key}`);
      }
    }
    expect(offenders.toSorted()).toEqual([]);
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

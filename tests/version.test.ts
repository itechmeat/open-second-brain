/**
 * Lock the contract that all manifests carry the same version.
 *
 * Single source of truth: `package.json` `version`. Other files (Hermes
 * plugin.yaml, OpenClaw manifest, Claude/Codex plugin manifests, pyproject.toml)
 * carry a synced copy and are kept aligned by `scripts/sync-version.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_VERSION } from "../src/mcp/protocol.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function canonicalVersion(): string {
  return JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).version;
}

function readYamlVersion(rel: string): string {
  const text = readFileSync(`${ROOT}/${rel}`, "utf8");
  const m = text.match(/^version:\s*"([^"]+)"/m);
  expect(m).not.toBeNull();
  return m![1]!;
}

function readJsonVersion(rel: string): string {
  return JSON.parse(readFileSync(`${ROOT}/${rel}`, "utf8")).version;
}

function readPyprojectVersion(rel: string): string {
  const text = readFileSync(`${ROOT}/${rel}`, "utf8");
  const m = text.match(/^version\s*=\s*"([^"]+)"/m);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("version resolution", () => {
  test("MCP SERVER_VERSION matches package.json", () => {
    expect(SERVER_VERSION).toBe(canonicalVersion());
  });
});

describe("manifest version sync", () => {
  const cases = [
    { kind: "yaml", rel: "plugin.yaml" },
    { kind: "yaml", rel: "plugins/hermes/plugin.yaml" },
    { kind: "json", rel: ".claude-plugin/plugin.json" },
    { kind: "json", rel: ".codex-plugin/plugin.json" },
    { kind: "json", rel: "openclaw.plugin.json" },
    { kind: "pyproject", rel: "pyproject.toml" },
  ] as const;

  for (const { kind, rel } of cases) {
    test(`${rel} matches canonical`, () => {
      const expected = canonicalVersion();
      let actual: string;
      if (kind === "yaml") actual = readYamlVersion(rel);
      else if (kind === "json") actual = readJsonVersion(rel);
      else actual = readPyprojectVersion(rel);
      expect(actual).toBe(expected);
    });
  }
});

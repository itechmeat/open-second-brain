/**
 * Tests for the bundled Grok Build plugin (`plugins/grok/open-second-brain/`).
 *
 * The grok plugin is a static tree (plugin.json + .mcp.json + hooks/hooks.json)
 * whose grok-specific shape is derived from the canonical Claude plugin
 * artifacts (`./.mcp.json`, `./hooks/hooks.json`) by an explicit transform.
 * Grok sets `CLAUDE_PLUGIN_ROOT` as an alias of `GROK_PLUGIN_ROOT` and reads
 * the Claude-shape hook JSON, so the artifacts work under grok almost verbatim;
 * the only divergences are documented grok adjustments.
 *
 * `grok inspect` / `grok plugin validate` are exercised in QA against a live
 * grok. Here the transform is checked, and a sync guard asserts the committed
 * files match it semantically so they cannot drift from their Claude sources
 * (formatting is owned by the project formatter, hence the parsed comparison).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import packageJson from "../../package.json";
import {
  GROK_PLUGIN_DIR_NAME,
  GROK_PLUGIN_REL_PATHS,
  expectedHooks,
  expectedManifest,
  expectedMcp,
  grokPluginSourceDir,
} from "../../src/core/install/grok-plugin-asset.ts";

const LIFECYCLE_EVENTS_REJECTING_MATCHER = [
  "SessionStart",
  "SessionEnd",
  "Stop",
  "UserPromptSubmit",
] as const;

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
}

function committed(relPath: string): unknown {
  return JSON.parse(readFileSync(join(grokPluginSourceDir(), relPath), "utf8"));
}

describe("grok plugin manifest", () => {
  test("names the plugin and mirrors the package version", () => {
    const manifest = expectedManifest();
    expect(manifest["name"]).toBe(GROK_PLUGIN_DIR_NAME);
    expect(manifest["version"]).toBe(packageJson.version);
    expect(typeof manifest["description"]).toBe("string");
  });
});

describe("grok plugin .mcp.json transform", () => {
  test("declares the two canonical servers, PATH-resolved and vault-agnostic", () => {
    const servers = expectedMcp()["mcpServers"] as Record<string, unknown>;
    expect(Object.keys(servers).toSorted()).toEqual([
      "open-second-brain",
      "open-second-brain-writer",
    ]);
    expect(servers["open-second-brain"]).toEqual({ command: "o2b", args: ["mcp"] });
    expect(servers["open-second-brain-writer"]).toEqual({
      command: "o2b",
      args: ["mcp", "--scope", "writer"],
    });
  });

  test("bakes in no vault path, plugin-root token, or Claude-only keys", () => {
    const raw = JSON.stringify(expectedMcp());
    expect(raw).not.toContain("--vault");
    expect(raw).not.toContain("PLUGIN_ROOT");
    expect(raw).not.toContain("alwaysLoad");
  });
});

describe("grok plugin hooks.json transform", () => {
  test("strips the matcher from every event grok rejects a matcher on", () => {
    const hooks = expectedHooks()["hooks"] as Record<string, HookGroup[]>;
    for (const event of LIFECYCLE_EVENTS_REJECTING_MATCHER) {
      for (const group of hooks[event] ?? []) {
        expect(group).not.toHaveProperty("matcher");
      }
    }
  });

  test("keeps the PostToolUse matcher and adds grok's search_replace alias", () => {
    const post = (expectedHooks()["hooks"] as Record<string, HookGroup[]>)["PostToolUse"];
    const fileMutating = post.find((g) => (g.matcher ?? "").includes("Write"));
    expect(fileMutating?.matcher).toContain("search_replace");
    expect(fileMutating?.matcher).toContain("Write");
  });

  test("wires the core lifecycle behaviors through o2b-hook with a PATH fallback", () => {
    const raw = JSON.stringify(expectedHooks());
    expect(raw).toContain("active-inject");
    expect(raw).toContain("post-write-reminder");
    expect(raw).toContain("session-capture");
    expect(raw).toContain("command -v o2b-hook");
  });
});

describe("grok plugin committed tree", () => {
  test("the committed files match the documented set", () => {
    expect([...GROK_PLUGIN_REL_PATHS].toSorted()).toEqual([
      ".mcp.json",
      "hooks/hooks.json",
      "plugin.json",
    ]);
  });

  test("committed files match the transform semantically (sync guard)", () => {
    expect(committed("plugin.json")).toEqual(expectedManifest());
    expect(committed(".mcp.json")).toEqual(expectedMcp());
    expect(committed("hooks/hooks.json")).toEqual(expectedHooks());
  });
});

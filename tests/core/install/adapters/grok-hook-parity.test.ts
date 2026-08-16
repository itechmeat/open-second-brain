/**
 * The grok installer's claim to mirror the plugin's hooks, measured
 * (a-label-is-not-a-boundary review, C9).
 *
 * `src/core/install/grok-asset.ts` says its table mirrors the Claude Code
 * plugin's behaviour. Nothing checked it, and it did not: `SubagentStop`
 * and `PreToolUse` were absent, so a grok install captured nothing from a
 * delegated sub-agent - the headline capability of a unit that shipped in
 * the same release - and ran no orientation gate. `UserPromptSubmit` was
 * missing `nav-inject` on top of that.
 *
 * The existing adapter test asserts `readFileSync(hooksPath()) ===
 * grokHooksJson(payload())`, which is true of any hook set the generator
 * emits, including an empty one. This one derives the expectation from
 * `hooks/hooks.json` - the plugin's own source of truth - so a hook added
 * there is a failure here until grok either registers it or declares why
 * it does not.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { grokHooksJson } from "../../../../src/core/install/grok-asset.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import type { McpPayload } from "../../../../src/core/install/types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PLUGIN_HOOKS_JSON = join(REPO_ROOT, "hooks", "hooks.json");

/**
 * Hooks the plugin registers that grok deliberately does not, keyed
 * `<event>:<hook>`, each with the reason an operator would need.
 *
 * Empty today, and that is the contract: a divergence is a written
 * decision or it is a defect. A stale entry fails too - see the test
 * below - so this cannot become a list of things that used to be true.
 */
const DECLARED_GROK_DIVERGENCES: Readonly<Record<string, string>> = Object.freeze({});

/** `<event>:<hook-script-name>` for every hook one JSON hooks file registers. */
function registeredHooks(hooksJson: string): ReadonlySet<string> {
  const parsed = JSON.parse(hooksJson) as {
    hooks: Record<string, ReadonlyArray<{ hooks: ReadonlyArray<{ command: string }> }>>;
  };
  const out = new Set<string>();
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    for (const group of groups) {
      for (const entry of group.hooks) {
        const name = hookScriptName(entry.command);
        expect(`${event}: ${name}`).not.toContain("<unrecognised>");
        out.add(`${event}:${name}`);
      }
    }
  }
  return out;
}

/**
 * The hook entry point a command invokes, in both shapes this repo writes
 * it: the plugin's `o2b-hook <name>` shell line and grok's absolute
 * `<bun> run <repo>/hooks/<name>.ts`.
 */
function hookScriptName(command: string): string {
  const viaFile = /\/hooks\/([a-z0-9-]+)\.ts\b/.exec(command);
  if (viaFile?.[1] !== undefined) return viaFile[1];
  const viaLauncher = /o2b-hook\s+([a-z0-9-]+)/.exec(command);
  if (viaLauncher?.[1] !== undefined) return viaLauncher[1];
  return "<unrecognised>";
}

function payload(): McpPayload {
  return buildPayload({
    vault: "/tmp/o2b-parity-vault",
    agent_name: "claude-dev-agent",
    timezone: "UTC",
  });
}

describe("grok registers the plugin's hooks", () => {
  const plugin = registeredHooks(readFileSync(PLUGIN_HOOKS_JSON, "utf8"));
  const grok = registeredHooks(grokHooksJson(payload()));

  test("the derivation reads a real hook set, not an empty one", () => {
    // Both floors sit just under the live measurement. Without them a
    // parser that stopped recognising commands would report a clean sweep
    // over two empty sets, which is the failure mode this file replaces.
    expect(plugin.size).toBeGreaterThan(10);
    expect(grok.size).toBeGreaterThan(10);
    expect([...plugin].filter((k) => k.startsWith("SubagentStop:"))).toEqual([
      "SubagentStop:session-capture",
    ]);
  });

  test("every plugin hook is registered for grok or declared as a divergence", () => {
    // Named, not counted: the failure has to say which hook.
    const missing = [...plugin]
      .filter((key) => !grok.has(key))
      .filter((key) => !(key in DECLARED_GROK_DIVERGENCES))
      .toSorted();
    expect(missing).toEqual([]);
  });

  test("the two hooks this review found missing are registered", () => {
    // Pinned by name rather than by count, because "eight events" is a
    // number that goes stale and these two are the capability.
    expect(grok.has("SubagentStop:session-capture")).toBe(true);
    expect(grok.has("PreToolUse:pretool-orient")).toBe(true);
    expect(grok.has("UserPromptSubmit:nav-inject")).toBe(true);
  });

  test("no divergence outlives the hook it excuses", () => {
    const stale = Object.keys(DECLARED_GROK_DIVERGENCES)
      .filter((key) => !plugin.has(key) || grok.has(key))
      .toSorted();
    expect(stale).toEqual([]);
  });

  test("every declared divergence carries a reason", () => {
    for (const [key, reason] of Object.entries(DECLARED_GROK_DIVERGENCES)) {
      expect(`${key}: ${reason.trim().length > 0}`).toBe(`${key}: true`);
    }
  });

  test("grok registers nothing the plugin does not", () => {
    // The complement: a hook grok runs alone would be an install-specific
    // behaviour nobody reading `hooks/hooks.json` could find.
    expect([...grok].filter((key) => !plugin.has(key)).toSorted()).toEqual([]);
  });
});

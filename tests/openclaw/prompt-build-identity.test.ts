/**
 * The OpenClaw per-turn identity reminder names OpenClaw's OWN identity.
 *
 * `register()` hooks `before_prompt_build` and returns a `prependContext`
 * that tells the model which name to log under. That name is derived from
 * the operator's configured name with OpenClaw's vendor token, so Brain
 * activity from this runtime is distinguishable from the operator's other
 * agents on the same host. Handing the operator's name through unchanged
 * would make OpenClaw's writes indistinguishable from theirs.
 *
 * Driven through the real plugin entry with a mock `api`, the same harness
 * `page-search-visibility.test.ts` uses.
 */

import { describe, expect, mock, test } from "bun:test";

/** The plugin SDK is an external at build time and absent at test time. */
mock.module("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

type PromptBuildHandler = () => { prependContext: string } | undefined;

/** Registers the plugin and returns the handler it put on `before_prompt_build`. */
async function promptBuildHandler(agentName: string): Promise<PromptBuildHandler> {
  const handlers = new Map<string, PromptBuildHandler>();
  const entry = (await import("../../src/openclaw/index.ts")).default as {
    register(api: unknown): void;
  };
  entry.register({
    pluginConfig: { vault: ".", agentName },
    on: (event: string, handler: PromptBuildHandler) => handlers.set(event, handler),
    registerTool: () => undefined,
  });
  const handler = handlers.get("before_prompt_build");
  if (handler === undefined) throw new Error("before_prompt_build was not registered");
  return handler;
}

describe("before_prompt_build", () => {
  test("a host-qualified operator name becomes OpenClaw's host-qualified name", async () => {
    const out = (await promptBuildHandler("claude-devbox-agent"))();
    expect(out?.prependContext).toContain("openclaw-devbox-agent");
    expect(out?.prependContext).not.toContain("claude-devbox-agent");
  });

  test("a name outside the template is prefixed with the openclaw token", async () => {
    const out = (await promptBuildHandler("alice"))();
    expect(out?.prependContext).toContain("openclaw-alice");
  });
});

/**
 * `brain_feedback` on a store-only machine that has a vault names the
 * records it wrote as `store:<id>`, as `o2b brain feedback --json` does
 * (tests/cli/store-only-cli-output.test.ts): the write is a store record,
 * so a legacy `Brain/` path would name a file that was never written. An
 * unswitched machine keeps naming its files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { toolBrainFeedback } from "../../src/mcp/brain/feedback-tool.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { switchDevice } from "../core/brain/fixtures/memory-twins.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function context(): ServerContext {
  return {
    vault: env!.vault,
    vaultOrNull: env!.vault,
    configPath: env!.configPath,
    repoRoot: null,
    agentName: "me-agent",
  } as ServerContext;
}

const ARGS = {
  topic: "naming",
  signal: "positive",
  principle: "Name records, not files.",
  force_confirmed: true,
};

const PATH_FIELDS = [
  "signal_path",
  "signal_absolute_path",
  "preference_path",
  "preference_absolute_path",
  "path",
  "absolute_path",
] as const;

describe("brain_feedback record naming", () => {
  test("store-only with a vault: every path field names the store record", async () => {
    env = makeStoreEnv("osb-mcp-fb-store-only-", { dualWrite: false });
    switchDevice(env);
    const out = await toolBrainFeedback(context(), ARGS);
    expect(out["signal_path"]).toBe(`store:${String(out["signal_id"])}`);
    expect(out["signal_absolute_path"]).toBe(`store:${String(out["signal_id"])}`);
    expect(out["preference_absolute_path"]).toBe(`store:${String(out["preference_id"])}`);
    for (const field of PATH_FIELDS) expect(String(out[field])).toMatch(/^store:/);
  });

  test("unswitched: the absolute path names the file that was written", async () => {
    env = makeStoreEnv("osb-mcp-fb-legacy-");
    const out = await toolBrainFeedback(context(), ARGS);
    expect(String(out["signal_path"])).toMatch(/^Brain\/inbox\/sig-/);
    expect(existsSync(String(out["signal_absolute_path"]))).toBe(true);
  });
});

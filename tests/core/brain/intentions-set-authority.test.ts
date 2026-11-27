/**
 * An intention set through an agent tool over a chain an operator's command
 * set, on a machine whose lane pages live in the store (change
 * `tool-lane-write-keeps-standing`, design D5 site 4).
 *
 * The operator's `o2b brain intention set` writes the chain at authority
 * `human`; the agent's `brain_intention set` (channel `mcp-tool`) rewrites
 * it. The rewrite must read back: the new text, the next version, and the
 * prior text in the history trail. The control is the same flow on a
 * machine that has not switched, where the chain is a file.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { ORIGIN_CHANNEL, setOriginChannel } from "../../../src/core/origin-channel.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { buildToolTable, findTool } from "../../../src/mcp/tools.ts";
import type { ServerContext } from "../../../src/mcp/tool-contract.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const SCOPE = "release-review";
const FIRST = "Collect the release notes for the review";
const SECOND = "Walk the reviewers through the release notes";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

/** The server context of the agent's MCP session: the operator's own shell. */
function serverContext(vault: string, configPath: string): ServerContext {
  return { vault, configPath, repoRoot: null, reach: TRANSPORT_REACH.local };
}

/** A machine whose lane pages live in the store: switched, no legacy tree. */
function switchedMachine(prefix: string): StoreEnv {
  const made = makeStoreEnv(prefix, { legacyTree: false });
  // This device's own `device-switched` record, as the migration writes it.
  switchDevice(made.storeRoot);
  expect(storeOnlyMode({ vault: made.vault })).toMatchObject({
    storeOnly: true,
    reason: "device-switched",
  });
  return made;
}

/** A machine that has not switched: a legacy `Brain/` tree, pages are files. */
function unswitchedMachine(prefix: string): StoreEnv {
  const made = makeStoreEnv(prefix);
  expect(storeOnlyMode({ vault: made.vault })).toMatchObject({
    storeOnly: false,
    reason: "legacy",
  });
  return made;
}

/** The operator's own command: `o2b brain intention set`. */
async function setThroughCli(configPath: string): Promise<void> {
  const set = await runCli(
    ["brain", "intention", "set", "--scope", SCOPE, "--text", FIRST, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(set.returncode).toBe(0);
}

async function intention(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await tool("brain_intention").handler(ctx, args)) as Record<string, unknown>;
}

describe("an intention set through an agent tool over an operator's chain", () => {
  for (const machine of ["switched", "unswitched"] as const) {
    const name =
      machine === "switched"
        ? "on a switched machine the new text, version and history read back"
        : "control: on a machine that has not switched the new text reads back";
    test(name, async () => {
      env =
        machine === "switched"
          ? switchedMachine("osb-intention-authority-")
          : unswitchedMachine("osb-intention-authority-legacy-");
      const ctx = serverContext(env.vault, env.configPath);
      await setThroughCli(env.configPath);

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      const set = await intention(ctx, { operation: "set", scope: SCOPE, text: SECOND });
      expect(set["version"]).toBe(2);

      const shown = await intention(ctx, { operation: "show", scope: SCOPE });
      expect({
        present: shown["present"],
        text: shown["text"],
        version: shown["version"],
        historyNamesFirst: ((shown["history"] as string[] | undefined) ?? []).some((line) =>
          line.includes(FIRST),
        ),
      }).toEqual({ present: true, text: SECOND, version: 2, historyNamesFirst: true });
    });
  }
});

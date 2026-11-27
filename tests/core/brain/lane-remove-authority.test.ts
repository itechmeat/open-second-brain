/**
 * A removal or a move made through an agent tool over an entry an
 * operator's command wrote, on a machine whose lane pages live in the
 * store (change `tool-lane-write-keeps-standing`, design D5 site 7).
 *
 * `o2b brain obligation add` and `o2b brain intention set` write their
 * pages at authority `human`. The agent's `brain_obligation remove` and
 * `brain_intention move` (channel `mcp-tool`) retire them: on a store-only
 * machine both are a move (the source's tombstone and the entry at its
 * archive path). The source must be gone on the next read, and the
 * archived obligation must be there. The control is the same flow on a
 * machine that has not switched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { ORIGIN_CHANNEL, setOriginChannel } from "../../../src/core/origin-channel.ts";
import { lanePageExists } from "../../../src/core/store/lane-pages.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { buildToolTable, findTool } from "../../../src/mcp/tools.ts";
import type { ServerContext } from "../../../src/mcp/tool-contract.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const SLUG = "weekly-review";
const SCOPE = "release-review";

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

function machineFor(machine: "switched" | "unswitched", prefix: string): StoreEnv {
  return machine === "switched" ? switchedMachine(prefix) : unswitchedMachine(`${prefix}legacy-`);
}

function caseName(machine: "switched" | "unswitched", what: string): string {
  return machine === "switched"
    ? `on a switched machine ${what}`
    : `control: on a machine that has not switched ${what}`;
}

async function cli(configPath: string, args: string[]): Promise<void> {
  const result = await runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
  expect(result.returncode).toBe(0);
}

async function answer(
  ctx: ServerContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await tool(name).handler(ctx, args)) as Record<string, unknown>;
}

describe("a removal or a move through an agent tool over an operator's entry", () => {
  for (const machine of ["switched", "unswitched"] as const) {
    test(
      caseName(machine, "an obligation removed by the tool leaves the list and is archived"),
      async () => {
        env = machineFor(machine, "osb-obligation-remove-authority-");
        const ctx = serverContext(env.vault, env.configPath);
        await cli(env.configPath, [
          "brain",
          "obligation",
          "add",
          "--title",
          "Weekly Review",
          "--cadence",
          "weekly",
          "--anchor",
          "2026-06-22",
          "--json",
        ]);

        setOriginChannel(ORIGIN_CHANNEL.mcpTool);
        await answer(ctx, "brain_obligation", { operation: "remove", slug: SLUG });

        const listed = await answer(ctx, "brain_obligation", { operation: "list" });
        const slugs = (listed["obligations"] as Array<{ slug: string }>).map((o) => o.slug);
        expect({
          listed: slugs.includes(SLUG),
          archived: lanePageExists(
            env.vault,
            join(env.vault, "Brain", "obligations", "archive", `${SLUG}.md`),
          ),
        }).toEqual({ listed: false, archived: true });
      },
    );

    test(caseName(machine, "an intention moved to history leaves no active chain"), async () => {
      env = machineFor(machine, "osb-intention-move-authority-");
      const ctx = serverContext(env.vault, env.configPath);
      await cli(env.configPath, [
        "brain",
        "intention",
        "set",
        "--scope",
        SCOPE,
        "--text",
        "Collect the release notes for the review",
        "--json",
      ]);

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      await answer(ctx, "brain_intention", { operation: "move", scope: SCOPE });

      const shown = await answer(ctx, "brain_intention", { operation: "show", scope: SCOPE });
      expect(shown["present"]).toBe(false);
    });
  }
});

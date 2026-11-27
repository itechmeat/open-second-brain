/**
 * A pledge re-anchored by the pledge intake tool over a pledge an `o2b`
 * process wrote, on a machine whose lane pages live in the store (change
 * `tool-lane-write-keeps-standing`, design D5 site 3).
 *
 * The `o2b tool-call brain_pledge add` process writes the pledge at
 * authority `human` with no counterparty (the entity it names is not
 * registered yet). Once the operator registers the entity, the agent's
 * `brain_intake_pledges` post of the same pledge (channel `mcp-tool`)
 * re-anchors it: the page's `promised_to` is rewritten to the entity. The
 * rewrite must read back as the intake answered it. The control is the
 * same flow on a machine that has not switched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { ORIGIN_CHANNEL, setOriginChannel } from "../../../src/core/origin-channel.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { buildToolTable, findTool } from "../../../src/mcp/tools.ts";
import type { ServerContext } from "../../../src/mcp/tool-contract.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const SOURCE_REL = "notes/team-meeting.md";
const SOURCE_TEXT = [
  "---",
  "title: Team meeting",
  "---",
  "",
  "We synced on the rollout plan.",
  "",
  "- Ada asked for a written recap of the migration steps.",
].join("\n");
const QUOTE = "Ada asked for a written recap of the migration steps";

const TITLE = "Send Ada the migration recap";
const SLUG = "send-ada-the-migration-recap";
const DUE = "2026-06-25";

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

/** The page the pledge cites: a note of the user's own vault. */
function writeSourcePage(vault: string): void {
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");
}

/** The `o2b` process that writes the pledge: channel `cli`, authority `human`. */
async function addThroughCli(configPath: string): Promise<void> {
  const result = await runCli(
    [
      "tool-call",
      "brain_pledge",
      "--tool-arg",
      "operation=add",
      "--tool-arg",
      `title=${TITLE}`,
      "--tool-arg",
      `due=${DUE}`,
      "--tool-arg",
      `source=${SOURCE_REL}`,
      "--tool-arg",
      `evidence=${JSON.stringify([QUOTE])}`,
      "--tool-arg",
      "agent=claude",
    ],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(result.returncode).toBe(0);
}

/** The operator registers the entity the pledge names: `o2b brain entity set`. */
async function registerEntity(configPath: string): Promise<string> {
  const result = await runCli(
    ["brain", "entity", "set", "people", "Ada Lovelace", "--alias", "Ada", "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(result.returncode).toBe(0);
  return (JSON.parse(result.stdout) as { id: string }).id;
}

describe("a pledge re-anchored by the intake tool over an o2b process's pledge", () => {
  for (const machine of ["switched", "unswitched"] as const) {
    const name =
      machine === "switched"
        ? "on a switched machine the re-anchored counterparty reads back"
        : "control: on a machine that has not switched the re-anchored counterparty reads back";
    test(name, async () => {
      env =
        machine === "switched"
          ? switchedMachine("osb-pledge-reanchor-authority-")
          : unswitchedMachine("osb-pledge-reanchor-authority-legacy-");
      const ctx = serverContext(env.vault, env.configPath);
      writeSourcePage(env.vault);
      await addThroughCli(env.configPath);
      const ada = await registerEntity(env.configPath);

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      const intake = (await tool("brain_intake_pledges").handler(ctx, {
        source: SOURCE_REL,
        agent: "proxy-agent",
        pledges: [{ title: TITLE, due: DUE, evidence: [QUOTE], counterparties: ["Ada"] }],
      })) as { created: string[]; reanchored: string[] };
      expect({ created: intake.created, reanchored: intake.reanchored }).toEqual({
        created: [],
        reanchored: [SLUG],
      });

      const shown = (await tool("brain_pledge").handler(ctx, {
        operation: "show",
        slug: SLUG,
      })) as { pledge?: { promised_to: string[] } };
      expect(shown.pledge?.promised_to).toEqual([ada]);
    });
  }
});

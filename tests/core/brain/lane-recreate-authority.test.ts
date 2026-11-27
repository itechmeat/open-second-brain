/**
 * A create made through an agent tool at a path whose entry an `o2b`
 * process removed, on a machine whose lane pages live in the store (change
 * `tool-lane-write-keeps-standing`, design D5 site 8).
 *
 * The removal's tombstone is written at authority `human`. The agent's add
 * (channel `mcp-tool`) of the same obligation title, or of the same pledge
 * (title, due date and source), writes the entry at that path again: it
 * must read back as the tool answered it, as on a machine that has not
 * switched, where the removal emptied the place the create writes into.
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

const OBLIGATION_SLUG = "weekly-review";

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
const PLEDGE_TITLE = "Recap the migration";
const PLEDGE_SLUG = "recap-the-migration";
const PLEDGE_DUE = "2026-06-25";

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

/** The pledge arguments of an add, as the tool and `o2b tool-call` take them. */
const PLEDGE_ADD: Record<string, string> = {
  operation: "add",
  title: PLEDGE_TITLE,
  due: PLEDGE_DUE,
  source: SOURCE_REL,
  evidence: JSON.stringify([QUOTE]),
  agent: "claude",
};

/** `o2b tool-call brain_pledge` with `args`: channel `cli`, authority `human`. */
async function pledgeThroughCli(configPath: string, args: Record<string, string>): Promise<void> {
  const argv = ["tool-call", "brain_pledge"];
  for (const [key, value] of Object.entries(args)) argv.push("--tool-arg", `${key}=${value}`);
  await cli(configPath, argv);
}

describe("a create through an agent tool over an entry an o2b process removed", () => {
  for (const machine of ["switched", "unswitched"] as const) {
    test(caseName(machine, "an obligation added again reads back"), async () => {
      env = machineFor(machine, "osb-obligation-recreate-authority-");
      const ctx = serverContext(env.vault, env.configPath);
      const add = [
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
      ];
      await cli(env.configPath, add);
      await cli(env.configPath, [
        "brain",
        "obligation",
        "remove",
        "--slug",
        OBLIGATION_SLUG,
        "--json",
      ]);

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      const added = await answer(ctx, "brain_obligation", {
        operation: "add",
        title: "Weekly Review",
        cadence: "weekly",
        anchor: "2026-06-29",
      });
      expect((added["obligation"] as { slug: string }).slug).toBe(OBLIGATION_SLUG);

      const shown = await answer(ctx, "brain_obligation", {
        operation: "show",
        slug: OBLIGATION_SLUG,
      });
      const listed = await answer(ctx, "brain_obligation", { operation: "list" });
      expect({
        shown: shown["present"] === true,
        nextDue: (shown["obligation"] as { next_due?: string } | undefined)?.next_due,
        listed: (listed["obligations"] as Array<{ slug: string }>).some(
          (o) => o.slug === OBLIGATION_SLUG,
        ),
      }).toEqual({ shown: true, nextDue: "2026-06-29", listed: true });
    });

    test(caseName(machine, "a pledge added again reads back"), async () => {
      env = machineFor(machine, "osb-pledge-recreate-authority-");
      const ctx = serverContext(env.vault, env.configPath);
      mkdirSync(join(env.vault, "notes"), { recursive: true });
      writeFileSync(join(env.vault, SOURCE_REL), SOURCE_TEXT, "utf8");
      await pledgeThroughCli(env.configPath, PLEDGE_ADD);
      await pledgeThroughCli(env.configPath, { operation: "remove", slug: PLEDGE_SLUG });

      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      const added = await answer(ctx, "brain_pledge", { ...PLEDGE_ADD, evidence: [QUOTE] });
      expect((added["pledge"] as { slug: string }).slug).toBe(PLEDGE_SLUG);

      const shown = await answer(ctx, "brain_pledge", { operation: "show", slug: PLEDGE_SLUG });
      expect({
        present: shown["present"] !== false,
        slug: (shown["pledge"] as { slug?: string } | undefined)?.slug,
      }).toEqual({ present: true, slug: PLEDGE_SLUG });
    });
  }
});

/**
 * A fulfilment made through an agent tool, on a machine whose lane pages
 * live in the store (design D14 items 1 and 4).
 *
 * A pledge page is a lane entry, and a lane entry is a register resolved by
 * authority, then clock (`src/core/store/fold.ts`). The write takes the
 * authority of the process that made it (`authorityFromOrigin`,
 * `src/core/store/dual-write.ts`): an `o2b` process is `cli`, so its write
 * is `human`; an agent's tool call is `agent`. A fulfilment an agent makes
 * to a pledge a human wrote therefore lands as an `agent` record, and the
 * `human` version stays the winner of the register: the tool answers the
 * fulfilled page it computed in memory, the next read shows an open pledge,
 * and a second fulfilment is accepted again.
 *
 * The cases below are the seams a user sees: the `o2b` process that wrote
 * the pledge (channel `cli`, authority `human`), the agent's tool call
 * (`brain_pledge fulfill`, channel `mcp-tool`, authority `agent`), and the
 * read that follows. The controls are the two flows that must keep working:
 * the same fulfilment made through an `o2b` process, and the same
 * fulfilment on a machine that has not switched (where the page is a file,
 * not a register).
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

const TITLE = "Recap the migration";
const SLUG = "recap-the-migration";
const DUE = "2026-06-25";
/** The fulfilment date the agent's tool call records. */
const FULFILLED = "2026-06-22";

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

/** The pledge page a `brain_pledge` answer carries. */
interface PledgeAnswer {
  readonly operation: string;
  readonly present?: boolean;
  readonly pledge: {
    readonly slug: string;
    readonly due: string;
    readonly fulfilled: string | null;
  };
}

async function pledgeAnswer(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<PledgeAnswer> {
  return (await tool("brain_pledge").handler(ctx, args)) as PledgeAnswer;
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

/** The page the pledge cites: a note of the user's own vault. */
function writeSourcePage(vault: string): void {
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");
}

/**
 * The `o2b` process that writes the pledge: `o2b tool-call brain_pledge`
 * runs the tool handler in a command-line process, so the origin channel
 * is `cli` and the write carries the authority `human`.
 */
async function pledgeThroughCli(
  configPath: string,
  operation: "add" | "fulfill",
): Promise<Record<string, unknown>> {
  const args = ["tool-call", "brain_pledge", "--tool-arg", `operation=${operation}`];
  if (operation === "add") {
    args.push(
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
    );
  } else {
    args.push("--tool-arg", `slug=${SLUG}`, "--tool-arg", `date=${FULFILLED}`);
  }
  const result = await runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
  expect(result.returncode).toBe(0);
  // The tool-call bridge prints the MCP tool result; its `structuredContent`
  // is the tool's own answer.
  const parsed = JSON.parse(result.stdout) as { structuredContent?: Record<string, unknown> };
  return parsed.structuredContent ?? {};
}

describe("a pledge fulfilled through an agent tool", () => {
  test("on a switched machine the fulfilment of a human-written pledge is kept", async () => {
    env = switchedMachine("osb-pledge-authority-");
    const ctx = serverContext(env.vault, env.configPath);
    writeSourcePage(env.vault);

    // The `o2b` process that wrote the pledge: authority `human`.
    const added = await pledgeThroughCli(env.configPath, "add");
    expect((added["pledge"] as { slug: string }).slug).toBe(SLUG);

    // The agent's tool call: the same page, written at authority `agent`.
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const fulfilled = await pledgeAnswer(ctx, {
      operation: "fulfill",
      slug: SLUG,
      date: FULFILLED,
    });
    // The answer is the page computed in memory.
    expect(fulfilled.pledge.fulfilled).toBe(FULFILLED);

    // The read that follows: a fresh fold of the store's lane register.
    const shown = await pledgeAnswer(ctx, { operation: "show", slug: SLUG });
    expect(shown.pledge).toMatchObject({ slug: SLUG, fulfilled: FULFILLED });
  });

  test("on a switched machine a second fulfilment is refused as already fulfilled", async () => {
    env = switchedMachine("osb-pledge-authority-retry-");
    const ctx = serverContext(env.vault, env.configPath);
    writeSourcePage(env.vault);

    await pledgeThroughCli(env.configPath, "add");

    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    await pledgeAnswer(ctx, { operation: "fulfill", slug: SLUG, date: FULFILLED });

    // The pledge is fulfilled: a second fulfilment is refused. A second
    // fulfilment that is accepted again is the symptom of the fulfilment
    // having been discarded.
    await expect(
      pledgeAnswer(ctx, { operation: "fulfill", slug: SLUG, date: FULFILLED }),
    ).rejects.toThrow(/already fulfilled/);
  });

  test("control: the same fulfilment through an o2b process is kept", async () => {
    env = switchedMachine("osb-pledge-authority-cli-");
    const ctx = serverContext(env.vault, env.configPath);
    writeSourcePage(env.vault);

    await pledgeThroughCli(env.configPath, "add");

    // The `o2b` process again: the channel is `cli`, the authority `human`,
    // the same authority the pledge was written at.
    const fulfilled = await pledgeThroughCli(env.configPath, "fulfill");
    expect((fulfilled["pledge"] as { fulfilled: string }).fulfilled).toBe(FULFILLED);

    const shown = await pledgeAnswer(ctx, { operation: "show", slug: SLUG });
    expect(shown.pledge).toMatchObject({ slug: SLUG, fulfilled: FULFILLED });
  });

  test("control: on a machine that has not switched the fulfilment is kept", async () => {
    // A vault with a legacy `Brain/` tree: the page is a file, and the read
    // comes from the file, not from a register.
    env = makeStoreEnv("osb-pledge-authority-legacy-");
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({
      storeOnly: false,
      reason: "legacy",
    });
    const ctx = serverContext(env.vault, env.configPath);
    writeSourcePage(env.vault);

    await pledgeThroughCli(env.configPath, "add");

    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const fulfilled = await pledgeAnswer(ctx, {
      operation: "fulfill",
      slug: SLUG,
      date: FULFILLED,
    });
    expect(fulfilled.pledge.fulfilled).toBe(FULFILLED);

    const shown = await pledgeAnswer(ctx, { operation: "show", slug: SLUG });
    expect(shown.pledge).toMatchObject({ slug: SLUG, fulfilled: FULFILLED });
  });
});

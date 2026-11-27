/**
 * A completion made through an agent tool, on a machine whose lane pages
 * live in the store (design D14 items 1 and 4).
 *
 * A lane entry is a register resolved by authority, then clock
 * (`src/core/store/fold.ts`), and a lane write takes the authority of the
 * process that made it (`authorityFromOrigin`,
 * `src/core/store/dual-write.ts`): an operator's command is `human`, an
 * agent's tool call is `agent`. A completion an agent makes to an obligation
 * a human wrote therefore lands as an `agent` record, and the `human`
 * version stays the winner of the register. The tool answers the completed
 * page it computed in memory, the next read shows the old next-due, and a
 * retry completes again.
 *
 * The cases below are the seams a user sees: the operator's own command
 * (`o2b brain obligation add`, channel `cli`, authority `human`), the
 * agent's tool call (`brain_obligation done`, channel `mcp-tool`,
 * authority `agent`), and the read that follows. The controls are the two
 * flows that must keep working: the same completion made through the
 * command line, and the same completion on a machine that has not switched
 * (where the page is a file, not a register).
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

/** The anchor the operator's add writes; the first due date. */
const ANCHOR = "2026-06-22";
/** The completion date the agent's tool call records. */
const DONE = "2026-06-22";
/** One weekly cadence past the completion date. */
const NEXT_DUE = "2026-06-29";
const SLUG = "weekly-review";

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

/** The obligation page a `brain_obligation` answer carries. */
interface ObligationAnswer {
  readonly operation: string;
  readonly present?: boolean;
  readonly obligation: {
    readonly slug: string;
    readonly next_due: string;
    readonly last_done: string | null;
    readonly completions: ReadonlyArray<string>;
  };
}

async function obligationAnswer(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ObligationAnswer> {
  return (await tool("brain_obligation").handler(ctx, args)) as ObligationAnswer;
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

/** The operator's own command: `o2b brain obligation add`. */
async function addThroughCli(configPath: string): Promise<void> {
  const added = await runCli(
    [
      "brain",
      "obligation",
      "add",
      "--title",
      "Weekly Review",
      "--cadence",
      "weekly",
      "--anchor",
      ANCHOR,
      "--json",
    ],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(added.returncode).toBe(0);
  expect(JSON.parse(added.stdout).obligation.next_due).toBe(ANCHOR);
}

describe("an obligation completed through an agent tool", () => {
  test("on a switched machine the completion of a human-written obligation is kept", async () => {
    env = switchedMachine("osb-obligation-authority-");
    const ctx = serverContext(env.vault, env.configPath);

    // The operator's own shell: the entry is written at authority `human`.
    await addThroughCli(env.configPath);

    // The agent's tool call: the same page, written at authority `agent`.
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const done = await obligationAnswer(ctx, { operation: "done", slug: SLUG, date: DONE });
    // The answer is the page computed in memory.
    expect(done.obligation.next_due).toBe(NEXT_DUE);
    expect(done.obligation.last_done).toBe(DONE);

    // The read that follows: a fresh fold of the store's lane register.
    const shown = await obligationAnswer(ctx, { operation: "show", slug: SLUG });
    expect(shown.obligation).toMatchObject({
      next_due: NEXT_DUE,
      last_done: DONE,
      completions: [DONE],
    });
  });

  test("on a switched machine a retry does not complete the obligation again", async () => {
    env = switchedMachine("osb-obligation-authority-retry-");
    const ctx = serverContext(env.vault, env.configPath);

    await addThroughCli(env.configPath);

    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    await obligationAnswer(ctx, { operation: "done", slug: SLUG, date: DONE });
    // The retry: the same completion the agent already made.
    await obligationAnswer(ctx, { operation: "done", slug: SLUG, date: DONE });

    // The entry stands one cadence past the completion date, not two, and
    // the completion is not lost: a retry that "completes again" is the
    // symptom of the completion being discarded every time.
    const after = await obligationAnswer(ctx, { operation: "show", slug: SLUG });
    expect(after.obligation).toMatchObject({
      next_due: NEXT_DUE,
      last_done: DONE,
    });
  });

  test("control: the same completion through the command line is kept", async () => {
    env = switchedMachine("osb-obligation-authority-cli-");
    const ctx = serverContext(env.vault, env.configPath);

    await addThroughCli(env.configPath);

    // The operator's own command again: the channel is `cli`, the authority
    // `human`, the same authority the entry was written at.
    const done = await runCli(
      ["brain", "obligation", "done", "--slug", SLUG, "--date", DONE, "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: env.configPath } },
    );
    expect(done.returncode).toBe(0);
    expect(JSON.parse(done.stdout).obligation.next_due).toBe(NEXT_DUE);

    const shown = await obligationAnswer(ctx, { operation: "show", slug: SLUG });
    expect(shown.obligation.next_due).toBe(NEXT_DUE);
    expect(shown.obligation.last_done).toBe(DONE);
    expect(shown.obligation.completions).toEqual([DONE]);
  });

  test("control: on a machine that has not switched the completion is kept", async () => {
    // A vault with a legacy `Brain/` tree: the page is a file, and the read
    // comes from the file, not from a register.
    env = makeStoreEnv("osb-obligation-authority-legacy-");
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({
      storeOnly: false,
      reason: "legacy",
    });
    const ctx = serverContext(env.vault, env.configPath);

    await addThroughCli(env.configPath);

    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const done = await obligationAnswer(ctx, { operation: "done", slug: SLUG, date: DONE });
    expect(done.obligation.next_due).toBe(NEXT_DUE);

    const shown = await obligationAnswer(ctx, { operation: "show", slug: SLUG });
    expect(shown.obligation.next_due).toBe(NEXT_DUE);
    expect(shown.obligation.last_done).toBe(DONE);
    expect(shown.obligation.completions).toEqual([DONE]);
  });
});

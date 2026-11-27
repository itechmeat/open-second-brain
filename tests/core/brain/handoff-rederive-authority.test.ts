/**
 * A handoff note re-derived in place by an agent's process over a note an
 * `o2b` process wrote, on a machine whose lane pages live in the store
 * (change `tool-lane-write-keeps-standing`, design D5 site 5).
 *
 * `o2b brain handoff <session-file>` writes the note at authority `human`;
 * the targeted-recompile executor re-derives it at the same path
 * (`writeHandoffNote` with `targetPath`) from the agent's process (channel
 * `mcp-tool`). The re-derived note must read back. The control is the same
 * flow on a machine that has not switched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeHandoffNote } from "../../../src/core/brain/handoff.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";
import { ORIGIN_CHANNEL, setOriginChannel } from "../../../src/core/origin-channel.ts";
import { readLaneText } from "../../../src/core/store/lane-pages.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const SESSION_ID = "handoff-review";
const FIRST_REQUEST = "Please summarise the release checklist for the team.";
const SECOND_REQUEST = "Please draft the rollback runbook for the migration.";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

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

/** A recorded session of two turns, in the Claude Code JSONL shape. */
function writeSession(parent: string): string {
  const path = join(parent, "session.jsonl");
  const lines = [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-22T09:00:00Z",
      message: { role: "user", content: FIRST_REQUEST },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-22T09:01:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "Done: checklist sent." }] },
    },
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

/** The turns the recompile executor re-derives the note from. */
const SECOND_TURNS: SessionTurn[] = [
  { turnId: "u2", timestamp: "2026-06-22T10:00:00Z", role: "user", text: SECOND_REQUEST },
  {
    turnId: "a2",
    timestamp: "2026-06-22T10:01:00Z",
    role: "assistant",
    text: "Done: runbook drafted.",
  },
];

describe("a handoff note re-derived in place over an o2b process's note", () => {
  for (const machine of ["switched", "unswitched"] as const) {
    const name =
      machine === "switched"
        ? "on a switched machine the re-derived note reads back"
        : "control: on a machine that has not switched the re-derived note reads back";
    test(name, async () => {
      env =
        machine === "switched"
          ? switchedMachine("osb-handoff-authority-")
          : unswitchedMachine("osb-handoff-authority-legacy-");
      const session = writeSession(env.parent);
      const written = await runCli(
        ["brain", "handoff", session, "--format", "claude", "--session-id", SESSION_ID, "--json"],
        { env: { OPEN_SECOND_BRAIN_CONFIG: env.configPath } },
      );
      expect(written.returncode).toBe(0);
      const path = (JSON.parse(written.stdout) as { path: string }).path;
      expect(readLaneText(env.vault, path)).toContain(FIRST_REQUEST);

      // The agent's process: the recompile executor's call.
      setOriginChannel(ORIGIN_CHANNEL.mcpTool);
      writeHandoffNote(env.vault, {
        turns: SECOND_TURNS,
        sessionId: SESSION_ID,
        agent: "recompile",
        targetPath: path,
      });

      const text = readLaneText(env.vault, path) ?? "";
      expect({
        second: text.includes(SECOND_REQUEST),
        first: text.includes(FIRST_REQUEST),
      }).toEqual({ second: true, first: false });
    });
  }
});

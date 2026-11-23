/**
 * Shared fixture of the launched agent's tests (change
 * `dream-launched-agent`): a temp store whose dream owner is this device
 * (`closedFixture`), the process pinned to that device's id and state
 * base so a started server opens the same store, a fixture text
 * operation, and the fake agent's command.
 */
import { join } from "node:path";

import type { DreamAgentCommand } from "../../../../src/core/brain/dream-queue/agent-config.ts";
import { recordDreamAgentVerification } from "../../../../src/core/brain/dream-queue/agent-verified.ts";
import { ROLLUP_SUMMARY_OPERATION } from "../../../../src/core/brain/dream-queue/rollup-work.ts";
import { produceWork, type ProduceSpec } from "../../../../src/core/brain/dream-queue/queue.ts";
import { readDreamOwner } from "../../../../src/core/brain/dream-owner/owner.ts";
import type { DreamOwner } from "../../../../src/core/brain/dream-owner/fold.ts";
import { closedFixture, type ClosedFixture } from "../../topics/fixtures/closed-fixture.ts";
import { homeEnv } from "../../../helpers/platform.ts";

/**
 * The text operation the sessions answer: the rollup summary, a real
 * operation, since the started server is another process and knows only
 * what production registers. Items of a rung above `fact` keep their input.
 */
export const AGENT_TEXT = ROLLUP_SUMMARY_OPERATION;
export const FAKE_AGENT = join(import.meta.dir, "..", "..", "..", "helpers", "fake-dream-agent.ts");

const PINNED = ["O2B_DEVICE_ID", "XDG_STATE_HOME", "LOCALAPPDATA"] as const;

export interface AgentFixture {
  readonly f: ClosedFixture;
  owner(): DreamOwner;
  /** Queue one text item for `subject`. */
  text(subject: string, sources?: ProduceSpec["sources"]): string;
  /** The fake agent's command in `mode`. */
  command(mode: string): DreamAgentCommand;
  /** The environment naming `command` (and fallbacks) as the dream agent. */
  env(
    command: DreamAgentCommand,
    extra?: Record<string, string>,
    fallbacks?: DreamAgentCommand[],
  ): Record<string, string | undefined>;
  verify(command: DreamAgentCommand): void;
  cleanup(): void;
}

export function agentFixture(): AgentFixture {
  const f = closedFixture();
  // The worker and the server it starts run on the wall clock.
  f.setClock(Date.now());
  const before = Object.fromEntries(PINNED.map((k) => [k, process.env[k]]));
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env["XDG_STATE_HOME"] = join(f.m.parent, "state", "dev-a");
  process.env["LOCALAPPDATA"] = join(f.m.parent, "state", "dev-a");
  return {
    f,
    owner: () => readDreamOwner(f.a).owner!,
    text(subject, sources = ["shared"]) {
      return produceWork(f.queue, {
        operation: AGENT_TEXT,
        subject: `rung:week->month/${subject}`,
        occurrence: `2026-12-01/${subject}`,
        input: subject,
        prompt_version: "1",
        schema_version: "1",
        answer_schema: { type: "text" },
        after: [],
        resources: [],
        evidence: [`ev-${subject}`],
        payload: {
          tier: "week",
          produces: "month",
          prompt: `Summarise ${subject}.`,
          target_path: `Brain/rollups/month/${subject}.md`,
        },
        sources,
      }).id;
    },
    command: (mode) => ({
      label: "custom",
      preset: null,
      program: process.execPath,
      args: [FAKE_AGENT, "{mcp_config}", mode, "{prompt}"],
    }),
    env(command, extra = {}, fallbacks = []) {
      const childHome = join(f.m.parent, "home", "dream-agent");
      const stateHome = join(f.m.parent, "state", "dev-a");
      return {
        ...process.env,
        ...homeEnv(childHome),
        XDG_CONFIG_HOME: join(f.m.parent, "config"),
        XDG_DATA_HOME: join(f.m.parent, "data"),
        XDG_STATE_HOME: stateHome,
        XDG_CACHE_HOME: join(f.m.parent, "cache"),
        LOCALAPPDATA: stateHome,
        OPEN_SECOND_BRAIN_CONFIG: f.configPath,
        OPEN_SECOND_BRAIN_STORE_ROOT: f.a.root,
        VAULT_DIR: f.vault,
        OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND: JSON.stringify([command.program, ...command.args]),
        ...(fallbacks.length > 0
          ? {
              OPEN_SECOND_BRAIN_DREAM_AGENT_FALLBACKS: JSON.stringify(
                fallbacks.map((c) => [c.program, ...c.args]),
              ),
            }
          : {}),
        ...extra,
      };
    },
    verify(command) {
      recordDreamAgentVerification(command, {
        agent: command.label,
        model: "fake-model-1",
        programVersion: null,
      });
    },
    cleanup() {
      for (const k of PINNED) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
      f.cleanup();
    },
  };
}

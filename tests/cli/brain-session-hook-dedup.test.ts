/**
 * Signal capture and dedup on the hook path, on the unswitched and the
 * switched layout.
 *
 * `o2b brain session-hook` replays a `brain_feedback` call from the
 * host's PostToolUse payload through the shared signal dedup hash (topic,
 * sign, principle, scope). A host names the MCP tool with its server
 * prefix (`mcp__<server>__brain_feedback` in Claude Code), and the replay
 * used to compare the bare name only, so a real host's payload created
 * nothing: `created=0 deduped=0`, the field check's result. The replay now
 * takes the decorated names, a repeat counts as deduped, and the live call
 * stamps the same hash, so the hook's replay of a call the live tool
 * already wrote is a dedup, not a second signal.
 *
 * An explicit `o2b brain feedback` (or MCP `brain_feedback`) call with a
 * principle identical to an existing signal writes a second signal by
 * design: each explicit call is one more observation of the rule, and
 * only a retry that carries the same `idempotency_key` is a no-op.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSignals } from "../../src/core/store/read/signals.ts";
import { memoryFromStore } from "../../src/core/store/read/memory-ids.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The name Claude Code gives the writer server's tool in a hook payload. */
const CLAUDE_TOOL = "mcp__plugin_open-second-brain_open-second-brain-writer__brain_feedback";

const INPUT = {
  topic: "hook-dedup-probe",
  signal: "negative",
  principle: "Never report a hook capture as working without a created signal.",
};

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function layout(switched: boolean): StoreEnv {
  env = makeStoreEnv("o2b-hook-dedup-", { dualWrite: true });
  if (switched) switchDevice(env.storeRoot);
  expect(memoryFromStore(env.vault)).toBe(switched);
  return env;
}

function postToolUse(toolName: string): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "hook-dedup-session",
    cwd: "/tmp",
    tool_name: toolName,
    tool_input: INPUT,
    tool_response: { content: [{ type: "text", text: "{}" }] },
  });
}

async function sessionHook(toolName: string): Promise<Record<string, unknown>> {
  const r = await runCli(["brain", "session-hook", "--json"], {
    env: cliEnv(),
    stdin: postToolUse(toolName),
  });
  expect(r.returncode).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** The test's config, so every CLI run writes the test's vault and store. */
function cliEnv(): Record<string, string> {
  return { OPEN_SECOND_BRAIN_CONFIG: env!.configPath };
}

async function explicitFeedback(): Promise<void> {
  const r = await runCli(
    [
      "brain",
      "feedback",
      "--topic",
      INPUT.topic,
      "--signal",
      INPUT.signal,
      "--principle",
      INPUT.principle,
    ],
    { env: cliEnv() },
  );
  expect(r.returncode).toBe(0);
}

function probeSignals(vault: string): number {
  return readSignals({ vault }, { states: "all" }).filter(
    (s) => s.frontmatter["topic"] === INPUT.topic,
  ).length;
}

for (const switched of [false, true]) {
  const name = switched ? "switched" : "unswitched";

  describe(`session-hook signal dedup, ${name} layout`, () => {
    test("a host's decorated tool name creates the signal, and its repeat is deduped", async () => {
      const { vault } = layout(switched);
      const first = await sessionHook(CLAUDE_TOOL);
      expect(first["signals_created"]).toBe(1);
      expect(first["signals_deduped"]).toBe(0);
      const repeat = await sessionHook(CLAUDE_TOOL);
      expect(repeat["signals_created"]).toBe(0);
      expect(repeat["signals_deduped"]).toBe(1);
      // The bare name (a host that does not prefix) dedups against it too.
      const bare = await sessionHook("brain_feedback");
      expect(bare["signals_deduped"]).toBe(1);
      expect(probeSignals(vault)).toBe(1);
    });

    test("the hook's replay of a call the live tool already wrote is a dedup", async () => {
      const { vault } = layout(switched);
      await explicitFeedback();
      expect(probeSignals(vault)).toBe(1);
      const replay = await sessionHook(CLAUDE_TOOL);
      expect(replay["signals_created"]).toBe(0);
      expect(replay["signals_deduped"]).toBe(1);
      expect(probeSignals(vault)).toBe(1);
    });

    test("an explicit feedback call with an identical principle records one more signal", async () => {
      const { vault } = layout(switched);
      await explicitFeedback();
      await explicitFeedback();
      expect(probeSignals(vault)).toBe(2);
    });

    test("a tool other than brain_feedback, or a failed call, creates nothing", async () => {
      const { vault } = layout(switched);
      expect((await sessionHook("mcp__other__brain_feedback_extra"))["signals_created"]).toBe(0);
      const failed = await runCli(["brain", "session-hook", "--json"], {
        env: cliEnv(),
        stdin: JSON.stringify({
          ...(JSON.parse(postToolUse(CLAUDE_TOOL)) as object),
          tool_response: { isError: true, content: [{ type: "text", text: "refused" }] },
        }),
      });
      expect(JSON.parse(failed.stdout)["signals_created"]).toBe(0);
      expect(probeSignals(vault)).toBe(0);
    });
  });
}

/**
 * The hook registration: the PostToolUse group that runs session-capture
 * must fire for the tool a host actually names. Both hosts read a matcher
 * of only name characters as an exact list, which no `mcp__` name equals,
 * and anything else as an unanchored regex (Claude Code's documented
 * matcher rule; Codex's `codex-rs/hooks/src/engine/matcher.rs`).
 */
describe("the session-capture PostToolUse matcher", () => {
  const files = [
    join(REPO, "hooks", "hooks.json"),
    join(REPO, "plugins", "codex", "hooks", "hooks.json"),
  ];

  function captureMatcher(file: string): string {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const group = parsed.hooks.PostToolUse.find((g) =>
      g.hooks.some((h) => h.command.includes("session-capture")),
    );
    expect(group).toBeDefined();
    return group!.matcher;
  }

  function claudeMatches(matcher: string, name: string): boolean {
    if (/^[A-Za-z0-9_\- ,|]*$/.test(matcher)) {
      return matcher.split(/[|,]/).some((candidate) => candidate.trim() === name);
    }
    return new RegExp(matcher).test(name);
  }

  function codexMatches(matcher: string, name: string): boolean {
    if (/^[A-Za-z0-9_|]*$/.test(matcher)) return matcher.split("|").includes(name);
    return new RegExp(matcher).test(name);
  }

  for (const file of files) {
    test(`${file.slice(REPO.length + 1)} selects brain_feedback under every host's name`, () => {
      const matcher = captureMatcher(file);
      for (const matches of [claudeMatches, codexMatches]) {
        expect(matches(matcher, CLAUDE_TOOL)).toBe(true);
        expect(matches(matcher, "mcp__open-second-brain__brain_feedback")).toBe(true);
        expect(matches(matcher, "brain_feedback")).toBe(true);
        expect(matches(matcher, "brain_feedback_extra")).toBe(false);
        expect(matches(matcher, "Write")).toBe(false);
      }
    });
  }
});

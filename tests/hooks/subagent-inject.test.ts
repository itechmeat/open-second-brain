/**
 * The PostToolUse subagent carrier (context-injection-pipeline, A2):
 * delivers the operator's standing-rules block into a delegated
 * sub-agent's first write-shaped tool call, once per agent id per
 * session-scope ledger, and stays silent everywhere else.
 *
 * Spawn-based like its carrier siblings: the contract under test is the
 * process boundary (payload in, at most one stdout line out), not the
 * module surface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEDGER_KEY_SUBAGENT_INJECT,
  SUBAGENT_SET_MAX,
  readSubagentDeliveredIds,
  recordSubagentDeliveredId,
} from "../../hooks/lib/injection-ledger.ts";
import { renderStandingBlock } from "../../hooks/lib/standing-block.ts";
import { hookStateFilePath } from "../../hooks/lib/session-state.ts";
import { STANDING_RULES_MAX_CHARS_DEFAULT } from "../../src/core/brain/standing-rules.ts";
import { CHMOD_CANNOT_DENY, homeEnv } from "../helpers/platform.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "subagent-inject.ts",
);

const SESSION = "subagent-session-0001";
const AGENT = "agent-aaaa";
const TOOL_USE_ID = "toolu-01";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-subagent-inject-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-subagent-inject-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeRules(body: string): string {
  const path = join(vault, "Brain", "standing-rules.md");
  writeFileSync(path, body, "utf8");
  return path;
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(configHome),
      VAULT_DIR: vault,
      ...env,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

/** A write-shaped PostToolUse payload as Claude Code sends it from inside a sub-agent. */
function subagentPayload(
  opts: { agentId?: string; toolName?: string } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    tool_name: opts.toolName ?? "Write",
    tool_input: { file_path: join(vault, "notes.txt") },
    tool_use_id: TOOL_USE_ID,
    cwd: vault,
  };
  if (opts.agentId !== undefined) payload["agent_id"] = opts.agentId;
  return payload;
}

function expectedBlock(): string {
  return renderStandingBlock(vault, STANDING_RULES_MAX_CHARS_DEFAULT);
}

describe("subagent-inject hook", () => {
  test("a payload without a non-empty agent_id emits nothing", async () => {
    writeRules("Always run the test suite before committing.");
    const missing = await runHook(subagentPayload());
    expect(missing.exit).toBe(0);
    expect(missing.stdout).toBe("");
    const empty = await runHook(subagentPayload({ agentId: "" }));
    expect(empty.exit).toBe(0);
    expect(empty.stdout).toBe("");
  });

  test("the first write-shaped subagent call delivers exactly one additionalContext line", async () => {
    writeRules("Always run the test suite before committing.");
    const first = await runHook(subagentPayload({ agentId: AGENT }));
    expect(first.exit).toBe(0);
    expect(first.stderr).toBe("");
    // Exactly one line: the JSON object and its single trailing newline.
    expect(first.stdout.endsWith("\n")).toBe(true);
    expect(first.stdout.trimEnd().includes("\n")).toBe(false);
    const parsed = JSON.parse(first.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(expectedBlock());
  });

  test("a second call with the same agent_id is silent", async () => {
    writeRules("Always run the test suite before committing.");
    await runHook(subagentPayload({ agentId: AGENT }));
    const second = await runHook(subagentPayload({ agentId: AGENT }));
    expect(second.exit).toBe(0);
    expect(second.stdout).toBe("");
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a failed rules read delivers the explicit failure block, once",
    async () => {
      const path = writeRules("rules that exist but cannot be read");
      chmodSync(path, 0o000);
      let first: RunResult;
      // The expected block is rendered inside the same denial window the
      // hook runs in: the failure block names the error, so it must be
      // captured while the file is still unreadable.
      let expected: string;
      try {
        first = await runHook(subagentPayload({ agentId: AGENT }));
        expected = renderStandingBlock(vault, STANDING_RULES_MAX_CHARS_DEFAULT);
      } finally {
        chmodSync(path, 0o644);
      }
      expect(first.exit).toBe(0);
      const parsed = JSON.parse(first.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(parsed.hookSpecificOutput.additionalContext).toBe(expected);
      expect(parsed.hookSpecificOutput.additionalContext).toContain("UNAVAILABLE:");
      const second = await runHook(subagentPayload({ agentId: AGENT }));
      expect(second.stdout).toBe("");
    },
  );

  test("an absent rules file is silent and records no ledger", async () => {
    const r = await runHook(subagentPayload({ agentId: AGENT }));
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(hookStateFilePath(vault, SESSION))).toBe(false);
  });

  test("an empty rules file is silent", async () => {
    writeRules("   \n\t\n");
    const r = await runHook(subagentPayload({ agentId: AGENT }));
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a missing vault is silent", async () => {
    writeRules("rules in a vault that will not be resolved");
    const r = await runHook(subagentPayload({ agentId: AGENT }), {
      VAULT_DIR: join(configHome, "no-such-vault"),
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a missing session scope is silent", async () => {
    writeRules("rules no sessionless host may receive");
    const { session_id: _session, ...scopeless } = subagentPayload({ agentId: AGENT });
    const r = await runHook(scopeless);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a non-write tool call is silent", async () => {
    writeRules("rules a read-only call does not carry");
    const r = await runHook(subagentPayload({ agentId: AGENT, toolName: "Read" }));
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("the ledger records the id only after a successful emission", async () => {
    // No rules yet: the call is silent and nothing is recorded.
    await runHook(subagentPayload({ agentId: AGENT }));
    expect(existsSync(hookStateFilePath(vault, SESSION))).toBe(false);
    // Rules arrive; the emission happens and only then is the id recorded.
    writeRules("Always run the test suite before committing.");
    const delivering = await runHook(subagentPayload({ agentId: AGENT }));
    expect(delivering.stdout).not.toBe("");
    expect(readSubagentDeliveredIds(vault, SESSION).has(AGENT)).toBe(true);
    expect(readHookStampKey(vault, SESSION)).toBe(LEDGER_KEY_SUBAGENT_INJECT);
  });

  test.skipIf(process.platform === "win32")(
    "a failed stdout write records no ledger id: the record happens only after the emission",
    async () => {
      writeRules("Always run the test suite before committing.");
      const payloadPath = join(configHome, "payload.json");
      writeFileSync(payloadPath, JSON.stringify(subagentPayload({ agentId: AGENT })), "utf8");
      // A completed run cannot tell the two orders apart, so the hook is
      // driven with a stdout pipe that is already closed: `head -c0`
      // exits before the hook starts, so its single stdout write fails
      // with EPIPE in a real process (the stdout-epipe-guard precedent).
      // The delay makes the close deterministic; bash's pipefail carries
      // the hook's own exit past head.
      const script =
        "set -o pipefail; sleep 0.3; " +
        `bun run ${JSON.stringify(HOOK)} < ${JSON.stringify(payloadPath)}` +
        " | head -c0 >/dev/null";
      const proc = Bun.spawn(["bash", "-c", script], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "",
          ...homeEnv(configHome),
          VAULT_DIR: vault,
        },
      });
      const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // The hook never blocks on its own failure: the EPIPE throw is
      // swallowed by the fail-soft catch and exits 0.
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      // The rules were deliverable and the write failed: recording the id
      // here would lose them, so the ledger must stay empty and the next
      // write-shaped call re-delivers.
      expect(existsSync(hookStateFilePath(vault, SESSION))).toBe(false);
      expect(readSubagentDeliveredIds(vault, SESSION).has(AGENT)).toBe(false);
    },
    20_000,
  );

  test("a runtime the host-shape detector cannot name still gets the additionalContext envelope", async () => {
    writeRules("Always run the test suite before committing.");
    // No transcript path, no cwd/tool_use_id triple: the detector would
    // resolve to `unknown`, and the carrier is runtime-agnostic anyway -
    // the PostToolUse envelope is the one additive-context channel on
    // this event, so every runtime gets it (post-write-reminder shape).
    const payload = subagentPayload({ agentId: AGENT });
    delete payload["tool_use_id"];
    delete payload["cwd"];
    const r = await runHook(payload);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(expectedBlock());
  });
});

/** Reads the raw scope state and names the one key the carrier may write. */
function readHookStampKey(vaultDir: string, sessionId: string): string {
  const raw = JSON.parse(readFileSync(hookStateFilePath(vaultDir, sessionId), "utf8")) as Record<
    string,
    unknown
  >;
  const keys = Object.keys(raw);
  expect(keys.length).toBe(1);
  return keys[0]!;
}

describe("capped subagent delivered-id ledger", () => {
  test("records and reads back delivered ids, deduplicated", () => {
    expect(recordSubagentDeliveredId(vault, SESSION, AGENT)).toBe(true);
    expect(recordSubagentDeliveredId(vault, SESSION, AGENT)).toBe(true);
    expect(recordSubagentDeliveredId(vault, SESSION, "agent-bbbb")).toBe(true);
    expect([...readSubagentDeliveredIds(vault, SESSION)].toSorted()).toEqual([AGENT, "agent-bbbb"]);
  });

  test("keeps only the most recent ids past the cap", () => {
    const total = SUBAGENT_SET_MAX + 5;
    for (let i = 0; i < total; i++) {
      expect(recordSubagentDeliveredId(vault, SESSION, `agent-${String(i).padStart(4, "0")}`)).toBe(
        true,
      );
    }
    const delivered = readSubagentDeliveredIds(vault, SESSION);
    expect(delivered.size).toBe(SUBAGENT_SET_MAX);
    expect(delivered.has("agent-0000")).toBe(false);
    expect(delivered.has(`agent-${String(total - 1).padStart(4, "0")}`)).toBe(true);
  });
});

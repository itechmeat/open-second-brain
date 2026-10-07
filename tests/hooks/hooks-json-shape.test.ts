/**
 * Lock the resilient shape of every hook command in hooks/hooks.json.
 *
 * Each command must resolve the wrapper via $CLAUDE_PLUGIN_ROOT (Claude Code,
 * current version) with a PATH fallback (Codex / stable dir) and must end with
 * `exit 0` so a hook can never block the agent. The bare `o2b-hook <name>`
 * form is forbidden because it relies solely on a PATH symlink that goes stale
 * across plugin updates.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS_JSON = join(REPO, "hooks", "hooks.json");

interface HookEntry {
  type: string;
  command: string;
  statusMessage?: string;
}
function allCommands(): string[] {
  const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
    hooks: Record<string, Array<{ hooks: HookEntry[] }>>;
  };
  const cmds: string[] = [];
  for (const groups of Object.values(parsed.hooks)) {
    for (const group of groups) {
      for (const h of group.hooks) {
        if (h.type === "command") cmds.push(h.command);
      }
    }
  }
  return cmds;
}

describe("hooks.json command shape", () => {
  const cmds = allCommands();

  test("is valid JSON with at least one command", () => {
    expect(cmds.length).toBeGreaterThan(0);
  });

  test("every command is version-current, has a PATH fallback, and never blocks", () => {
    for (const cmd of cmds) {
      expect(cmd).toContain("$CLAUDE_PLUGIN_ROOT");
      expect(cmd).toContain("/scripts/o2b-hook");
      expect(cmd).toContain("command -v o2b-hook");
      expect(cmd.trimEnd().endsWith("exit 0")).toBe(true);
      // Must NOT be the bare PATH-only form.
      expect(/^o2b-hook\s/.test(cmd.trim())).toBe(false);
    }
  });

  test("SessionStart matcher covers compact - the supported post-compaction re-injection path", () => {
    const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };
    const sessionStart = parsed.hooks["SessionStart"] ?? [];
    expect(sessionStart.length).toBeGreaterThan(0);
    for (const group of sessionStart) {
      expect(group.matcher).toBe("startup|resume|clear|compact");
    }
  });

  test("reground-deliver rides the PostToolUse * and UserPromptSubmit * groups", () => {
    const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: HookEntry[] }>>;
    };
    for (const event of ["PostToolUse", "UserPromptSubmit"]) {
      const star = (parsed.hooks[event] ?? []).filter((group) => group.matcher === "*");
      expect(`${event}: ${star.length}`).toBe(`${event}: 1`);
      const last = star[0]!.hooks.at(-1)!;
      expect(last.command.trimEnd()).toEndWith(
        "command -v o2b-hook >/dev/null 2>&1 && exec o2b-hook reground-deliver; exit 0",
      );
    }
  });

  test("the PostToolUse reground-deliver entry shows no status line on every tool call", () => {
    const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: HookEntry[] }>>;
    };
    const carriers = (parsed.hooks["PostToolUse"] ?? [])
      .flatMap((group) => group.hooks)
      .filter((h) => h.command.includes("o2b-hook reground-deliver"));
    expect(carriers.length).toBe(1);
    expect(carriers[0]!.statusMessage).toBeUndefined();
  });

  // Runs the command through `sh` with a POSIX PATH (/usr/bin:/bin); native
  // Windows has neither, so the fixture cannot be built there.
  test.skipIf(process.platform === "win32")(
    "a command never blocks when nothing resolves (exit 0)",
    () => {
      const cmd = cmds[0]!;
      const env = { ...process.env } as Record<string, string | undefined>;
      delete env["CLAUDE_PLUGIN_ROOT"];
      delete env["OSB_PLUGIN_ROOT"];
      // Minimal PATH: sh + coreutils resolve, but the `o2b-hook` fallback
      // (installed under ~/.local/bin) does not.
      env["PATH"] = "/usr/bin:/bin";
      const r = spawnSync("sh", ["-c", cmd], { env, encoding: "utf8" });
      expect(r.status).toBe(0);
    },
  );
});

describe("hooks.json Stop hygiene-digest entry", () => {
  const stopGroups =
    (
      JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
        hooks: Record<
          string,
          Array<{ matcher?: string; hooks: Array<HookEntry & { timeout?: number }> }>
        >;
      }
    ).hooks["Stop"] ?? [];

  test("exactly one Stop * group carries exactly one hygiene-digest entry, after stop-log-guardrail", () => {
    const stars = stopGroups.filter((group) => group.matcher === "*");
    expect(stars.length).toBe(1);
    const hooks = stars[0]!.hooks;
    const guardrail = hooks.findIndex((h) => h.command.includes("o2b-hook stop-log-guardrail"));
    expect(guardrail).toBeGreaterThanOrEqual(0);
    const digestIndices = hooks
      .map((h, i) => (h.command.includes("o2b-hook hygiene-digest") ? i : -1))
      .filter((i) => i >= 0);
    expect(digestIndices).toEqual([hooks.length - 1]);
    expect(digestIndices[0]).toBe(guardrail + 1);
  });

  test("the hygiene-digest dispatch target resolves to an existing hook file with the sibling timeout and fail-soft shape", () => {
    const hooks = stopGroups.filter((group) => group.matcher === "*")[0]!.hooks;
    const entry = hooks.find((h) => h.command.includes("o2b-hook hygiene-digest"))!;
    expect(entry.timeout).toBe(10);
    expect(entry.statusMessage).toBeDefined();
    expect(entry.type).toBe("command");
    const tail = entry.command.trimEnd();
    expect(tail.endsWith("exit 0")).toBe(true);
    const match = /exec o2b-hook ([a-z0-9-]+); exit 0$/.exec(tail);
    expect(match).not.toBeNull();
    expect(existsSync(join(REPO, "hooks", match![1]! + ".ts"))).toBe(true);
  });
});
describe("hooks.json subagent-inject entry", () => {
  test("the PostToolUse write group carries the carrier after post-write-reminder, shaped like its siblings", () => {
    const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<HookEntry & { timeout?: number }> }>
      >;
    };
    const group = (parsed.hooks["PostToolUse"] ?? []).find(
      (g) => g.matcher === "Write|Edit|MultiEdit|apply_patch",
    );
    expect(group).toBeDefined();
    const hooks = group!.hooks;
    const carriers = hooks.filter((h) => h.command.includes("o2b-hook subagent-inject"));
    expect(carriers.length).toBe(1);
    const carrier = carriers[0]!;
    // Registered inside the write-shaped group, right after its
    // post-write-reminder sibling: both fire on the same tool calls.
    expect(hooks.at(-1)).toBe(carrier);
    expect(hooks[hooks.indexOf(carrier) - 1]!.command).toContain("o2b-hook post-write-reminder");
    expect(carrier.type).toBe("command");
    expect(carrier.timeout).toBe(10);
    expect(carrier.statusMessage).toBe("OSB: delivering context to a subagent");
    // Fail-soft shape identical to its sibling: same wrapper, same PATH
    // fallback, same never-blocks tail, only the dispatch name differs.
    // Both occurrences of the name (plugin-root branch and fallback) must
    // map, so the swap is a replaceAll.
    const sibling = hooks.find((h) => h.command.includes("o2b-hook post-write-reminder"))!;
    expect(carrier.command).toBe(
      sibling.command.replaceAll("post-write-reminder", "subagent-inject"),
    );
    // The dispatch target resolves to an existing hook file, so the
    // registered name can never silently no-op.
    expect(existsSync(join(REPO, "hooks", "subagent-inject.ts"))).toBe(true);
  });

  test("SubagentStart registers the same carrier as the primary channel", () => {
    const parsed = JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<HookEntry & { timeout?: number }> }>
      >;
    };
    // Exactly one group over every sub-agent, carrying exactly one
    // subagent-inject entry - the SubagentStart event fires when the Task
    // tool spawns the sub-agent, before its first prompt.
    const groups = parsed.hooks["SubagentStart"] ?? [];
    expect(groups.length).toBe(1);
    expect(groups[0]!.matcher).toBe("*");
    const carriers = groups[0]!.hooks.filter((h) => h.command.includes("o2b-hook subagent-inject"));
    expect(carriers.length).toBe(1);
    expect(groups[0]!.hooks.length).toBe(1);
    // The same fail-soft command, timeout and status shape as the
    // PostToolUse fallback entry: one hook script, two registrations.
    const postToolUseCarrier = (parsed.hooks["PostToolUse"] ?? [])
      .flatMap((group) => group.hooks)
      .find((h) => h.command.includes("o2b-hook subagent-inject"))!;
    expect(carriers[0]!.command).toBe(postToolUseCarrier.command);
    expect(carriers[0]!.timeout).toBe(postToolUseCarrier.timeout);
    expect(carriers[0]!.statusMessage).toBe(postToolUseCarrier.statusMessage);
    expect(carriers[0]!.type).toBe("command");
  });
});

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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS_JSON = join(REPO, "hooks", "hooks.json");

interface HookEntry {
  type: string;
  command: string;
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

  test("a command never blocks when nothing resolves (exit 0)", () => {
    const cmd = cmds[0]!;
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env["CLAUDE_PLUGIN_ROOT"];
    delete env["OSB_PLUGIN_ROOT"];
    // Minimal PATH: sh + coreutils resolve, but the `o2b-hook` fallback
    // (installed under ~/.local/bin) does not.
    env["PATH"] = "/usr/bin:/bin";
    const r = spawnSync("sh", ["-c", cmd], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});

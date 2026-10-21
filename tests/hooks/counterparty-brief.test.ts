/**
 * The counterparty-brief UserPromptSubmit hook (dated commitments,
 * t_43b0a379), driven end-to-end through a spawned `bun run
 * hooks/counterparty-brief.ts` process, the way both runtimes invoke it.
 *
 * The contract: default OFF is a byte-identical no-op; ON with a
 * qualifying prompt and exactly one matched counterparty emits exactly one
 * `hookSpecificOutput.additionalContext` envelope with at most three dated
 * items; the injection ledger keeps it to once per session; a sessionless
 * payload neither emits nor records (once-per-session is impossible
 * without a session, and an unrecordable brief would repeat on every
 * prompt); an empty trigger vocabulary is inert; every path exits 0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { addPledge } from "../../src/core/brain/pledges.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { readBriefDelivered } from "../../hooks/lib/injection-ledger.ts";
import { homeEnv } from "../helpers/platform.ts";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

const NOW = new Date("2026-06-01T12:00:00Z");
const AGENT = "test-agent";
const PROMPT = "meet Ada Lovelace tomorrow to plan the launch";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-counterparty-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-counterparty-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `counterparty_brief_triggers: meet, call\n`);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedCounterparty(promptText = "Ada Lovelace"): string {
  const { entity } = upsertEntity(vault, {
    category: "people",
    name: promptText,
    agent: AGENT,
    now: NOW,
  });
  const sourceRel = "notes/scratch.md";
  const abs = join(vault, sourceRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "Scratch notes.\n\nThe promise was made in prose here.\n");
  addPledge(vault, {
    title: "Ship the parser",
    due: "2026-06-05",
    source: sourceRel,
    evidence: ["The promise was made in prose here."],
    counterparties: [entity.id],
    agent: AGENT,
    now: NOW,
  });
  return entity.id;
}

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
  cwd: string = configHome,
): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(configHome),
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    ...env,
  };
  const proc = Bun.spawn(["bun", "run", join(HOOKS_DIR, "counterparty-brief.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: inherited,
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

const FLAG_ON = { OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED: "true" } as const;
const SESSION = { session_id: "counterparty-session-1" } as const;

function userPromptPayload(): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptSubmit",
    ...SESSION,
    prompt: PROMPT,
  };
}

describe("counterparty-brief hook (UserPromptSubmit)", () => {
  test("flag off is a byte-identical no-op: empty stdout, exit 0", async () => {
    seedCounterparty();
    const r = await runHook(userPromptPayload(), { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("flag on with a qualifying prompt emits exactly one additionalContext envelope", async () => {
    const entityId = seedCounterparty();
    const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain("Ada Lovelace");
    expect(context).toContain("Ship the parser");
    expect(context).toContain("2026-06-05");
    // The delivered entity is in the ledger, so the suppression read sees it.
    expect(readBriefDelivered(vault, SESSION.session_id)).toBe(entityId);
  });

  test("a second run in the same session emits nothing (ledger)", async () => {
    seedCounterparty();
    const first = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(first.stdout).not.toBe("");
    const second = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(second.exit).toBe(0);
    expect(second.stdout).toBe("");
  });

  test("no real session id means no ledger write and no emission", async () => {
    seedCounterparty();
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: PROMPT },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(readBriefDelivered(vault, "")).toBeNull();
  });

  test("an empty trigger list is inert even with a counterparty match", async () => {
    seedCounterparty();
    writeFileSync(configPath, "counterparty_brief_triggers: \n");
    const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a prompt naming no counterparty emits nothing", async () => {
    seedCounterparty();
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", ...SESSION, prompt: "meet the team about launch" },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("malformed stdin is a silent exit 0", async () => {
    seedCounterparty();
    const proc = Bun.spawn(["bun", "run", join(HOOKS_DIR, "counterparty-brief.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: configHome,
      env: {
        PATH: process.env["PATH"] ?? "",
        ...homeEnv(configHome),
        OPEN_SECOND_BRAIN_CONFIG: configPath,
        VAULT_DIR: vault,
        ...FLAG_ON,
      },
    });
    proc.stdin.write("not json at all");
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });

  test("an unresolvable vault is a silent exit 0", async () => {
    seedCounterparty();
    // A config that names no vault, no VAULT_DIR, and a cwd outside any
    // project pointer: resolution falls through to null and the hook exits.
    writeFileSync(configPath, "counterparty_brief_triggers: meet\n");
    const r = await runHook(userPromptPayload(), { ...FLAG_ON });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("the registration rides hooks.json in the exact sibling command shape", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const hooksJson = JSON.parse(readFileSync(join(repoRoot, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks: Array<{ command: string; timeout?: number; statusMessage?: string }>;
        }>
      >;
    };
    const group = (hooksJson.hooks["UserPromptSubmit"] ?? []).find((g) => g.matcher === "*");
    expect(group).toBeDefined();
    const entries = group!.hooks.filter((h) => h.command.includes("o2b-hook counterparty-brief"));
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.timeout).toBe(10);
    expect(entry.statusMessage).toBe("OSB: injecting counterparty brief (opt-in)");
    expect(entry.command.trimEnd()).toEndWith(
      "command -v o2b-hook >/dev/null 2>&1 && exec o2b-hook counterparty-brief; exit 0",
    );
    expect(entry.command).toContain("$CLAUDE_PLUGIN_ROOT");
    // The dispatch target resolves to the hook this suite just exercised.
    expect(existsSync(join(repoRoot, "hooks", "counterparty-brief.ts"))).toBe(true);
  });
});

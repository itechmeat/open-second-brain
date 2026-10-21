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
 * prompt); an empty trigger vocabulary is inert; the process ceiling ends
 * a stalled read with a silent exit 0; every path exits 0, and every
 * fail-open path keeps stderr empty. The audit line names the cause of a
 * refusal (`no_trigger`, `no_match`, `ambiguous`), never a blanket one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { addPledge } from "../../src/core/brain/pledges.ts";
import { hookAuditDir } from "../../src/core/brain/paths.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { readBriefDelivered } from "../../hooks/lib/injection-ledger.ts";
import { hookStateFilePath } from "../../hooks/lib/session-state.ts";
import { CHMOD_CANNOT_DENY, homeEnv } from "../helpers/platform.ts";

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
  seedPledgeFor(entity.id, "Ship the parser", "2026-06-05", "notes/scratch.md");
  return entity.id;
}

/** Seed one open promise to the counterparty, citing a source page. */
function seedPledgeFor(entityId: string, title: string, due: string, sourceRel: string): void {
  const abs = join(vault, sourceRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "Scratch notes.\n\nThe promise was made in prose here.\n");
  addPledge(vault, {
    title,
    due,
    source: sourceRel,
    evidence: ["The promise was made in prose here."],
    counterparties: [entityId],
    agent: AGENT,
    now: NOW,
  });
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

/** The vault-relative path of a canonical entity page, for the hand edits. */
function entityRel(entityId: string): string {
  return `Brain/entities/people/${entityId}.md`;
}

/** Add a scalar `visibility:` to an existing page's frontmatter (hand edit). */
function addVisibility(rel: string, token: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  writeFileSync(abs, text.replace(/^---\n/u, `---\nvisibility: ${token}\n`));
}

/** A preference page in the vault's preferences directory; returns its rel. */
function writePref(slug: string, body: string): string {
  const rel = `Brain/preferences/pref-${slug}.md`;
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    [
      "---",
      `id: pref-${slug}`,
      "topic: project notes",
      `principle: ${slug}`,
      "tier: core",
      "created_at: 2026-05-01T00:00:00Z",
      "---",
      "",
      body,
    ].join("\n"),
  );
  return rel;
}

/** The hook's own audit records for this vault. */
function auditRecords(): Array<Record<string, unknown>> {
  const dir = hookAuditDir(vault);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
    .filter((record) => record["actor"] === "counterparty-brief");
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
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit };
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
    expect(r.stderr).toBe("");
  }, 20000);

  test("flag on with a qualifying prompt emits exactly one additionalContext envelope", async () => {
    const entityId = seedCounterparty();
    const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    // Exactly one envelope: one JSON object on stdout, carrying one
    // additionalContext. A second envelope would show up as a second line
    // and a second occurrence of the key.
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(r.stdout.match(/additionalContext/gu) ?? []).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain("Ada Lovelace");
    // The item line is pinned by its SHAPE, not by the fixture values it
    // happens to repeat: date, text and source path, in that order.
    expect(context.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- 2026-06-05 Ship the parser (notes/scratch.md)",
    ]);
    // The delivered entity is in the ledger, so the suppression read sees it.
    expect(readBriefDelivered(vault, SESSION.session_id)).toBe(entityId);
  }, 20000);

  test("the brief carries at most three dated items", async () => {
    const entityId = seedCounterparty();
    // Four open promises to the same counterparty: the injection budget is
    // three dated lines, and the fourth stays in the vault.
    seedPledgeFor(entityId, "Second promise", "2026-06-06", "notes/second.md");
    seedPledgeFor(entityId, "Third promise", "2026-06-07", "notes/third.md");
    seedPledgeFor(entityId, "Fourth promise", "2026-06-08", "notes/fourth.md");
    const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout.trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const itemLines = parsed.hookSpecificOutput.additionalContext
      .split("\n")
      .filter((line) => line.startsWith("- "));
    // Three lines, the three earliest promises (due-sorted), and never the
    // fourth.
    expect(itemLines).toHaveLength(3);
    expect(itemLines).toEqual([
      "- 2026-06-05 Ship the parser (notes/scratch.md)",
      "- 2026-06-06 Second promise (notes/second.md)",
      "- 2026-06-07 Third promise (notes/third.md)",
    ]);
  }, 20000);

  test("a second run in the same session emits nothing (ledger)", async () => {
    seedCounterparty();
    const first = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(first.stdout).not.toBe("");
    const second = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(second.exit).toBe(0);
    expect(second.stdout).toBe("");
    expect(second.stderr).toBe("");
  }, 20000);

  test("no real session id means no ledger write and no emission", async () => {
    seedCounterparty();
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: PROMPT },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    // The empty key is not the key shape the hook would have used, so the
    // answer under it says little on its own: the SCOPE FILES are the
    // evidence. No ledger write means no scope file at all - not the one
    // an empty session id maps to, and not one under any other scope.
    expect(readBriefDelivered(vault, "")).toBeNull();
    expect(existsSync(hookStateFilePath(vault, ""))).toBe(false);
    const stateDir = dirname(hookStateFilePath(vault, ""));
    expect(existsSync(stateDir) ? readdirSync(stateDir) : []).toEqual([]);
  }, 20000);

  test("an empty trigger list is inert even with a counterparty match", async () => {
    seedCounterparty();
    writeFileSync(configPath, "counterparty_brief_triggers: \n");
    const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    // The empty vocabulary is its own decision, not an empty brief: the
    // audit line names the reason, and the ledger stays untouched - so the
    // test fails if the early exit is ever removed and the run falls
    // through to the counterparty match instead.
    const abstain = auditRecords().find((record) => record["ok"] === false);
    const details = abstain?.["details"] as Record<string, unknown> | undefined;
    expect(details?.["decision"]).toBe("abstain");
    expect(details?.["reason"]).toBe("no_triggers");
    expect(readBriefDelivered(vault, SESSION.session_id)).toBeNull();
  }, 20000);

  test("a prompt naming no counterparty emits nothing", async () => {
    seedCounterparty();
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", ...SESSION, prompt: "meet the team about launch" },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    // The audit line names the CAUSE, not a blanket refusal: the prompt
    // carried the trigger but named no canonical counterparty.
    const abstain = auditRecords().find((record) => record["ok"] === false);
    const details = abstain?.["details"] as Record<string, unknown> | undefined;
    expect(details?.["decision"]).toBe("abstain");
    expect(details?.["reason"]).toBe("no_match");
  }, 20000);

  test("a prompt without a trigger token names that cause", async () => {
    seedCounterparty();
    // The counterparty IS named, but the prompt carries none of the
    // operator's trigger tokens, so the brief never starts.
    const r = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        ...SESSION,
        prompt: "Ada Lovelace to plan the launch",
      },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    const abstain = auditRecords().find((record) => record["ok"] === false);
    const details = abstain?.["details"] as Record<string, unknown> | undefined;
    expect(details?.["decision"]).toBe("abstain");
    expect(details?.["reason"]).toBe("no_trigger");
  }, 20000);

  test("a prompt naming two counterparties names that cause", async () => {
    seedCounterparty();
    // Only the second RECORD is needed here: the ambiguity is in the
    // prompt, not in the promises.
    upsertEntity(vault, {
      category: "people",
      name: "Grace Hopper",
      agent: AGENT,
      now: NOW,
    });
    const r = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        ...SESSION,
        prompt: "meet Ada Lovelace and Grace Hopper to plan",
      },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    const abstain = auditRecords().find((record) => record["ok"] === false);
    const details = abstain?.["details"] as Record<string, unknown> | undefined;
    expect(details?.["decision"]).toBe("abstain");
    expect(details?.["reason"]).toBe("ambiguous");
  }, 20000);

  test("a counterparty whose entity page carries the reserved token emits nothing", async () => {
    const entityId = seedCounterparty();
    addVisibility(entityRel(entityId), REMOTE_DENY_VISIBILITY_TOKEN);
    const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  }, 20000);

  // A mode change cannot make a file unreadable to uid 0, nor on Windows.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "the audit line counts the pages the brief could not read",
    async () => {
      seedCounterparty();
      const locked = writePref("locked", "Ada Lovelace reviewed the draft");
      chmodSync(join(vault, locked), 0o000);
      const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
      expect(r.exit).toBe(0);
      expect(r.stdout).not.toBe("");
      expect(r.stderr).toBe("");
      const emit = auditRecords().find((record) => record["ok"] === true);
      const details = emit?.["details"] as Record<string, unknown> | undefined;
      expect(details?.["skipped_reads"]).toBe(1);
    },
    20000,
  );

  // A mode change cannot make a directory unreadable to uid 0, nor on Windows.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "an internal error still lands its audit line and never blocks the prompt",
    async () => {
      seedCounterparty();
      // The pledges directory itself unreadable: the brief's walk cannot
      // even list it, so building the brief throws instead of abstaining.
      const pledgesDir = join(vault, "Brain", "pledges");
      chmodSync(pledgesDir, 0o000);
      try {
        const r = await runHook(userPromptPayload(), { VAULT_DIR: vault, ...FLAG_ON });
        expect(r.exit).toBe(0);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("");
        // The decision trail keeps its one-line-per-decision contract on
        // the error path too: the failure is on the record, by name.
        const errorLine = auditRecords().find(
          (record) =>
            record["ok"] === false &&
            (record["details"] as Record<string, unknown> | undefined)?.["decision"] === "error",
        );
        expect(errorLine).toBeDefined();
      } finally {
        chmodSync(pledgesDir, 0o755);
      }
    },
    20000,
  );

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
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(stdout).toBe("");
    // Silent means silent on BOTH streams: a crash trace on stderr with a
    // zero exit is a crash the exit code hides.
    expect(stderr).toBe("");
  }, 20000);

  test("an unresolvable vault is a silent exit 0", async () => {
    seedCounterparty();
    // A config that names no vault, no VAULT_DIR, and a cwd outside any
    // project pointer: resolution falls through to null and the hook exits.
    writeFileSync(configPath, "counterparty_brief_triggers: meet\n");
    const r = await runHook(userPromptPayload(), { ...FLAG_ON });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  }, 20000);

  test("the process ceiling ends a stalled read with a silent exit 0", async () => {
    seedCounterparty();
    // The ceiling is the hook's own watchdog, and the env override is how
    // a test pulls it down to its floor (the module ignores anything
    // below it). The vault read itself is SYNCHRONOUS, and a JS timer
    // cannot interrupt a synchronous hang - which is why the module's own
    // docblock calls the host timeout the outer bound - so the stall the
    // ceiling exists for is the ASYNC read the hook blocks on first: the
    // payload. The fixture therefore writes a payload and never closes
    // stdin, so the hook waits for an end that never comes.
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
        OPEN_SECOND_BRAIN_HOOK_CEILING_MS: "1000",
      },
    });
    proc.stdin.write(JSON.stringify(userPromptPayload()));
    await proc.stdin.flush();
    const started = Date.now();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exit = await proc.exited;
    const elapsed = Date.now() - started;
    // A clean exit with no output: the prompt is never blocked, and it
    // never receives a partial brief.
    expect(exit).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    // The process was still alive at the deadline, so the exit came from
    // the ceiling and not from a hook that finished early.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 20000);

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

    // The generated plugin mirror carries the SAME row: the mirror is what
    // the other runtime reads, so a row that drifted out of it would
    // register the hook in one runtime only.
    const mirror = JSON.parse(
      readFileSync(join(repoRoot, "plugins", "codex", "hooks", "hooks.json"), "utf8"),
    ) as {
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks: Array<{ command: string; timeout?: number; statusMessage?: string }>;
        }>
      >;
    };
    const mirrorGroup = (mirror.hooks["UserPromptSubmit"] ?? []).find((g) => g.matcher === "*");
    expect(mirrorGroup).toBeDefined();
    const mirrorEntries = mirrorGroup!.hooks.filter((h) =>
      h.command.includes("o2b-hook counterparty-brief"),
    );
    expect(mirrorEntries).toHaveLength(1);
    const mirrorEntry = mirrorEntries[0]!;
    expect(mirrorEntry.command).toBe(entry.command);
    expect(mirrorEntry.timeout).toBe(entry.timeout);
    expect(mirrorEntry.statusMessage).toBe(entry.statusMessage);
  });
});

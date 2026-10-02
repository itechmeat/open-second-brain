/**
 * The SessionStart hook injects the scoped operator rules for the project
 * the session runs in (payload `cwd`, the nearest `.o2b-vault.json`
 * pointer) and for this device, between the constitution and the
 * budgeted memory context. Harness-scoped files are an MCP-only layer in
 * this release: the hook has no harness signal it could trust.
 *
 * Each project case is an A/B probe: a vault holding another project's
 * file injects byte-for-byte what the same vault without it injects.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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

import { STANDING_RULES_HEADER } from "../../src/core/brain/standing-rules.ts";
import {
  SCOPED_RULES_HEADER,
  SCOPED_RULES_NOTICE_RESERVE,
  readScopedRules,
} from "../../src/core/brain/scoped-rules.ts";
import { budgetActiveBody } from "../../src/core/brain/active-budget.ts";
import { writeVaultPointer } from "../../src/core/brain/portability/pointer.ts";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

let tmp: string;
let vault: string;
let projectX: string;
let projectY: string;
let configHome: string;

const MARKER = "zzscopedhookmarkerzz";
const ACTIVE_HEAD = "# Active Brain Preferences";
const ACTIVE_BODY = `---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n${ACTIVE_HEAD}\n\n## Confirmed (1)\n\n- \`pref-foo\` — Rule body\n`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hook-scoped-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "standing-rules.md"), "Never force-push to main.", "utf8");
  writeFileSync(join(vault, "Brain", "active.md"), ACTIVE_BODY, "utf8");
  projectX = join(tmp, "proj-x");
  projectY = join(tmp, "proj-y");
  for (const dir of [projectX, projectY]) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeVaultPointer(dir, vault);
  }
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-scoped-cfg-"));
});

afterEach(async () => {
  await waitForSelfHealChildren(vault);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<string> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(configHome),
    OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
    VAULT_DIR: vault,
    O2B_DEVICE_ID: "",
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(await proc.exited).toBe(0);
  return stdout;
}

function injected(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
}

function writeScoped(axis: "project" | "harness" | "host", key: string, body: string): string {
  const dir = join(vault, "Brain", "standing-rules", axis);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

interface ReceiptRecord {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function injectionReceipts(): ReceiptRecord[] {
  const dir = join(vault, "Brain", "log", "continuity");
  if (!existsSync(dir)) return [];
  const out: ReceiptRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as ReceiptRecord);
    }
  }
  return out.filter(
    (r) => r.kind === "context_receipt" && r.payload["trigger"] === "session_inject",
  );
}

describe("active-inject scoped rules - project axis", () => {
  test("another project's file leaves the injection byte-identical", async () => {
    const payload = { hook_event_name: "SessionStart", cwd: join(projectY, "src") };
    const path = writeScoped("project", "proj-x", MARKER);
    const withFile = await runHook(payload);
    rmSync(path);
    const withoutFile = await runHook(payload);
    expect(withFile).not.toContain(MARKER);
    expect(withFile).toBe(withoutFile);
  });

  test("the session's project renders after the constitution and before the memory body", async () => {
    writeScoped("project", "proj-x", MARKER);
    const context = injected(
      await runHook({ hook_event_name: "SessionStart", cwd: join(projectX, "src") }),
    );
    const standingAt = context.indexOf(STANDING_RULES_HEADER);
    const scopedAt = context.indexOf(SCOPED_RULES_HEADER);
    const markerAt = context.indexOf(MARKER);
    const bodyAt = context.indexOf(ACTIVE_HEAD);
    expect(standingAt).toBe(0);
    expect(scopedAt).toBeGreaterThan(standingAt);
    expect(context).toContain("### Project: proj-x");
    expect(markerAt).toBeGreaterThan(scopedAt);
    expect(bodyAt).toBeGreaterThan(markerAt);
    expect(context).not.toContain(vault);
  });

  test("the scoped block is never served from the inject cache", async () => {
    // Run in project X first so a cached body could hold X's rules, then
    // in project Y: the cache key is vault-wide, so a cached scoped block
    // would replay X's rules here.
    writeScoped("project", "proj-x", MARKER);
    await runHook({ hook_event_name: "SessionStart", cwd: projectX });
    const inY = await runHook({ hook_event_name: "SessionStart", cwd: projectY });
    expect(inY).not.toContain(MARKER);
  });
});

describe("active-inject scoped rules - harness and host axes", () => {
  test("a harness file never renders in the hook", async () => {
    const payload = { hook_event_name: "SessionStart", cwd: projectY };
    const path = writeScoped("harness", "claude-code", MARKER);
    const withFile = await runHook(payload, { CLAUDE_PLUGIN_ROOT: tmp });
    rmSync(path);
    const withoutFile = await runHook(payload, { CLAUDE_PLUGIN_ROOT: tmp });
    expect(withFile).not.toContain(MARKER);
    expect(withFile).toBe(withoutFile);
  });

  test("this device's host file renders and another device's does not", async () => {
    writeScoped("host", "bbbb0002", "zzotherdevicezz");
    writeScoped("host", "aaaa0001", MARKER);
    const context = injected(
      await runHook(
        { hook_event_name: "SessionStart", cwd: projectY },
        { O2B_DEVICE_ID: "aaaa0001" },
      ),
    );
    expect(context).toContain("### Host: aaaa0001");
    expect(context).toContain(MARKER);
    expect(context).not.toContain("zzotherdevicezz");
  });
});

describe("active-inject scoped rules - budget", () => {
  test("the scoped block is capped and subtracted from the injection budget", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 1000\n  scoped_rules_max_chars: 200\n",
      "utf8",
    );
    // Many short lines, so the cap cuts at a real line and keeps the marker.
    const ruleLines = Array.from({ length: 200 }, (_, i) => `- scoped rule line ${i}`);
    writeScoped("project", "proj-x", `${MARKER}\n${ruleLines.join("\n")}`);
    const lines = Array.from({ length: 60 }, (_, i) => `- \`pref-${i}\` — rule body number ${i}`);
    const longActive = `---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n${ACTIVE_HEAD}\n\n## Confirmed (60)\n\n${lines.join("\n")}\n`;
    writeFileSync(join(vault, "Brain", "active.md"), longActive, "utf8");

    const context = injected(await runHook({ hook_event_name: "SessionStart", cwd: projectX }));

    const expected = readScopedRules(
      vault,
      { project: "proj-x", harness: null, host: null },
      { maxChars: 200 },
    );
    expect(expected.text).toContain(MARKER);
    expect(expected.files[0]?.truncated).toBe(true);
    expect(context).toContain(expected.text);

    const trimmedActive = longActive.slice(longActive.indexOf(ACTIVE_HEAD)).trim();
    const activeBudget = Math.max(0, 1000 - expected.text.length);
    expect(context.endsWith(budgetActiveBody(trimmedActive, activeBudget))).toBe(true);

    const receipts = injectionReceipts();
    expect(receipts.length).toBe(1);
    const budget = receipts[0]!.payload["budget"] as Record<string, unknown>;
    expect(budget["inject_budget_chars"]).toBe(1000);
    expect(budget["scoped_rules_chars"]).toBe(expected.text.length);
    const items = receipts[0]!.payload["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(items.map((item) => item["id"])).toContain("scoped-rules");
  });

  test("with no scoped file the receipt records zero scoped characters", async () => {
    await runHook({ hook_event_name: "SessionStart", cwd: projectY });
    const budget = injectionReceipts()[0]!.payload["budget"] as Record<string, unknown>;
    expect(budget["scoped_rules_chars"]).toBe(0);
  });
});

describe("active-inject scoped rules - gaps closed by the test audit", () => {
  test("a cached memory body never replays another project's rules", async () => {
    // Prime the fail-open cache in project X, then break the memory layer
    // (a directory in active.md's place) so project Y is served the cache.
    // A scoped block that rode inside the cached body would replay X here.
    writeScoped("project", "proj-x", MARKER);
    await runHook({ hook_event_name: "SessionStart", cwd: projectX });
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));
    const context = injected(await runHook({ hook_event_name: "SessionStart", cwd: projectY }));
    expect(context).toContain(ACTIVE_HEAD);
    expect(context).not.toContain(MARKER);
  });

  test("a payload cwd outside every linked project matches no project file", async () => {
    const unlinked = join(tmp, "unlinked", "deep");
    mkdirSync(unlinked, { recursive: true });
    const payload = { hook_event_name: "SessionStart", cwd: unlinked };
    const path = writeScoped("project", "unlinked", MARKER);
    const withFile = await runHook(payload);
    rmSync(path);
    expect(withFile).not.toContain(MARKER);
    expect(withFile).toBe(await runHook(payload));
  });

  test("an unreadable device id with a host file ends the block with the notice", async () => {
    writeScoped("host", "aaaa0001", MARKER);
    const configDir = join(configHome, "config-is-a-directory");
    mkdirSync(configDir, { recursive: true });
    const context = injected(
      await runHook(
        { hook_event_name: "SessionStart", cwd: projectY },
        { O2B_DEVICE_ID: "NOT A VALID ID", OPEN_SECOND_BRAIN_CONFIG: configDir },
      ),
    );
    expect(context).toContain(
      "Host-scoped rules were not applied: this device's id could not be read.",
    );
    expect(context).not.toContain(MARKER);
    expect(context).not.toContain(configDir);
  });

  test("the scoped cap never exceeds the injection budget", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 1000\n",
      "utf8",
    );
    // Many short lines: the budgeter cuts at a line, so a one-line body
    // would be dropped under any cap and prove nothing.
    const lines = Array.from({ length: 200 }, (_, i) => `- scoped rule line ${i}`);
    writeScoped("project", "proj-x", `${MARKER}\n${lines.join("\n")}`);
    const context = injected(await runHook({ hook_event_name: "SessionStart", cwd: projectX }));
    // The default cap (2000) is clamped to what the budget leaves once the
    // header and the notices are reserved.
    const clamped = readScopedRules(
      vault,
      { project: "proj-x", harness: null, host: null },
      { maxChars: 1000 - SCOPED_RULES_HEADER.length - SCOPED_RULES_NOTICE_RESERVE },
    );
    expect(clamped.text).toContain(MARKER);
    expect(clamped.text.length).toBeLessThanOrEqual(1000);
    expect(context).toContain(clamped.text);
  });

  test("the header and the notices ride inside a tight injection budget", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 500\n  scoped_rules_max_chars: 200\n",
      "utf8",
    );
    writeScoped("project", "proj-x", `${MARKER} ${"x".repeat(5000)}`);
    const lines = Array.from({ length: 60 }, (_, i) => `- \`pref-${i}\` — rule body number ${i}`);
    const longActive = `---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n${ACTIVE_HEAD}\n\n## Confirmed (60)\n\n${lines.join("\n")}\n`;
    writeFileSync(join(vault, "Brain", "active.md"), longActive, "utf8");

    const context = injected(await runHook({ hook_event_name: "SessionStart", cwd: projectX }));

    const scopedStart = context.indexOf(SCOPED_RULES_HEADER);
    const activeStart = context.indexOf(ACTIVE_HEAD);
    expect(scopedStart).toBeGreaterThan(-1);
    const scopedBlock = context.slice(scopedStart, activeStart).trimEnd();
    // A one-line rule that cannot fit is dropped whole, never left as a
    // bare heading, and the notice says so.
    expect(scopedBlock).not.toContain("### Project: proj-x");
    expect(scopedBlock).toContain("1 file(s) dropped");
    expect(scopedBlock.length).toBeLessThanOrEqual(500);
    // The budgeted output (the constitution excluded) stays within the
    // budget plus the memory body's own truncation notice.
    const budgeted = context.slice(scopedStart);
    const trimmedActive = longActive.slice(longActive.indexOf(ACTIVE_HEAD)).trim();
    const activeBudget = 500 - scopedBlock.length;
    const activeOut = budgetActiveBody(trimmedActive, activeBudget);
    expect(budgeted.endsWith(activeOut)).toBe(true);
    const activeNotice = activeOut.slice(activeOut.lastIndexOf("\n\n") + 2);
    expect(budgeted.length).toBeLessThanOrEqual(500 + "\n\n".length + activeNotice.length);
  });

  test("a degraded run keeps the scoped-rules item in the receipt", async () => {
    writeScoped("project", "proj-x", MARKER);
    await runHook({ hook_event_name: "SessionStart", cwd: projectX });
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));
    const context = injected(await runHook({ hook_event_name: "SessionStart", cwd: projectX }));
    expect(context).toContain(MARKER);
    const receipts = injectionReceipts();
    expect(receipts.length).toBe(2);
    const degraded = receipts[1]!.payload;
    const injection = degraded["injection"] as Record<string, unknown>;
    expect(injection["loader_source"]).not.toBe("fresh");
    const items = degraded["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(items.map((item) => item["id"])).toEqual(["standing-rules", "scoped-rules"]);
  });

  test("with no active.md the receipt still records the scoped characters", async () => {
    rmSync(join(vault, "Brain", "active.md"));
    writeScoped("project", "proj-x", MARKER);
    const context = injected(await runHook({ hook_event_name: "SessionStart", cwd: projectX }));
    const expected = readScopedRules(vault, { project: "proj-x", harness: null, host: null });
    expect(context).toContain(expected.text);
    const receipts = injectionReceipts();
    expect(receipts.length).toBe(1);
    const budget = receipts[0]!.payload["budget"] as Record<string, unknown>;
    expect(budget["scoped_rules_chars"]).toBe(expected.text.length);
  });
});

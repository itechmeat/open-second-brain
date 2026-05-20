/**
 * Tests for `o2b brain note <text>` CLI verb (v0.10.10).
 *
 * Drives §7.2 of `docs/plans/2026-05-20-v0.10.10-design.md` — the
 * Brain-native milestone-log mirror of the MCP `brain_note` tool.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let configDir: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-note-cli-"));
  configDir = mkdtempSync(join(tmpdir(), "o2b-brain-note-cli-cfg-"));
  vault = join(tmp, "vault");
  configPath = join(configDir, "config.yaml");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("o2b brain note", () => {
  test("writes a note with the positional text", async () => {
    writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
    const r = await runCli(["brain", "note", "released v0.10.10"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath, VAULT_AGENT_NAME: "" },
    });
    expect(r.returncode).toBe(0);
    const body = readFileSync(join(vault, "Brain", "log", `${today()}.md`), "utf8");
    expect(body).toContain("— note");
    expect(body).toContain("- text: released v0.10.10");
    expect(body).toContain("- agent: tester");
  });

  test("--json emits the structured result", async () => {
    writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
    const r = await runCli(
      ["brain", "note", "json output check", "--json"],
      {
        env: { OPEN_SECOND_BRAIN_CONFIG: configPath, VAULT_AGENT_NAME: "" },
      },
    );
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent).toBe("tester");
    expect(parsed.log_path).toMatch(/^Brain\/log\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(parsed.logged_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(typeof parsed.absolute_log_path).toBe("string");
  });

  test("--agent flag overrides the config-resolved identity", async () => {
    writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
    const r = await runCli(
      ["brain", "note", "agent override", "--agent", "explicit-name", "--json"],
      {
        env: { OPEN_SECOND_BRAIN_CONFIG: configPath, VAULT_AGENT_NAME: "" },
      },
    );
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.agent).toBe("explicit-name");
  });

  test("missing text exits 2 with a clear stderr message", async () => {
    writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
    const r = await runCli(["brain", "note"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath, VAULT_AGENT_NAME: "" },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("brain note");
  });

  test("whitespace-only text exits 2 (usage error)", async () => {
    // Design §7.2: empty / whitespace-only text is a usage error, not a
    // runtime failure. Cron callers can distinguish "operator forgot
    // text" (exit 2) from a real append failure (exit 1) by the code.
    writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
    const r = await runCli(["brain", "note", "   "], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath, VAULT_AGENT_NAME: "" },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("non-empty text");
  });
});

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";
import { redactSecrets } from "../../src/cli/json-helpers.ts";
import { redactRawOutput } from "../../src/core/redactor.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/** A signal id: the shape every `_evidenced_by` wikilink points through. */
const SIGNAL_ID = "sig-2026-08-16-secret-leak";

let tempDir: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "o2b-cli-json-"));
  vault = join(tempDir, "vault");
  configPath = join(tempDir, "config.yaml");
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: "",
    VAULT_AGENT_NAME: "",
  };
}

describe("inherited CLI --json contract", () => {
  test("text-only commands accept --json and return a fallback envelope", async () => {
    const result = await runCli(["init", "--vault", vault, "--json"], {
      env: env(),
    });

    const parsed = JSON.parse(result.stdout);
    expect(parsed.command).toBe("init");
    expect(parsed.code).toBe(result.returncode);
    expect(typeof parsed.ok).toBe("boolean");
    expect(typeof parsed.stdout).toBe("string");
    expect(parsed.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  test("commands with semantic JSON keep their existing payload shape", async () => {
    const result = await runCli(["status", "--config", configPath, "--json"], {
      env: env(),
    });

    expect(result.returncode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.config_path).toBe(configPath);
    expect(parsed).not.toHaveProperty("command");
    expect(parsed).not.toHaveProperty("stdout");
  });

  test("doctor --json is a semantic report, not the fallback envelope", async () => {
    const result = await runCli(["doctor", "--vault", vault, "--json"], {
      env: env(),
    });
    const parsed = JSON.parse(result.stdout);
    // Semantic payload: no envelope wrapper, a structured per-check list and
    // an aggregate summary the operator can gate a setup/CI step on.
    expect(parsed).not.toHaveProperty("command");
    expect(parsed).not.toHaveProperty("stdout");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(typeof parsed.summary.total).toBe("number");
    expect(typeof parsed.summary.failed).toBe("number");
  });

  test("fallback JSON redacts secret-shaped output", async () => {
    const result = await runCli(
      ["init", "--vault", vault, "--agent-name", "api_key=super-secret-value", "--json"],
      { env: env() },
    );

    expect(result.returncode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).toContain("[REDACTED]");
  });

  test("the envelope hands a signal id back verbatim", async () => {
    // The knock-on of the egress guard's signal-id carve-out, pinned on
    // the OTHER redactor. `redactSecrets` here is assignment-shaped only -
    // it has no high-entropy pass at all - so this envelope never ate a
    // `sig-<date>-<slug>`, while the shared redactor behind
    // `redactForEgress` did. The two surfaces now agree, and that
    // agreement is what this asserts: the same identifier survives both,
    // so an operator cannot get one answer from a bundle and a different
    // one from `--json`.
    const nested = join(tempDir, SIGNAL_ID, "vault");
    const result = await runCli(["init", "--vault", nested, "--json"], { env: env() });

    expect(result.returncode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { stdout: string };
    expect(parsed.stdout).toContain(SIGNAL_ID);
    expect(JSON.stringify(parsed)).not.toContain("[REDACTED]");
    // And the shared egress redactor, which is the one that used to
    // rewrite it, leaves the same string alone.
    expect(redactRawOutput(`_evidenced_by: [[${SIGNAL_ID}]]`, { redactTokens: true })).toBe(
      `_evidenced_by: [[${SIGNAL_ID}]]`,
    );
  });

  test("redactSecrets still replaces an assignment wearing a signal id", () => {
    // The complement: the carve-out is about a BARE identifier, so a
    // credential assigned under a secret-shaped key is still replaced
    // whatever its value looks like.
    const redacted = redactSecrets({ note: `token=${SIGNAL_ID}` }) as { note: string };
    expect(redacted.note).toBe("token=[REDACTED]");
  });
});

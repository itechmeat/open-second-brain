/**
 * Secret exec path (t_0b134404, part 2): allowlist-gated subprocess
 * execution with env injection and redacted output. The capability
 * gate is the operator-declared glob allowlist; a non-matching
 * command is refused and audited, and a command that echoes the
 * secret back gets the value scrubbed before the caller sees it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  matchesAllowlist,
  runWithSecret,
  SecretExecDeniedError,
} from "../../../../src/core/brain/secrets/exec.ts";
import { setSecret } from "../../../../src/core/brain/secrets/store.ts";

const NOW = new Date("2026-06-05T10:00:00Z");
const CTX = { agent: "tester", now: NOW };

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-secret-exec-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("matchesAllowlist (pure)", () => {
  test("glob star spans arguments; everything else is literal", () => {
    expect(matchesAllowlist(["curl *"], "curl https://api.example.com")).toBe(true);
    expect(matchesAllowlist(["curl *"], "bash -c curl")).toBe(false);
    expect(matchesAllowlist(["echo secret-test"], "echo secret-test")).toBe(true);
    expect(matchesAllowlist([], "anything")).toBe(false);
  });

  test("regex metacharacters in patterns stay literal", () => {
    expect(matchesAllowlist(["node script.js"], "node scriptxjs")).toBe(false);
  });
});

describe("runWithSecret", () => {
  test("an allowlisted command sees the env var; output is redacted", async () => {
    setSecret(vault, {
      name: "api-key",
      value: "sk-redact-me-12345",
      envVar: "MY_API_KEY",
      allow: ["bun -e *"],
      agent: "tester",
      now: NOW,
    });
    const result = await runWithSecret(
      vault,
      "api-key",
      ["bun", "-e", "console.log('key=' + process.env.MY_API_KEY)"],
      CTX,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("sk-redact-me-12345");
    expect(result.stdout).toContain("***REDACTED***");
  });

  test("a non-matching command is refused and audited", async () => {
    setSecret(vault, {
      name: "api-key",
      value: "sk-redact-me-12345",
      allow: ["curl *"],
      agent: "tester",
      now: NOW,
    });
    await expect(runWithSecret(vault, "api-key", ["bash", "-c", "env"], CTX)).rejects.toThrow(
      SecretExecDeniedError,
    );
    const auditDir = join(vault, "Brain", "log", "secret-custody");
    const lines = readdirSync(auditDir)
      .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { action: string; ok: boolean });
    expect(lines.some((l) => l.action === "secret_exec_denied" && l.ok === false)).toBe(true);
  });

  test("an empty allowlist denies every exec", async () => {
    setSecret(vault, {
      name: "locked",
      value: "sealed-value",
      agent: "tester",
      now: NOW,
    });
    await expect(runWithSecret(vault, "locked", ["echo", "hi"], CTX)).rejects.toThrow(
      /empty allowlist/,
    );
  });

  test("the subprocess exit code propagates", async () => {
    setSecret(vault, {
      name: "api-key",
      value: "sk-redact-me-12345",
      allow: ["bun -e *"],
      agent: "tester",
      now: NOW,
    });
    const result = await runWithSecret(vault, "api-key", ["bun", "-e", "process.exit(3)"], CTX);
    expect(result.exitCode).toBe(3);
  });
});

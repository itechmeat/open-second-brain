/**
 * Capability-gated secret custody store (t_0b134404, part 1):
 * per-value AES-256-GCM ciphertext under the vault-local state dir
 * with a 0600 keyfile, set/list/rm surface that never returns
 * plaintext, fail-closed tamper detection, and a no-values audit
 * trail in Brain/log/secret-custody/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listSecrets,
  removeSecret,
  resolveSecretForExec,
  setSecret,
  secretsDir,
} from "../../../../src/core/brain/secrets/store.ts";

const NOW = new Date("2026-06-05T10:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-secrets-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function set(name = "embed-key", value = "sk-super-secret-value"): void {
  setSecret(vault, {
    name,
    value,
    envVar: "EMBED_API_KEY",
    allow: ["curl *"],
    agent: "tester",
    now: NOW,
  });
}

describe("setSecret / listSecrets / removeSecret", () => {
  test("set + list round-trips metadata and never the value", () => {
    set();
    const secrets = listSecrets(vault);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      name: "embed-key",
      env_var: "EMBED_API_KEY",
      allow: ["curl *"],
      created_at: "2026-06-05T10:00:00Z",
    });
    expect(JSON.stringify(secrets)).not.toContain("sk-super-secret-value");
  });

  test("the value is encrypted at rest and the keyfile is 0600", () => {
    set();
    const dir = secretsDir(vault);
    const storeRaw = readFileSync(join(dir, "secrets.json"), "utf8");
    expect(storeRaw).not.toContain("sk-super-secret-value");
    const keyMode = statSync(join(dir, "keyfile")).mode & 0o777;
    expect(keyMode).toBe(0o600);
    const storeMode = statSync(join(dir, "secrets.json")).mode & 0o777;
    expect(storeMode).toBe(0o600);
  });

  test("resolveSecretForExec decrypts; tampered ciphertext fails closed", () => {
    set();
    expect(resolveSecretForExec(vault, "embed-key").value).toBe("sk-super-secret-value");

    const storePath = join(secretsDir(vault), "secrets.json");
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as {
      secrets: Record<string, { ciphertext: string }>;
    };
    const ct = Buffer.from(parsed.secrets["embed-key"]!.ciphertext, "base64");
    ct[0] = ct[0]! ^ 0xff;
    parsed.secrets["embed-key"]!.ciphertext = ct.toString("base64");
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(storePath, JSON.stringify(parsed));
    expect(() => resolveSecretForExec(vault, "embed-key")).toThrow();
  });

  test("an unknown name fails with the stored names listed", () => {
    set();
    expect(() => resolveSecretForExec(vault, "ghost")).toThrow(/ghost.*embed-key/);
  });

  test("removeSecret deletes the entry; the value is unrecoverable", () => {
    set();
    expect(removeSecret(vault, "embed-key", { agent: "tester", now: NOW })).toBe(true);
    expect(listSecrets(vault)).toHaveLength(0);
    expect(removeSecret(vault, "embed-key", { agent: "tester", now: NOW })).toBe(false);
  });

  test("set validates the name and refuses empty values", () => {
    expect(() =>
      setSecret(vault, { name: "bad name!", value: "x", agent: "tester", now: NOW }),
    ).toThrow(/name/);
    expect(() =>
      setSecret(vault, { name: "ok-name", value: "  ", agent: "tester", now: NOW }),
    ).toThrow(/value/);
  });

  test("every operation lands a no-values audit record", () => {
    set();
    resolveSecretForExec(vault, "embed-key");
    removeSecret(vault, "embed-key", { agent: "tester", now: NOW });
    const auditDir = join(vault, "Brain", "log", "secret-custody");
    const files = readdirSync(auditDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const lines = files
      .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { action: string });
    const actions = lines.map((l) => l.action);
    expect(actions).toContain("secret_set");
    expect(actions).toContain("secret_resolved_for_exec");
    expect(actions).toContain("secret_removed");
    expect(JSON.stringify(lines)).not.toContain("sk-super-secret-value");
  });
});

/**
 * `o2b mcp token` sub-dispatcher (write-side-trust, Task 14).
 *
 * mint | rotate | revoke | list over the named per-agent store. The
 * material of a mint or rotation is printed exactly once with a
 * shown-once notice; `list` prints metadata only (names, agents,
 * statuses, non-secret prefixes) and can never be talked into printing
 * material, because the store does not hold it. Every credential-shaped
 * literal here is assembled by `fakeCredential`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";
import { listAgentTokens, resolveAgentForToken } from "../../src/core/brain/secrets/token-store.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-token-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** The verb comes straight after `token`; flags follow it. */
function tokenArgs(extra: ReadonlyArray<string>): string[] {
  return ["mcp", "token", ...extra, "--vault", vault];
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The single osbt-shaped line a mint or rotate prints, trimmed. */
function printedMaterial(stdout: string): string {
  const start = stdout.indexOf("osbt_");
  expect(start).toBeGreaterThanOrEqual(0);
  return stdout.slice(start, stdout.indexOf("\n", start)).trim();
}

function custodyAuditRows(): Array<Record<string, any>> {
  const dir = join(vault, "Brain", "log", "secret-custody");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>),
  );
}

describe("o2b mcp token mint", () => {
  test("prints the material exactly once with the shown-once notice and stores only the hash", async () => {
    const r = await runCli(tokenArgs(["mint", "--agent", "codex"]));
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("mcp_token_codex");
    expect(r.stdout).toContain("shown exactly once");

    const tokenMaterial = printedMaterial(r.stdout);
    expect(countOccurrences(r.stdout, tokenMaterial)).toBe(1);
    expect(r.stderr).not.toContain(tokenMaterial);

    const store = listAgentTokens(vault);
    expect(store).toHaveLength(1);
    expect(store[0]!.name).toBe("mcp_token_codex");
    expect(store[0]!.agent).toBe("codex");
    expect(store[0]!.status).toBe("active");
    expect(resolveAgentForToken(vault, tokenMaterial)).toEqual({
      agent: "codex",
      name: "mcp_token_codex",
    });
    // The audit records the mint with no values.
    const rows = custodyAuditRows().filter((row) => row["action"] === "mcp_token_minted");
    expect(rows).toHaveLength(1);
  });

  test("derives the name from the agent slug", async () => {
    const r = await runCli(tokenArgs(["mint", "--agent", "grok"]));
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("mcp_token_grok");
    expect(listAgentTokens(vault).map((t) => t.name)).toEqual(["mcp_token_grok"]);
  });

  test("an explicit --name that breaks the grammar is a usage refusal", async () => {
    const r = await runCli(tokenArgs(["mint", "--agent", "codex", "--name", "mcp_token_Codex"]));
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("mcp_token_");
  });

  test("minting over a live name refuses and names rotate", async () => {
    const first = await runCli(tokenArgs(["mint", "--agent", "codex"]));
    expect(first.returncode).toBe(0);
    const second = await runCli(tokenArgs(["mint", "--agent", "codex"]));
    expect(second.returncode).toBe(1);
    expect(second.stderr).toContain("rotate");
  });

  test("a missing --agent is a usage refusal", async () => {
    const r = await runCli(tokenArgs(["mint"]));
    expect(r.returncode).toBe(2);
  });
});

describe("o2b mcp token rotate", () => {
  test("replaces the material under the same name; the old material stops resolving", async () => {
    const first = await runCli(tokenArgs(["mint", "--agent", "codex"]));
    const oldMaterial = printedMaterial(first.stdout);
    const before = listAgentTokens(vault)[0]!;

    const second = await runCli(tokenArgs(["rotate", "--name", "mcp_token_codex"]));
    expect(second.returncode).toBe(0);
    const newMaterial = printedMaterial(second.stdout);
    expect(newMaterial).not.toBe(oldMaterial);
    expect(countOccurrences(second.stdout, newMaterial)).toBe(1);
    expect(second.stdout).toContain("shown exactly once");

    const after = listAgentTokens(vault)[0]!;
    expect(after.name).toBe("mcp_token_codex");
    expect(after.token_hash).not.toBe(before.token_hash);
    expect(after.rotated_at).toBeDefined();
    expect(resolveAgentForToken(vault, oldMaterial)).toBeNull();
    expect(resolveAgentForToken(vault, newMaterial)).toEqual({
      agent: "codex",
      name: "mcp_token_codex",
    });

    const rows = custodyAuditRows().filter((row) => row["action"] === "mcp_token_rotated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["details"]["replaced"]).toBe(true);
  });

  test("rotating an unknown name is a runtime error; a missing --name is usage", async () => {
    const unknown = await runCli(tokenArgs(["rotate", "--name", "mcp_token_nobody"]));
    expect(unknown.returncode).toBe(1);
    const noName = await runCli(tokenArgs(["rotate"]));
    expect(noName.returncode).toBe(2);
  });
});

describe("o2b mcp token revoke", () => {
  test("stops the material; a second revoke refuses", async () => {
    const minted = await runCli(tokenArgs(["mint", "--agent", "codex"]));
    const tokenMaterial = printedMaterial(minted.stdout);

    const revoked = await runCli(tokenArgs(["revoke", "--name", "mcp_token_codex"]));
    expect(revoked.returncode).toBe(0);
    expect(revoked.stdout).toContain("revoked");
    expect(resolveAgentForToken(vault, tokenMaterial)).toBeNull();

    const again = await runCli(tokenArgs(["revoke", "--name", "mcp_token_codex"]));
    expect(again.returncode).toBe(1);
  });
});

describe("o2b mcp token list", () => {
  test("shows every record sorted, with prefixes, and never the material", async () => {
    const codex = await runCli(tokenArgs(["mint", "--agent", "codex"]));
    const codexMaterial = printedMaterial(codex.stdout);
    const aider = await runCli(tokenArgs(["mint", "--agent", "aider"]));
    const aiderMaterial = printedMaterial(aider.stdout);

    const r = await runCli(tokenArgs(["list"]));
    expect(r.returncode).toBe(0);
    const codexAt = r.stdout.indexOf("mcp_token_codex");
    const aiderAt = r.stdout.indexOf("mcp_token_aider");
    expect(codexAt).toBeGreaterThanOrEqual(0);
    expect(aiderAt).toBeGreaterThanOrEqual(0);
    expect(aiderAt).toBeLessThan(codexAt);
    expect(r.stdout).toContain("active");
    expect(r.stdout).toContain("osbt_"); // the non-secret prefixes
    expect(r.stdout).not.toContain(codexMaterial);
    expect(r.stdout).not.toContain(aiderMaterial);
  });

  test("an empty store answers with zero records", async () => {
    const r = await runCli(tokenArgs(["list"]));
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no tokens");
  });
});

describe("o2b mcp token dispatch", () => {
  test("a missing or unknown verb is a usage refusal naming the four verbs", async () => {
    const bare = await runCli(tokenArgs([]));
    expect(bare.returncode).toBe(2);
    expect(bare.stderr).toContain("mint");
    const unknown = await runCli(tokenArgs(["frobnicate"]));
    expect(unknown.returncode).toBe(2);
    expect(unknown.stderr).toContain("frobnicate");
  });

  test("an unconfigured vault is the named usage refusal", async () => {
    const r = await runCli(["mcp", "token", "mint", "--agent", "codex"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("vault not configured");
  });

  test("an unresolvable presented material still answers null after all of the above", () => {
    expect(
      resolveAgentForToken(vault, fakeCredential("osbt_", "absent-material-value")),
    ).toBeNull();
  });
});

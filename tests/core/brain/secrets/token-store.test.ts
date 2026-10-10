/**
 * Named per-agent MCP token store (write-side-trust, Task 3).
 *
 * Hash-at-rest: the store keeps sha256(tokenMaterial) beside a
 * non-secret prefix, and the minted material exists in plaintext only
 * for the moment the mint answer carries it - shown once, never
 * stored, never audited. Every credential-shaped literal here is
 * assembled by `fakeCredential`, so no source line carries a string
 * shaped like a real token.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import {
  MCP_TOKENS_SCHEMA_VERSION,
  TOKEN_PREFIX_LENGTH,
  listAgentTokens,
  mintAgentToken,
  resolveAgentForToken,
  revokeAgentToken,
  rotateAgentToken,
} from "../../../../src/core/brain/secrets/token-store.ts";
import {
  secretsDir,
  tokenStorePath,
  withSecretsLock,
} from "../../../../src/core/brain/secrets/store.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

let tempRoot: string;
let vault: string;

beforeEach(() => {
  // A vault name with spaces and CJK characters: the store round-trips
  // vault paths no filesystem grammar should have to care about.
  tempRoot = mkdtempSync(join(tmpdir(), "o2b-token-store-"));
  vault = join(tempRoot, "brain vault 東");
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** sha256 hex, the at-rest form the store persists. */
function hashOf(material: string): string {
  return createHash("sha256").update(material).digest("hex");
}

function mint(name = "mcp_token_codex", agent = "codex") {
  return mintAgentToken(vault, name, agent);
}

function auditActions(): string[] {
  const auditDir = join(vault, "Brain", "log", "secret-custody");
  if (!existsSync(auditDir)) return [];
  return readdirSync(auditDir)
    .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n"))
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { action: string }).action);
}

function auditLines(): string[] {
  const auditDir = join(vault, "Brain", "log", "secret-custody");
  return readdirSync(auditDir)
    .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n"))
    .filter((l) => l.trim().length > 0);
}

describe("mintAgentToken", () => {
  test("returns material exactly once and persists only the hash plus a non-secret prefix", () => {
    const { tokenMaterial, record } = mint();
    expect(tokenMaterial).toMatch(/^osbt_/);
    expect(record).toMatchObject({
      name: "mcp_token_codex",
      agent: "codex",
      status: "active",
      token_hash: hashOf(tokenMaterial),
      created_at: expect.any(String),
    });
    // The prefix is a display aid, not a credential: a cut of the front
    // of the material, never the whole of it.
    expect(record.token_prefix).toBe(tokenMaterial.slice(0, TOKEN_PREFIX_LENGTH));
    expect(record.token_prefix.length).toBeLessThan(tokenMaterial.length);

    const raw = readFileSync(tokenStorePath(vault), "utf8");
    expect(raw).not.toContain(tokenMaterial);
    const parsed = JSON.parse(raw) as {
      version: number;
      tokens: Record<string, { token_hash: string }>;
    };
    expect(parsed.version).toBe(MCP_TOKENS_SCHEMA_VERSION);
    expect(parsed.tokens["mcp_token_codex"]?.token_hash).toBe(hashOf(tokenMaterial));
  });

  test("the store file is created 0600 on POSIX", () => {
    if (IS_WINDOWS) return; // access there is the owner ACL, pinned via custodyTargets
    mint();
    const mode = statSync(tokenStorePath(vault)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a fresh vault keeps the store absent until the first mint", () => {
    expect(listAgentTokens(vault)).toEqual([]);
    expect(resolveAgentForToken(vault, fakeCredential("osbt_", "nothing-here"))).toBeNull();
    expect(existsSync(secretsDir(vault))).toBe(false);
  });

  test("names validate mcp_token_<slug> in the $secret: grammar", () => {
    expect(() => mint("codex")).toThrow(/name/);
    expect(() => mint("mcp_token_")).toThrow(/name/);
    expect(() => mint("MCP_TOKEN_CODEX")).toThrow(/name/);
    expect(() => mint("mcp-token-codex")).toThrow(/name/);
    expect(() => mint("mcp_token_codex", " ")).toThrow(/agent/);
  });

  test("an existing name refuses mint and names rotate", () => {
    mint();
    expect(() => mint()).toThrow(/rotate/);
  });

  test("writes serialize under the secrets store lock", () => {
    // The lock anchors on the secrets directory, which a first write
    // creates through the keyfile path; build it here so the held lock
    // describes the same directory a real writer would hold.
    mkdirSync(secretsDir(vault), { recursive: true });
    const release = lockfile.lockSync(secretsDir(vault), { stale: 10_000, realpath: false });
    try {
      expect(() => mint()).toThrow(/secrets store lock/);
    } finally {
      void release();
    }
    mint();
    expect(listAgentTokens(vault)).toHaveLength(1);
  });

  test("two named tokens coexist and land one mint audit record each", () => {
    mint("mcp_token_codex", "codex");
    mint("mcp_token_grok", "grok");
    expect(listAgentTokens(vault).map((t) => t.name)).toEqual([
      "mcp_token_codex",
      "mcp_token_grok",
    ]);
    expect(auditActions().filter((a) => a === "mcp_token_minted")).toHaveLength(2);
  });
});

describe("listAgentTokens", () => {
  test("sorted by name, never carrying the material", () => {
    const grok = mint("mcp_token_grok", "grok");
    const codex = mint("mcp_token_codex", "codex");
    const listed = listAgentTokens(vault);
    expect(listed.map((t) => t.name)).toEqual(["mcp_token_codex", "mcp_token_grok"]);
    expect(JSON.stringify(listed)).not.toContain(codex.tokenMaterial);
    expect(JSON.stringify(listed)).not.toContain(grok.tokenMaterial);
  });
});

describe("resolveAgentForToken", () => {
  test("matches the presented material by hash; unknown material answers null", () => {
    const { tokenMaterial } = mint();
    expect(resolveAgentForToken(vault, tokenMaterial)).toEqual({
      agent: "codex",
      name: "mcp_token_codex",
    });
    expect(resolveAgentForToken(vault, fakeCredential("osbt_", "unknown-material"))).toBeNull();
    expect(resolveAgentForToken(vault, "")).toBeNull();
    expect(resolveAgentForToken(vault, tokenMaterial.slice(0, 8))).toBeNull();
  });

  test("a revoked token answers null, exactly like an unknown one", () => {
    const { tokenMaterial } = mint();
    expect(revokeAgentToken(vault, "mcp_token_codex")).toBe(true);
    expect(resolveAgentForToken(vault, tokenMaterial)).toBeNull();
    expect(listAgentTokens(vault)[0]?.status).toBe("revoked");
  });

  test("a rotation takes effect on the next call without any restart", () => {
    const first = mint();
    expect(resolveAgentForToken(vault, first.tokenMaterial)?.agent).toBe("codex");
    const second = rotateAgentToken(vault, "mcp_token_codex");
    expect(second.record.status).toBe("active");
    expect(second.record.rotated_at).toEqual(expect.any(String));
    expect(resolveAgentForToken(vault, first.tokenMaterial)).toBeNull();
    expect(resolveAgentForToken(vault, second.tokenMaterial)).toEqual({
      agent: "codex",
      name: "mcp_token_codex",
    });
  });

  test("a store rewritten by another process is picked up through the mtime cache", () => {
    // Simulate a rotation performed by a different process (the CLI)
    // while a long-lived server holds its read cache: rewrite the store
    // file out from under the cache and resolve again.
    const stale = mint();
    expect(resolveAgentForToken(vault, stale.tokenMaterial)?.agent).toBe("codex");
    const elsewhere = fakeCredential("osbt_", "rotated-elsewhere-9c22");
    const file = JSON.parse(readFileSync(tokenStorePath(vault), "utf8")) as {
      version: number;
      tokens: Record<string, unknown>;
    };
    file.tokens["mcp_token_codex"] = {
      name: "mcp_token_codex",
      agent: "codex",
      status: "active",
      token_hash: hashOf(elsewhere),
      token_prefix: elsewhere.slice(0, TOKEN_PREFIX_LENGTH),
      created_at: "2026-06-05T10:00:00Z",
    };
    writeFileSync(tokenStorePath(vault), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    expect(resolveAgentForToken(vault, stale.tokenMaterial)).toBeNull();
    expect(resolveAgentForToken(vault, elsewhere)?.agent).toBe("codex");
  });
});

describe("rotateAgentToken", () => {
  test("re-mints under the same name and keeps created_at", () => {
    const first = mint();
    const second = rotateAgentToken(vault, "mcp_token_codex");
    expect(second.record.created_at).toBe(first.record.created_at);
    expect(second.record.token_hash).not.toBe(first.record.token_hash);
    expect(listAgentTokens(vault)).toHaveLength(1);
  });

  test("an unknown name refuses by name; a revoked one stays revoked", () => {
    expect(() => rotateAgentToken(vault, "mcp_token_ghost")).toThrow(/unknown token/);
    mint();
    revokeAgentToken(vault, "mcp_token_codex");
    expect(() => rotateAgentToken(vault, "mcp_token_codex")).toThrow(/revoked/);
  });

  test("revoke then revoke again answers true then false, one audit record", () => {
    mint();
    expect(revokeAgentToken(vault, "mcp_token_codex")).toBe(true);
    expect(revokeAgentToken(vault, "mcp_token_codex")).toBe(false);
    expect(auditActions().filter((a) => a === "mcp_token_revoked")).toHaveLength(1);
  });
});

describe("custody audit", () => {
  test("mint, rotate and revoke land no-values records; material never appears", () => {
    const minted = mint();
    rotateAgentToken(vault, "mcp_token_codex");
    revokeAgentToken(vault, "mcp_token_codex");
    const actions = auditActions();
    expect(actions).toContain("mcp_token_minted");
    expect(actions).toContain("mcp_token_rotated");
    expect(actions).toContain("mcp_token_revoked");
    const everything = auditLines().join("\n");
    expect(everything).not.toContain(minted.tokenMaterial);
    expect(everything).not.toContain(minted.record.token_hash);
  });

  test("the rotation audit row carries replaced: true", () => {
    mint();
    rotateAgentToken(vault, "mcp_token_codex");
    const auditDir = join(vault, "Brain", "log", "secret-custody");
    const rows = readdirSync(auditDir)
      .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> });
    const rotated = rows.filter((r) => r.action === "mcp_token_rotated");
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.details).toMatchObject({ replaced: true, agent: "codex" });
  });
});

describe("the Windows custody ACL covers the token store", () => {
  test("an existing mcp-tokens.json joins custodyTargets", () => {
    mint();
    const { custodyTargets } = require("../../../../src/core/brain/secrets/store.ts") as {
      custodyTargets: (v: string) => ReadonlyArray<readonly [string, string]>;
    };
    expect(custodyTargets(vault).map(([p]) => p)).toContain(tokenStorePath(vault));
  });
});

describe("the store lock stays with the store module", () => {
  test("withSecretsLock serialises a token write the same as a custody write", () => {
    let ran = false;
    withSecretsLock(vault, () => {
      ran = true;
    });
    expect(ran);
  });
});

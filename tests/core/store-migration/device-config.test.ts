/**
 * What the migration writes into this machine's device config (design D14
 * items 3 and 15): the changed device keys of `_brain.yaml`, never over a
 * key the user already set, and the MCP token map, so a vault-free server
 * authenticates a token minted before the migration; a rollback makes the
 * per-vault token map authoritative again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  mintAgentToken,
  revokeAgentToken,
  rotateAgentToken,
} from "../../../src/core/brain/secrets/token-store.ts";
import { tokenStorePath } from "../../../src/core/brain/secrets/store.ts";
import { readBrainSettingsFromStore } from "../../../src/core/brain/policy/settings-source.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { deviceTokenStorePath, resolveMcpToken } from "../../../src/mcp/token-source.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

const FAST = { settleMs: 0 } as const;
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

describe("the migration's device config", () => {
  test("changed device keys are written to the machine config; a key the user set stays", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const configPath = process.env["OPEN_SECOND_BRAIN_CONFIG"]!;
    a.write(
      "Brain/_brain.yaml",
      "schema_version: 1\nsnapshots:\n  retention_count: 9\nhygiene:\n  resolver_cmd: ./resolve.sh\n",
    );
    appendFileSync(configPath, 'brain_hygiene_resolver_cmd: "./mine.sh"\n');

    const result = runMigration(a.vault, FAST);
    expect(result.ok).toBe(true);
    expect(result.device_config?.written).toEqual(["brain_snapshots_retention_count: 9"]);
    expect(result.device_config?.kept).toEqual(["brain_hygiene_resolver_cmd"]);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("brain_snapshots_retention_count: 9\n");
    expect(text).toContain('brain_hygiene_resolver_cmd: "./mine.sh"');
    expect(text).not.toContain("./resolve.sh");
    // Switched, the setting is in force with its type, not its default.
    const { config } = readBrainSettingsFromStore({ configPath });
    expect(config.snapshots.retention_count).toBe(9);
  });

  test("a token minted before the migration authenticates a vault-free server; a rollback hands the map back", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const configPath = process.env["OPEN_SECOND_BRAIN_CONFIG"]!;
    // The fixture's keyfile is a placeholder; minting makes a real one.
    rmSync(join(a.vault, ".open-second-brain", "secrets", "keyfile"));
    const { tokenMaterial } = mintAgentToken(a.vault, "mcp_token_codex", "codex");
    expect(resolveMcpToken({ vault: null, configPath }, tokenMaterial)).toBeNull();

    const result = runMigration(a.vault, FAST);
    expect(result.device_tokens?.status).toBe("copied");
    expect(resolveMcpToken({ vault: null, configPath }, tokenMaterial)).toMatchObject({
      agent: "codex",
    });

    const back = rollback(a.vault);
    expect(back.device_tokens_aside).toBeNull();
    expect(existsSync(deviceTokenStorePath(configPath))).toBe(false);
    expect(resolveMcpToken({ vault: a.vault, configPath }, tokenMaterial)).toMatchObject({
      agent: "codex",
    });
  });

  test("on a switched machine minting, rotation and revocation write the device-config map", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const configPath = process.env["OPEN_SECOND_BRAIN_CONFIG"]!;
    rmSync(join(a.vault, ".open-second-brain", "secrets", "keyfile"));
    mintAgentToken(a.vault, "mcp_token_codex", "codex");
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const perVault = readFileSync(tokenStorePath(a.vault), "utf8");

    const { tokenMaterial } = mintAgentToken(a.vault, "mcp_token_late", "late");
    expect(resolveMcpToken({ vault: null, configPath }, tokenMaterial)).toMatchObject({
      agent: "late",
    });
    const rotated = rotateAgentToken(a.vault, "mcp_token_late").tokenMaterial;
    expect(resolveMcpToken({ vault: null, configPath }, rotated)).toMatchObject({ agent: "late" });
    expect(revokeAgentToken(a.vault, "mcp_token_late")).toBe(true);
    expect(resolveMcpToken({ vault: null, configPath }, rotated)).toBeNull();
    // The vault's own map is untouched once switched.
    expect(readFileSync(tokenStorePath(a.vault), "utf8")).toBe(perVault);
  });

  test("a rollback hands back the token map as it is now: later tokens work, revoked ones do not", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const configPath = process.env["OPEN_SECOND_BRAIN_CONFIG"]!;
    rmSync(join(a.vault, ".open-second-brain", "secrets", "keyfile"));
    const early = mintAgentToken(a.vault, "mcp_token_early", "early").tokenMaterial;
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // After the switch: one token revoked, one minted.
    expect(revokeAgentToken(a.vault, "mcp_token_early")).toBe(true);
    const late = mintAgentToken(a.vault, "mcp_token_late", "late").tokenMaterial;

    const back = rollback(a.vault);
    expect(back.device_tokens_aside).toBeNull();
    expect(existsSync(deviceTokenStorePath(configPath))).toBe(false);
    expect(resolveMcpToken({ vault: a.vault, configPath }, early)).toBeNull();
    expect(resolveMcpToken({ vault: a.vault, configPath }, late)).toMatchObject({ agent: "late" });
    if (process.platform !== "win32") {
      expect(statSync(tokenStorePath(a.vault)).mode & 0o777).toBe(0o600);
    }
  });
});

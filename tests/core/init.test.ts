import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import {
  AGENTS_PLACEHOLDER,
  VAULT_FILES,
  bootstrapVault,
} from "../../src/core/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-init-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("bootstrapVault", () => {
  test("creates the canonical structure", () => {
    const created = bootstrapVault(tmp, { name: "Test Brain" });
    expect(created.length).toBeGreaterThan(0);
    for (const rel of VAULT_FILES) {
      expect(existsSync(join(tmp, rel))).toBe(true);
    }
    const manual = readFileSync(join(tmp, "AI Wiki", "_OPEN_SECOND_BRAIN.md"), "utf8");
    expect(manual).toContain("Test Brain");
  });

  test("writes agent_name into agents.md", () => {
    bootstrapVault(tmp, { name: "Test", agentName: "openclaw-main" });
    const txt = readFileSync(join(tmp, "AI Wiki", "identity", "agents.md"), "utf8");
    expect(txt).toContain("- openclaw-main: primary agent on this server");
    expect(txt).not.toContain(AGENTS_PLACEHOLDER);
  });

  test("without agent_name keeps placeholder", () => {
    bootstrapVault(tmp, { name: "Test" });
    const txt = readFileSync(join(tmp, "AI Wiki", "identity", "agents.md"), "utf8");
    expect(txt).toContain(AGENTS_PLACEHOLDER);
  });

  test("registers a second agent under existing one (multi-runtime install)", () => {
    bootstrapVault(tmp, { name: "Test", agentName: "hermes-vps-agent" });
    const agentsPath = join(tmp, "AI Wiki", "identity", "agents.md");
    expect(readFileSync(agentsPath, "utf8")).toContain(
      "- hermes-vps-agent: primary agent on this server",
    );

    const second = bootstrapVault(tmp, { name: "Test", agentName: "codex-vps-agent" });
    expect(second).toContain(normalize("AI Wiki/identity/agents.md"));

    const text = readFileSync(agentsPath, "utf8");
    expect(text).toContain("- hermes-vps-agent: primary agent on this server");
    expect(text).toContain("- codex-vps-agent: primary agent on this server");
    expect(text.indexOf("hermes-vps-agent")).toBeLessThan(text.indexOf("codex-vps-agent"));
    expect(text).toContain("## Scopes");
    expect(text.indexOf("codex-vps-agent")).toBeLessThan(text.indexOf("## Scopes"));

    // Re-registering the same agent is a no-op.
    const third = bootstrapVault(tmp, { name: "Test", agentName: "codex-vps-agent" });
    expect(third).not.toContain(normalize("AI Wiki/identity/agents.md"));
    const after = readFileSync(agentsPath, "utf8");
    expect((after.match(/- codex-vps-agent: primary agent on this server/g) ?? []).length).toBe(1);
  });

  test("upgrades existing placeholder in place when agent_name added later", () => {
    bootstrapVault(tmp, { name: "Test" });
    const agentsPath = join(tmp, "AI Wiki", "identity", "agents.md");
    expect(readFileSync(agentsPath, "utf8")).toContain(AGENTS_PLACEHOLDER);

    const created = bootstrapVault(tmp, { name: "Test", agentName: "hermes-main" });
    expect(created).toContain(normalize("AI Wiki/identity/agents.md"));
    const text = readFileSync(agentsPath, "utf8");
    expect(text).toContain("- hermes-main: primary agent on this server");
    expect(text).not.toContain(AGENTS_PLACEHOLDER);
  });

  test("does not overwrite existing files by default", () => {
    mkdirSync(join(tmp, "AI Wiki"), { recursive: true });
    writeFileSync(join(tmp, "AI Wiki", "index.md"), "custom content");
    const created = bootstrapVault(tmp, { name: "Test" });
    expect(created).not.toContain(normalize("AI Wiki/index.md"));
    expect(readFileSync(join(tmp, "AI Wiki", "index.md"), "utf8")).toBe("custom content");
  });

  test("force overwrites", () => {
    mkdirSync(join(tmp, "AI Wiki"), { recursive: true });
    writeFileSync(join(tmp, "AI Wiki", "index.md"), "old");
    const created = bootstrapVault(tmp, { name: "Test", force: true });
    expect(created).toContain(normalize("AI Wiki/index.md"));
    expect(readFileSync(join(tmp, "AI Wiki", "index.md"), "utf8")).not.toBe("old");
  });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildOnboardingChecklist, renderOnboardingChecklist } from "../../src/cli/onboarding.ts";

let vault: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-onboarding-"));
  configPath = join(vault, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function stepById(vaultDir: string, id: string) {
  const checklist = buildOnboardingChecklist(vaultDir, { configPath, env: {} });
  return checklist.steps.find((s) => s.id === id)!;
}

test("a bare initialized vault marks config done and later steps todo", () => {
  const checklist = buildOnboardingChecklist(vault, { configPath, env: {} });
  const byId = new Map(checklist.steps.map((s) => [s.id, s]));
  expect(byId.get("vault_configured")!.done).toBe(true);
  expect(byId.get("build_index")!.done).toBe(false);
  expect(byId.get("build_index")!.command).toContain("o2b search index");
  expect(byId.get("scaffold_brain")!.done).toBe(false);
  expect(byId.get("agent_name")!.done).toBe(false);
  // Required steps still pending -> not complete.
  expect(checklist.complete).toBe(false);
});

test("a built search index flips the index step to done", () => {
  expect(stepById(vault, "build_index").done).toBe(false);
  mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
  writeFileSync(join(vault, ".open-second-brain", "brain.sqlite"), "x", "utf8");
  expect(stepById(vault, "build_index").done).toBe(true);
});

test("a configured agent name flips the agent step to done", () => {
  writeFileSync(configPath, `vault: "${vault}"\nagent_name: "claude-dev"\n`, "utf8");
  expect(stepById(vault, "agent_name").done).toBe(true);
});

test("recording a first preference flips the feedback step to done", () => {
  expect(stepById(vault, "first_feedback").done).toBe(false);
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  writeFileSync(join(vault, "Brain", "preferences", "pref-x.md"), "---\nid: pref-x\n---\n", "utf8");
  expect(stepById(vault, "first_feedback").done).toBe(true);
});

test("a local embedding provider is semantic-ready without an API key", () => {
  writeFileSync(
    configPath,
    `vault: "${vault}"\nsearch_semantic_enabled: "true"\nembedding_provider: "local"\n`,
    "utf8",
  );
  // No embedding key, but a local provider needs none - the optional semantic
  // step is satisfied, matching the runtime-notice logic.
  expect(stepById(vault, "semantic_search").done).toBe(true);
});

test("the checklist renders a human-readable block with checkboxes and commands", () => {
  const checklist = buildOnboardingChecklist(vault, { configPath, env: {} });
  const text = renderOnboardingChecklist(checklist);
  expect(text).toContain("Next steps:");
  expect(text).toContain("[x]"); // config done
  expect(text).toContain("[ ]"); // pending steps
  expect(text).toContain("o2b search index");
});

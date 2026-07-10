/**
 * Memory-source backend boundary (Agent Write Contract Suite,
 * t_53f9f67f): protocol + registry + Claude adapter with config-driven
 * selection. The default backend must be byte-identical to calling the
 * claude-memory modules directly.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MEMORY_BACKEND_ID,
  getMemoryBackend,
  listMemoryBackends,
  resolveMemoryBackend,
} from "../../../src/core/brain/agent-backend/registry.ts";
import { claudeMemoryBackend } from "../../../src/core/brain/agent-backend/claude.ts";
import { parseClaudeMemoryFile } from "../../../src/core/brain/claude-memory-parser.ts";
import {
  renderPreferenceFromMemory,
  slugifyMemoryName,
} from "../../../src/core/brain/claude-memory-render.ts";
import { defaultMemoryDir } from "../../../src/core/brain/claude-memory-paths.ts";
import { importClaudeMemory } from "../../../src/core/brain/import-claude-memory.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-agent-backend-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const MEMORY_FILE = [
  "---",
  "name: no_shouting_in_docs",
  "description: Avoid exclamation marks in documentation",
  "metadata:",
  "  type: feedback",
  "---",
  "",
  "Do not use exclamation marks in technical documentation.",
  "",
  "**Why:** Tone consistency.",
  "**How to apply:** Use neutral punctuation.",
].join("\n");

test("registry lists the registered backends and resolves them by id", () => {
  const ids = listMemoryBackends().map((b) => b.id);
  expect(ids).toEqual(["claude", "mem0", "generic"]);
  expect(getMemoryBackend("claude").id).toBe("claude");
  expect(DEFAULT_MEMORY_BACKEND_ID).toBe("claude");
});

test("an unknown backend id fails with the registered list in the message", () => {
  expect(() => getMemoryBackend("cursor")).toThrow(/unknown memory backend 'cursor'.*claude/);
});

test("resolveMemoryBackend defaults to claude and honors the memory_backend config key", () => {
  const configPath = join(tmp, "config.yaml");
  // A guaranteed-missing path keeps the default-resolution assertion
  // hermetic - the host machine's real config must not leak in.
  expect(resolveMemoryBackend(join(tmp, "missing-config.yaml")).id).toBe("claude");
  expect(resolveMemoryBackend(configPath).id).toBe("claude");

  writeFileSync(configPath, 'vault: "/tmp/x"\nmemory_backend: claude\n');
  expect(resolveMemoryBackend(configPath).id).toBe("claude");

  writeFileSync(configPath, 'vault: "/tmp/x"\nmemory_backend: bogus\n');
  expect(() => resolveMemoryBackend(configPath)).toThrow(/unknown memory backend 'bogus'/);
});

test("the claude adapter is byte-identical to the claude-memory modules", () => {
  const entries = claudeMemoryBackend.parseMemoryEntries(MEMORY_FILE);
  expect(entries).toEqual([parseClaudeMemoryFile(MEMORY_FILE)]);
  const parsed = entries[0]!;
  if (parsed.kind !== "feedback") throw new Error("fixture must parse as feedback");

  expect(claudeMemoryBackend.slugifyName(parsed.name)).toBe(slugifyMemoryName(parsed.name));

  const renderInput = {
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    memoryPath: "/home/u/.claude/projects/-x/memory/no_shouting.md",
    importedAt: "2026-06-04T10:00:00Z",
    bodySha256: parsed.bodySha256,
  };
  expect(claudeMemoryBackend.renderPreference(renderInput)).toBe(
    renderPreferenceFromMemory(renderInput),
  );

  expect(claudeMemoryBackend.discoverMemoryDir("/srv/projects/demo")).toBe(
    defaultMemoryDir("/srv/projects/demo"),
  );
});

test("importClaudeMemory through an explicit backend matches the default path", () => {
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const memoryDir = join(tmp, "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "no_shouting_in_docs.md"), MEMORY_FILE);

  const baseline = importClaudeMemory({
    vault,
    memoryDir,
    mode: "dry-run",
    allowArbitraryMemoryPath: true,
  });
  const viaBackend = importClaudeMemory({
    vault,
    memoryDir,
    mode: "dry-run",
    allowArbitraryMemoryPath: true,
    backend: claudeMemoryBackend,
  });
  expect(viaBackend.plans).toEqual(baseline.plans);
  expect(viaBackend.skipped).toEqual(baseline.skipped);
});

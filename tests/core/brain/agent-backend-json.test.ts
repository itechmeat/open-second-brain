/**
 * mem0 / generic JSON memory-store backends (t_ac9d2588). The seam widened to
 * discover-files + parse-entries so one JSON export maps to many preferences.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { mem0MemoryBackend } from "../../../src/core/brain/agent-backend/mem0.ts";
import { genericMemoryBackend } from "../../../src/core/brain/agent-backend/generic.ts";
import { getMemoryBackend } from "../../../src/core/brain/agent-backend/registry.ts";
import { importClaudeMemory } from "../../../src/core/brain/import-claude-memory.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-json-backend-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("mem0 backend", () => {
  test("parses a top-level array export into one entry per record", () => {
    const text = JSON.stringify([
      { id: "abc", memory: "Prefer pipeline() over barriers." },
      { name: "tone", memory: "Keep a neutral tone.", metadata: { description: "Voice rule" } },
    ]);
    const entries = mem0MemoryBackend.parseMemoryEntries(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "feedback",
      body: "Prefer pipeline() over barriers.",
    });
    expect(entries[1]).toMatchObject({ kind: "feedback", name: "tone", description: "Voice rule" });
  });

  test("parses the {results:[...]} envelope shape", () => {
    const text = JSON.stringify({ results: [{ memory: "Alpha." }, { memory: "Bravo." }] });
    const entries = mem0MemoryBackend.parseMemoryEntries(text);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "feedback")).toBe(true);
  });

  test("a record with no memory text skips with a reason", () => {
    const entries = mem0MemoryBackend.parseMemoryEntries(JSON.stringify([{ id: "x" }]));
    expect(entries[0]).toMatchObject({ kind: "skip" });
  });

  test("a non-object record and invalid JSON both skip", () => {
    expect(mem0MemoryBackend.parseMemoryEntries(JSON.stringify(["nope"]))[0]).toMatchObject({
      kind: "skip",
    });
    expect(mem0MemoryBackend.parseMemoryEntries("{ not json")[0]).toMatchObject({ kind: "skip" });
  });

  test("discoverMemoryFiles selects .json exports only", () => {
    writeFileSync(join(tmp, "export.json"), "[]", "utf8");
    writeFileSync(join(tmp, "notes.md"), "x", "utf8");
    expect(mem0MemoryBackend.discoverMemoryFiles(tmp)).toEqual(["export.json"]);
  });

  test("discoverMemoryDir has no default and fails loudly", () => {
    expect(() => mem0MemoryBackend.discoverMemoryDir("/srv/x")).toThrow(/--memory/);
  });
});

describe("generic backend", () => {
  test("parses the neutral {name,description,body} array", () => {
    const text = JSON.stringify([
      { name: "no-shouting", description: "Tone rule", body: "Never use all caps." },
      { body: "Minimal entry with body only." },
    ]);
    const entries = genericMemoryBackend.parseMemoryEntries(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "feedback",
      name: "no-shouting",
      description: "Tone rule",
    });
    // Minimal entry: name/description fall back to a body-derived value.
    expect(entries[1]).toMatchObject({ kind: "feedback", body: "Minimal entry with body only." });
  });

  test("registered under its id; unknown id fails with the registered list", () => {
    expect(getMemoryBackend("mem0").id).toBe("mem0");
    expect(getMemoryBackend("generic").id).toBe("generic");
    expect(() => getMemoryBackend("nope")).toThrow(/registered: claude, mem0, generic/);
  });
});

describe("importClaudeMemory through the mem0 backend (end-to-end)", () => {
  function setupVault(): string {
    const v = join(tmp, "vault");
    mkdirSync(v, { recursive: true });
    bootstrapBrain(v);
    return v;
  }

  test("dry-run plans one preference per mem0 record", () => {
    const vault = setupVault();
    const memDir = join(tmp, "mem0");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "export.json"),
      JSON.stringify([
        { name: "rule-a", memory: "Body A." },
        { name: "rule-b", memory: "Body B." },
      ]),
      "utf8",
    );
    const res = importClaudeMemory({
      vault,
      memoryDir: memDir,
      mode: "dry-run",
      allowArbitraryMemoryPath: true,
      backend: mem0MemoryBackend,
    });
    expect(res.plans).toHaveLength(2);
    expect(res.plans.every((p) => p.action === "CREATE")).toBe(true);
  });

  test("apply writes one preference file per record, pointed at a single export file", () => {
    const vault = setupVault();
    const memFile = join(tmp, "mem0-export.json");
    writeFileSync(
      memFile,
      JSON.stringify({ results: [{ name: "keep-neutral", memory: "Stay neutral." }] }),
      "utf8",
    );
    const res = importClaudeMemory({
      vault,
      memoryDir: memFile,
      mode: "apply",
      allowArbitraryMemoryPath: true,
      backend: mem0MemoryBackend,
    });
    expect(res.applied).toHaveLength(1);
    const prefFile = join(vault, "Brain", "preferences", "pref-keep-neutral.md");
    expect(existsSync(prefFile)).toBe(true);
    const body = readFileSync(prefFile, "utf8");
    expect(body).toContain("Stay neutral.");
  });
});

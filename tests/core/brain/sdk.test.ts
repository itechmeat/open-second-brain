/**
 * In-process SDK (Brain Portability & Interop suite, Unit C).
 *
 * `createBrain(vault)` is a thin façade: every method delegates to an
 * existing core function. These tests assert the façade returns the core
 * result and that the source CRUD lifecycle works end to end through it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { createBrain } from "../../../src/core/brain/sdk.ts";
import { BANK_BUNDLE_SCHEMA_VERSION } from "../../../src/core/brain/portability/bundle.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-sdk-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-sdk-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("createBrain", () => {
  test("exposes the bound vault", () => {
    expect(createBrain(vault).vault).toBe(vault);
  });

  test("exportBank delegates to the bank exporter", () => {
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks [[Other]].\n");
    const bundle = createBrain(vault).exportBank();
    expect(bundle.schema).toBe(BANK_BUNDLE_SCHEMA_VERSION);
    expect(bundle.graph.nodes.some((n) => n.id === "Note")).toBe(true);
  });

  test("exportGraph / importGraph round-trip through the façade", () => {
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks [[Other]].\n");
    const brain = createBrain(vault);
    const graph = brain.exportGraph();
    const dest = mkdtempSync(join(tmpdir(), "o2b-sdk-dest-"));
    try {
      const result = createBrain(dest).importGraph(graph, { mode: "skip" });
      expect(result.created).toContain("Note.md");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("exportPreferencesJson returns the schema-versioned export", () => {
    const out = createBrain(vault).exportPreferencesJson();
    expect(out.schema).toBeDefined();
    expect(Array.isArray(out.preferences)).toBe(true);
  });

  test("source CRUD lifecycle: ingest -> list -> get -> delete", () => {
    const brain = createBrain(vault);
    const res = brain.ingestSource(
      {
        sourcePath: "Articles/x.md",
        summary: "summary x",
        extraction: { entities: [{ category: "concept", name: "Topic" }], relations: [] },
      },
      { agent: "claude", now: new Date("2026-01-01T00:00:00Z") },
    );
    expect(res.created).toBe(true);

    const listed = brain.listSources();
    expect(listed.length).toBe(1);
    const id = listed[0]!.path;

    const detail = brain.getSource(id);
    expect(detail!.body).toContain("summary x");

    expect(brain.deleteSource(id)).toBe(true);
    expect(brain.listSources().length).toBe(0);
  });

  test("createNote writes a vault note through the façade", () => {
    const res = createBrain(vault).createNote({
      path: "Notes/Sdk.md",
      frontmatter: { title: "Sdk" },
      content: "via sdk",
    });
    expect(res.created).toBe(true);
    expect(existsSync(join(vault, "Notes/Sdk.md"))).toBe(true);
  });
});

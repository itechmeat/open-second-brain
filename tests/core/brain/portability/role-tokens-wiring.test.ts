/**
 * Vault-map wiring (Vault portability suite, Feature 3, Task 8).
 *
 * The shared role-token resolver feeds two content surfaces: graph-import
 * target paths and scan-inline read paths. An absent map leaves both
 * unchanged; the FIXED Brain machinery layout is never routed through it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importVaultGraph } from "../../../../src/core/brain/portability/graph.ts";
import { scanInline } from "../../../../src/core/brain/inline-scan.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-vmap-wiring-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-vmap-wiring-cfg-"));
  const cfg = join(configHome, "config.yaml");
  atomicWriteFileSync(cfg, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: cfg });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeVaultMap(body: string): void {
  writeFileSync(join(vault, "Brain", "_vault-map.yaml"), body, "utf8");
}

describe("graph import token resolution", () => {
  test("resolves a {{role}} token in the target path via the vault-map", () => {
    writeVaultMap("projects: Work/Projects\n");
    const graph = {
      version: "1",
      nodes: [{ path: "{{projects}}/Foo.md", title: "Foo", links: [], relations: {} }],
    };
    const res = importVaultGraph(vault, graph, { mode: "overwrite" });
    expect(res.created).toContain("{{projects}}/Foo.md");
    expect(existsSync(join(vault, "Work", "Projects", "Foo.md"))).toBe(true);
  });

  test("an absent map leaves a literal token folder name in place", () => {
    const graph = {
      version: "1",
      nodes: [{ path: "{{projects}}/Bar.md", title: "Bar", links: [], relations: {} }],
    };
    importVaultGraph(vault, graph, { mode: "overwrite" });
    // Default token resolves to its own name "projects".
    expect(existsSync(join(vault, "projects", "Bar.md"))).toBe(true);
  });
});

describe("scan-inline token resolution", () => {
  test("resolves a {{role}} read path to the mapped folder", async () => {
    writeVaultMap("projects: Work\n");
    mkdirSync(join(vault, "Work"), { recursive: true });
    writeFileSync(
      join(vault, "Work", "note.md"),
      "@osb feedback negative topic=tokenised-read-path principle=p\n",
      "utf8",
    );
    const res = await scanInline(vault, { agent: "test", paths: ["{{projects}}"] });
    expect(res.created).toBeGreaterThanOrEqual(1);
  });
});

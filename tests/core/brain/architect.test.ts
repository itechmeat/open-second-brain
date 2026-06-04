/**
 * Deterministic architecture docs generator
 * (Project History Suite, t_929da8a2).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../../src/core/brain/architect/generate.ts";
import { scanProject } from "../../../src/core/brain/architect/scan.ts";

let tmp: string;
let project: string;
let vault: string;

function seed(relPath: string, content = "// x\n"): void {
  const abs = join(project, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-architect-"));
  project = join(tmp, "demo-app");
  mkdirSync(project, { recursive: true });
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });

  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "demo-app",
      version: "1.2.3",
      description: "Fixture project",
      main: "src/index.ts",
      dependencies: { "left-pad": "^1.0.0" },
    }),
  );
  seed("src/index.ts");
  seed("src/core/engine.ts");
  seed("src/core/util.ts");
  seed("src/cli/main.ts");
  seed("tests/engine.test.ts");
  seed("README.md", "# Demo App\n");
  // Noise that must be ignored:
  seed("node_modules/dep/index.js");
  seed(".git/HEAD", "ref: refs/heads/main\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("scanProject produces deterministic structural facts", () => {
  const facts = scanProject(project);
  expect(facts.name).toBe("demo-app");
  expect(facts.manifest!.version).toBe("1.2.3");
  expect(facts.manifest!.dependencies).toEqual(["left-pad"]);
  expect(facts.modules.map((m) => m.name)).toEqual(["cli", "core"]);
  expect(facts.modules.find((m) => m.name === "core")!.files).toBe(2);
  expect(facts.entryPoints).toContain("src/index.ts");
  expect(facts.testLayout).toBe("tests");
  // node_modules and .git are invisible.
  expect(facts.languages[".js"]).toBeUndefined();
  expect(facts.languages[".ts"]).toBe(5);
  // Determinism: scanning twice gives deep-equal results.
  expect(scanProject(project)).toEqual(facts);
});

test("scanProject degrades to a single root module on flat layouts", () => {
  const flat = join(tmp, "flat-proj");
  mkdirSync(flat, { recursive: true });
  writeFileSync(join(flat, "main.py"), "print('x')\n");
  const facts = scanProject(flat);
  expect(facts.modules.map((m) => m.name)).toEqual(["root"]);
  expect(facts.manifest).toBeNull();
  expect(facts.languages[".py"]).toBe(1);
});

test("first generation creates overview + per-module notes under Brain/projects/arch", () => {
  const res = generateArchDocs(vault, project);
  expect(res.created).toBeGreaterThanOrEqual(3); // overview + 2 modules
  expect(res.updated).toBe(0);
  const overview = readFileSync(res.overviewPath, "utf8");
  expect(overview).toContain("kind: arch-overview");
  expect(overview).toContain("<!-- o2b:begin summary -->");
  expect(overview).toContain("demo-app");
  expect(overview).toContain("core");
  const moduleNote = readFileSync(res.modulePaths.find((p) => p.endsWith("core.md"))!, "utf8");
  expect(moduleNote).toContain("kind: arch-module");
  expect(moduleNote).toContain("engine.ts");
});

test("regeneration preserves operator edits outside regions and refreshes facts inside", () => {
  const first = generateArchDocs(vault, project);
  const operatorNote = "\nOperator: core owns the scheduling invariants.\n";
  writeFileSync(first.overviewPath, readFileSync(first.overviewPath, "utf8") + operatorNote);

  seed("src/api/server.ts"); // new module appears
  const second = generateArchDocs(vault, project);
  const overview = readFileSync(second.overviewPath, "utf8");
  expect(overview).toContain("Operator: core owns the scheduling invariants.");
  expect(overview).toContain("api");
  expect(second.updated).toBeGreaterThanOrEqual(1);
});

test("unchanged project regenerates byte-identically", () => {
  const first = generateArchDocs(vault, project);
  const before = readFileSync(first.overviewPath, "utf8");
  const second = generateArchDocs(vault, project);
  expect(readFileSync(second.overviewPath, "utf8")).toBe(before);
  expect(second.created).toBe(0);
  expect(second.unchanged).toBeGreaterThanOrEqual(3);
});

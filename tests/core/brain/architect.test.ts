/**
 * Deterministic architecture docs generator
 * (Project History Suite, t_929da8a2).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("scanProject skips symlinks instead of following them", () => {
  // A symlink cycle inside the tree must not hang or overflow the scan,
  // and symlinked content outside the module must not be counted.
  symlinkSync(project, join(project, "src", "core", "loop"), "dir");
  const facts = scanProject(project);
  expect(facts.modules.find((m) => m.name === "core")!.files).toBe(2);
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

/**
 * The renderer must not consult the host's collation.
 *
 * Two children generate the same fixture and their overview bytes are
 * compared. `LC_ALL` alone cannot prove this: measured on this runtime,
 * `new Intl.Collator().resolvedOptions().locale` stays `en-US` whatever
 * `LC_ALL` says, so an env-only test would pass against a collator-based
 * tie-break too. The second child therefore installs a reversed collation
 * on `String.prototype.localeCompare` before importing the generator -
 * that is the collation difference the environment could not supply, and
 * it is exactly what a differently-collating host would do to a
 * `localeCompare` tie-break.
 */
const COLLATION_CHILD = `
if (process.env["O2B_TEST_REVERSE_COLLATION"] === "1") {
  Object.defineProperty(String.prototype, "localeCompare", {
    value(other) { return other < this ? -1 : other > this ? 1 : 0; },
    configurable: true,
    writable: true,
  });
}
const { readFileSync } = await import("node:fs");
const { generateArchDocs } = await import(process.env["O2B_TEST_GENERATE"]);
const res = generateArchDocs(process.env["O2B_TEST_VAULT"], process.env["O2B_TEST_PROJECT"]);
process.stdout.write(readFileSync(res.overviewPath, "utf8"));
`;

function renderUnderCollation(locale: string, reversed: boolean): string {
  const childVault = join(tmp, `vault-${locale}-${reversed ? "rev" : "plain"}`);
  mkdirSync(join(childVault, "Brain"), { recursive: true });
  const child = Bun.spawnSync([process.execPath, "-e", COLLATION_CHILD], {
    env: {
      ...process.env,
      LC_ALL: locale,
      LANG: locale,
      O2B_TEST_REVERSE_COLLATION: reversed ? "1" : "0",
      O2B_TEST_GENERATE: join(import.meta.dir, "../../../src/core/brain/architect/generate.ts"),
      O2B_TEST_VAULT: childVault,
      O2B_TEST_PROJECT: project,
    },
  });
  const stderr = new TextDecoder().decode(child.stderr);
  expect({ locale, code: child.exitCode, stderr }).toEqual({ locale, code: 0, stderr: "" });
  return new TextDecoder().decode(child.stdout);
}

test("the language tie-break does not depend on the host collation", () => {
  // Equal counts, so ONLY the tie-break decides their order.
  seed("src/core/one.aaa");
  seed("src/core/two.aab");

  const plain = renderUnderCollation("C", false);
  const reversed = renderUnderCollation("tr_TR.UTF-8", true);

  expect(reversed).toBe(plain);
  expect(plain).toContain(".aaa (1)");
});

test("unchanged project regenerates byte-identically", () => {
  const first = generateArchDocs(vault, project);
  const before = readFileSync(first.overviewPath, "utf8");
  const second = generateArchDocs(vault, project);
  expect(readFileSync(second.overviewPath, "utf8")).toBe(before);
  expect(second.created).toBe(0);
  expect(second.unchanged).toBeGreaterThanOrEqual(3);
});

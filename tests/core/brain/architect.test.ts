/**
 * Deterministic architecture docs generator
 * (Project History Suite, t_929da8a2).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArchWriteError, generateArchDocs } from "../../../src/core/brain/architect/generate.ts";
import { ARCHITECT_STAGE, scanProject } from "../../../src/core/brain/architect/scan.ts";
import { PROGRESS_KIND } from "../../../src/core/brain/progress.ts";
import { RegionError } from "../../../src/core/brain/regions.ts";

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

test("a dot-directory's contents never reach the facts", () => {
  const before = scanProject(project);
  // Tooling state, not architecture: agent worktrees, CI definitions,
  // caches. On this repository that rule is 88% of every file visited.
  seed(".claude/worktrees/copy/src/index.ts");
  seed(".github/workflows/ci.yml");
  seed(".cache-of-things/blob.ts");
  // A FILE whose name collides with a skipped directory is still a file.
  seed("src/core/build");

  const facts = scanProject(project);
  expect(facts.languages[".yml"]).toBeUndefined();
  expect(facts.totalFiles).toBe(before.totalFiles + 1);
  expect(facts.modules.map((m) => m.name)).toEqual(["cli", "core"]);
  expect(facts.modules.find((m) => m.name === "core")!.topFiles).toContain("build");
});

test("the traversal reads each directory exactly once", () => {
  seed("src/core/deep/nested/util.ts");
  // Every directory the scan is allowed to enter, listed rather than
  // computed: `node_modules/dep` and `.git` are skipped, so reading
  // either of them would show up here as an extra count.
  const walkable = [
    "",
    "src",
    "src/cli",
    "src/core",
    "src/core/deep",
    "src/core/deep/nested",
    "tests",
  ];

  // The progress counter is the instrument: it advances once per
  // directory read, so a subtree walked a second time doubles its count.
  let reads = 0;
  scanProject(project, {
    onProgress: (event) => {
      if (event.kind === PROGRESS_KIND.advanced) reads += 1;
    },
  });

  expect(reads).toBe(walkable.length);
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

test("a corrupted note aborts the run before any note is written", () => {
  const first = generateArchDocs(vault, project);
  const cliNote = first.modulePaths.find((p) => p.endsWith("cli.md"))!;
  // Unbalanced sentinels: `mergeRegions` fails closed on this note.
  writeFileSync(cliNote, readFileSync(cliNote, "utf8").replace("<!-- o2b:end facts -->", ""));
  const overviewBefore = readFileSync(first.overviewPath, "utf8");
  seed("src/core/added.ts"); // the overview WOULD change

  expect(() => generateArchDocs(vault, project)).toThrow(RegionError);
  // The overview is written first, so a run that wrote as it went would
  // have left it updated next to a module note it could not repair.
  expect(readFileSync(first.overviewPath, "utf8")).toBe(overviewBefore);
});

/**
 * Planning removes the error class that arises while DECIDING a note's
 * bytes. It cannot remove the one that arises while PLACING them, and the
 * module docblock no longer claims otherwise: this is the mid-loop write
 * failure, and it does leave a refreshed prefix beside stale notes.
 *
 * The failure is injected with a real errno rather than a mocked writer -
 * `modules/` is made read-only, so `atomicWriteFileSync`'s temp file
 * cannot be created there. The overview lives one directory up and is
 * written first, so exactly one note is refreshed before the loop stops.
 */
test("a write that fails part-way through reports the prefix it already refreshed", () => {
  const first = generateArchDocs(vault, project);
  const coreNote = first.modulePaths.find((p) => p.endsWith("core.md"))!;
  const coreBefore = readFileSync(coreNote, "utf8");
  const overviewBefore = readFileSync(first.overviewPath, "utf8");
  seed("src/core/added.ts"); // overview.md AND core.md must both change

  chmodSync(join(first.dir, "modules"), 0o555);
  let caught: unknown = null;
  try {
    generateArchDocs(vault, project);
  } catch (error) {
    caught = error;
  }
  chmodSync(join(first.dir, "modules"), 0o755);

  expect(caught).toBeInstanceOf(ArchWriteError);
  const failure = caught as ArchWriteError;
  expect(failure.path).toBe(coreNote);
  // The overview is on disk; `core.md` and nothing after it are not.
  expect(failure.written).toBe(1);
  expect(failure.pending).toBe(1);
  expect(failure.message).toContain("re-run");
  expect(failure.cause).toBeDefined();

  // The half-refreshed tree the counts describe, observed directly.
  expect(readFileSync(first.overviewPath, "utf8")).not.toBe(overviewBefore);
  expect(readFileSync(coreNote, "utf8")).toBe(coreBefore);
  // A failed write is not a leaked lock.
  expect(existsSync(`${first.dir}.lock`)).toBe(false);

  // And the repair the message promises is real: with the cause gone, one
  // ordinary re-run rewrites the suffix the failure left stale.
  const repaired = generateArchDocs(vault, project);
  expect(repaired.updated).toBe(1);
  expect(readFileSync(coreNote, "utf8")).toContain("added.ts");
});

test("module_paths follows the scan's module order, not the write order", () => {
  const res = generateArchDocs(vault, project);
  const facts = scanProject(project);
  expect(res.modulePaths).toEqual(
    facts.modules.map((m) => join(res.dir, "modules", `${m.name}.md`)),
  );
});

test("the notes are written inside one lock, which is released afterwards", () => {
  const first = generateArchDocs(vault, project);
  const lockPath = `${first.dir}.lock`;
  seed("src/core/added.ts"); // force real writes on the second run

  // The sink runs inside the run, so it can see what the run is holding.
  const heldDuringWrites: boolean[] = [];
  const res = generateArchDocs(vault, project, {
    onProgress: (event) => {
      // `advanced` only: the stage is announced BEFORE the lock is
      // waited for, so a watcher sees "rendering" during the wait too.
      if (event.stage === ARCHITECT_STAGE.render && event.kind === PROGRESS_KIND.advanced) {
        heldDuringWrites.push(existsSync(lockPath));
      }
    },
  });

  expect(res.updated).toBeGreaterThan(0);
  expect(heldDuringWrites.length).toBeGreaterThan(0);
  expect(heldDuringWrites.every(Boolean)).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
});

test("unchanged project regenerates byte-identically", () => {
  const first = generateArchDocs(vault, project);
  const before = readFileSync(first.overviewPath, "utf8");
  const second = generateArchDocs(vault, project);
  expect(readFileSync(second.overviewPath, "utf8")).toBe(before);
  expect(second.created).toBe(0);
  expect(second.unchanged).toBeGreaterThanOrEqual(3);
});

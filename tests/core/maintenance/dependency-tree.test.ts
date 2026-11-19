/**
 * Whether this checkout's dependency tree is present, decided by the rule
 * the launcher's precheck (`scripts/_bun-precheck.sh`) applies: one probe
 * file read out of that script, and its `O2B_SKIP_DEP_BOOTSTRAP` seam. A
 * self-spawn that finds the tree missing starts the bootstrap entry, which
 * installs it the way the precheck does before it runs the CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEPENDENCY_INSTALL_ARGS,
  dependencyProbeOf,
  dependencyTreeMissing,
  ensureDependencyTree,
} from "../../../src/core/maintenance/dependency-tree.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const PRECHECK = readFileSync(join(REPO, "scripts", "_bun-precheck.sh"), "utf8");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A checkout with the launcher's precheck and, when `present`, the probe file. */
function checkout(present: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "osb-deps-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "_bun-precheck.sh"), PRECHECK);
  if (present) {
    const probe = join(root, ...dependencyProbeOf(PRECHECK)!.split("/"));
    mkdirSync(join(probe, ".."), { recursive: true });
    writeFileSync(probe, "{}");
  }
  return root;
}

describe("the dependency rule is the launcher's", () => {
  test("the probe is read out of the precheck script", () => {
    expect(dependencyProbeOf(PRECHECK)).toBe("node_modules/proper-lockfile/package.json");
    expect(dependencyProbeOf("#!/bin/bash\necho nothing\n")).toBeNull();
  });

  test("every Windows launcher probes the same file", () => {
    const probe = dependencyProbeOf(PRECHECK)!.replaceAll("/", "\\");
    for (const name of ["o2b.cmd", "o2b-mcp.cmd", "o2b-aider.cmd", "vault-log.cmd"]) {
      expect([name, readFileSync(join(REPO, "scripts", name), "utf8").includes(probe)]).toEqual([
        name,
        true,
      ]);
    }
  });

  test("the install is the precheck's", () => {
    expect(PRECHECK).toContain(`bun ${DEPENDENCY_INSTALL_ARGS.join(" ")}`);
  });

  test("missing exactly when the probe file is absent and the seam is not set", () => {
    expect(dependencyTreeMissing(checkout(false), {})).toBe(true);
    expect(dependencyTreeMissing(checkout(false), { O2B_SKIP_DEP_BOOTSTRAP: "1" })).toBe(false);
    expect(dependencyTreeMissing(checkout(true), {})).toBe(false);
  });

  test("a checkout whose precheck names no probe is taken as present", () => {
    const root = mkdtempSync(join(tmpdir(), "osb-deps-none-"));
    roots.push(root);
    expect(dependencyTreeMissing(root, {})).toBe(false);
  });
});

describe("the bootstrap before the CLI", () => {
  test("a missing tree is installed once with the runtime's own path, in the checkout", () => {
    const dir = checkout(false);
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    ensureDependencyTree(dir, {}, (argv, cwd) => {
      calls.push({ argv, cwd });
      return 0;
    });
    expect(calls).toEqual([{ argv: [process.execPath, ...DEPENDENCY_INSTALL_ARGS], cwd: dir }]);
  });

  test("a present tree runs nothing; a failed install throws with the manual command", () => {
    const calls: string[][] = [];
    ensureDependencyTree(checkout(true), {}, (argv) => (calls.push(argv), 0));
    expect(calls).toEqual([]);
    expect(() => ensureDependencyTree(checkout(false), {}, () => 1)).toThrow(
      "bun install --frozen-lockfile",
    );
  });
});

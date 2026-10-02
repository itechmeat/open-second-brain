import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CODE_MANIFEST_FILES,
  DEPENDENCY_MANIFESTS,
  MANIFEST_ECOSYSTEM,
  manifestSpecFor,
} from "../../src/core/project-manifests.ts";

describe("project manifest vocabulary", () => {
  test("the dependency manifests are the eight specs, in precedence order", () => {
    expect(
      DEPENDENCY_MANIFESTS.map((spec) => [spec.file, spec.ecosystem, spec.dependencyReadable]),
    ).toEqual([
      ["package.json", "npm", true],
      ["pyproject.toml", "pypi", true],
      ["Cargo.toml", "cargo", true],
      ["go.mod", "go", true],
      ["pom.xml", "maven", false],
      ["build.gradle", "gradle", false],
      ["Gemfile", "rubygems", false],
      ["composer.json", "composer", false],
    ]);
    expect(Object.isFrozen(DEPENDENCY_MANIFESTS)).toBe(true);
    expect(Object.isFrozen(MANIFEST_ECOSYSTEM)).toBe(true);
  });

  test("the detection set is the eight dependency manifests plus tsconfig.json", () => {
    expect(CODE_MANIFEST_FILES.toSorted()).toEqual(
      [
        "Cargo.toml",
        "Gemfile",
        "build.gradle",
        "composer.json",
        "go.mod",
        "package.json",
        "pom.xml",
        "pyproject.toml",
        "tsconfig.json",
      ].toSorted(),
    );
    expect(Object.isFrozen(CODE_MANIFEST_FILES)).toBe(true);
  });

  test("manifestSpecFor finds a dependency manifest by its exact basename", () => {
    expect(manifestSpecFor("pyproject.toml")?.ecosystem).toBe(MANIFEST_ECOSYSTEM.pypi);
    expect(manifestSpecFor("pom.xml")?.dependencyReadable).toBe(false);
    expect(manifestSpecFor("tsconfig.json")).toBeUndefined();
    expect(manifestSpecFor("cargo.toml")).toBeUndefined();
    expect(manifestSpecFor("src/package.json")).toBeUndefined();
  });

  // A cheap tripwire only: it misses a Bun use through an import and fires on
  // a comment. The real guard is the Node bundle test and the openclaw-bundle gate.
  test("the module stays Node-safe: it is bundled, so it names no Bun API", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/core/project-manifests.ts"),
      "utf8",
    );
    expect(source).not.toContain("Bun.");
  });
});

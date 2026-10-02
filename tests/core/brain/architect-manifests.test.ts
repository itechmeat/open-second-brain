/**
 * Manifest readers of the architecture scanner: one reading per manifest,
 * a closed status for every outcome, never a throw on project content.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalDependencyName,
  MANIFEST_STATUS,
  readManifestAt,
} from "../../../src/core/brain/architect/manifests.ts";
import { MANIFEST_ECOSYSTEM } from "../../../src/core/project-manifests.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let root: string;

function seed(relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-architect-manifests-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("package.json", () => {
  test("a read manifest lists runtime dependencies and counts the other groups", () => {
    seed(
      "package.json",
      JSON.stringify({
        name: "demo",
        version: "1.2.3",
        description: "A demo",
        main: "index.js",
        dependencies: { zod: "^3", "@scope/b": "1", alpha: "2" },
        devDependencies: { typescript: "5", vitest: "1" },
        optionalDependencies: { fsevents: "2" },
        peerDependencies: { react: "18", "react-dom": "18", vue: "3" },
      }),
    );
    const reading = readManifestAt(root, "package.json");
    expect(reading.path).toBe("package.json");
    expect(reading.ecosystem).toBe(MANIFEST_ECOSYSTEM.npm);
    expect(reading.status).toBe(MANIFEST_STATUS.read);
    expect(reading.detail).toBeUndefined();
    expect(reading.fact).toEqual({
      name: "demo",
      version: "1.2.3",
      description: "A demo",
      dependencies: ["@scope/b", "alpha", "zod"],
    });
    expect(reading.otherGroups).toEqual([
      { group: "dev", count: 2 },
      { group: "optional", count: 1 },
      { group: "peer", count: 3 },
    ]);
    expect(reading.raw?.["main"]).toBe("index.js");
  });

  test("a module manifest keeps its project-relative path with forward slashes", () => {
    seed("packages/web/package.json", JSON.stringify({ name: "web" }));
    const reading = readManifestAt(root, join("packages", "web", "package.json"));
    expect(reading.path).toBe("packages/web/package.json");
    expect(reading.fact?.dependencies).toEqual([]);
    expect(reading.otherGroups).toEqual([]);
  });

  test("broken JSON is malformed with the parser's detail, not absent", () => {
    seed("package.json", "{ not json");
    const reading = readManifestAt(root, "package.json");
    expect(reading.status).toBe(MANIFEST_STATUS.malformed);
    expect(reading.detail).toBeTruthy();
    expect(reading.fact).toBeNull();
    expect(reading.raw).toBeNull();
    expect(reading.otherGroups).toEqual([]);
  });

  test("a JSON value that is not an object is malformed", () => {
    seed("package.json", "[1, 2]");
    const reading = readManifestAt(root, "package.json");
    expect(reading.status).toBe(MANIFEST_STATUS.malformed);
    expect(reading.detail).toBeTruthy();
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a file that cannot be read is unreadable with its errno code",
    () => {
      seed("package.json", "{}");
      chmodSync(join(root, "package.json"), 0o000);
      try {
        const reading = readManifestAt(root, "package.json");
        expect(reading.status).toBe(MANIFEST_STATUS.unreadable);
        expect(reading.detail).toBe("EACCES");
        expect(reading.fact).toBeNull();
      } finally {
        chmodSync(join(root, "package.json"), 0o644);
      }
    },
  );
});

describe("pyproject.toml", () => {
  test("PEP 621 dependencies are named by their PEP 508 prefix and PEP 503 name", () => {
    seed(
      "pyproject.toml",
      [
        "[project]",
        'name = "demo-py"',
        'version = "0.1.0"',
        'description = "Python demo"',
        "dependencies = [",
        '  "Requests[security]>=2.0",',
        '  "zope.interface (>=5)",',
        "  \"typing_extensions; python_version < '3.11'\",",
        '  "pkg @ https://example.org/pkg.whl",',
        '  "Flask~=3.0",',
        '  "flask>=2",',
        '  "attrs",',
        "]",
        "",
        "[project.optional-dependencies]",
        'docs = ["sphinx", "furo"]',
        'test = ["pytest"]',
        "",
        "[dependency-groups]",
        'lint = ["ruff", "mypy"]',
      ].join("\n"),
    );
    const reading = readManifestAt(root, "pyproject.toml");
    expect(reading.status).toBe(MANIFEST_STATUS.read);
    expect(reading.ecosystem).toBe(MANIFEST_ECOSYSTEM.pypi);
    expect(reading.raw).toBeNull();
    expect(reading.fact).toEqual({
      name: "demo-py",
      version: "0.1.0",
      description: "Python demo",
      dependencies: ["attrs", "flask", "pkg", "requests", "typing-extensions", "zope-interface"],
    });
    expect(reading.otherGroups).toEqual([
      { group: "dev", count: 2 },
      { group: "optional", count: 3 },
    ]);
  });

  test("Poetry dependencies are read and the python constraint is dropped", () => {
    seed(
      "pyproject.toml",
      [
        "[tool.poetry]",
        'name = "poetry-demo"',
        'version = "2.0.0"',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'Django = "^5"',
        'my_lib = { path = "../my_lib" }',
        "",
        "[tool.poetry.group.dev.dependencies]",
        'pytest = "^8"',
        "",
        "[tool.poetry.dev-dependencies]",
        'black = "*"',
      ].join("\n"),
    );
    const reading = readManifestAt(root, "pyproject.toml");
    expect(reading.status).toBe(MANIFEST_STATUS.read);
    expect(reading.fact).toEqual({
      name: "poetry-demo",
      version: "2.0.0",
      description: null,
      dependencies: ["django", "my-lib"],
    });
    expect(reading.otherGroups).toEqual([{ group: "dev", count: 2 }]);
  });

  test("broken TOML is malformed with the parser's detail", () => {
    seed("pyproject.toml", "[project\nname = ");
    const reading = readManifestAt(root, "pyproject.toml");
    expect(reading.status).toBe(MANIFEST_STATUS.malformed);
    expect(reading.detail).toBeTruthy();
    expect(reading.fact).toBeNull();
  });
});

describe("canonicalDependencyName", () => {
  test("PyPI names follow PEP 503; other ecosystems keep the declared name", () => {
    expect(canonicalDependencyName(MANIFEST_ECOSYSTEM.pypi, "Foo__Bar.baz-Qux")).toBe(
      "foo-bar-baz-qux",
    );
    expect(canonicalDependencyName(MANIFEST_ECOSYSTEM.npm, "@Scope/Pkg_x")).toBe("@Scope/Pkg_x");
  });
});

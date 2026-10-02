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

describe("Cargo.toml", () => {
  test("runtime dependencies come from every dependencies table, renames resolved", () => {
    seed(
      "Cargo.toml",
      [
        "[package]",
        'name = "demo-rs"',
        'version = "0.3.0"',
        'description = "Rust demo"',
        "",
        "[dependencies]",
        'serde = { version = "1", features = ["derive"] }',
        'rand_core = "0.6"',
        'web = { package = "actix-web", version = "4" }',
        "",
        "[dependencies.tokio]",
        'version = "1"',
        "",
        "[target.'cfg(windows)'.dependencies]",
        'winapi = "0.3"',
        "",
        "[target.'cfg(unix)'.dependencies]",
        'serde = "1"',
        "",
        "[dev-dependencies]",
        'proptest = "1"',
        'criterion = "0.5"',
        "",
        "[target.'cfg(unix)'.dev-dependencies]",
        'tempfile = "3"',
        "",
        "[build-dependencies]",
        'cc = "1"',
      ].join("\n"),
    );
    const reading = readManifestAt(root, "Cargo.toml");
    expect(reading.status).toBe(MANIFEST_STATUS.read);
    expect(reading.ecosystem).toBe(MANIFEST_ECOSYSTEM.cargo);
    expect(reading.raw).toBeNull();
    expect(reading.fact).toEqual({
      name: "demo-rs",
      version: "0.3.0",
      description: "Rust demo",
      dependencies: ["actix-web", "rand_core", "serde", "tokio", "winapi"],
    });
    expect(reading.otherGroups).toEqual([
      { group: "build", count: 1 },
      { group: "dev", count: 3 },
    ]);
  });

  test("a workspace-inherited version is not a version string", () => {
    seed("Cargo.toml", '[package]\nname = "member"\nversion = { workspace = true }\n');
    expect(readManifestAt(root, "Cargo.toml").fact).toEqual({
      name: "member",
      version: null,
      description: null,
      dependencies: [],
    });
  });

  test("broken TOML is malformed", () => {
    seed("Cargo.toml", "[dependencies\nserde = ");
    expect(readManifestAt(root, "Cargo.toml").status).toBe(MANIFEST_STATUS.malformed);
  });
});

describe("go.mod", () => {
  test("require lines and blocks are read; indirect counted; replace and exclude ignored", () => {
    seed(
      "go.mod",
      [
        "// The demo module.",
        'module "example.com/demo"',
        "",
        "go 1.22",
        "",
        "require github.com/single/dep v1.0.0",
        "",
        "require (",
        "\tgithub.com/b/lib v1.2.3",
        '\t"github.com/quoted/path" v0.1.0 // pinned',
        "\tgolang.org/x/text v0.14.0 // indirect",
        "\tgithub.com/c/other v2.0.0+incompatible // indirect; needed by b",
        ")",
        "",
        "replace github.com/b/lib => ../lib",
        "replace (",
        "\tgithub.com/replaced/only v1.0.0 => ./local",
        ")",
        "exclude github.com/excluded/only v0.9.0",
        "exclude (",
        "\tgithub.com/excluded/block v0.8.0",
        ")",
      ].join("\n"),
    );
    const reading = readManifestAt(root, "go.mod");
    expect(reading.status).toBe(MANIFEST_STATUS.read);
    expect(reading.ecosystem).toBe(MANIFEST_ECOSYSTEM.go);
    expect(reading.fact).toEqual({
      name: "example.com/demo",
      version: null,
      description: null,
      dependencies: ["github.com/b/lib", "github.com/quoted/path", "github.com/single/dep"],
    });
    expect(reading.otherGroups).toEqual([{ group: "indirect", count: 2 }]);
  });

  test("an unterminated require block is malformed", () => {
    seed("go.mod", "module example.com/x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n");
    const reading = readManifestAt(root, "go.mod");
    expect(reading.status).toBe(MANIFEST_STATUS.malformed);
    expect(reading.detail).toBeTruthy();
    expect(reading.fact).toBeNull();
  });

  test("a require entry without a version is malformed", () => {
    seed("go.mod", "module example.com/x\n\nrequire github.com/a/b\n");
    expect(readManifestAt(root, "go.mod").status).toBe(MANIFEST_STATUS.malformed);
  });
});

describe("unsupported manifests and caller errors", () => {
  test.each([
    ["pom.xml", MANIFEST_ECOSYSTEM.maven],
    ["build.gradle", MANIFEST_ECOSYSTEM.gradle],
    ["Gemfile", MANIFEST_ECOSYSTEM.rubygems],
    ["composer.json", MANIFEST_ECOSYSTEM.composer],
  ])("%s is reported unsupported with its ecosystem and no fact", (file, ecosystem) => {
    seed(`api/${file}`, "anything");
    const reading = readManifestAt(root, `api/${file}`);
    expect(reading).toEqual({
      path: `api/${file}`,
      ecosystem,
      status: MANIFEST_STATUS.unsupported,
      fact: null,
      otherGroups: [],
      raw: null,
    });
  });

  test("a basename that is not a dependency manifest throws a TypeError naming the path", () => {
    seed("tsconfig.json", "{}");
    expect(() => readManifestAt(root, "tsconfig.json")).toThrow(TypeError);
    expect(() => readManifestAt(root, "src/README.md")).toThrow("src/README.md");
  });
});

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { tempDirs } from "../helpers/temp-dir.ts";
import { spawnNpmSync } from "../../scripts/npm.ts";
import {
  comparePathLists,
  findForbiddenPaths,
  checkSizes,
  findLifecycleScripts,
} from "../../scripts/pack-manifest.ts";

const FORBIDDEN = [
  ".apb/",
  ".ai-notes/",
  ".claude/",
  ".env",
  "*.local.*",
  "node_modules/",
  "tests/",
  "openspec/",
  "docs/brainstorm/",
  "docs/plans/",
  "**/__pycache__/**",
  "*.pyc",
];

const makeTemp = tempDirs();
const REPO = resolve(import.meta.dir, "..", "..");
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

describe("package manifest checks", () => {
  test("committed manifest matches the dry-run pack", () => {
    const manifest = readFileSync("package-files.txt", "utf8");
    const expected = manifest.split("\n").filter((line) => line && !line.startsWith("#"));
    const proc = spawnNpmSync(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    expect(proc.exitCode).toBe(0);
    const packed = (
      JSON.parse(new TextDecoder().decode(proc.stdout)) as [{ files: { path: string }[] }]
    )[0]!.files.map((file) => file.path);
    expect(comparePathLists(packed, expected)).toEqual([]);
  });

  test("npm pack excludes Python bytecode caches", () => {
    const root = makeTemp("pack-bytecode-");
    mkdirSync(join(root, "plugins", "hermes", "__pycache__"), { recursive: true });
    writeFileSync(join(root, "package.json"), readFileSync(join(REPO, "package.json")));
    writeFileSync(join(root, "plugins", "hermes", "__pycache__", "cache.pyc"), "bytecode");

    const proc = spawnNpmSync(["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
    });
    expect(proc.exitCode).toBe(0);
    const packed = (
      JSON.parse(new TextDecoder().decode(proc.stdout)) as [{ files: { path: string }[] }]
    )[0]!.files.map((file) => file.path);
    expect(packed.filter((path) => path.includes("__pycache__") || path.endsWith(".pyc"))).toEqual(
      [],
    );
  });

  test("reports packed paths missing from the manifest", () => {
    expect(comparePathLists(["src/a.ts", "hooks/new.ts"], ["src/a.ts"])).toContain(
      "unlisted packed path: hooks/new.ts",
    );
  });

  test("reports manifest paths missing from the pack", () => {
    expect(comparePathLists(["src/a.ts"], ["src/a.ts", "hooks/old.ts"])).toContain(
      "manifest path not packed: hooks/old.ts",
    );
  });

  test("normalizes backslashes and ignores input order", () => {
    expect(comparePathLists(["hooks\\a.ts", "src\\b.ts"], ["src/b.ts", "hooks/a.ts"])).toEqual([]);
  });

  test("names forbidden paths", () => {
    expect(
      findForbiddenPaths(
        [
          "src/a.ts",
          "tests/core/secret.test.ts",
          ".env",
          "plugins/hermes/__pycache__/cache.pyc",
          "tests/fixtures/decision-model/rerank.json",
        ],
        FORBIDDEN,
      ),
    ).toEqual([
      "forbidden packed path: .env",
      "forbidden packed path: plugins/hermes/__pycache__/cache.pyc",
      "forbidden packed path: tests/core/secret.test.ts",
    ]);
  });

  test("enforces packed and unpacked size ceilings", () => {
    expect(
      checkSizes({ packedSize: 11, unpackedSize: 10 }, { packedSize: 10, unpackedSize: 10 }),
    ).toEqual(["packed size 11 exceeds ceiling 10"]);
    expect(
      checkSizes({ packedSize: 9, unpackedSize: 10 }, { packedSize: 10, unpackedSize: 10 }),
    ).toEqual([]);
  });

  test("names package lifecycle scripts", () => {
    expect(
      findLifecycleScripts({ scripts: { prepare: "x", postinstall: "y", test: "z" } }),
    ).toEqual(["forbidden lifecycle script: postinstall", "forbidden lifecycle script: prepare"]);
  });
});

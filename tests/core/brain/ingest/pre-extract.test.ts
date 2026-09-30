/**
 * P4 (t_ef786747): deterministic, stdlib-only code-structure pre-extractor.
 *
 * Turns a code source into JSON entity/edge seeds (classes/functions as
 * entities; imports and inheritance as edges) without any model. Same input
 * yields the same output; unknown languages are reported as unextracted, never
 * a fake empty success. Structural parsing only, no natural-language word list.
 */

import { describe, expect, test } from "bun:test";

import {
  preExtractCodeStructure,
  type PreExtractResult,
  type PreExtractSuccess,
} from "../../../../src/core/brain/ingest/pre-extract.ts";

function asSuccess(res: PreExtractResult): PreExtractSuccess {
  if (!res.extracted) throw new Error(`expected extracted, got: ${res.reason}`);
  return res;
}

const TS_SOURCE = [
  "// leading comment mentioning class Ghost should be ignored",
  'import { readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "export class Animal {}",
  "export abstract class Dog extends Animal implements Pet, Runner {}",
  "export function makeDog() {}",
  "async function helper() {}",
  'const load = require("./loader");',
  "",
].join("\n");

const PY_SOURCE = [
  "# leading comment mentioning class Ghost should be ignored",
  "import os",
  "from collections import OrderedDict",
  "class Base:",
  "    def method(self):",
  "        pass",
  "class Derived(Base, metaclass=Meta):",
  "    pass",
  "def top():",
  "    pass",
  "",
].join("\n");

describe("preExtractCodeStructure - TypeScript/JavaScript", () => {
  test("extracts classes and functions as sorted entity seeds", () => {
    const res = asSuccess(preExtractCodeStructure("pkg/a.ts", TS_SOURCE));
    expect(res.language).toBe("typescript");
    expect(res.entities).toEqual([
      { kind: "class", name: "Animal" },
      { kind: "class", name: "Dog" },
      { kind: "function", name: "helper" },
      { kind: "function", name: "makeDog" },
    ]);
  });

  test("extracts import and inheritance edges", () => {
    const res = asSuccess(preExtractCodeStructure("pkg/a.ts", TS_SOURCE));
    expect(res.edges).toEqual([
      { kind: "imports", from: "pkg/a.ts", to: "./loader" },
      { kind: "imports", from: "pkg/a.ts", to: "node:fs" },
      { kind: "imports", from: "pkg/a.ts", to: "node:path" },
      { kind: "inherits", from: "Dog", to: "Animal" },
      { kind: "inherits", from: "Dog", to: "Pet" },
      { kind: "inherits", from: "Dog", to: "Runner" },
    ]);
  });

  test("javascript extension reports the javascript family", () => {
    const res = asSuccess(preExtractCodeStructure("pkg/a.js", "export function f() {}\n"));
    expect(res.language).toBe("javascript");
    expect(res.entities).toEqual([{ kind: "function", name: "f" }]);
  });
});

describe("preExtractCodeStructure - Python", () => {
  test("extracts classes, functions, imports and base-class edges", () => {
    const res = asSuccess(preExtractCodeStructure("pkg/a.py", PY_SOURCE));
    expect(res.language).toBe("python");
    expect(res.entities).toEqual([
      { kind: "class", name: "Base" },
      { kind: "class", name: "Derived" },
      { kind: "function", name: "method" },
      { kind: "function", name: "top" },
    ]);
    expect(res.edges).toEqual([
      { kind: "imports", from: "pkg/a.py", to: "collections" },
      { kind: "imports", from: "pkg/a.py", to: "os" },
      { kind: "inherits", from: "Derived", to: "Base" },
    ]);
  });
});

describe("preExtractCodeStructure - determinism", () => {
  test("same input yields byte-identical JSON output", () => {
    const a = preExtractCodeStructure("pkg/a.ts", TS_SOURCE);
    const b = preExtractCodeStructure("pkg/a.ts", TS_SOURCE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("preExtractCodeStructure - unknown languages", () => {
  test("an unsupported extension is reported as unextracted, not empty success", () => {
    const res = preExtractCodeStructure("notes/plan.txt", "class NotCode {}\n");
    expect(res.extracted).toBe(false);
    if (!res.extracted) expect(res.reason).toContain(".txt");
  });

  test("a path without an extension is reported as unextracted", () => {
    const res = preExtractCodeStructure("Makefile", "all:\n\techo hi\n");
    expect(res.extracted).toBe(false);
  });

  test("a known language with no declarations is an honest empty success", () => {
    const res = asSuccess(preExtractCodeStructure("pkg/empty.ts", "const x = 1;\n"));
    expect(res.entities).toEqual([]);
    expect(res.edges).toEqual([]);
  });
});

describe("preExtractCodeStructure - relative-import binding (t_2356dace)", () => {
  const INGESTED = new Set([
    "src/lib/dom.ts",
    "src/lib/widget.ts",
    "src/lib/loader.ts",
    "src/feature/index.ts",
    "pkg/helpers.py",
    "pkg/util.py",
  ]);

  test("a ./ specifier resolving to exactly one ingested file fills resolvedTo", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { h } from "./dom";\n', {
        ingestedFiles: INGESTED,
      }),
    );
    expect(res.edges).toEqual([
      { kind: "imports", from: "src/lib/widget.ts", to: "./dom", resolvedTo: "src/lib/dom.ts" },
    ]);
  });

  test("a ../ specifier binds through extension and index probing", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { f } from "../feature";\n', {
        ingestedFiles: INGESTED,
      }),
    );
    expect(res.edges).toEqual([
      {
        kind: "imports",
        from: "src/lib/widget.ts",
        to: "../feature",
        resolvedTo: "src/feature/index.ts",
      },
    ]);
  });

  test("a require of a relative specifier binds the same way", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'const load = require("./loader");\n', {
        ingestedFiles: INGESTED,
      }),
    );
    expect(res.edges).toEqual([
      {
        kind: "imports",
        from: "src/lib/widget.ts",
        to: "./loader",
        resolvedTo: "src/lib/loader.ts",
      },
    ]);
  });

  test("a specifier matching no ingested file leaves the seed raw", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { g } from "./ghost";\n', {
        ingestedFiles: INGESTED,
      }),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "src/lib/widget.ts", to: "./ghost" }]);
    expect(Object.hasOwn(res.edges[0]!, "resolvedTo")).toBe(false);
  });

  test("a specifier matching several ingested files leaves the seed raw", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { d } from "./dom";\n', {
        ingestedFiles: new Set(["src/lib/dom.ts", "src/lib/dom.tsx", "src/lib/dom.js"]),
      }),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "src/lib/widget.ts", to: "./dom" }]);
  });

  test("a bare package specifier never binds", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { x } from "react";\n', {
        ingestedFiles: INGESTED,
      }),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "src/lib/widget.ts", to: "react" }]);
  });

  test("a python leading-dot from-import binds to the ingested module file", () => {
    const res = asSuccess(
      preExtractCodeStructure("pkg/mod.py", "from .helpers import thing\n", {
        ingestedFiles: INGESTED,
      }),
    );
    expect(res.edges).toEqual([
      { kind: "imports", from: "pkg/mod.py", to: ".helpers", resolvedTo: "pkg/helpers.py" },
    ]);
  });

  test("a python two-dot from-import resolves against the parent directory", () => {
    const res = asSuccess(
      preExtractCodeStructure("pkg/sub/mod.py", "from ..util import thing\n", {
        ingestedFiles: INGESTED,
      }),
    );
    expect(res.edges).toEqual([
      { kind: "imports", from: "pkg/sub/mod.py", to: "..util", resolvedTo: "pkg/util.py" },
    ]);
  });

  test("a call without ingestedFiles leaves every seed byte-identical to today", () => {
    const withOpt = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { h } from "./dom";\n', {
        ingestedFiles: INGESTED,
      }),
    );
    const withoutOpt = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { h } from "./dom";\n'),
    );
    expect(withoutOpt.edges).toEqual([{ kind: "imports", from: "src/lib/widget.ts", to: "./dom" }]);
    expect(Object.hasOwn(withoutOpt.edges[0]!, "resolvedTo")).toBe(false);
    expect(JSON.stringify(withoutOpt)).toBe(
      JSON.stringify({ ...withOpt, edges: withoutOpt.edges }),
    );
  });
});

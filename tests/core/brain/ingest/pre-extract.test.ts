/**
 * The deterministic, built-in-runtime-only code-structure pre-extractor.
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
import { REDACTION_PLACEHOLDER } from "../../../../src/core/redactor.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";

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

describe("preExtractCodeStructure - relative-import binding", () => {
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

  test.each([
    [
      "a TS/JS specifier",
      "src/a.ts",
      'import { x } from "../../lib/x";\n',
      "../../lib/x",
      "lib/x.ts",
    ],
    ["a python specifier", "src/a.py", "from ...util import thing\n", "...util", "util.py"],
  ])("%s climbing above the vault root never binds", (_label, from, source, to, rootFile) => {
    const res = asSuccess(
      preExtractCodeStructure(from, source, { ingestedFiles: new Set([rootFile]) }),
    );
    expect(res.edges).toEqual([{ kind: "imports", from, to }]);
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

  test("a python relative import never binds to a TS/JS file of the same name", () => {
    const res = asSuccess(
      preExtractCodeStructure("pkg/mod.py", "from .util import thing\n", {
        ingestedFiles: new Set(["pkg/util.ts"]),
      }),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "pkg/mod.py", to: ".util" }]);
  });

  test("a TS/JS relative import never binds to a python file of the same name", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { h } from "./helpers";\n', {
        ingestedFiles: new Set(["src/lib/helpers.py", "src/lib/helpers/__init__.py"]),
      }),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "src/lib/widget.ts", to: "./helpers" }]);
  });

  test("a python relative import binds to a package through its __init__.py", () => {
    const res = asSuccess(
      preExtractCodeStructure("pkg/mod.py", "from .sub import thing\n", {
        ingestedFiles: new Set(["pkg/sub/__init__.py", "pkg/sub/index.py"]),
      }),
    );
    expect(res.edges).toEqual([
      { kind: "imports", from: "pkg/mod.py", to: ".sub", resolvedTo: "pkg/sub/__init__.py" },
    ]);
  });

  test("a python bare-dot import binds to the enclosing package's __init__.py", () => {
    const res = asSuccess(
      preExtractCodeStructure("pkg/mod.py", "from . import thing\n", {
        ingestedFiles: new Set(["pkg/__init__.py", "pkg.py"]),
      }),
    );
    expect(res.edges).toEqual([
      { kind: "imports", from: "pkg/mod.py", to: ".", resolvedTo: "pkg/__init__.py" },
    ]);
  });

  test("a specifier that already carries an extension binds the joined path first", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.tsx", 'import "./widget.css";\n', {
        ingestedFiles: new Set(["src/lib/widget.css"]),
      }),
    );
    expect(res.edges).toEqual([
      {
        kind: "imports",
        from: "src/lib/widget.tsx",
        to: "./widget.css",
        resolvedTo: "src/lib/widget.css",
      },
    ]);
  });

  test("an exact joined-path hit wins over the extension probes", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/lib/widget.ts", 'import { v } from "./view.js";\n', {
        ingestedFiles: new Set(["src/lib/view.js", "src/lib/view.js.ts"]),
      }),
    );
    expect(res.edges).toEqual([
      {
        kind: "imports",
        from: "src/lib/widget.ts",
        to: "./view.js",
        resolvedTo: "src/lib/view.js",
      },
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

describe("preExtractCodeStructure - JSX component usage", () => {
  test("a capitalized opening tag in a .tsx source yields a uses edge", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "src/app/View.tsx",
        "export function View() {\n  return (\n    <Widget size={3} />\n  );\n}\n",
      ),
    );
    expect(res.edges).toContainEqual({ kind: "uses", from: "src/app/View.tsx", to: "Widget" });
  });

  test("lowercase-initial DOM and intrinsic tags produce nothing", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "src/app/View.tsx",
        "const view = (\n  <div><nav><span>hi</span></nav></div>\n);\n",
      ),
    );
    expect(res.edges).toEqual([]);
  });

  test("member-expression tags produce nothing", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/app/View.tsx", "const view = <Nav.Item active />;\n"),
    );
    expect(res.edges).toEqual([]);
  });

  test("generic type arguments produce nothing", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "src/app/View.tsx",
        "const names: Array<Foo> = [];\nconst pair: Pair<Bar, Baz> = pairOf();\n",
      ),
    );
    expect(res.edges).toEqual([]);
  });

  test.each([
    ["a trailing-comma arrow generic", "const id = <T,>(x: T) => x;\n"],
    ["a constrained arrow generic", "const key = <K extends string>(k: K) => k;\n"],
    ["a generic call after a closing paren", "const v = make()<Foo>(arg);\n"],
    ["a generic call-signature type alias", "type Fn = <T>(value: T) => T;\n"],
    ["a generic call-signature annotation", "const id: <U>(x: U) => U = (x) => x;\n"],
  ])("%s in a .tsx source produces no uses edge", (_label, source) => {
    const res = asSuccess(preExtractCodeStructure("src/app/View.tsx", source));
    expect(res.edges).toEqual([]);
  });

  test.each([
    ["a bare opening tag", "return <Foo>child</Foo>;\n", "Foo"],
    ["a self-closing tag with an attribute", "const el = <Foo prop={1} />;\n", "Foo"],
    [
      "a tag whose attributes continue on the next line",
      "return (\n  <Foo\n    prop={1}\n  />\n);\n",
      "Foo",
    ],
    ["a tag opening with a spread attribute", "const el = <Foo {...props} />;\n", "Foo"],
  ])("%s in a .tsx source still yields its uses edge", (_label, source, name) => {
    const res = asSuccess(preExtractCodeStructure("src/app/View.tsx", source));
    expect(res.edges).toEqual([{ kind: "uses", from: "src/app/View.tsx", to: name }]);
  });

  test("closing tags and fragments produce nothing; a repeated component dedupes", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/app/View.tsx", "const view = (<><Widget /><Widget /></>);\n"),
    );
    expect(res.edges).toEqual([{ kind: "uses", from: "src/app/View.tsx", to: "Widget" }]);
  });

  test("a .ts source yields no uses edges even with tag-shaped lines", () => {
    const res = asSuccess(preExtractCodeStructure("src/app/util.ts", "const el = <Widget />;\n"));
    expect(res.edges).toEqual([]);
  });

  test("several components on one line each yield their own edge, sorted", () => {
    const res = asSuccess(
      preExtractCodeStructure(
        "src/app/View.tsx",
        "const view = <Layout><Header /><Footer /></Layout>;\n",
      ),
    );
    expect(res.edges).toEqual([
      { kind: "uses", from: "src/app/View.tsx", to: "Footer" },
      { kind: "uses", from: "src/app/View.tsx", to: "Header" },
      { kind: "uses", from: "src/app/View.tsx", to: "Layout" },
    ]);
  });
});

describe("preExtractCodeStructure - URL credentials in import specifiers", () => {
  const userInfo = `deploy:${fakeCredential("hunter", "2-", "pw")}`;
  const withCredentials = `https://${userInfo}@registry.example.com/m.js`;
  const redacted = `https://${REDACTION_PLACEHOLDER}@registry.example.com/m.js`;

  test("a TypeScript from-specifier carrying user:password is redacted", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/a.ts", `import { m } from "${withCredentials}";\n`),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "src/a.ts", to: redacted }]);
    expect(JSON.stringify(res)).not.toContain(userInfo);
  });

  test("a JavaScript require specifier carrying user:password is redacted", () => {
    const res = asSuccess(
      preExtractCodeStructure("src/a.js", `const m = require("${withCredentials}");\n`),
    );
    expect(res.edges).toEqual([{ kind: "imports", from: "src/a.js", to: redacted }]);
  });

  test("a Python import specifier carrying user:password is redacted", () => {
    const res = asSuccess(preExtractCodeStructure("pkg/a.py", `import ${withCredentials}\n`));
    expect(res.edges).toEqual([{ kind: "imports", from: "pkg/a.py", to: redacted }]);
  });

  test("a TypeScript from-specifier whose userinfo is a bare token is redacted", () => {
    const token = fakeCredential("tok", "1234", "56789");
    const res = asSuccess(
      preExtractCodeStructure(
        "src/a.ts",
        `import x from "https://${token}@host.example.com/m.js";\n`,
      ),
    );
    expect(res.edges).toEqual([
      {
        kind: "imports",
        from: "src/a.ts",
        to: `https://${REDACTION_PLACEHOLDER}@host.example.com/m.js`,
      },
    ]);
  });

  test("specifiers without credentials are byte-identical", () => {
    const plain = "https://registry.example.com:8443/m.js";
    const ts = asSuccess(
      preExtractCodeStructure("src/a.ts", `import { m } from "${plain}";\nimport "./local";\n`),
    );
    expect(ts.edges).toEqual([
      { kind: "imports", from: "src/a.ts", to: "./local" },
      { kind: "imports", from: "src/a.ts", to: plain },
    ]);
    const py = asSuccess(preExtractCodeStructure("pkg/a.py", "from .util import x\nimport os\n"));
    expect(py.edges).toEqual([
      { kind: "imports", from: "pkg/a.py", to: ".util" },
      { kind: "imports", from: "pkg/a.py", to: "os" },
    ]);
  });
});

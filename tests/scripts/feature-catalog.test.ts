/**
 * `scripts/feature-catalog.ts` - the feature catalog under `docs/catalog/`
 * holds to the code: the real catalog passes the check, and each rule the
 * check applies fails on a small in-memory catalog that breaks exactly it.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSupportedSchema,
  buildIndex,
  checkCatalog,
  codeFacts,
  collectSurfaces,
  SCHEMA_FILE,
  TOOL_SERVER_FILES,
  validateAgainst,
  INDEX_FILE,
  INDEX_KEYWORDS,
  INDEX_MAX_BYTES,
  loadSchema,
  markdownAnchors,
  readCatalog,
  REMOVED_FILE,
  renderIndex,
  repositoryEnv,
  scanToolServerFiles,
  type CatalogArea,
  type CatalogFeature,
  type CatalogFile,
  type CheckEnv,
  type CodeFacts,
} from "../../scripts/feature-catalog.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// The dump case spawns the script; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FACTS: CodeFacts = {
  verbs: new Set(["alpha", "alpha run", "beta"]),
  coverableVerbs: new Set(["alpha run", "beta"]),
  tools: new Set(["tool_one", "tool_two"]),
  removedTools: new Set(["tool_old"]),
  hooks: new Set(["hook-one"]),
  skills: new Set(["skill-one"]),
  configKeys: new Set(["dream", "dream.auto"]),
  requiredConfigKeys: new Set(["dream"]),
  toolServerFiles: new Set(TOOL_SERVER_FILES),
  hostNativeTools: new Set(["tool_one"]),
};

const ENV: CheckEnv = {
  schema: loadSchema(REPO_ROOT),
  exists: () => true,
  inRepository: () => true,
  anchors: () => new Set(),
  docText: () => "`tool_one` and `tool_two`",
};

function feature(slug: string, over: Partial<CatalogFeature> = {}): CatalogFeature {
  return {
    slug,
    name: `Feature ${slug}`,
    summary: `What ${slug} does.`,
    status: "stable",
    capabilities: ["Does one thing.", "Does a second thing.", "Does a third thing."],
    limits: [],
    surfaces: {},
    docs: ["docs/guide.md"],
    code: ["src/feature.ts"],
    keywords: ["alpha", "beta", "gamma", "delta"],
    ...over,
  };
}

function areasOf(groups: ReadonlyArray<ReadonlyArray<CatalogFeature>>): CatalogArea[] {
  return groups.map((features, i) => ({
    area: `area-${i + 1}`,
    name: `Area ${i + 1}`,
    summary: `Area ${i + 1} of the fixture.`,
    features,
  }));
}

/** The files of a catalog folder holding `groups`, with an up-to-date index. */
function catalogFiles(
  groups: ReadonlyArray<ReadonlyArray<CatalogFeature>>,
  removed: ReadonlyArray<object> = [],
): CatalogFile[] {
  const areas = areasOf(groups);
  return [
    { file: INDEX_FILE, text: renderIndex(areas) },
    { file: REMOVED_FILE, text: JSON.stringify({ features: removed }) },
    ...areas.map((a) => ({ file: `${a.area}.json`, text: JSON.stringify(a) })),
  ];
}

/** A catalog that covers every fixture surface once. */
function validGroups(): CatalogFeature[][] {
  return [
    [
      feature("first-feature", {
        surfaces: { cli: ["alpha run"], mcp: ["tool_one"], hooks: ["hook-one"], config: ["dream"] },
      }),
    ],
    [
      feature("second-feature", {
        surfaces: { cli: ["beta"], mcp: ["tool_two"], skills: ["skill-one"] },
      }),
    ],
  ];
}

describe("the real catalog", () => {
  test("passes the check", () => {
    expect(checkCatalog(readCatalog(REPO_ROOT), codeFacts(), repositoryEnv(REPO_ROOT))).toEqual([]);
  });
});

/** `n` distinct capability lines. */
function lines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Does thing ${i}.`);
}

/** The check errors of the small catalog with the first feature's lines replaced. */
function withCapabilities(capabilities: string[], limits: string[] = []): string[] {
  const groups = validGroups();
  groups[0] = [{ ...(groups[0]?.[0] as CatalogFeature), capabilities, limits }];
  return checkCatalog(catalogFiles(groups), FACTS, ENV);
}

describe("the check on a small catalog", () => {
  test("a catalog that covers every surface once passes", () => {
    expect(checkCatalog(catalogFiles(validGroups()), FACTS, ENV)).toEqual([]);
  });

  test("a slug used twice is refused", () => {
    const groups = validGroups();
    groups[1]?.push(feature("first-feature"));
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toContain(
      "docs/catalog/area-2.json: first-feature: slug repeats the feature in docs/catalog/area-1.json",
    );
  });

  test("a slug of a removed feature cannot come back", () => {
    const removed = [{ slug: "first-feature", name: "Old", status: "removed", replaced_by: [] }];
    expect(checkCatalog(catalogFiles(validGroups(), removed), FACTS, ENV)).toContain(
      "docs/catalog/area-1.json: first-feature: slug was used by a feature in docs/catalog/_removed.json",
    );
  });

  test("a verb no feature claims is named", () => {
    const groups = validGroups();
    groups[1] = [
      feature("second-feature", { surfaces: { mcp: ["tool_two"], skills: ["skill-one"] } }),
    ];
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toEqual([
      'docs/catalog: cli verb "beta" is assigned to no feature',
    ]);
  });

  test("a namespace is not a verb", () => {
    const groups = validGroups();
    groups[1] = [
      feature("second-feature", {
        surfaces: { cli: ["beta", "alpha"], mcp: ["tool_two"], skills: ["skill-one"] },
      }),
    ];
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toEqual([
      'docs/catalog/area-2.json: second-feature: cli "alpha" is a namespace; list its verbs instead',
    ]);
  });

  test("a tool assigned twice names both features", () => {
    const groups = validGroups();
    groups[1] = [
      feature("second-feature", {
        surfaces: { cli: ["beta"], mcp: ["tool_two", "tool_one"], skills: ["skill-one"] },
      }),
    ];
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toEqual([
      'docs/catalog/area-2.json: second-feature: mcp "tool_one" is also assigned to first-feature (docs/catalog/area-1.json)',
    ]);
  });

  test("a removed tool cannot be listed", () => {
    const groups = validGroups();
    groups[1] = [
      feature("second-feature", {
        surfaces: { cli: ["beta"], mcp: ["tool_two", "tool_old"], skills: ["skill-one"] },
      }),
    ];
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toEqual([
      'docs/catalog/area-2.json: second-feature: mcp "tool_old" was removed and cannot be listed',
    ]);
  });

  test("a tool the MCP reference does not name is refused", () => {
    const env = { ...ENV, docText: () => "only `tool_one` here, and tool_two without backticks" };
    expect(checkCatalog(catalogFiles(validGroups()), FACTS, env)).toEqual([
      'docs/mcp.md: mcp tool "tool_two" is not named there in backticks',
    ]);
  });

  test("a stale index is refused", () => {
    const files = catalogFiles(validGroups()).map((f) =>
      f.file === INDEX_FILE ? { ...f, text: `${f.text}- an extra line\n` } : f,
    );
    expect(checkCatalog(files, FACTS, ENV)).toEqual([
      "docs/catalog/INDEX.md: stale; run bun run catalog:build",
    ]);
  });

  test("an index over the size limit is refused", () => {
    const groups = validGroups();
    const long = "x".repeat(110);
    for (let i = 0; i < 150; i++) groups[0]?.push(feature(`filler-${i}`, { summary: long }));
    const errors = checkCatalog(catalogFiles(groups), FACTS, ENV);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      new RegExp(
        `^docs/catalog/INDEX\\.md: would be \\d+ bytes, over the ${INDEX_MAX_BYTES}-byte limit$`,
      ),
    );
  });

  test("a tracker id anywhere in the folder is refused", () => {
    // Built at run time, so this file carries no tracker id of its own.
    const id = ["osb", "a1b2c3"].join("-");
    const files = [...catalogFiles(validGroups()), { file: "README.md", text: `See ${id}.` }];
    expect(checkCatalog(files, FACTS, ENV)).toEqual([
      `docs/catalog/README.md: carries a tracker id (${id})`,
    ]);
  });

  test("a schema violation names the file, the slug and the field", () => {
    const groups = validGroups();
    groups[0] = [{ ...(groups[0]?.[0] as CatalogFeature), summary: "y".repeat(121) }];
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toContain(
      "docs/catalog/area-1.json: first-feature: summary must be at most 120 characters (is 121)",
    );
  });

  test("every feature needs capabilities, keywords, docs and code", () => {
    const groups = validGroups();
    groups[0] = [
      {
        ...(groups[0]?.[0] as CatalogFeature),
        capabilities: ["Only one."],
        keywords: ["one", "two"],
        docs: [],
        code: [],
      },
    ];
    const errors = checkCatalog(catalogFiles(groups), FACTS, ENV);
    for (const line of [
      "docs/catalog/area-1.json: first-feature: capabilities must have at least 3 item(s)",
      "docs/catalog/area-1.json: first-feature: keywords must have at least 4 item(s)",
      "docs/catalog/area-1.json: first-feature: docs must have at least 1 item(s)",
      "docs/catalog/area-1.json: first-feature: code must have at least 1 item(s)",
    ]) {
      expect(errors).toContain(line);
    }
  });

  test("a feature holds up to 10 capability lines, each of at most 110 characters", () => {
    expect(withCapabilities(lines(10))).toEqual([]);
    expect(withCapabilities(lines(11))).toContain(
      "docs/catalog/area-1.json: first-feature: capabilities must have at most 10 item(s) (has 11)",
    );
    const long = "x".repeat(111);
    const errors = withCapabilities([...lines(2), long], [long]);
    expect(
      errors.filter((e) => e.includes("must be at most 110 characters (is 111)")),
    ).toHaveLength(2);
    expect(withCapabilities([...lines(2), "x".repeat(110)], ["y".repeat(110)])).toEqual([]);
  });
});

describe("the index", () => {
  test("marks a status that is not stable and lists keywords only when there are some", () => {
    const text = renderIndex(
      areasOf([
        [
          feature("plain", { keywords: [] }),
          feature("tuned", { status: "optional", keywords: ["one", "two"] }),
        ],
      ]),
    );
    expect(text).toContain("## area-1 - Area 1 (area-1.json)\n\n- `plain` — What plain does.\n");
    expect(text).toContain("- `tuned` [optional] — What tuned does. | kw: one, two\n");
  });

  test("shows the first keywords only", () => {
    const keywords = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"];
    const text = renderIndex(areasOf([[feature("many", { keywords })]]));
    expect(INDEX_KEYWORDS).toBe(5);
    expect(text).toContain("- `many` — What many does. | kw: k1, k2, k3, k4, k5\n");
  });

  test("doc anchors follow headings, repeats included", () => {
    const anchors = markdownAnchors(
      "# Top\n## The `brain` store (v2)\n```\n# not a heading\n```\n## Top\n",
    );
    expect([...anchors]).toEqual(["top", "the-brain-store-v2", "top-1"]);
  });
});

/** The check errors of the small catalog read against an MCP reference of `text`. */
function named(text: string): string[] {
  return checkCatalog(catalogFiles(validGroups()), FACTS, { ...ENV, docText: () => text });
}

/** The check errors of the small catalog with the first feature's summary replaced. */
function summaryOf(summary: string): string[] {
  const groups = validGroups();
  groups[0] = [{ ...(groups[0]?.[0] as CatalogFeature), summary }];
  return checkCatalog(catalogFiles(groups), FACTS, ENV);
}

/** An object schema whose `additionalProperties` is `extra`. */
function objectSchema(extra: unknown): Record<string, unknown> {
  return { type: "object", additionalProperties: extra };
}

describe("more rules of the check", () => {
  test("a hook, a skill and a required setting no feature claims are named", () => {
    const groups = validGroups();
    groups[0] = [feature("first-feature", { surfaces: { cli: ["alpha run"], mcp: ["tool_one"] } })];
    groups[1] = [feature("second-feature", { surfaces: { cli: ["beta"], mcp: ["tool_two"] } })];
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toEqual([
      'docs/catalog: hook "hook-one" is assigned to no feature',
      'docs/catalog: skill "skill-one" is assigned to no feature',
      'docs/catalog: setting "dream" is assigned to no feature',
    ]);
  });

  test("replaced_by must name a live feature", () => {
    const removed = [{ slug: "old-feature", name: "Old", status: "merged", replaced_by: ["gone"] }];
    expect(checkCatalog(catalogFiles(validGroups(), removed), FACTS, ENV)).toEqual([
      "docs/catalog/_removed.json: old-feature: replaced_by gone is no feature",
    ]);
  });

  test("an alias cannot be the slug of another live feature", () => {
    const groups = validGroups();
    groups[1] = [
      {
        ...(groups[1]?.[0] as CatalogFeature),
        aliases: ["first-feature"],
      },
    ];
    expect(checkCatalog(catalogFiles(groups), FACTS, ENV)).toEqual([
      "docs/catalog/area-2.json: second-feature: alias first-feature is the slug of a live feature",
    ]);
  });

  test("a JSON file in a subfolder is refused, not skipped", () => {
    const files = [...catalogFiles(validGroups()), { file: "sub/broken.json", text: "{" }];
    expect(checkCatalog(files, FACTS, ENV)).toContain(
      "docs/catalog/sub/broken.json: a JSON file in a subfolder is not part of the catalog",
    );
  });

  test("the order the files are passed in does not matter", () => {
    expect(checkCatalog(catalogFiles(validGroups()).toReversed(), FACTS, ENV)).toEqual([]);
  });

  test("a server the catalog does not read, or a host tool that is no MCP tool, is named", () => {
    const facts: CodeFacts = {
      ...FACTS,
      toolServerFiles: new Set([...TOOL_SERVER_FILES, "src/mcp/other-server.ts"]),
      hostNativeTools: new Set(["tool_one", "tool_native_only"]),
    };
    expect(checkCatalog(catalogFiles(validGroups()), facts, ENV)).toEqual([
      "src/mcp/other-server.ts: answers tools/list, but the catalog reads no tool registry from it",
      'src/openclaw/index.ts: native tool "tool_native_only" is no MCP tool, so no feature claims it',
    ]);
  });

  test("a longer name or a file name does not count as naming a tool", () => {
    const env = {
      ...ENV,
      docText: () => "`tool_one-v2`, `tool_one.ts` and `tool_two`",
    };
    expect(checkCatalog(catalogFiles(validGroups()), FACTS, env)).toEqual([
      'docs/mcp.md: mcp tool "tool_one" is not named there in backticks',
    ]);
  });

  test("a doc reference with a parent segment before its anchor is refused by the schema", () => {
    const schema = loadSchema(REPO_ROOT);
    expect(
      ["..#foo", "a/..#foo", "docs/guide.md#guide"].map(
        (ref) => validateAgainst(schema, ref, "doc_ref").length > 0,
      ),
    ).toEqual([true, true, false]);
  });

  test("a tool counts as named only inside a code span that closes", () => {
    const missing = 'docs/mcp.md: mcp tool "tool_one" is not named there in backticks';
    // A backtick that nothing closes is plain text, and a span never
    // crosses a blank line.
    expect(named("`tool_two` and `tool_one, a span that never closes")).toEqual([missing]);
    expect(named("`tool_two` and `tool_one\n\nbut the span never closed`")).toEqual([missing]);
    expect(named("`tool_one { a |\n b }` and `tool_two`")).toEqual([]);
    // Line endings inside a span are spaces, and one space is stripped
    // from each end: this span names `tool_one`.
    expect(named("`\ntool_one\n` and `tool_two`")).toEqual([]);
    // A fenced block, even one holding a blank line, pairs with nothing
    // outside it, so the inline mentions between two blocks still count.
    expect(
      named("```\ncode a\n\ncode b\n```\nUse `tool_one` and `tool_two`.\n~~~\nmore\n~~~\n"),
    ).toEqual([]);
    // A name only inside a fenced block is not an inline mention.
    expect(named("```\ntool_one\n```\n\n`tool_two`")).toEqual([missing]);
    expect(named("`` tool_one `` and `tool_two`")).toEqual([]);
  });

  test("a summary is measured in characters, not UTF-16 units", () => {
    // 119 letters and one character outside the Basic Multilingual Plane.
    expect(summaryOf(`${"a".repeat(119)}\u{1F600}`)).toEqual([]);
    expect(summaryOf(`${"a".repeat(120)}\u{1F600}`)).toContain(
      "docs/catalog/area-1.json: first-feature: summary must be at most 120 characters (is 121)",
    );
  });

  test("a schema whose additionalProperties is a schema is refused at load", () => {
    expect(() => assertSupportedSchema(objectSchema({ type: "string" }))).toThrow(
      "additionalProperties must be true or false",
    );
    expect(() => assertSupportedSchema(objectSchema(true))).not.toThrow();
    expect(() => assertSupportedSchema(objectSchema(false))).not.toThrow();
  });

  test("a repeated heading takes the next free suffix, as on GitHub", () => {
    expect([...markdownAnchors("# Setup-1\n# Setup\n# Setup\n# Setup\n")]).toEqual([
      "setup-1",
      "setup",
      "setup-2",
      "setup-3",
    ]);
  });

  test("a tool counts as named when other text follows it inside the backticks", () => {
    const env = { ...ENV, docText: () => "`tool_one {}` and `tool_two(args)`, not `tool_onex`" };
    expect(checkCatalog(catalogFiles(validGroups()), FACTS, env)).toEqual([]);
  });

  test("paths with a backslash, a drive letter or a parent segment are refused", () => {
    const groups = validGroups();
    groups[0] = [
      {
        ...(groups[0]?.[0] as CatalogFeature),
        docs: ["..\\outside.md"],
        code: ["C:/src/x.ts", "a/../b.ts"],
      },
    ];
    const errors = checkCatalog(catalogFiles(groups), FACTS, ENV);
    expect(errors.filter((e) => e.includes("does not match")).length).toBe(3);
  });
});

/** The check errors of a catalog whose first feature names `docs` and `code`, read against `root`. */
function docErrors(root: string, docs: string[], code: string[] = ["docs/guide.md"]): string[] {
  const groups = validGroups();
  groups[0] = [{ ...(groups[0]?.[0] as CatalogFeature), docs, code }];
  const env = { ...repositoryEnv(root), docText: ENV.docText };
  return checkCatalog(catalogFiles(groups), FACTS, env);
}

describe("the repository environment", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A repository root holding one doc with one heading and the schema. */
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "o2b-catalog-repo-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "catalog"), { recursive: true });
    copyFileSync(join(REPO_ROOT, SCHEMA_FILE), join(root, SCHEMA_FILE));
    writeFileSync(join(root, "docs", "guide.md"), '# Guide\n\n```html\n<a id="fenced"></a>\n```\n');
    writeFileSync(join(root, "notes.txt"), "plain\n");
    // The code path every fixture feature names.
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "feature.ts"), "export {};\n");
    return root;
  }

  test("an existing doc and heading pass", () => {
    expect(docErrors(repo(), ["docs/guide.md#guide"])).toEqual([]);
  });

  test("a missing file, a missing heading and an uncheckable anchor are named", () => {
    const root = repo();
    expect(docErrors(root, ["docs/none.md"], ["src/none.ts"])).toEqual([
      'docs/catalog/area-1.json: first-feature: docs "docs/none.md" names no file',
      'docs/catalog/area-1.json: first-feature: code "src/none.ts" names no file',
    ]);
    expect(docErrors(root, ["docs/guide.md#nope", "notes.txt#top"])).toEqual([
      'docs/catalog/area-1.json: first-feature: docs "docs/guide.md#nope" names no heading',
      'docs/catalog/area-1.json: first-feature: docs "notes.txt#top" has an anchor in a file whose headings cannot be read',
    ]);
  });

  test("an id inside a code fence is no anchor", () => {
    expect(docErrors(repo(), ["docs/guide.md#fenced"])).toEqual([
      'docs/catalog/area-1.json: first-feature: docs "docs/guide.md#fenced" names no heading',
    ]);
  });

  // POSIX only: creating a symbolic link needs a privilege on Windows.
  test.skipIf(process.platform === "win32")(
    "a link inside the tree that leads out of it is not inside it",
    () => {
      const root = repo();
      const outside = mkdtempSync(join(tmpdir(), "o2b-catalog-outside-"));
      roots.push(outside);
      writeFileSync(join(outside, "secret.md"), "# Outside\n");
      symlinkSync(join(outside, "secret.md"), join(root, "docs", "out.md"));
      symlinkSync(join(root, "docs", "guide.md"), join(root, "docs", "in.md"));
      const env = repositoryEnv(root);
      expect(
        ["docs/guide.md", "docs/in.md", "docs/out.md"].map((p) => env.inRepository(p)),
      ).toEqual([true, true, false]);
    },
  );

  test("only a server that answers tools/list on its method counts as one", () => {
    const root = repo();
    mkdirSync(join(root, "src", "mcp"), { recursive: true });
    const files: Record<string, string> = {
      "src/mcp/left.ts": 'if ("tools/list" === request.method) list();\n',
      "src/mcp/right.ts": 'if (msg.method === "tools/list") list();\n',
      "src/mcp/switch.ts": 'switch (m) { case "tools/list": list(); }\n',
      "src/mcp/log.ts": 'const listed = calls.some((c) => c.tool === "tools/list");\n',
    };
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
    expect(scanToolServerFiles(root)).toEqual([
      "src/mcp/left.ts",
      "src/mcp/right.ts",
      "src/mcp/switch.ts",
    ]);
  });

  test("a path that resolves outside the repository is not inside it", () => {
    const env = repositoryEnv(repo());
    expect([env.inRepository("docs/guide.md"), env.inRepository("../outside.md")]).toEqual([
      true,
      false,
    ]);
  });

  test("the build writes the index from valid files and refuses a mismatched file name", () => {
    const root = repo();
    const dir = join(root, "docs", "catalog");
    for (const f of catalogFiles(validGroups())) writeFileSync(join(dir, f.file), f.text);
    rmSync(join(dir, INDEX_FILE));
    const built = buildIndex(root);
    expect(built.errors).toEqual([]);
    expect(readFileSync(join(dir, INDEX_FILE), "utf8")).toBe(renderIndex(areasOf(validGroups())));

    rmSync(join(dir, INDEX_FILE));
    writeFileSync(join(dir, "wrong.json"), readFileSync(join(dir, "area-1.json"), "utf8"));
    rmSync(join(dir, "area-1.json"));
    const refused = buildIndex(root);
    expect(refused.errors).toContain(
      'docs/catalog/wrong.json: area "area-1" does not match the file name',
    );
    expect(existsSync(join(dir, INDEX_FILE))).toBe(false);
  });
});

const shellQuote = (w: string): string => `'${w.replaceAll("'", `'\\''`)}'`;

describe("the dump", () => {
  test("serializes every surface", () => {
    const surfaces = collectSurfaces();
    const parsed = JSON.parse(JSON.stringify(surfaces)) as typeof surfaces;
    expect(parsed.mcp.tools.map((t) => t.name)).toContain("dream_work_take");
    expect(parsed.cli.verbs.map((v) => v.path)).toContain("doctor selftest");
  });

  // A shell pipe is the one that cut the output; Windows has no POSIX shell.
  test.skipIf(process.platform === "win32")("reaches a pipe whole and parses", async () => {
    const script = join(REPO_ROOT, "scripts", "feature-catalog.ts");
    // The dump's own status, not the pipeline's (that is `cat`'s): the
    // shell writes it to a file of its own before the pipe closes.
    const dir = mkdtempSync(join(tmpdir(), "o2b-catalog-dump-"));
    const statusFile = join(dir, "status");
    try {
      const dump = `${shellQuote(process.execPath)} ${shellQuote(script)} dump`;
      const proc = Bun.spawn(
        ["sh", "-c", `{ ${dump}; echo $? > ${shellQuote(statusFile)}; } | cat`],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const pipeline = await proc.exited;
      const raw = existsSync(statusFile) ? readFileSync(statusFile, "utf8").trim() : "";
      const dumpStatus = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
      expect({ dumpStatus, pipeline, err }).toEqual({ dumpStatus: 0, pipeline: 0, err: "" });
      expect(Buffer.byteLength(out)).toBeGreaterThan(131_072);
      expect(Object.keys(JSON.parse(out) as object)).toContain("cli");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

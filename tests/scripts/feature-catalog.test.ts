/**
 * `scripts/feature-catalog.ts` - the feature catalog under `docs/catalog/`
 * holds to the code: the real catalog passes the check, and each rule the
 * check applies fails on a small in-memory catalog that breaks exactly it.
 */

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCatalog,
  codeFacts,
  INDEX_FILE,
  INDEX_KEYWORDS,
  INDEX_MAX_BYTES,
  loadSchema,
  markdownAnchors,
  readCatalog,
  REMOVED_FILE,
  renderIndex,
  repositoryEnv,
  type CatalogArea,
  type CatalogFeature,
  type CatalogFile,
  type CheckEnv,
  type CodeFacts,
} from "../../scripts/feature-catalog.ts";

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
};

const ENV: CheckEnv = {
  schema: loadSchema(REPO_ROOT),
  exists: () => true,
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

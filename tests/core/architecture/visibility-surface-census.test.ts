/**
 * Unit H (form B) — every surface that can hand a vault note's path,
 * title, or body back to a caller, measured rather than described
 * (nothing-writes-silently).
 *
 * `graph/visibility.ts`'s `visibility:` frontmatter is caller-liftable
 * scoping, not a boundary, and it is wired into exactly ONE place:
 * `search()`'s pool-filters pipeline. This file is the coverage map that
 * fact needs, in the shape `write-site-census.test.ts` already
 * established for a different gap: a closed category vocabulary, a
 * per-entry written reason, a population pin, and a mechanism that fails
 * on an unclassified newcomer rather than describing the population in
 * prose.
 *
 * The claims pinned here:
 *
 *   1. Every MCP tool file that imports a known note-content-returning
 *      primitive is swept into a population; every REAL registered tool
 *      name (from `buildToolTable("full")`) that a swept file defines
 *      has an entry in `VISIBILITY_SURFACE_REGISTRY`, in both
 *      directions - a newly-swept tool with no entry fails, and a
 *      registry entry for a tool no swept file defines fails too.
 *   2. Every MCP resource `listResources()` / `listResourceTemplates()`
 *      advertises has a registry entry, exactly.
 *   3. Every CLI-verb registry entry names a `<group> <verb>` pair that
 *      actually exists in `command-manifest.ts`.
 *   4. Every registry entry carries exactly one of the two closed
 *      categories and a reason of meaningful length that is not a
 *      placeholder.
 *   5. The population is pinned as an equality, the way
 *      `DIRECT_WRITE_ROWS` pins write-site-census's count - a moved
 *      number is a finding to name, not a re-measurement chore.
 *   6. The census can fail: a synthetic file importing a known
 *      note-content primitive and defining a tool name in the (also
 *      synthetic) real-tool set is reported unclassified.
 *   7. `search()` is the only lane wired to `applyVisibilityScope` -
 *      pinned by grepping `src/core/search/` for the call site.
 *
 * ## The mechanical anchor, and what it cannot catch
 *
 * MCP population: a file under `src/mcp/` is a candidate the moment it
 * imports one of {@link NOTE_CONTENT_PRODUCERS} - an identifier taken
 * from a module suffix already verified, by reading the source, to hand
 * back a page's path, title, or body. That is exactly write-site-census's
 * `VAULT_VOCABULARY_IMPORT_RE` shape, aimed at reads instead of writes.
 * Within a candidate FILE, every `name: "…"` tool-registration string is
 * extracted and kept only when it ALSO appears in `buildToolTable("full")`'s
 * real, live tool list - which turns a merely-plausible string match (a
 * `name:` field on some unrelated object) into a real, currently-registered
 * tool, with no hand-picked per-tool filter to go stale.
 *
 * The population unit is the FILE, not the individual tool: a file that
 * imports one primitive for one of its tools sweeps in every OTHER real
 * tool name that file also defines (over-inclusion is the safe direction,
 * matching write-site-census's own stated principle), so several entries
 * in the registry below carry a reason of "swept in for file-level
 * completeness; this handler returns no note content" rather than a real
 * disclosure - stated in each such entry rather than left to be guessed.
 *
 * What this cannot see, stated rather than implied: a tool that reads
 * note content through a NEW primitive not yet in the vocabulary (the
 * same blind spot write-site-census states for a new write shape); a
 * tool that reaches a listed primitive only through a transitive import
 * two modules away (the population rule reads the MCP file's own
 * imports, not its whole call graph - deep-synthesis.ts is in
 * population via `deepSynthesis`, not because knowledge-tools.ts itself
 * imports `search`); and `src/openclaw/` (the OpenClaw native plugin
 * adapter), which the charter scoped this sweep away from even though
 * `src/openclaw/index.ts` hosts its own `listVaultPages`-backed page
 * search with no visibility check - named here, not swept, and worth a
 * follow-up census of its own.
 *
 * CLI population is NOT mechanically discovered the way the MCP one is:
 * it is hand-enumerated, one row per MCP tool above that has a CLI
 * mirror, and each row is only CROSS-CHECKED for existence against
 * `command-manifest.ts` via `nestedCommand`. A wholly new CLI verb with
 * no MCP counterpart would not be caught by this file at all - a real
 * gap, named so a reader does not assume otherwise.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { lexSource, type LexedSource } from "../../helpers/source-lexer.ts";
import { buildToolTable } from "../../../src/mcp/tools.ts";
import { listResources, listResourceTemplates } from "../../../src/mcp/resources.ts";
import { nestedCommand } from "../../../src/cli/command-manifest.ts";
import {
  VISIBILITY_SURFACE_CATEGORY,
  VISIBILITY_SURFACE_KIND,
  VISIBILITY_SURFACE_REGISTRY,
  type VisibilitySurfaceEntry,
} from "../../../src/core/search/visibility-surface-registry.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const MCP_ROOT = join(REPO_ROOT, "src", "mcp");
const SRC_ROOT = join(REPO_ROOT, "src");

// ─────────────────────────────────────────────────────────────────────────────
// Tree reading, shared with the intruder fixtures below
// ─────────────────────────────────────────────────────────────────────────────

interface CensusFile {
  readonly path: string;
  readonly text: string;
}

function readTree(root: string): CensusFile[] {
  const files: CensusFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

const LEXED = new Map<string, { readonly text: string; readonly views: LexedSource }>();

function lexedViews(file: CensusFile): LexedSource {
  const cached = LEXED.get(file.path);
  if (cached !== undefined && cached.text === file.text) return cached.views;
  const views = lexSource(file.text);
  LEXED.set(file.path, { text: file.text, views });
  return views;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP tool population
// ─────────────────────────────────────────────────────────────────────────────

interface ProducerRule {
  /** A substring the import specifier must contain. */
  readonly specifierIncludes: string;
  /** Any one of these named imports, present alongside that specifier, qualifies. */
  readonly identifiers: ReadonlyArray<string>;
}

/**
 * Known note-content-returning primitives, keyed by the module each is
 * imported from. Every entry is source-verified: the reason field on the
 * matching {@link VISIBILITY_SURFACE_REGISTRY} row cites exactly how.
 */
const NOTE_CONTENT_PRODUCERS: ReadonlyArray<ProducerRule> = Object.freeze([
  {
    specifierIncludes: "/vault.ts",
    identifiers: [
      "parseFrontmatter",
      "parseFrontmatterWithNotices",
      "parseFrontmatterText",
      "parseFrontmatterTextWithNotices",
      "listVaultPages",
    ],
  },
  { specifierIncludes: "/search/search.ts", identifiers: ["search"] },
  { specifierIncludes: "/search/index.ts", identifiers: ["search", "expandHit"] },
  { specifierIncludes: "/search/cards.ts", identifiers: ["expandHit"] },
  { specifierIncludes: "/search/store.ts", identifiers: ["Store"] },
  { specifierIncludes: "/brain/file-recall.ts", identifiers: ["fileContextRecall"] },
  { specifierIncludes: "/brain/context-pack.ts", identifiers: ["packContext"] },
  { specifierIncludes: "/brain/backlinks.ts", identifiers: ["buildBacklinkIndex"] },
  {
    specifierIncludes: "/brain/link-graph/unlinked-mentions.ts",
    identifiers: ["findUnlinkedMentions"],
  },
  { specifierIncludes: "/brain/portability/sources.ts", identifiers: ["aggregateSources"] },
  { specifierIncludes: "/brain/query.ts", identifiers: ["queryByPreference", "queryByTopic"] },
  { specifierIncludes: "/brain/pref-audit.ts", identifiers: ["readPrefAudit"] },
  {
    specifierIncludes: "/brain/link-graph/bridge-discovery.ts",
    identifiers: [
      "discoverBridges",
      "writeBridgeProposals",
      "readDismissedBridges",
      "dismissBridge",
      "acceptBridge",
    ],
  },
  {
    specifierIncludes: "/brain/link-graph/communities.ts",
    identifiers: ["detectCommunities", "materializeClusterNotes"],
  },
  {
    specifierIncludes: "/brain/deep-synthesis.ts",
    identifiers: ["deepSynthesis", "synthesisCandidates", "synthesisFindingsJson"],
  },
  {
    specifierIncludes: "/brain/idea-discovery.ts",
    identifiers: ["discoverIdeas", "ideaCandidates"],
  },
  { specifierIncludes: "/brain/link-graph/moc-audit.ts", identifiers: ["auditMoc"] },
  { specifierIncludes: "/brain/dead-ends.ts", identifiers: ["listDeadEnds", "recordDeadEnd"] },
  {
    specifierIncludes: "/brain/claim-graph.ts",
    identifiers: [
      "currentTruth",
      "rebuildClaimGraph",
      "whatReplaced",
      "whatContests",
      "truthAt",
      "allClaims",
    ],
  },
  {
    specifierIncludes: "/brain/truth/",
    identifiers: ["computeTruthStateWithConflicts", "aggregateQuantities", "detectAgentCollisions"],
  },
]);

/**
 * Every `import { … } from "…"` statement's named-import list and
 * specifier, read off {@link LexedSource.withoutComments} - the import
 * specifier and the imported NAMES are both strings/identifiers a
 * structural scan must read as written, not the `code` view that blanks
 * literal contents (the same split write-site-census's own import
 * clause uses, and for the same reason).
 */
const IMPORT_RE = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;

/** Whether `text` imports any {@link NOTE_CONTENT_PRODUCERS} primitive. */
function importsNoteContentPrimitive(text: string): boolean {
  for (const match of text.matchAll(IMPORT_RE)) {
    const names = new Set(
      match[1]!.split(",").map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim(),
      ),
    );
    const specifier = match[2]!;
    for (const rule of NOTE_CONTENT_PRODUCERS) {
      if (!specifier.includes(rule.specifierIncludes)) continue;
      if (rule.identifiers.some((id) => names.has(id))) return true;
    }
  }
  return false;
}

/** Every `name: "…"` tool-registration string literal a file's text contains. */
const TOOL_NAME_LITERAL_RE = /\bname:\s*"([a-z][a-z0-9_]*)"/g;

function toolNameLiteralsIn(text: string): string[] {
  return [...text.matchAll(TOOL_NAME_LITERAL_RE)].map((m) => m[1]!);
}

/**
 * The MCP tool population: real, currently-registered tool names defined
 * in a file that imports a note-content primitive. `realToolNames` is
 * passed in rather than read globally so the fixtures below can exercise
 * the same function with a synthetic registry.
 */
function discoverMcpToolPopulation(
  files: ReadonlyArray<CensusFile>,
  realToolNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of files) {
    if (!importsNoteContentPrimitive(lexedViews(file).withoutComments)) continue;
    for (const literal of toolNameLiteralsIn(lexedViews(file).withoutComments)) {
      if (realToolNames.has(literal)) found.add(literal);
    }
  }
  return found;
}

const MCP_SOURCE_TREE = readTree(MCP_ROOT);
const REAL_TOOL_NAMES: ReadonlySet<string> = new Set(buildToolTable("full").map((t) => t.name));
const MCP_TOOL_POPULATION = discoverMcpToolPopulation(MCP_SOURCE_TREE, REAL_TOOL_NAMES);

const REGISTRY_BY_KIND = (
  kind: (typeof VISIBILITY_SURFACE_KIND)[keyof typeof VISIBILITY_SURFACE_KIND],
) => VISIBILITY_SURFACE_REGISTRY.filter((e) => e.kind === kind);

// ─────────────────────────────────────────────────────────────────────────────
// Reason quality, matching write-site-census's bar
// ─────────────────────────────────────────────────────────────────────────────

const MIN_REASON_LENGTH = 80;
const LAZY_REASON_RE = /\bTODO\b|\bfor now\b|\blater\b/i;

function reasonProblems(entries: ReadonlyArray<VisibilitySurfaceEntry>): {
  thin: string[];
  lazy: string[];
} {
  const thin: string[] = [];
  const lazy: string[] = [];
  for (const e of entries) {
    if (e.reason.trim().length < MIN_REASON_LENGTH) thin.push(`${e.surface} (${e.reason.length})`);
    if (LAZY_REASON_RE.test(e.reason)) lazy.push(e.surface);
  }
  return { thin, lazy };
}

// ─────────────────────────────────────────────────────────────────────────────
// Population pins - equalities, the way write-site-census pins its own counts
// ─────────────────────────────────────────────────────────────────────────────

/** Measured: MCP tools whose file imports a note-content primitive. */
const MCP_TOOL_POPULATION_SIZE = 42;
/** Measured: MCP resources + templates, all excluded. */
const MCP_RESOURCE_POPULATION_SIZE = 8;
/** Measured: hand-enumerated CLI verb mirrors. */
const CLI_VERB_POPULATION_SIZE = 20;

describe("visibility surface census", () => {
  test("every category is one of the two closed values", () => {
    const bad = VISIBILITY_SURFACE_REGISTRY.filter(
      (e) =>
        e.category !== VISIBILITY_SURFACE_CATEGORY.covered &&
        e.category !== VISIBILITY_SURFACE_CATEGORY.excluded,
    );
    expect(bad).toEqual([]);
  });

  test("every entry carries a reason of meaningful length, not a placeholder", () => {
    const { thin, lazy } = reasonProblems(VISIBILITY_SURFACE_REGISTRY);
    expect(thin.toSorted().join("\n")).toBe("");
    expect(lazy.toSorted().join("\n")).toBe("");
  });

  test("no surface name is registered twice under the same kind", () => {
    const seen = new Map<string, number>();
    for (const e of VISIBILITY_SURFACE_REGISTRY) {
      const key = `${e.kind}:${e.surface}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes).toEqual([]);
  });

  describe("MCP tools", () => {
    test("every swept tool name has a registry entry, and every registry entry names a swept tool", () => {
      const registered = new Set(
        REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.mcpTool).map((e) => e.surface),
      );
      const unclassified = [...MCP_TOOL_POPULATION].filter((name) => !registered.has(name));
      const stale = [...registered].filter((name) => !MCP_TOOL_POPULATION.has(name));
      expect(unclassified.toSorted()).toEqual([]);
      expect(stale.toSorted()).toEqual([]);
    });

    test("the swept population is measured, as an equality", () => {
      // A moved number is a finding to name in the report, not a
      // re-measurement chore - see write-site-census's own convention.
      expect(MCP_TOOL_POPULATION.size).toBe(MCP_TOOL_POPULATION_SIZE);
    });

    test("brain_search and brain_file_context are the only two covered MCP tools", () => {
      const covered = REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.mcpTool)
        .filter((e) => e.category === VISIBILITY_SURFACE_CATEGORY.covered)
        .map((e) => e.surface)
        .toSorted();
      expect(covered).toEqual(["brain_file_context", "brain_search"]);
    });
  });

  describe("MCP resources", () => {
    test("every advertised resource and template has a registry entry, exactly", () => {
      const advertised = new Set<string>([
        ...listResources().map((r) => r.uri),
        ...listResourceTemplates().map((t) => t.uriTemplate),
      ]);
      const registered = new Set(
        REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.mcpResource).map((e) => e.surface),
      );
      expect([...advertised].toSorted()).toEqual([...registered].toSorted());
      expect(advertised.size).toBe(MCP_RESOURCE_POPULATION_SIZE);
    });

    test("no MCP resource is covered - resources.ts never calls applyVisibilityScope", () => {
      const anyCovered = REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.mcpResource).some(
        (e) => e.category === VISIBILITY_SURFACE_CATEGORY.covered,
      );
      expect(anyCovered).toBe(false);
    });
  });

  describe("CLI verbs", () => {
    test("every registered CLI-verb entry names a <group> <verb> pair that exists", () => {
      const missing: string[] = [];
      for (const entry of REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.cliVerb)) {
        const [group, verb] = entry.surface.split(" ");
        if (group === undefined || verb === undefined || nestedCommand(group, verb) === undefined) {
          missing.push(entry.surface);
        }
      }
      expect(missing).toEqual([]);
    });

    test("the hand-enumerated CLI population is measured, as an equality", () => {
      expect(REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.cliVerb).length).toBe(
        CLI_VERB_POPULATION_SIZE,
      );
    });

    test("no CLI verb is covered except the two search lanes", () => {
      const covered = REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.cliVerb)
        .filter((e) => e.category === VISIBILITY_SURFACE_CATEGORY.covered)
        .map((e) => e.surface)
        .toSorted();
      expect(covered).toEqual(["search query"]);
    });
  });

  test("the index store's own chunk tables carry exactly one entry", () => {
    const rows = REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.indexStore);
    expect(rows.length).toBe(1);
    expect(rows[0]!.category).toBe(VISIBILITY_SURFACE_CATEGORY.excluded);
  });

  test("applyVisibilityScope has exactly one call site in src/core/search/", () => {
    // The fact the whole registry rests on: search()'s pool-filters
    // pipeline is the ONE place the field is consulted. A second call
    // site would mean a covered lane this file does not know about.
    const hits: string[] = [];
    for (const file of readTree(SRC_ROOT)) {
      if (!file.path.startsWith("src/core/search/")) continue;
      if (/\bapplyVisibilityScope\s*\(/.test(lexedViews(file).code)) hits.push(file.path);
    }
    // The declaration site itself (`export function applyVisibilityScope`)
    // is a definition, not a call, and the lexer's `code` view still
    // matches its parameter list open-paren - so the DEFINING file is
    // expected to appear once alongside its one real caller.
    expect(hits.toSorted()).toEqual([
      "src/core/search/pipeline/pool-filters.ts",
      "src/core/search/result-filters.ts",
    ]);
  });
});

describe("the census can fail", () => {
  test("a synthetic MCP tool file with a known primitive and a real tool name is reported unclassified", () => {
    const syntheticRealNames = new Set(["brain_synthetic_intruder"]);
    const intruder: CensusFile = {
      path: "src/mcp/brain/synthetic-tools.ts",
      text:
        'import { parseFrontmatter } from "../../core/vault.ts";\n' +
        "export const SYNTHETIC_TOOLS = [\n" +
        '  { name: "brain_synthetic_intruder", description: "x", handler: () => parseFrontmatter },\n' +
        "];\n",
    };
    const population = discoverMcpToolPopulation([intruder], syntheticRealNames);
    expect([...population]).toEqual(["brain_synthetic_intruder"]);
    // And the registry, as it stands, does not carry this synthetic name -
    // exactly the state the real test above fails the build on.
    const registered = new Set(
      REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.mcpTool).map((e) => e.surface),
    );
    expect(registered.has("brain_synthetic_intruder")).toBe(false);
  });

  test("a file with no note-content import is not swept in, even with a matching tool-name literal", () => {
    const syntheticRealNames = new Set(["brain_synthetic_bystander"]);
    const bystander: CensusFile = {
      path: "src/mcp/brain/synthetic-bystander.ts",
      text: 'export const X = [{ name: "brain_synthetic_bystander", description: "x" }];\n',
    };
    const population = discoverMcpToolPopulation([bystander], syntheticRealNames);
    expect([...population]).toEqual([]);
  });

  test("a tool-name literal that is not a REAL registered tool is not swept in (noise filter)", () => {
    const noisy: CensusFile = {
      path: "src/mcp/brain/synthetic-noise.ts",
      text:
        'import { listVaultPages } from "../../core/vault.ts";\n' +
        'const unrelatedObject = { name: "not_a_real_tool" };\n',
    };
    const population = discoverMcpToolPopulation([noisy], new Set(["brain_search"]));
    expect([...population]).toEqual([]);
  });

  test("a renamed import binding is still detected (the same shape write-site-census pins)", () => {
    const renamed: CensusFile = {
      path: "src/mcp/brain/synthetic-renamed.ts",
      text:
        'import { parseFrontmatter as pf } from "../../core/vault.ts";\n' +
        'export const T = [{ name: "brain_synthetic_renamed", handler: pf }];\n',
    };
    // The vocabulary check reads the IMPORTED name (before `as`), not the
    // local alias `pf` the file goes on to use - so a rename cannot hide
    // the import the way it could not hide a write-site-census call.
    const population = discoverMcpToolPopulation([renamed], new Set(["brain_synthetic_renamed"]));
    expect([...population]).toEqual(["brain_synthetic_renamed"]);
  });
});

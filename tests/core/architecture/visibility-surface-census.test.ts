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
 * Within a candidate FILE, every tool-registration `name:` is extracted -
 * both the string literals and the `name: SOME_CONSTANT` form, resolved
 * through the constants the file declares and the ones it imports - and
 * kept only when the resulting name ALSO appears in
 * `buildToolTable("full")`'s real, live tool list, which turns a
 * merely-plausible match (a `name:` field on some unrelated object) into a
 * real, currently-registered tool with no hand-picked per-tool filter to
 * go stale.
 *
 * Constant resolution is not decoration. Roughly a dozen MCP tool files
 * register their tools through constants, and `src/mcp/tools.ts` - in
 * population, and swept since this census shipped - registers
 * `second_brain_capabilities` as `name: CAPABILITY_DIAGNOSTIC_TOOL`. A
 * literals-only sweep reported a population of 42 that was 43 and left
 * that tool with no registry row, which is the failure mode the design's
 * risk section names: a census that quietly omits a surface reproduces
 * the defect it documents.
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
 * tool name built at runtime rather than written down - a template
 * literal, a concatenation, a value read from a table - since constant
 * resolution reads `const NAME = "literal"` declarations only, and a
 * constant re-exported through a third module (the resolver follows one
 * hop, from the registering file to the file it imported the name from);
 * a tool that reaches a listed primitive only through a transitive import
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
  DIRECT_VAULT_READ_CATEGORY,
  DIRECT_VAULT_READ_REGISTRY,
  VISIBILITY_SURFACE_CATEGORY,
  VISIBILITY_SURFACE_KIND,
  VISIBILITY_SURFACE_REGISTRY,
  type DirectVaultReadEntry,
  type VisibilitySurfaceEntry,
} from "../../../src/core/search/visibility-surface-registry.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const MCP_ROOT = join(REPO_ROOT, "src", "mcp");
const OPENCLAW_ROOT = join(REPO_ROOT, "src", "openclaw");
const CLI_ROOT = join(REPO_ROOT, "src", "cli");
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

/**
 * Every `name: SOME_CONSTANT` registration. A tool name does not have to
 * be written at the registration site: `src/mcp/tools.ts` registers
 * `second_brain_capabilities` as `name: CAPABILITY_DIAGNOSTIC_TOOL`, and
 * a dozen other MCP files register theirs through constants too. Reading
 * literals only left those invisible INSIDE an already-swept file, which
 * is the one blind spot a reader of this census would not expect.
 */
const TOOL_NAME_CONST_RE = /\bname:\s*([A-Z][A-Z0-9_]*)\b/g;

/** A `const NAME = "value"` declaration, exported or not. */
const STRING_CONST_RE =
  /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*"([a-z][a-z0-9_]*)"/g;

/** Named imports and the specifier they came from, for constant resolution. */
const NAMED_IMPORT_RE = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;

function toolNameLiteralsIn(text: string): string[] {
  return [...text.matchAll(TOOL_NAME_LITERAL_RE)].map((m) => m[1]!);
}

/** `const NAME = "value"` pairs a file declares, by constant name. */
function stringConstantsIn(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of text.matchAll(STRING_CONST_RE)) found.set(match[1]!, match[2]!);
  return found;
}

/**
 * Resolve a relative import specifier against the importing file's path,
 * to the same repo-relative spelling {@link readTree} produces. Only
 * `./` and `../` specifiers resolve; a bare package specifier has no
 * file in the tree and returns `null`.
 */
function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/** Which file each named import in `file` was imported from. */
function importSources(file: CensusFile, text: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const match of text.matchAll(NAMED_IMPORT_RE)) {
    const resolved = resolveSpecifier(file.path, match[2]!);
    if (resolved === null) continue;
    for (const raw of match[1]!.split(",")) {
      const local = raw
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (local.length > 0) sources.set(local, resolved);
    }
  }
  return sources;
}

/**
 * The MCP tool population: real, currently-registered tool names defined
 * in a file that imports a note-content primitive - whether the name is
 * written at the registration site or reached through a constant the
 * file declares or imports. `realToolNames` is passed in rather than read
 * globally so the fixtures below can exercise the same function with a
 * synthetic registry.
 *
 * A constant resolves through the file's own declarations first, then
 * through the file it was imported from. It resolves to NOTHING when
 * neither answers - an unresolved identifier contributes no name rather
 * than a guessed one - and the real-tool filter is the backstop either
 * way.
 */
function discoverMcpToolPopulation(
  files: ReadonlyArray<CensusFile>,
  realToolNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const constantsByFile = new Map<string, Map<string, string>>();
  for (const file of files) {
    constantsByFile.set(file.path, stringConstantsIn(lexedViews(file).withoutComments));
  }
  const found = new Set<string>();
  for (const file of files) {
    const text = lexedViews(file).withoutComments;
    if (!importsNoteContentPrimitive(text)) continue;
    for (const literal of toolNameLiteralsIn(text)) {
      if (realToolNames.has(literal)) found.add(literal);
    }
    const own = constantsByFile.get(file.path)!;
    const imported = importSources(file, text);
    for (const match of text.matchAll(TOOL_NAME_CONST_RE)) {
      const identifier = match[1]!;
      const source = imported.get(identifier);
      const value =
        own.get(identifier) ??
        (source === undefined ? undefined : constantsByFile.get(source)?.get(identifier));
      if (value !== undefined && realToolNames.has(value)) found.add(value);
    }
  }
  return found;
}

/**
 * The tool-surface tree. `src/openclaw/` joined `src/mcp/` here when the
 * boundary reached it: the previous census named the OpenClaw page walker
 * as an un-swept surface and left it out, which meant the one place the
 * charter had already identified as a gap was the one place the sweep
 * could not have found it. It registers its tools on the OpenClaw plugin
 * api rather than in `buildToolTable`, but the names it registers are the
 * same names the MCP surface publishes, so the real-tool filter admits
 * them and the registry rows they land on are shared.
 */
const MCP_SOURCE_TREE = [...readTree(MCP_ROOT), ...readTree(OPENCLAW_ROOT)];
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
const MCP_TOOL_POPULATION_SIZE = 43;
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

    test("the covered MCP tools are exactly the ones a read root reaches", () => {
      // Written out rather than derived: this list IS the measurement, and
      // a tool joining or leaving it is a finding to name in the release
      // rather than a number to re-take. Before this wave it was two.
      const covered = REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.mcpTool)
        .filter((e) => e.category === VISIBILITY_SURFACE_CATEGORY.covered)
        .map((e) => e.surface)
        .toSorted();
      expect(covered).toEqual([
        "brain_backlinks",
        "brain_bridges",
        "brain_clusters",
        "brain_deep_synthesis",
        "brain_file_context",
        "brain_query",
        "brain_recall_feedback",
        "brain_search",
        "brain_search_expand",
        "second_brain_query",
      ]);
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

    test("the four templated readers are covered and the four whole-vault ones are not", () => {
      // The split is the design, not an oversight: a templated reader is
      // keyed by a caller-supplied id and is therefore root C, while the
      // four whole-vault readers return Brain/active.md, the lessons
      // digest and the status projection - shared artifacts by
      // construction, which no page's reservation covers.
      const byCategory = (category: string): string[] =>
        REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.mcpResource)
          .filter((e) => e.category === category)
          .map((e) => e.surface)
          .toSorted();
      expect(byCategory(VISIBILITY_SURFACE_CATEGORY.covered)).toEqual([
        "osb://backlinks/{id}",
        "osb://log/{date}",
        "osb://preference/{id}",
        "osb://topic/{slug}",
      ]);
      expect(byCategory(VISIBILITY_SURFACE_CATEGORY.excluded)).toEqual([
        "osb://digest/latest",
        "osb://lessons",
        "osb://preferences/active",
        "osb://status",
      ]);
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

    test("the covered CLI verbs are exactly the mirrors of the covered tools", () => {
      // Each of these states its reach at the call site rather than
      // inheriting a default. The verdict is admit-all, because the caller
      // is the operator's own shell - which is a decision these verbs make
      // rather than a question they skip.
      const covered = REGISTRY_BY_KIND(VISIBILITY_SURFACE_KIND.cliVerb)
        .filter((e) => e.category === VISIBILITY_SURFACE_CATEGORY.covered)
        .map((e) => e.surface)
        .toSorted();
      expect(covered).toEqual([
        "brain backlinks",
        "brain clusters",
        "brain deep-synthesis",
        "brain file-context",
        "brain query",
        "search expand",
        "search query",
      ]);
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

  test("a tool registered under a constant declared in the same file is swept in", () => {
    const named: CensusFile = {
      path: "src/mcp/brain/synthetic-const-local.ts",
      text:
        'import { listVaultPages } from "../../core/vault.ts";\n' +
        'const MY_TOOL = "brain_synthetic_local_const";\n' +
        "export const T = [{ name: MY_TOOL, handler: listVaultPages }];\n",
    };
    const population = discoverMcpToolPopulation([named], new Set(["brain_synthetic_local_const"]));
    expect([...population]).toEqual(["brain_synthetic_local_const"]);
  });

  test("a tool registered under a constant IMPORTED from another swept file is swept in", () => {
    // The real shape this blind spot had: `src/mcp/tools.ts` registers
    // `second_brain_capabilities` as `name: CAPABILITY_DIAGNOSTIC_TOOL`,
    // declared in `src/mcp/capabilities.ts`.
    const declaring: CensusFile = {
      path: "src/mcp/synthetic-names.ts",
      text: 'export const REMOTE_TOOL = "brain_synthetic_remote_const";\n',
    };
    const registering: CensusFile = {
      path: "src/mcp/synthetic-registry.ts",
      text:
        'import { listVaultPages } from "../core/vault.ts";\n' +
        'import { REMOTE_TOOL } from "./synthetic-names.ts";\n' +
        "export const T = [{ name: REMOTE_TOOL, handler: listVaultPages }];\n",
    };
    const population = discoverMcpToolPopulation(
      [declaring, registering],
      new Set(["brain_synthetic_remote_const"]),
    );
    expect([...population]).toEqual(["brain_synthetic_remote_const"]);
  });

  test("a constant the file never imports and never declares resolves to nothing", () => {
    // Over-reach is the failure the resolution has to avoid: an unresolved
    // identifier contributes no name rather than a guessed one.
    const dangling: CensusFile = {
      path: "src/mcp/synthetic-dangling.ts",
      text:
        'import { listVaultPages } from "../core/vault.ts";\n' +
        "export const T = [{ name: UNRESOLVED_TOOL, handler: listVaultPages }];\n",
    };
    const population = discoverMcpToolPopulation([dangling], new Set(["brain_search"]));
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

// ─────────────────────────────────────────────────────────────────────────────
// Root closure: is there a fourth root?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A direct filesystem READ. Writes are deliberately absent: this sweep is
 * about what leaves the process, and `write-site-census.test.ts` is the
 * one that watches what enters the vault.
 */
const FS_READ_RE = /\b(readFileSync|readdirSync|createReadStream|opendirSync)\s*\(/;

/**
 * A path built onto a vault root: `join(vault, …)`, `join(ctx.vault, …)`,
 * `join(cfg.vault, …)`, `join(vaultDir, …)`. Read off the lexer's `code`
 * view, so the word appearing inside a string literal or a comment cannot
 * match.
 */
const VAULT_JOIN_RE = /\bjoin\(\s*[A-Za-z_.]*[Vv]ault[A-Za-z_.]*\s*,/;

/** The trees a caller can reach this process through. */
const SURFACE_TREES: ReadonlyArray<string> = Object.freeze([MCP_ROOT, CLI_ROOT, OPENCLAW_ROOT]);

/**
 * Every file in the surface trees that opens a vault path itself rather
 * than going through one of the three read roots.
 *
 * Exported as a function of its input so the fixture below can run the
 * same sweep over a synthetic intruder.
 */
function directVaultReadFiles(files: ReadonlyArray<CensusFile>): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of files) {
    const code = lexedViews(file).code;
    if (FS_READ_RE.test(code) && VAULT_JOIN_RE.test(code)) found.add(file.path);
  }
  return found;
}

const SURFACE_SOURCE_TREE = SURFACE_TREES.flatMap((root) => readTree(root));
const DIRECT_VAULT_READERS = directVaultReadFiles(SURFACE_SOURCE_TREE);

/** Measured: files in the surface trees that read a vault path directly. */
const DIRECT_VAULT_READ_POPULATION_SIZE = 4;

/**
 * ## What this sweep cannot see, stated rather than implied
 *
 * It reads two SHAPES in one file's own text, so it is blind in the same
 * four ways the tool sweep above is, plus two of its own:
 *
 *   - a vault path built without `join` - a template literal, a
 *     `resolve()`, a path threaded in as an already-absolute string from
 *     a caller two modules away - reads as no vault path at all;
 *   - a read performed by a helper in `src/core/` that a surface file
 *     calls. That is not a gap in the guarantee so much as a restatement
 *     of it: `src/core/` is where the three roots live, and a core helper
 *     that reads a vault page without asking them is what the roots exist
 *     to be. It is out of THIS sweep's population and named here so a
 *     reader does not read root closure as more than it is.
 *
 * What it does establish is the claim the boundary actually rests on: no
 * file a caller reaches this process through opens a vault page behind
 * the roots' back without a written reason.
 */
describe("root closure", () => {
  test("every direct vault reader is registered, and every row names one", () => {
    const registered = new Set(DIRECT_VAULT_READ_REGISTRY.map((e) => e.file));
    const unregistered = [...DIRECT_VAULT_READERS].filter((f) => !registered.has(f));
    const stale = [...registered].filter((f) => !DIRECT_VAULT_READERS.has(f));
    expect(unregistered.toSorted()).toEqual([]);
    expect(stale.toSorted()).toEqual([]);
  });

  test("the population is measured, as an equality", () => {
    expect(DIRECT_VAULT_READERS.size).toBe(DIRECT_VAULT_READ_POPULATION_SIZE);
  });

  test("every row carries a closed category and a reason of meaningful length", () => {
    const values = new Set<string>(Object.values(DIRECT_VAULT_READ_CATEGORY));
    const badCategory = DIRECT_VAULT_READ_REGISTRY.filter((e) => !values.has(e.category));
    expect(badCategory).toEqual([]);
    const { thin, lazy } = directReadReasonProblems(DIRECT_VAULT_READ_REGISTRY);
    expect(thin.toSorted().join("\n")).toBe("");
    expect(lazy.toSorted().join("\n")).toBe("");
  });

  test("the guarded reader actually consults the rule at the site of the read", () => {
    // A category is a claim; this is the check that the claim is true of
    // the file it is made about. A row that said `guarded` about a file
    // that never asks would be exactly the decorative classification this
    // census exists to prevent.
    for (const entry of DIRECT_VAULT_READ_REGISTRY) {
      if (entry.category !== DIRECT_VAULT_READ_CATEGORY.guarded) continue;
      const file = SURFACE_SOURCE_TREE.find((f) => f.path === entry.file);
      expect(file, `${entry.file} is registered but not in the swept tree`).toBeDefined();
      expect(lexedViews(file!).code, entry.file).toContain("reachView");
    }
  });

  test("a synthetic file reading a vault path directly is reported", () => {
    const intruder: CensusFile = {
      path: "src/mcp/brain/synthetic-reader.ts",
      text:
        'import { readFileSync } from "node:fs";\n' +
        'import { join } from "node:path";\n' +
        "export function leak(vault: string): string {\n" +
        '  return readFileSync(join(vault, "notes", "secret.md"), "utf8");\n' +
        "}\n",
    };
    expect([...directVaultReadFiles([intruder])]).toEqual([intruder.path]);
    expect(DIRECT_VAULT_READ_REGISTRY.some((e) => e.file === intruder.path)).toBe(false);
  });

  test("a file that only WRITES a vault path is not swept in", () => {
    // The sweep is about what leaves the process. A writer is
    // `write-site-census.test.ts`'s population, not this one.
    const writer: CensusFile = {
      path: "src/cli/synthetic-writer.ts",
      text:
        'import { writeFileSync } from "node:fs";\n' +
        'import { join } from "node:path";\n' +
        "export function put(vault: string, body: string): void {\n" +
        '  writeFileSync(join(vault, "notes", "new.md"), body);\n' +
        "}\n",
    };
    expect([...directVaultReadFiles([writer])]).toEqual([]);
  });
});

function directReadReasonProblems(entries: ReadonlyArray<DirectVaultReadEntry>): {
  thin: string[];
  lazy: string[];
} {
  const thin: string[] = [];
  const lazy: string[] = [];
  for (const e of entries) {
    if (e.reason.trim().length < MIN_REASON_LENGTH) thin.push(`${e.file} (${e.reason.length})`);
    if (LAZY_REASON_RE.test(e.reason)) lazy.push(e.file);
  }
  return { thin, lazy };
}

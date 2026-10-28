/**
 * Census over the content-class egress policy (F5, tasks E3 and E4).
 *
 * ## The defect
 *
 * The reserved `content_class: prompt-derived` stamp marks material an
 * agent produced from a prompt, and the default egress policy leaves such
 * pages out of every shared export. The exclusion is ONE call -
 * `egressContentClassSplit` at the guard seam
 * (`src/core/egress/guard.ts`), or the knowledge pack's block scan, which
 * composes nothing it blocks. A page-carrying export that skips the seam
 * composes agent-produced pages into the payload and lets the redactor
 * scan text the policy says should never have been composed at all: the
 * page leaves unless it happens to carry a credential shape, which is not
 * a policy, it is a coincidence.
 *
 * The same defect the egress census fixed for the guard call
 * (`egress-census.test.ts`), one policy later: wiring the seam into five
 * verbs fixes five verbs, and a declared census is what makes the sixth
 * impossible.
 *
 * ## The population, defined structurally
 *
 * A module is IN POPULATION - a page-carrying shared export - when all
 * three hold:
 *
 * 1. it declares an operator-named output destination (the same
 *    unambiguous flag names the egress census reads);
 * 2. it redacts through the shared guard (`redactForEgress`);
 * 3. it composes vault page material: it imports a composer from the
 *    portability surface or the brain-export modules. The brain-export
 *    arm reads the import's BINDINGS, not just its module path, because
 *    the shared denial notice rides the same module and composes
 *    nothing - see `importsPageComposer`.
 *
 * All three, because each alone over- or under-states: a destination
 * without the guard is the egress census's finding, not this one's; the
 * guard without a composer covers exports whose payload is not pages
 * (the config snapshot, continuity records, preference rows); and a
 * composer without a destination is an in-vault writer, which
 * `write-site-census.test.ts` owns.
 *
 * ## What it does not cover, stated rather than implied
 *
 * - The sharedRedactor sites whose payload is not vault PAGES: the
 *   machine-config snapshot (`config-export`), the continuity export,
 *   the explorer's preference rows, the credential bundle (ciphertext by
 *   construction) and the decision-model routes. None imports a page
 *   composer, so none is in population; the continuity and explorer
 *   decisions are recorded in their registry reasons (commit 887cb142),
 *   and the snapshot carries no vault content at all. The explorer's
 *   static export reads one helper from the brain-export module - the
 *   denial notice it prints beside its reservation omissions (commit
 *   0d00e879) - so the composer rule credits a brain-export import only
 *   when it binds something beyond that notice pair; the rows it
 *   exports never take the prompt-derived stamp, and the registry
 *   reason says so.
 * - A class filter delegated more than ONE hop. The knowledge-pack verb
 *   composes through `selectKnowledgePack`, whose module applies the
 *   filter inside `pageBlockReason`; that is the one named delegation
 *   below, and a chain any longer stops being something a text census
 *   can honestly claim to have checked.
 * - Per-SITE coverage inside a module. Like the guard-call census it
 *   extends, the seam is asserted per declared page-carrying MODULE; two
 *   collections behind one module and one split call still pass as a
 *   pair (the bank bundle's graph nodes and pages are two calls today,
 *   which is how the per-collection shape looks when it is done right).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EGRESS_REDACTION, EGRESS_SITES } from "../../../src/core/egress/registry.ts";
import { lexSource } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Where an operator is told what the class policy does. The census pins
 * the disclosure in the same style the egress census pins the network
 * disclosures: keyed on stable spellings, so an undisclosed surface is a
 * named failure rather than an implication.
 */
const OPERATOR_DOCS: ReadonlyArray<string> = Object.freeze([
  "docs/cli-reference.md",
  "SECURITY.md",
]);

/**
 * The unambiguous destination names, in the parameter-spec shape a CLI
 * flag spec and an MCP `inputSchema` property share. Read off the
 * comment-stripped view: the `"string"` is a literal, and its contents
 * must survive.
 */
const DESTINATION_NAMES: ReadonlyArray<string> = Object.freeze([
  "out",
  "output",
  "outfile",
  "outdir",
  "out-dir",
  "dest",
  "destination",
  "export",
]);

function namedStringParamRe(names: ReadonlyArray<string>): RegExp {
  return new RegExp(
    String.raw`(^|[^A-Za-z0-9_$"'\-])"?(${names.join("|")})"?\s*:\s*\{\s*type\s*:\s*"string"`,
    "m",
  );
}

const DESTINATION_RE = namedStringParamRe(DESTINATION_NAMES);

/**
 * A composer import from the portability surface or the transcript
 * export module. The brain-export module (`src/core/brain/export.ts`)
 * is handled by `importsPageComposer`, which reads the import's
 * bindings before crediting it.
 */
const PORTABILITY_OR_TRANSCRIPTS_IMPORT_RE =
  /from\s*"[^"]*(?:\/portability\/[^"]*|\/brain\/export-transcripts\.ts)"/;

/** One `import { ... } from "<...>/brain/export.ts"` statement. */
const BRAIN_EXPORT_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*"[^"]*\/brain\/export\.ts"/g;

/**
 * The shared denial notice and its row type. They ride the brain-export
 * module but compose nothing: they are the omission report an exporter
 * prints BESIDE the payload. The explorer's static export pulls exactly
 * this pair to name its reservation omissions (commit 0d00e879), so a
 * module-level path match would place a no-composer site in population
 * and demand a class filter the registry already records as removing
 * nothing - preference and retired rows never take the prompt-derived
 * stamp.
 */
const DENIAL_NOTICE_BINDINGS: ReadonlySet<string> = new Set([
  "preferenceDenialNotice",
  "PreferenceDenial",
]);

/**
 * Whether the module imports a page composer. A brain-export import is
 * a composer import only when it binds something beyond the denial
 * notice pair - a text census cannot otherwise tell the exporters'
 * composer imports from the explorer's notice import, because both name
 * the same module.
 */
function importsPageComposer(withoutComments: string): boolean {
  if (PORTABILITY_OR_TRANSCRIPTS_IMPORT_RE.test(withoutComments)) return true;
  for (const match of withoutComments.matchAll(BRAIN_EXPORT_IMPORT_RE)) {
    const bindings = (match[1] ?? "")
      .split(",")
      .map((binding) =>
        binding
          .trim()
          .replace(/^type\s+/, "")
          .trim(),
      )
      .filter((binding) => binding.length > 0);
    if (bindings.some((binding) => !DENIAL_NOTICE_BINDINGS.has(binding))) return true;
  }
  return false;
}

/** The shared egress guard. A module that calls it redacts on the way out. */
const GUARD_RE = /\bredactForEgress\s*\(/;

/** The class-filter seam: the policy runs BEFORE the payload is composed. */
const SEAM_RE = /\b(?:egressContentClassSplit|treeCarriesPromptDerived)\s*\(/;

/**
 * The one named delegation: the pack verb composes through
 * `selectKnowledgePack`, so its filter is the selection step's block
 * scan, not a call in the verb's own text.
 */
const DELEGATED_FILTER_CALL_RE = /\bselectKnowledgePack\s*\(/;
const DELEGATED_FILTER_OWNER = "src/core/brain/portability/knowledge-pack.ts";

/** The seam one delegation away: the selection step's block scan. */
function packSelectionAppliesFilter(text: string): boolean {
  const start = text.search(/^\s*function pageBlockReason\b/m);
  if (start < 0) return false;
  const end = text.indexOf("\n}\n", start);
  const body = text.slice(start, end < 0 ? undefined : end);
  return /\breadContentClass\s*\(/.test(body);
}

interface CensusFile {
  readonly path: string;
  readonly text: string;
}

/** Every `.ts` file under `src/`, as repo-relative POSIX path + text. */
function readSourceTree(): ReadonlyArray<CensusFile> {
  const glob = new Bun.Glob("src/**/*.ts");
  const files: CensusFile[] = [];
  for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
    const path = rel.split("\\").join("/");
    files.push({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** True when the module is a page-carrying shared export (all three rules). */
function isPageCarryingRedactor(text: string): boolean {
  const views = lexSource(text);
  return (
    DESTINATION_RE.test(views.withoutComments) &&
    GUARD_RE.test(views.code) &&
    importsPageComposer(views.withoutComments)
  );
}

/**
 * The census over whatever tree it is handed: the page-carrying shared
 * exports that do NOT apply the class filter, in their own text or one
 * named delegation away. Taking the tree as an argument is what lets the
 * synthetic controls below fail - a real verb with its seam removed is
 * fed back through the same rule the live tree runs under.
 */
function classFilterCensus(files: ReadonlyArray<CensusFile>): ReadonlyArray<string> {
  const seamOwners = new Map<string, boolean>(
    files.map((f) => [f.path, SEAM_RE.test(lexSource(f.text).code)] as const),
  );
  const out: string[] = [];
  for (const file of files) {
    const views = lexSource(file.text);
    if (
      !DESTINATION_RE.test(views.withoutComments) ||
      !GUARD_RE.test(views.code) ||
      !importsPageComposer(views.withoutComments)
    ) {
      continue;
    }
    if (SEAM_RE.test(views.code)) continue;
    const delegated =
      DELEGATED_FILTER_CALL_RE.test(views.code) &&
      (seamOwners.get(DELEGATED_FILTER_OWNER) === true ||
        packSelectionAppliesFilter(
          files.find((f) => f.path === DELEGATED_FILTER_OWNER)?.text ?? "",
        ));
    if (!delegated) out.push(file.path);
  }
  return out;
}

const SOURCE_TREE = readSourceTree();
const POPULATION: ReadonlyArray<string> = SOURCE_TREE.filter((f) =>
  isPageCarryingRedactor(f.text),
).map((f) => f.path);

/**
 * The page-carrying shared exports, named. "Carries pages" is a property
 * of what a verb is FOR, not of its syntax, so the structural rule above
 * is checked against this list as an equality in both directions: a new
 * page-carrying export fails until it is named here, and a renamed or
 * retired one fails until the list follows it.
 */
const PAGE_CARRYING_SITES: ReadonlyArray<string> = Object.freeze([
  "src/cli/brain/verbs/bank-export.ts",
  "src/cli/brain/verbs/export.ts",
  "src/cli/brain/verbs/graph-export.ts",
  "src/cli/brain/verbs/knowledge-pack.ts",
  "src/cli/brain/verbs/okf-export.ts",
]);

const ENTRIES = Object.values(EGRESS_SITES);

describe("content-class egress census", () => {
  test("the derived population is the named page-carrying sites, as an equality", () => {
    expect([...POPULATION].toSorted()).toEqual([...PAGE_CARRYING_SITES].toSorted());
  });

  test("every page-carrying site is a declared sharedRedactor egress entry", () => {
    // The class filter extends the guard policy, so a module that filters
    // but is not declared as redacting would understate what it does -
    // the exact lie the egress census's own complement rule exists for.
    const undeclared = PAGE_CARRYING_SITES.filter(
      (path) =>
        !ENTRIES.some(
          (entry) => entry.module === path && entry.redaction === EGRESS_REDACTION.sharedRedactor,
        ),
    );
    expect(undeclared).toEqual([]);
  });

  // The census scans the whole source tree; it measured 2.0-4.5 s on main
  // and brushes the 5 s default on slower runners as the tree grows, so it
  // carries its own budget instead of riding the default.
  test("every page-carrying site applies the class filter", () => {
    expect(classFilterCensus(SOURCE_TREE)).toEqual([]);
  }, 20000);

  test("the pack verb's delegated filter is really there", () => {
    // The one hop the census credits. If the selection step's block scan
    // lost the class check, this fails by name AND the verb fails the
    // census above - the delegation is only as good as the delegate.
    const text = readFileSync(join(REPO_ROOT, DELEGATED_FILTER_OWNER), "utf8");
    expect(packSelectionAppliesFilter(text)).toBe(true);
    // The block list names the class beside the operator-set scopes.
    expect(text).toContain('| "prompt-derived";');
  });

  test("the named-omission sites document their class decision in the registry", () => {
    // The sharedRedactor entries that carry no page composer are out of
    // population by the structural rule, so the census cannot see them -
    // what pins them is the decision record: the registry reason says
    // what the site does about the class, in so many words. The
    // machine-config snapshot carries no vault content at all, so E3
    // wrote no class sentence for it and none is pinned here.
    const decisions: ReadonlyArray<readonly [string, string]> = Object.freeze([
      ["brain-continuity-export", "src/cli/brain/verbs/continuity.ts"],
      ["brain-explorer-export", "src/cli/brain/verbs/explorer.ts"],
    ]);
    for (const [id, module] of decisions) {
      const entry = ENTRIES.find((e) => e.id === id);
      expect(`${id}: ${entry !== undefined && entry.module === module}`).toBe(`${id}: true`);
      expect(`${id}: ${/\bcontent[-_]class\b|\bprompt-derived\b/.test(entry?.reason ?? "")}`).toBe(
        `${id}: true`,
      );
    }
  });
});

describe("the content-class census cannot pass by finding nothing", () => {
  test("the population is measured, not empty", () => {
    expect(POPULATION.length).toBeGreaterThanOrEqual(5);
  });

  test("a synthetic redacting page-carrying module without the filter is reported by name", () => {
    const intruder: CensusFile = {
      path: "src/cli/brain/verbs/synthetic-class-blind-export.ts",
      text:
        'import { exportBundle } from "../../../core/brain/portability/okf.ts";\n' +
        'import { redactForEgress } from "../../../core/egress/guard.ts";\n' +
        'const flags = parse(argv, { out: { type: "string" } });\n' +
        '  const verdict = redactForEgress("synthetic-class-blind-export", bundle);\n',
    };
    // The intruder is IN population (the detector sees it), and the
    // census names it - a blinded detector or a vacuous census shows here.
    expect(isPageCarryingRedactor(intruder.text)).toBe(true);
    expect(classFilterCensus([...SOURCE_TREE, intruder])).toContain(intruder.path);
  }, 20000);

  test("removing the seam from a real verb is reported by name", () => {
    for (const path of [
      "src/cli/brain/verbs/bank-export.ts",
      "src/cli/brain/verbs/okf-export.ts",
    ]) {
      const stripped = readFileSync(join(REPO_ROOT, path), "utf8").replace(
        /\begressContentClassSplit\s*\(/g,
        "partitionByClass(",
      );
      expect(SEAM_RE.test(lexSource(stripped).code)).toBe(false);
      const tree = SOURCE_TREE.map((f) => (f.path === path ? { path, text: stripped } : f));
      expect(classFilterCensus(tree)).toContain(path);
    }
  }, 20000);

  test("removing the transcript naming from `brain export` is reported by name", () => {
    // The transcript branch's duty is refuse-or-name, never silently
    // empty; its seam is the tree tripwire, so losing it is the same
    // finding as losing a split call.
    const path = "src/cli/brain/verbs/export.ts";
    const stripped = readFileSync(join(REPO_ROOT, path), "utf8").replace(
      /\btreeCarriesPromptDerived\s*\(/g,
      "treeHasPromptMark(",
    );
    expect(SEAM_RE.test(lexSource(stripped).code)).toBe(false);
    const tree = SOURCE_TREE.map((f) => (f.path === path ? { path, text: stripped } : f));
    expect(classFilterCensus(tree)).toContain(path);
  });

  test("removing the delegated filter fails the pack verb by name", () => {
    const path = DELEGATED_FILTER_OWNER;
    const stripped = readFileSync(join(REPO_ROOT, path), "utf8").replace(
      /if \(readContentClass\(page\.frontmatter\) !== null\) return "prompt-derived";/,
      "return null;",
    );
    expect(packSelectionAppliesFilter(stripped)).toBe(false);
    const tree = SOURCE_TREE.map((f) => (f.path === path ? { path, text: stripped } : f));
    expect(classFilterCensus(tree)).toContain("src/cli/brain/verbs/knowledge-pack.ts");
  });

  test("a redacting destination without a page composer is not in population", () => {
    // The continuity export: guard call, destination flag, no composer
    // import - its class decision lives in the registry, not in a filter.
    const text = readFileSync(join(REPO_ROOT, "src/cli/brain/verbs/continuity.ts"), "utf8");
    expect(isPageCarryingRedactor(text)).toBe(false);
  });

  test("the explorer's brain-export imports bind only the denial notice", () => {
    // The one module whose composer verdict turns on import BINDINGS
    // rather than the module path. If a composer binding ever joins the
    // explorer's brain-export import, the explorer becomes a
    // page-carrying shared export: the equality test above fails until
    // it is named and filtered, and this pin is the signpost naming
    // which import moved.
    const text = readFileSync(join(REPO_ROOT, "src/cli/brain/verbs/explorer.ts"), "utf8");
    const views = lexSource(text);
    const imports = [...views.withoutComments.matchAll(BRAIN_EXPORT_IMPORT_RE)].map((m) =>
      (m[1] ?? "")
        .split(",")
        .map((binding) =>
          binding
            .trim()
            .replace(/^type\s+/, "")
            .trim(),
        )
        .filter((binding) => binding.length > 0),
    );
    expect(imports.length).toBeGreaterThanOrEqual(1);
    for (const bindings of imports) {
      expect(bindings.every((binding) => DENIAL_NOTICE_BINDINGS.has(binding))).toBe(true);
    }
    expect(isPageCarryingRedactor(text)).toBe(false);
  });
});

describe("the class policy is disclosed where an operator reads", () => {
  // The registry reasons and the guard's stderr notices are source and
  // runtime surfaces. An operator deciding whether to hand an export to
  // someone else reads the CLI reference and the security policy, so the
  // default exclusion, the per-verb override and the era boundary must
  // appear there. Keyed on the stable spellings, the way the egress
  // census keys its network disclosures on the entry id: a disclosure
  // that stops naming the surface is a named failure here, and a new
  // export surface is undisclosed until someone writes it down.
  for (const doc of OPERATOR_DOCS) {
    test(`${doc} discloses the default, the override and the era`, () => {
      const text = readFileSync(join(REPO_ROOT, doc), "utf8");
      // The default-excluded class, named as the field and as the value.
      expect(text).toContain("content_class");
      expect(text).toContain("prompt-derived");
      // The per-verb operator override, spelled as the flag it is.
      expect(text).toContain("--include-prompt-derived");
      // The era boundary: absence of the mark is documented rather than
      // migrated, and a pre-stamp page keeps exporting.
      expect(text).toMatch(/pre-stamp era/);
      expect(text).toMatch(/never\s+rewritten|nothing\s+rewrites/);
    });
  }
});

/**
 * Architecture docs generator (Project History Suite, t_929da8a2).
 *
 * Renders scanProject facts into vault notes under
 * `Brain/projects/arch/<repo-key>/`: one overview, one key-decisions
 * note, and one note per detected module, all generated content inside
 * sentinel regions. Regeneration goes through mergeRegions, so operator
 * prose outside regions survives byte-for-byte, and an unchanged project
 * regenerates byte-identically (the scanner is deterministic and the
 * renderer adds no timestamps).
 *
 * DECLARED EXCEPTIONS - three of them, and no others. The first two are
 * exceptions to the byte-identity guarantee, each scoped to its own
 * region: every other region, and every byte of operator prose, still
 * regenerates identically, and each carries the whole provenance of what
 * it was stamped from, so a stale stamp describes its own reading rather
 * than passing for a current one. The third is an exception to the
 * write-once frontmatter rule below.
 *
 *   - the overview's `codegraph` region states the codegraph partner's
 *     verdict, which is a fact about the machine and the partner index,
 *     not about the project tree; an index built, deleted, or gone stale
 *     moves those bytes while the repository stands still. Stamped with
 *     state, counts and health;
 *   - the key-decisions note lists the repo's ADR candidates, which the
 *     commit miner writes into the VAULT; mining new commits moves those
 *     bytes with no change to the repository at all. Stamped with each
 *     candidate's sha and matched signals;
 *   - a module note's `depends_on` frontmatter key is GENERATOR-OWNED and
 *     rewritten on every run: the modules this module's manifests declare
 *     a dependency on, as a YAML block list of quoted wikilinks, sorted,
 *     and absent when there is none. It lives in frontmatter because a
 *     frontmatter field named after a relation is the one way a typed
 *     edge enters the search index; a region cannot carry one. The
 *     generator touches exactly that key and no other, and overwrites
 *     whatever an operator typed under it. It does not break byte
 *     identity: an unchanged project renders the same key, and the merge
 *     then returns the note's bytes untouched.
 *
 * The overview's `module-map` diagram is NOT an exception: it renders the
 * same scanned facts as every other region and moves only when the tree
 * does. Neither are the `dependencies` and `module-dependencies` regions:
 * they render manifest facts, which are files in the tree.
 *
 * Frontmatter is written ONCE at file creation and never rewritten -
 * it carries static identity (kind, repo key, path), while every fact
 * that can change between scans lives inside a region. The one exception
 * is the generator-owned `depends_on` key above.
 *
 * Module REMOVAL keeps the old module note on disk (the operator may
 * have annotated it); the overview's module region reflects only the
 * current scan, so stale notes become unlinked rather than deleted.
 *
 * One run is one critical section: every note is planned, then written,
 * with the sync lock held across both. Planning before writing is what
 * makes a corrupted-sentinel abort - and an elapsed deadline - leave NO
 * half-refreshed prefix on disk, and the lock is what stops two runs on
 * the same repo from reading the same "before" state and erasing each
 * other's merge.
 *
 * Planning does NOT cover a failure of the writing itself. Planning
 * removes the error class that arises while DECIDING a note's bytes; an
 * ENOSPC, EACCES or EIO on the k-th of N notes arises while placing them,
 * and leaves k-1 refreshed beside the rest. No filesystem swaps N files
 * into place at once, so that state is reachable and cannot be rolled
 * back. What makes it survivable is that the loop is idempotent - every
 * note's bytes are a function of the scanned facts plus the prose already
 * outside its regions - so a re-run repairs any prefix. What makes it
 * actionable is {@link ArchWriteError}, which names the note that failed
 * and how far the run got.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { summarizeGraphHealth } from "../../partner/codegraph-health.ts";
import { buildCodegraphReport } from "../../partner/codegraph-report.ts";
import type { CodegraphReport, CodegraphReportOptions } from "../../partner/codegraph-report.ts";
import { repoKey as deriveRepoKey } from "../git/identity.ts";
import { OPERATION, progressCounter, progressReasonForError } from "../progress.ts";
import type { ProgressCounter, ProgressSink } from "../progress.ts";
import { buildRegionDocument, mergeRegions } from "../regions.ts";
import type { Region } from "../regions.ts";
import type { Safeguard } from "../safeguard.ts";
import { acquireLockSyncWithRetry, LOCK_WAIT_INTERACTIVE_MS } from "../sync-lockfile.ts";
import { DEPENDENCY_MANIFESTS } from "../../project-manifests.ts";
import type { ManifestEcosystem } from "../../project-manifests.ts";
import { listRepoDecisionCandidates } from "./decisions.ts";
import type { DecisionCandidateFact } from "./decisions.ts";
import { compareCodePoints, MANIFEST_STATUS, oneLine } from "./manifests.ts";
import type { DependencyGroup, ManifestReading } from "./manifests.ts";
import {
  ARCHITECT_STAGE,
  compareStable,
  manifestIdentity,
  moduleManifestIdentities,
  scanProject,
} from "./scan.ts";
import type { ModuleDependency, ModuleFact, ProjectFacts } from "./scan.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

export interface GenerateArchDocsOptions {
  /** Where a caller watches the run. Absence means nobody asked. */
  readonly onProgress?: ProgressSink;
  /**
   * Cooperative deadline, checked per directory read while scanning and
   * per note while planning - never between two writes.
   */
  readonly safeguard?: Safeguard;
  /**
   * How the run learns the codegraph partner's verdict. Defaults to the
   * real {@link buildCodegraphReport}.
   *
   * A seam rather than a setting: nothing in the product produces a
   * different reader, but the verdict is the one input to this module
   * that is neither the project tree nor the vault, so a test of the
   * region cannot construct it by arranging files.
   */
  readonly codegraphReport?: (options: CodegraphReportOptions) => CodegraphReport;
}

export interface GenerateArchDocsResult {
  readonly repoKey: string;
  readonly dir: string;
  readonly overviewPath: string;
  /** The key-decisions note, one per repo, beside the overview. */
  readonly decisionsPath: string;
  readonly modulePaths: ReadonlyArray<string>;
  /**
   * Every dependency manifest the scan found, root and modules, with its
   * status, sorted by path. A scan fact like `modulePaths`: it goes out
   * on the CLI's JSON envelope, where a manifest that was not read is the
   * operator's to fix.
   */
  readonly manifests: ReadonlyArray<ManifestReading>;
  /**
   * What this run did to the notes: how many it wrote for the first time,
   * how many it rewrote, and how many it found already correct. They sum
   * to `2 + modulePaths.length` - the overview, the key-decisions note,
   * and one per module - and go out on the CLI's JSON envelope.
   *
   * Each one is the verdict of a READ - `planNote` compares what is on
   * disk against what the facts say - so the three are only true of the
   * disk if that read and the write that follows it are one critical
   * section. They are consequently what a concurrent run can falsify:
   * two runs whose reads both preceded either write both report having
   * created the same note. That is the property
   * `architect-concurrent-runs.test.ts` holds down.
   */
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /**
   * The message of the first failure of the caller's progress sink, or
   * `null` when there was none (and when no sink was supplied).
   *
   * An observer must not be able to destroy what it observes - a closed
   * pipe cannot be allowed to abort a generation that is otherwise
   * succeeding - but it must not vanish either, so the fault is carried
   * out on the result the caller already reads and the sink is detached
   * for the rest of the run. Only the first is reported: after it there
   * is no attached sink left to fail again.
   */
  readonly progressFault: string | null;
}

/**
 * Extensions by descending file count, ties broken in codepoint order.
 * One definition: the summary line and the diagram's dominant-language
 * label must agree about which language leads a module.
 */
function sortedLanguages(
  languages: Readonly<Record<string, number>>,
): ReadonlyArray<readonly [string, number]> {
  return Object.entries(languages).toSorted(
    (a, b) => b[1] - a[1] || compareStable(a[0], b[0]),
  ) as ReadonlyArray<readonly [string, number]>;
}

function languagesLine(languages: Readonly<Record<string, number>>): string {
  const entries = sortedLanguages(languages);
  if (entries.length === 0) return "none detected";
  return entries
    .slice(0, LANGUAGES_LINE_CAP)
    .map(([ext, count]) => `${oneLine(ext)} (${count})`)
    .join(", ");
}

/** How many extensions the summary line names before it stops. */
const LANGUAGES_LINE_CAP = 8;

/**
 * The two verdicts the codegraph region can state, in the words an
 * operator reads. `graph-present` means a structural index exists for
 * this tree; `graph-absent, lexical-only` means everything in these notes
 * came from the deterministic file scan and nothing from a code graph.
 * Both are values, never errors - the partner report already settled that
 * (`partner/codegraph-report.ts`).
 */
const GRAPH_VERDICT = Object.freeze({
  present: "graph-present",
  absent: "graph-absent, lexical-only",
} as const);

/** How the region names a partner CLI that is not on PATH. */
const NO_PARTNER_CLI = "not on PATH";

/**
 * The codegraph verdict, as the region body an operator reads.
 *
 * Every one of the five {@link CodegraphReport} index states renders
 * distinctly. The four non-`indexed` states share the `graph-absent`
 * verdict but keep their own name and their own reason, because their
 * remediations differ and one of them is actively wrong for the others:
 * `not_indexed` asks for `codegraph init`, which is the last thing to run
 * at a partner that timed out (`error`).
 *
 * The body is also the provenance stamp for the declared byte-identity
 * exception in this module's docblock - state, counts and health are all
 * in it, so a region left behind by an index that has since changed
 * describes the reading it was made from.
 */
function codegraphRegionBody(report: CodegraphReport): string {
  const index = report.index;
  const head = [
    `Project: ${report.project ?? "none in scope"}`,
    `Partner CLI: ${report.cli.path ?? NO_PARTNER_CLI}`,
  ];
  if (index.state !== "indexed") {
    return [
      `${GRAPH_VERDICT.absent}: this overview rests on the file scan alone`,
      `State: ${index.state}`,
      ...head,
      `Reason: ${index.reason ?? "none reported"}`,
    ].join("\n");
  }
  const health = index.health;
  return [
    `${GRAPH_VERDICT.present}: codegraph holds an index for this project`,
    `State: ${index.state}`,
    ...head,
    `Nodes: ${index.node_count ?? 0}`,
    `Files: ${index.file_count ?? 0}`,
    `Edges: ${index.edge_count ?? 0}`,
    `Health: ${health === undefined ? "not assessed" : summarizeGraphHealth(health)}`,
    ...(health?.warnings ?? []).map((warning) => `- ${warning.code}: ${warning.message}`),
  ].join("\n");
}

/**
 * Escape a name that came from a DIRECTORY for a quoted Mermaid label.
 *
 * Mermaid's own escape mechanism is the `#nnn;`/`#name;` entity, so `#`
 * is rewritten FIRST - doing it last would rewrite the escapes this
 * function just produced. `<` and `>` matter because flowchart labels
 * render as HTML by default, so an unescaped angle bracket in a directory
 * name is markup, and `"` would end the label early.
 *
 * Line breaks are folded to a space rather than escaped: a directory name
 * may legally contain one, and `<br/>` is the label's own field
 * separator here. A backtick becomes its entity too, so a run of three
 * cannot close the Markdown fence the diagram sits in.
 */
function mermaidLabel(text: string): string {
  return text
    .replaceAll("#", "#35;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;")
    .replaceAll("`", "#96;")
    .replaceAll(/[\r\n]+/g, " ");
}

/** What a module node says when nothing in it carries an extension. */
const NO_LANGUAGE = "no language detected";

/**
 * The module containment diagram, as a Mermaid flowchart.
 *
 * CONTAINMENT ONLY, and the region says so in prose above the block. The
 * scanner records no import graph at all (`scan.ts`: "Import-graph
 * analysis is explicitly out of scope"), so every edge here runs from the
 * project root to a module it contains; a module-to-module edge would be
 * a relation nothing measured. The edges manifests DECLARE between modules
 * render in their own `module-dependencies` region, under their own claim,
 * so this diagram's claim stays true.
 *
 * Node ids are positional (`mod0`, `mod1`, ...), never derived from the
 * module name. A directory name is arbitrary bytes and a Mermaid node id
 * is an identifier, so deriving one from the other needs a mangling that
 * must also stay collision-free - an index needs neither.
 */
function moduleMapBody(facts: ProjectFacts): string {
  const modules = modulesByName(facts);
  const lines = [
    "Containment only: the scan records no import edges, so this diagram claims none.",
    "",
    "```mermaid",
    "graph TD",
    `  root["${mermaidLabel(facts.name)}<br/>${modules.length} module(s)"]`,
  ];
  for (const [index, module] of modules.entries()) {
    const language = sortedLanguages(module.languages)[0]?.[0] ?? NO_LANGUAGE;
    lines.push(
      `  root --> mod${index}["${mermaidLabel(module.name)}<br/>` +
        `${module.files} file(s)<br/>${mermaidLabel(language)}"]`,
    );
  }
  lines.push("```");
  return lines.join("\n");
}

/** Ecosystems in the manifest precedence order, each once. */
const ECOSYSTEM_ORDER: ReadonlyArray<ManifestEcosystem> = Object.freeze([
  ...new Set(DEPENDENCY_MANIFESTS.map((spec) => spec.ecosystem)),
]);

/** What the overview's `dependencies` region says when the tree has no manifest. */
const NO_MANIFEST = "No dependency manifest found.";

/** What a module note's `dependencies` region says when the module has no manifest. */
const NO_MODULE_MANIFEST = "No dependency manifest in this module.";

/** What an ecosystem's runtime list says when its read manifests declare nothing. */
const NO_RUNTIME_DEPENDENCY = "none declared";

/**
 * The claim the `module-dependencies` region makes, above its diagram.
 * The edges are DECLARED, not measured: the scan reads manifests and no
 * import graph, so the sentence names where every edge came from.
 */
const MODULE_DEPENDENCIES_CLAIM =
  "Declared by manifests, not measured from imports: an edge means the module's " +
  "manifest names exactly one other module's manifest as a runtime dependency.";

/** What the `module-dependencies` region says when no module declares an edge. */
const NO_MODULE_DEPENDENCY =
  "No module's manifest names exactly one other module's manifest as a runtime dependency.";

/** What a module note says when its module declares no edge. */
const NO_DEPENDS_ON = "Depends on: no other module";

/** One manifest line: its path, ecosystem, status and, when it has one, the detail. */
function manifestLine(reading: ManifestReading): string {
  const detail = reading.detail === undefined ? "" : ` - ${oneLine(reading.detail)}`;
  return `- ${codeSpanPath(reading.path)} (${reading.ecosystem}): ${reading.status}${detail}`;
}

/** The groups a manifest counts but does not list, summed per group, zero counts omitted. */
function groupCountsLine(
  ecosystem: string,
  readings: ReadonlyArray<ManifestReading>,
): string | null {
  const totals = new Map<DependencyGroup, number>();
  for (const reading of readings) {
    for (const { group, count } of reading.otherGroups) {
      totals.set(group, (totals.get(group) ?? 0) + count);
    }
  }
  if (totals.size === 0) return null;
  const parts = [...totals.entries()]
    .toSorted((a, b) => compareStable(a[0], b[0]))
    .map(([group, count]) => `${group} ${count}`);
  return `Not listed (${ecosystem}): ${parts.join(", ")}`;
}

/**
 * The manifest list and, per ecosystem with a read manifest, its runtime
 * dependencies and the count line for the groups not listed. `exclude`
 * holds the canonical names, per ecosystem, that are left out of the
 * runtime lists (a module's own manifest name, on the overview).
 */
function dependencySections(
  readings: ReadonlyArray<ManifestReading>,
  exclude: ReadonlySet<string>,
): string {
  const sections = [["Manifests:", ...readings.map(manifestLine)].join("\n")];
  for (const ecosystem of ECOSYSTEM_ORDER) {
    const read = readings.filter(
      (reading) => reading.ecosystem === ecosystem && reading.status === MANIFEST_STATUS.read,
    );
    if (read.length === 0) continue;
    const names = [...new Set(read.flatMap((reading) => reading.fact?.dependencies ?? []))]
      .filter((name) => !exclude.has(manifestIdentity(ecosystem, name)))
      .toSorted(compareCodePoints);
    const runtime =
      names.length === 0
        ? `Runtime dependencies (${ecosystem}): ${NO_RUNTIME_DEPENDENCY}`
        : [`Runtime dependencies (${ecosystem}):`, ...names.map((name) => `- ${name}`)].join("\n");
    const counts = groupCountsLine(ecosystem, read);
    sections.push(counts === null ? runtime : `${runtime}\n\n${counts}`);
  }
  return sections.join("\n\n");
}

/**
 * The overview's `dependencies` region: every manifest the scan found,
 * root and modules, with its status; the runtime dependencies per
 * ecosystem with the names that bind to exactly one module left out
 * (those are modules, drawn in `module-dependencies`); one count line per
 * ecosystem for the rest.
 */
function dependenciesBody(facts: ProjectFacts): string {
  if (facts.manifests.length === 0) return NO_MANIFEST;
  return dependencySections(facts.manifests, moduleManifestIdentities(facts.modules));
}

/** The modules in the order both diagrams number them. */
function modulesByName(facts: ProjectFacts): ReadonlyArray<ModuleFact> {
  return facts.modules.toSorted((a, b) => compareStable(a.name, b.name));
}

/**
 * The declared module edges, as a Mermaid flowchart under its claim.
 * Node ids are the same positional ids `module-map` uses, so one module
 * is one id across both diagrams.
 */
function moduleDependenciesBody(facts: ProjectFacts): string {
  const edges = linkableEdges(facts);
  if (edges.length === 0) return NO_MODULE_DEPENDENCY;
  const ids = new Map(modulesByName(facts).map((module, index) => [module.name, `mod${index}`]));
  const node = (name: string): string => `${ids.get(name)}["${mermaidLabel(name)}"]`;
  return [
    MODULE_DEPENDENCIES_CLAIM,
    "",
    "```mermaid",
    "graph LR",
    ...edges.map((edge) => `  ${node(edge.from)} --> ${node(edge.to)}`),
    "```",
  ].join("\n");
}

/**
 * A module name a wikilink cannot carry: a control character (C0, DEL or
 * C1) breaks the line or the note's YAML, `[`, `]` and `|` end the link or its alias early, and `#` and `^`
 * turn the target into a heading or block reference.
 */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const UNLINKABLE_MODULE_NAME = /[\u0000-\u001f\u007f-\u009f[\]|#^]/;

function isLinkable(name: string): boolean {
  return !UNLINKABLE_MODULE_NAME.test(name);
}

/** What the overview's module list says before the modules it cannot link. */
const UNLINKABLE_MODULES_LEAD = "Not linked (the name holds a character a link cannot carry):";

/** A path on one line inside a code span, with no backtick to end the span. */
function codeSpanPath(path: string): string {
  return `\`${oneLine(path).replaceAll("`", "\\u0060")}\``;
}

/** A name on one line inside a code span: JSON escapes, and no backtick to end the span. */
function codeSpanName(name: string): string {
  return `\`${JSON.stringify(name).replaceAll("`", "\\u0060")}\``;
}

/** The declared edges between modules a link can name; an edge touching any other is left out. */
function linkableEdges(facts: ProjectFacts): ReadonlyArray<ModuleDependency> {
  return facts.moduleDependencies.filter((edge) => isLinkable(edge.from) && isLinkable(edge.to));
}

/** The wikilink to one module's note, as the overview's module list writes it. */
function moduleLink(key: string, name: string): string {
  return `[[Brain/projects/arch/${key}/modules/${name}|${name}]]`;
}

/**
 * The frontmatter key the generator owns on module notes. Named after the
 * relation it produces, because the indexer turns a frontmatter field
 * named after a known relation into typed links of that relation.
 */
export const DEPENDS_ON_KEY = "depends_on";

/** The fence that opens and closes a note's frontmatter. */
const FRONTMATTER_FENCE = "---";

/** A YAML double-quoted scalar: backslash and quote are the two characters it escapes. */
function yamlQuoted(text: string): string {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(CONTROL_CHARACTER, (c) => YAML_ESCAPES.get(c) ?? yamlHexEscape(c));
  return `"${escaped}"`;
}

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g;
/** The short escapes YAML's double-quoted style defines for the common controls. */
const YAML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\n", "\\n"],
  ["\t", "\\t"],
  ["\r", "\\r"],
]);

function yamlHexEscape(c: string): string {
  return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

/** A name as a plain YAML scalar when it is one, else double-quoted. */
const PLAIN_YAML_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function yamlName(name: string): string {
  return PLAIN_YAML_NAME.test(name) ? name : yamlQuoted(name);
}

/** The `depends_on` key as frontmatter lines, or no lines when the module has no edge. */
function dependsOnLines(key: string, targets: ReadonlyArray<string>): ReadonlyArray<string> {
  if (targets.length === 0) return [];
  return [
    `${DEPENDS_ON_KEY}:`,
    ...targets.map((name) => `  - ${yamlQuoted(moduleLink(key, name))}`),
  ];
}

/** A note whose frontmatter opens and never closes; the generator will not guess where it ends. */
export class ArchFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchFrontmatterError";
  }
}

/** A line without the `\r` a CRLF note leaves on it. */
function bare(line: string): string {
  return line.replace(/\r$/, "");
}

/**
 * Rewrite one generator-owned frontmatter key, leaving every other byte
 * of `text` as it was.
 *
 * The key's extent is its own line plus every following line that is
 * indented or a block-list item, which is how YAML continues a value.
 * Rendered `lines` replace that extent in place, or are appended before
 * the closing fence when the key is absent; no lines remove it. A note
 * without frontmatter gets one only when there is something to write. A
 * frontmatter block that opens and never closes is refused by name
 * rather than edited, as the region engine refuses broken sentinels.
 * A CRLF note keeps CRLF on the lines written into it.
 */
function replaceGeneratorOwnedKey(text: string, key: string, lines: ReadonlyArray<string>): string {
  const all = text.split("\n");
  if (bare(all[0] ?? "") !== FRONTMATTER_FENCE) {
    if (lines.length === 0) return text;
    return [FRONTMATTER_FENCE, ...lines, FRONTMATTER_FENCE, text].join("\n");
  }
  const close = all.findIndex((line, index) => index > 0 && bare(line) === FRONTMATTER_FENCE);
  if (close < 0) {
    throw new ArchFrontmatterError(
      `frontmatter opens with "${FRONTMATTER_FENCE}" and never closes - ` +
        `the "${key}" key cannot be rewritten safely`,
    );
  }
  const eol = all[close]!.endsWith("\r") ? "\r" : "";
  const rendered = lines.map((line) => `${line}${eol}`);
  const keyLine = new RegExp(`^${key}\\s*:`);
  const start = all.findIndex((line, index) => index > 0 && index < close && keyLine.test(line));
  if (start < 0) {
    all.splice(close, 0, ...rendered);
    return all.join("\n");
  }
  let end = start + 1;
  // Indentation or a list item continues the value; a blank line, `\r`
  // alone on a CRLF note included, ends it and is left where it is.
  while (end < close && /^(?:[ \t]|-)/.test(all[end]!)) end += 1;
  all.splice(start, end - start, ...rendered);
  return all.join("\n");
}

/** One generator-owned frontmatter key and the lines it renders to. */
interface OwnedKey {
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
}

/** The modules `module` declares a dependency on that a link can name, sorted. */
function dependsOn(facts: ProjectFacts, module: ModuleFact): ReadonlyArray<string> {
  return linkableEdges(facts)
    .filter((edge) => edge.from === module.name)
    .map((edge) => edge.to);
}

/** A module note's `dependencies` region: its manifests and the modules it depends on. */
function moduleDependenciesRegionBody(
  key: string,
  module: ModuleFact,
  targets: ReadonlyArray<string>,
): string {
  if (module.manifests.length === 0) return NO_MODULE_MANIFEST;
  const edges =
    targets.length === 0
      ? NO_DEPENDS_ON
      : ["Depends on:", ...targets.map((name) => `- ${moduleLink(key, name)}`)].join("\n");
  return `${dependencySections(module.manifests, new Set())}\n\n${edges}`;
}

function overviewRegions(
  facts: ProjectFacts,
  key: string,
  codegraph: CodegraphReport,
): ReadonlyArray<Region> {
  const summary = [
    `Project: ${oneLine(facts.name)}`,
    ...(facts.manifest?.version != null ? [`Version: ${oneLine(facts.manifest.version)}`] : []),
    ...(facts.manifest?.description != null
      ? [`Description: ${oneLine(facts.manifest.description)}`]
      : []),
    `Files: ${facts.totalFiles}`,
    `Languages: ${languagesLine(facts.languages)}`,
    ...(facts.testLayout !== null ? [`Test layout: ${facts.testLayout}/`] : []),
  ].join("\n");

  const unlinkable = facts.modules.filter((module) => !isLinkable(module.name));
  const modules = [
    ...facts.modules
      .filter((module) => isLinkable(module.name))
      .map(
        (module) =>
          `- ${moduleLink(key, module.name)} (${oneLine(module.path)}, ${module.files} file(s))`,
      ),
    ...(unlinkable.length === 0
      ? []
      : [
          `${UNLINKABLE_MODULES_LEAD} ${unlinkable.map((module) => codeSpanName(module.name)).join(", ")}`,
        ]),
  ].join("\n");

  const entryPoints =
    facts.entryPoints.length === 0
      ? "none detected"
      : facts.entryPoints.map((entry) => `- ${codeSpanPath(entry)}`).join("\n");

  return [
    { id: "summary", body: summary },
    { id: "modules", body: modules },
    { id: "module-map", body: moduleMapBody(facts) },
    { id: "entry-points", body: entryPoints },
    { id: "dependencies", body: dependenciesBody(facts) },
    { id: "module-dependencies", body: moduleDependenciesBody(facts) },
    { id: "codegraph", body: codegraphRegionBody(codegraph) },
  ];
}

/** What the key-decisions note says when the repo has no candidates. */
const NO_DECISION_CANDIDATES = "No decision candidates recorded for this repository.";

/** What one entry says instead of a sha the candidate never recorded. */
const NO_CANDIDATE_SHA = "sha unrecorded";

/** What one entry says instead of the signals a candidate never recorded. */
const NO_CANDIDATE_SIGNALS = "no signals recorded";

/**
 * Keep a wikilink's display text from ending the link early.
 *
 * The text is a commit subject by way of the candidate's heading, so it
 * can hold anything a committer typed. `|` would open a second alias
 * field and `]]` would close the link mid-title; both are folded to
 * characters that read the same way in prose and mean nothing here.
 */
function wikilinkText(text: string): string {
  return text.replaceAll("|", "/").replaceAll("]", ")");
}

/**
 * The repo's ADR candidates, one entry each: title, sha, matched signals.
 *
 * The empty case is an explicit sentence rather than an empty region. A
 * blank region is indistinguishable from a generator that failed to run,
 * and "this repository has no mined decisions yet" is a real answer that
 * points at `o2b brain git mine`.
 */
function decisionsRegionBody(candidates: ReadonlyArray<DecisionCandidateFact>): string {
  if (candidates.length === 0) return NO_DECISION_CANDIDATES;
  return candidates
    .map((candidate) => {
      const signals =
        candidate.signals.length === 0
          ? NO_CANDIDATE_SIGNALS
          : `signals: ${candidate.signals.join(", ")}`;
      const sha = candidate.sha === null ? NO_CANDIDATE_SHA : `sha \`${candidate.sha}\``;
      return `- [[${candidate.link}|${wikilinkText(candidate.title)}]] (${sha}, ${signals})`;
    })
    .join("\n");
}

function moduleRegions(
  key: string,
  module: ModuleFact,
  targets: ReadonlyArray<string>,
): ReadonlyArray<Region> {
  const facts = [
    `Path: ${oneLine(module.path)}`,
    `Files: ${module.files}`,
    `Languages: ${languagesLine(module.languages)}`,
  ].join("\n");
  const files =
    module.topFiles.length === 0
      ? "empty module"
      : module.topFiles.map((file) => `- ${codeSpanPath(file)}`).join("\n");
  return [
    { id: "facts", body: facts },
    { id: "files", body: files },
    { id: "dependencies", body: moduleDependenciesRegionBody(key, module, targets) },
  ];
}

function frontmatter(kind: string, key: string, extra: ReadonlyArray<string>): string {
  return ["---", `kind: ${kind}`, `repo_key: ${key}`, ...extra, "---", ""].join("\n");
}

/** What one note's regeneration turned out to be. */
const NOTE_DISPOSITION = Object.freeze({
  created: "created",
  updated: "updated",
  unchanged: "unchanged",
} as const);

type NoteDisposition = (typeof NOTE_DISPOSITION)[keyof typeof NOTE_DISPOSITION];

/** One note's decided bytes, before any of them are on disk. */
interface PlannedNote {
  readonly path: string;
  /** The bytes to write, or `null` when the note is already correct. */
  readonly text: string | null;
  readonly disposition: NoteDisposition;
}

/**
 * Decide one region-bearing note's bytes WITHOUT writing them.
 *
 * Planning is separated from writing so that a `RegionError` - the
 * fail-closed verdict on corrupted sentinels - aborts the run before its
 * first byte instead of after the notes that happened to come earlier.
 * The prefix left on disk used to be a deterministic function of module
 * order, which made it predictable but no less wrong: an operator asked
 * to repair one note found the rest of the tree already half-refreshed.
 */
function planNote(
  path: string,
  head: string,
  regions: ReadonlyArray<Region>,
  owned?: OwnedKey,
): PlannedNote {
  if (!existsSync(path)) {
    return {
      path,
      text: `${head}\n${buildRegionDocument(regions)}`,
      disposition: NOTE_DISPOSITION.created,
    };
  }
  const existing = readFileSync(path, "utf8");
  const regionsMerged = mergeRegions(existing, regions);
  let merged = regionsMerged;
  if (owned !== undefined) {
    try {
      merged = replaceGeneratorOwnedKey(regionsMerged, owned.key, owned.lines);
    } catch (error) {
      if (error instanceof ArchFrontmatterError) {
        throw new ArchFrontmatterError(`${path}: ${error.message}`);
      }
      throw error;
    }
  }
  if (merged === existing) return { path, text: null, disposition: NOTE_DISPOSITION.unchanged };
  return { path, text: merged, disposition: NOTE_DISPOSITION.updated };
}

/**
 * A note could not be written, part-way through the write loop.
 *
 * The notes before it are already renamed into place and the notes after
 * it still hold their previous bytes. `rename(2)` is atomic per file and
 * nothing swaps N files at once, so this partial state is reachable and
 * cannot be undone by the loop that produced it. It is repairable, not
 * recoverable in place: one run is a pure function of the scanned facts
 * plus the prose outside each note's regions, so re-running once the
 * cause is fixed rewrites every note, the untouched suffix included.
 *
 * The counts are the reason this type exists. The native errno names a
 * temp file the caller never asked for - `atomicWriteFileSync` writes a
 * sibling and renames it - and says nothing about how much of the tree
 * already moved, which is the one fact an operator needs to know a
 * re-run is not optional.
 */
export class ArchWriteError extends Error {
  /** The note whose write failed. */
  readonly path: string;
  /** Notes whose new bytes are already on disk. */
  readonly written: number;
  /** Notes still holding their previous bytes, this one included. */
  readonly pending: number;

  constructor(path: string, written: number, pending: number, cause: unknown) {
    super(
      `failed to write architecture note ${path} after refreshing ` +
        `${written} of ${written + pending} note(s): ${errorMessage(cause)} - ` +
        "the tree is partially refreshed; fix the cause and re-run, which " +
        "rewrites every note and preserves prose outside the regions",
      { cause },
    );
    this.name = "ArchWriteError";
    this.path = path;
    this.written = written;
    this.pending = pending;
  }
}

/** How many of `plans` ended in `disposition`. */
function countOf(plans: ReadonlyArray<PlannedNote>, disposition: NoteDisposition): number {
  return plans.filter((plan) => plan.disposition === disposition).length;
}

/** Where one module's note lives. One definition, two call sites. */
function modulePath(dir: string, module: ModuleFact): string {
  return join(dir, "modules", `${module.name}.md`);
}

/** Where the key-decisions note lives. Beside the overview, one per repo. */
function decisionsPath(dir: string): string {
  return join(dir, "decisions.md");
}

/**
 * Plan every note, then write them - in that order, and never
 * interleaved.
 *
 * The deadline is checked while PLANNING only. A run that stops at a
 * checkpoint has therefore written nothing at all, and the write loop -
 * the cheap part, 7.9 ms of a 396 ms run on this repository - is allowed
 * to finish rather than being interrupted between two notes.
 *
 * A write that FAILS is the case a deadline policy cannot reach. The loop
 * cannot un-rename the notes already placed, so it reports how far it got
 * instead of implying it got nowhere: see {@link ArchWriteError}.
 */
function renderNotes(
  dir: string,
  key: string,
  facts: ProjectFacts,
  codegraph: CodegraphReport,
  candidates: ReadonlyArray<DecisionCandidateFact>,
  opts: GenerateArchDocsOptions,
  progress: ProgressCounter,
): ReadonlyArray<PlannedNote> {
  const plans: PlannedNote[] = [];
  opts.safeguard?.checkpoint();
  plans.push(
    planNote(
      join(dir, "overview.md"),
      frontmatter("arch-overview", key, [`repo_path: ${facts.root}`]),
      overviewRegions(facts, key, codegraph),
    ),
  );
  opts.safeguard?.checkpoint();
  plans.push(
    planNote(decisionsPath(dir), frontmatter("arch-decisions", key, [`repo_path: ${facts.root}`]), [
      { id: "decisions", body: decisionsRegionBody(candidates) },
    ]),
  );
  for (const module of facts.modules) {
    opts.safeguard?.checkpoint();
    const targets = dependsOn(facts, module);
    const owned = { key: DEPENDS_ON_KEY, lines: dependsOnLines(key, targets) };
    plans.push(
      planNote(
        modulePath(dir, module),
        frontmatter("arch-module", key, [`module: ${yamlName(module.name)}`, ...owned.lines]),
        moduleRegions(key, module, targets),
        owned,
      ),
    );
  }

  const toWrite = plans.filter((plan) => plan.text !== null).length;
  let written = 0;
  for (const plan of plans) {
    if (plan.text !== null) {
      try {
        atomicWriteFileSync(plan.path, plan.text);
      } catch (error) {
        throw new ArchWriteError(plan.path, written, toWrite - written, error);
      }
      written += 1;
    }
    // A note is complete when its bytes are on disk, or when they were
    // already the right bytes - so an unchanged note advances too.
    progress.advance(ARCHITECT_STAGE.render);
  }
  return plans;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a caller's sink so one broken stream cannot abort the run, and
 * report the first failure exactly once.
 *
 * `progressCounter` already refuses to let a throwing sink escape when it
 * is given a reporter - but a run spans TWO counters here, the scan's and
 * the renderer's, and a fault reported per counter would tell the caller
 * twice about one closed pipe. Detaching happens here, once, for the
 * whole run.
 */
function guardedSink(
  sink: ProgressSink | undefined,
  onFault: (message: string) => void,
): ProgressSink | undefined {
  if (sink === undefined) return undefined;
  let live = true;
  return (event) => {
    if (!live) return;
    try {
      sink(event);
    } catch (error) {
      live = false;
      onFault(errorMessage(error));
    }
  };
}

/** Generate or refresh architecture notes for one project tree. */
export function generateArchDocs(
  vault: string,
  projectRoot: string,
  opts: GenerateArchDocsOptions = {},
): GenerateArchDocsResult {
  const progressFaults: string[] = [];
  const sink = guardedSink(opts.onProgress, (message) => progressFaults.push(message));
  const progress = progressCounter(OPERATION.architect, sink);
  try {
    return generateRun(vault, projectRoot, opts, sink, progress, progressFaults);
  } catch (error) {
    // A stop the operator asked for, or a deadline that elapsed, is a
    // fact about the run - reported on the stream before the error
    // travels on. Anything else is a failure, and a failure is its own
    // report.
    const reason = progressReasonForError(error);
    if (reason !== null) progress.stop(reason);
    throw error;
  }
}

function generateRun(
  vault: string,
  projectRoot: string,
  opts: GenerateArchDocsOptions,
  sink: ProgressSink | undefined,
  progress: ProgressCounter,
  progressFaults: ReadonlyArray<string>,
): GenerateArchDocsResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // The scan opens the `walk` stage on its own counter over the same
  // sink; this counter opens `render` and is the one that terminates.
  const facts = scanProject(projectRoot, {
    ...(sink === undefined ? {} : { onProgress: sink }),
    ...(opts.safeguard === undefined ? {} : { safeguard: opts.safeguard }),
  });
  const key = deriveRepoKey(facts.root);

  // The partner verdict, read BEFORE the lock: it touches neither the
  // vault nor this repo's notes, so holding the critical section across
  // it would only lengthen the window another architect run waits on.
  //
  // `limit: 1` scopes the question to the project this overview is about.
  // `findCodeProjects` otherwise widens to the vault parent's siblings and
  // would answer about whichever of them it reached first - a verdict for
  // a different repository, stamped into this repository's overview. A
  // project root that is not a code project (no `.git`, no manifest) is
  // then reported as `no_project`, which is exactly true of it.
  const readReport = opts.codegraphReport ?? buildCodegraphReport;
  const codegraph = readReport({ cwd: facts.root, vault, limit: 1 });

  const dir = join(vault, "Brain", "projects", "arch", key);
  mkdirSync(join(dir, "modules"), { recursive: true });

  // Every note's path is a function of the FACTS, not of the order the
  // writes happen to complete in - `module_paths` is a documented part of
  // the CLI's JSON envelope, and it must not become a schedule report.
  const overviewPath = join(dir, "overview.md");
  const modulePaths = facts.modules.map((module) => modulePath(dir, module));

  // The repo's slice of the vault-global candidate store, read outside
  // the lock for the same reason the partner verdict is: it is a read of
  // `Brain/decisions/`, which this run never writes.
  const candidates = listRepoDecisionCandidates(vault, key);

  // The note count is known only now, and it is known exactly: the
  // overview, the key-decisions note, and one note per detected module.
  // Unlike the walk, this stage has a denominator.
  progress.start(ARCHITECT_STAGE.render, 2 + facts.modules.length);

  // One critical section over every note, held across the reads AND the
  // writes. Atomicity is not exclusivity: a whole file is renamed into
  // place, so no reader sees torn bytes, yet two architect runs on the
  // same repo would still read the same "before" state and erase each
  // other's merge. Every other Brain read-modify-write takes this lock;
  // this one did not. It cannot stop an operator editing a note in the
  // same millisecond - nothing here can - but that race was never the
  // one the module could do something about.
  //
  // What the race costs is worth naming exactly, because the answer is
  // not torn bytes and a byte comparison will therefore never find it.
  // One run's output is a pure function of the facts plus the prose
  // outside each region, so two runs on one repo compute the same bytes
  // and whichever writes last leaves the same file either way. The loss
  // lands in the REPORT: each run planned from a state the other had
  // already replaced, so both tell the operator they created notes only
  // one of them created. `architect-concurrent-runs.test.ts` is the
  // discriminating test, and the tally is its instrument.
  //
  // The INTERACTIVE budget, not the default. Waiting on this lock is a
  // synchronous freeze of the whole process, and this process has a
  // progress stream and an operator's Ctrl-C behind it. The default is
  // sized for the ingest fan-out, where several processes contend by
  // design and the waiter is a short-lived worker with nothing else to
  // run; a second architect run over the same repo is not that workload.
  // One second absorbs a genuine brief overlap and refuses the rest by
  // name, rather than parking a watched terminal for five.
  const handle = acquireLockSyncWithRetry(dir, LOCK_WAIT_INTERACTIVE_MS);
  let plans: ReadonlyArray<PlannedNote>;
  try {
    plans = renderNotes(dir, key, facts, codegraph, candidates, opts, progress);
  } finally {
    handle.release();
  }
  progress.finish();

  return Object.freeze({
    repoKey: key,
    dir,
    overviewPath,
    decisionsPath: decisionsPath(dir),
    modulePaths: Object.freeze(modulePaths),
    manifests: facts.manifests,
    created: countOf(plans, NOTE_DISPOSITION.created),
    updated: countOf(plans, NOTE_DISPOSITION.updated),
    unchanged: countOf(plans, NOTE_DISPOSITION.unchanged),
    progressFault: progressFaults[0] ?? null,
  });
}

/**
 * The architect overview's codegraph verdict region
 * (salience-lifecycle-enrichment, unit 5 / t_3a418d07).
 *
 * Claims pinned here:
 *  1. An `indexed` partner report renders a `graph-present` line carrying
 *     the node, file and edge counts plus the health verdict.
 *  2. Each of the four non-indexed states renders `graph-absent,
 *     lexical-only` and names its OWN state and reason - the four are not
 *     collapsed into one "no graph" sentence, because their remediations
 *     differ (`codegraph init` is the wrong advice for `error`).
 *  3. Health warnings are listed by code, so a present-but-unhealthy
 *     graph cannot be read as a clean one.
 *  4. The region body is a self-describing provenance stamp: state,
 *     counts and health are all in it, so a stale region says what it was
 *     stamped from.
 *  5. Operator prose outside the regions survives a regeneration that
 *     moves the verdict - the declared byte-identity exception is scoped
 *     to the region, not to the note.
 *  6. A fixed report renders byte-identically on re-run.
 *  7. The region draws on the EXISTING partner report only: the generator
 *     asks for the project it is documenting (one candidate, no wider
 *     scan) and adds no partner CLI vocabulary of its own.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../../src/core/brain/architect/generate.ts";
import type {
  CodegraphReport,
  CodegraphReportOptions,
} from "../../../src/core/partner/codegraph-report.ts";

let tmp: string;
let project: string;
let vault: string;

const CLI_PATH = "/usr/local/bin/codegraph";

function reportWith(index: CodegraphReport["index"], cliPath: string | null = CLI_PATH) {
  return (): CodegraphReport => ({
    schema_version: 1,
    project: "/repos/demo-app",
    cli: { available: cliPath !== null, path: cliPath },
    index,
    cargo_workspace: null,
    cargo_workspace_reason: "no Cargo.toml in project root (not a Rust project)",
  });
}

/** The overview text produced with `report` as the partner verdict. */
function overviewWith(report: () => CodegraphReport, into = vault): string {
  const res = generateArchDocs(into, project, { codegraphReport: report });
  return readFileSync(res.overviewPath, "utf8");
}

/** The body of one sentinel region, without its sentinel lines. */
function regionBody(text: string, id: string): string {
  const begin = `<!-- o2b:begin ${id} -->\n`;
  const end = `\n<!-- o2b:end ${id} -->`;
  const from = text.indexOf(begin);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return text.slice(from + begin.length, to);
}

function freshVault(name: string): string {
  const made = join(tmp, name);
  mkdirSync(join(made, "Brain"), { recursive: true });
  return made;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-architect-codegraph-"));
  project = join(tmp, "demo-app");
  mkdirSync(join(project, "src", "core"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo-app" }));
  writeFileSync(join(project, "src", "core", "engine.ts"), "// x\n");
  vault = freshVault("vault");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("an indexed partner report stamps graph-present with counts and health", () => {
  const body = regionBody(
    overviewWith(
      reportWith({
        state: "indexed",
        node_count: 1240,
        file_count: 210,
        edge_count: 5680,
        health: { ok: true, warnings: [] },
      }),
    ),
    "codegraph",
  );

  expect(body).toContain("graph-present");
  expect(body).not.toContain("graph-absent");
  expect(body).toContain("State: indexed");
  expect(body).toContain("Nodes: 1240");
  expect(body).toContain("Files: 210");
  expect(body).toContain("Edges: 5680");
  expect(body).toContain("Health: ok");
  expect(body).toContain(CLI_PATH);
});

test("an unhealthy but present graph names every finding by code", () => {
  const body = regionBody(
    overviewWith(
      reportWith({
        state: "indexed",
        node_count: 12,
        file_count: 3,
        edge_count: 0,
        health: {
          ok: false,
          warnings: [
            { code: "collapsed-edges", message: "graph has 12 node(s) but 0 edges" },
            { code: "self-loops", message: "1 self-loop edge(s)" },
          ],
        },
      }),
    ),
    "codegraph",
  );

  expect(body).toContain("graph-present");
  expect(body).toContain("Health: 2 warning(s) [collapsed-edges, self-loops]");
  expect(body).toContain("- collapsed-edges: graph has 12 node(s) but 0 edges");
  expect(body).toContain("- self-loops: 1 self-loop edge(s)");
});

/**
 * The four states that are NOT a graph. Each keeps its own name and its
 * own reason: `not_indexed` sends the operator to `codegraph init`,
 * `error` deliberately must not.
 */
const ABSENT_STATES = [
  { state: "no_project", reason: "no code project in scope" },
  { state: "absent", reason: "codegraph CLI not on PATH (optional partner)" },
  { state: "not_indexed", reason: "run: codegraph init /repos/demo-app" },
  { state: "error", reason: "codegraph status did not answer within 5000ms and was stopped" },
] as const;

for (const { state, reason } of ABSENT_STATES) {
  test(`the ${state} state renders graph-absent and names itself`, () => {
    const body = regionBody(
      overviewWith(reportWith({ state, reason }, state === "absent" ? null : CLI_PATH)),
      "codegraph",
    );

    expect(body).toContain("graph-absent, lexical-only");
    expect(body).not.toContain("graph-present");
    expect(body).toContain(`State: ${state}`);
    expect(body).toContain(`Reason: ${reason}`);
  });
}

test("the four absent states render four distinct bodies", () => {
  const bodies = ABSENT_STATES.map(({ state, reason }) =>
    regionBody(
      overviewWith(reportWith({ state, reason }), freshVault(`vault-${state}`)),
      "codegraph",
    ),
  );
  expect(new Set(bodies).size).toBe(ABSENT_STATES.length);
});

test("operator prose outside the regions survives a moving verdict", () => {
  const indexed = reportWith({
    state: "indexed",
    node_count: 5,
    file_count: 2,
    edge_count: 7,
    health: { ok: true, warnings: [] },
  });
  const first = generateArchDocs(vault, project, { codegraphReport: indexed });
  const prose = "\nOperator: the graph verdict is advisory, the scan is not.\n";
  writeFileSync(first.overviewPath, readFileSync(first.overviewPath, "utf8") + prose);

  const second = generateArchDocs(vault, project, {
    codegraphReport: reportWith({ state: "absent", reason: "partner uninstalled" }, null),
  });
  const after = readFileSync(second.overviewPath, "utf8");

  expect(after).toContain("Operator: the graph verdict is advisory, the scan is not.");
  expect(after).toContain("graph-absent, lexical-only");
  expect(second.updated).toBe(1);
  // Only the verdict region moved: every other region is byte-identical.
  const before = readFileSync(first.overviewPath, "utf8");
  for (const id of ["summary", "modules", "entry-points", "dependencies"]) {
    expect(regionBody(after, id)).toBe(regionBody(before, id));
  }
});

test("a fixed report regenerates the overview byte-identically", () => {
  const report = reportWith({
    state: "indexed",
    node_count: 5,
    file_count: 2,
    edge_count: 7,
    health: { ok: true, warnings: [] },
  });
  const first = generateArchDocs(vault, project, { codegraphReport: report });
  const before = readFileSync(first.overviewPath, "utf8");
  const second = generateArchDocs(vault, project, { codegraphReport: report });

  expect(readFileSync(second.overviewPath, "utf8")).toBe(before);
  expect(second.created).toBe(0);
  expect(second.updated).toBe(0);
});

test("the verdict is asked for the documented project, with no wider scan", () => {
  const asked: CodegraphReportOptions[] = [];
  generateArchDocs(vault, project, {
    codegraphReport: (options) => {
      asked.push(options);
      return reportWith({ state: "no_project", reason: "no code project in scope" })();
    },
  });

  expect(asked).toHaveLength(1);
  expect(asked[0]!.cwd).toBe(project);
  expect(asked[0]!.vault).toBe(vault);
  // One candidate directory inspected: the project this overview is about.
  expect(asked[0]!.limit).toBe(1);
});

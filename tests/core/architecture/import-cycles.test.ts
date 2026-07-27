/**
 * Acyclic Dependencies Principle ratchet over `src/`.
 *
 * A cycle in the module graph is not a style problem: it makes the
 * initialisation order of the members undefined, so a class or constant
 * that one member evaluates at module scope can be observed as
 * `undefined` depending only on which file the bundler happened to enter
 * first. Both cycles this repository carried were of exactly that shape -
 * an aggregate module that DEFINED an error class and a result row while
 * also naming leaf types from its own dependents, and a path-builder
 * module that imported the write guard which imported the builder's
 * constants.
 *
 * The fix in both cases was a leaf module that imports nothing from the
 * layer above it. That property is invisible in review - re-adding one
 * import to a leaf silently closes the loop again - so it is asserted
 * here instead.
 *
 * Static `import` / `export … from` declarations only, which is the
 * edge set the file-level graph is built from. Two deliberate readings
 * of that boundary, both asserted below so neither can rot into a
 * comment that outlives the code:
 *
 * `import type … from "…"` IS an edge, even though the emitted module
 * has none. The stricter line is the useful one here: the `type` keyword
 * is one word, dropping it is invisible in review, and the moment it goes
 * the erased edge becomes a real initialisation-order edge. A ratchet
 * that only fails after that word is removed fails one commit too late.
 *
 * A deferred `await import("…")` is NOT an edge. It is evaluated at call
 * time, when both modules have finished initialising, so it cannot
 * produce the `undefined`-at-module-scope failure this test exists to
 * prevent - and it is the sanctioned cure for a cycle, used exactly that
 * way in this tree. Counting it would report the cure as the disease.
 * An `import("…")` in a type position pulls in no module either.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const SRC = resolve(ROOT, "src");

/**
 * `import …` / `export … from "<relative>"`, anchored at the start of a
 * line so a specifier quoted inside a docblock or a string literal is
 * not mistaken for a declaration. The body may span lines (formatted
 * multi-name imports) but never a `;`, which terminates the statement.
 */
const FROM_RE = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*"(\.[^"]+)"/gm;
/** Side-effect import: `import "./x.ts";`. */
const BARE_RE = /^[ \t]*import\s*"(\.[^"]+)"/gm;
/** The same declarations minus the `type` ones, for the assertion below. */
const VALUE_FROM_RE = /^[ \t]*(?:import|export)\b(?!\s+type\b)[^;]*?\bfrom\s*"(\.[^"]+)"/gm;
/** The `export … from` half of {@link FROM_RE}, floored on its own below. */
const REEXPORT_RE = /^[ \t]*export\b[^;]*?\bfrom\s*"(\.[^"]+)"/gm;
/**
 * A deferred `await import("…")`, anywhere in the file. Not part of the
 * graph - the assertion below is what keeps that a decision.
 */
const DEFERRED_RE = /\bawait\s+import\s*\(\s*"(\.[^"]+)"\s*\)/g;

/** The declaration kinds the initialisation-order graph is built from. */
const STATIC_PATTERNS: ReadonlyArray<RegExp> = [FROM_RE, BARE_RE];

interface ModuleGraph {
  readonly files: ReadonlyArray<string>;
  readonly edges: ReadonlyMap<string, ReadonlyArray<string>>;
}

function moduleFiles(): ReadonlyArray<string> {
  return [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: true })].toSorted();
}

function importedFiles(
  file: string,
  known: ReadonlySet<string>,
  patterns: ReadonlyArray<RegExp>,
): ReadonlyArray<string> {
  const text = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const re of patterns) {
    for (const match of text.matchAll(new RegExp(re))) {
      const target = resolve(dirname(file), match[1]!);
      // Non-module relative imports (`../../package.json`) are data, not
      // graph edges, and are dropped by the known-file check.
      if (known.has(target)) out.add(target);
    }
  }
  return [...out];
}

function moduleGraph(patterns: ReadonlyArray<RegExp> = STATIC_PATTERNS): ModuleGraph {
  const files = moduleFiles();
  const known = new Set(files);
  const edges = new Map<string, ReadonlyArray<string>>();
  for (const file of files) edges.set(file, importedFiles(file, known, patterns));
  return { files, edges };
}

const edgeCount = (graph: ModuleGraph): number =>
  [...graph.edges.values()].reduce((total, targets) => total + targets.length, 0);

/** Edges `subset` has and `graph` does not, as readable `a -> b` pairs. */
function missingEdges(graph: ModuleGraph, subset: ModuleGraph): ReadonlyArray<string> {
  const out: string[] = [];
  for (const [file, targets] of subset.edges) {
    const present = new Set(graph.edges.get(file) ?? []);
    for (const target of targets) {
      if (!present.has(target)) out.push(`${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
    }
  }
  return out.toSorted();
}

/**
 * Every strongly connected component with more than one member, as
 * repo-relative paths. Tarjan's algorithm, iterative so a deep import
 * chain cannot overflow the stack.
 */
function importCycles(graph: ModuleGraph = moduleGraph()): ReadonlyArray<ReadonlyArray<string>> {
  const { files, edges } = graph;

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of files) {
    if (index.has(root)) continue;
    // (node, next edge to visit) frames; a frame is revisited after each
    // child returns so the child's lowlink can be folded in.
    const frames: Array<{ node: string; edge: number }> = [{ node: root, edge: 0 }];
    index.set(root, counter);
    lowlink.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = edges.get(frame.node)!;
      if (frame.edge < targets.length) {
        const target = targets[frame.edge]!;
        frame.edge++;
        if (!index.has(target)) {
          index.set(target, counter);
          lowlink.set(target, counter);
          counter++;
          stack.push(target);
          onStack.add(target);
          frames.push({ node: target, edge: 0 });
        } else if (onStack.has(target)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(target)!));
        }
        continue;
      }

      frames.pop();
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(relative(ROOT, member));
          if (member === frame.node) break;
        }
        if (component.length > 1) components.push(component.toSorted());
      }
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!));
      }
    }
  }
  return components;
}

/**
 * Floors under the measurement, so "no cycle" cannot be reported over a
 * graph that was never built. `src/` carried 889 modules and 3808 edges
 * when these were set; each floor below is placed where a specific way of
 * losing the input crosses it, not at a round number.
 *
 * 850 modules is under today's count by less than the smallest layer
 * under `src/` holds (`src/mcp`, 54 modules), so a moved source root
 * (zero) or a glob that stopped seeing a whole layer trips it.
 *
 * 3400 edges is under that count by more than the two narrow halves of
 * the declaration pattern contribute together, and by less than any layer
 * carries (`src/mcp` alone accounts for 516), so it catches the quote
 * style changing under every pattern at once - which takes the graph to
 * zero edges over a full module list - and the layer loss above.
 *
 * The total is dominated by `import … from`: the other two declaration
 * kinds are 224 and 37 edges, small enough that either could stop being
 * matched without the total crossing 3400. So each is measured on its own
 * pattern, floored at 180 and 25, and required to be PRESENT in the graph
 * the search ran over - which is what fails if the shared pattern loses
 * one of its halves. The side-effect kind earns that assertion beyond
 * symmetry: a module imported only for its registration side effect is
 * imported by nothing else, which is exactly where an
 * initialisation-order cycle hides.
 *
 * The last floor is under the erased edges themselves: 489 edges come
 * from a declaration carrying the `type` keyword, and 400 is the line
 * under which "type-only imports are edges too" would have stopped
 * describing a graph anyone can see.
 */
const MIN_MODULES = 850;
const MIN_EDGES = 3400;
const MIN_REEXPORT_EDGES = 180;
const MIN_SIDE_EFFECT_EDGES = 25;
const MIN_ERASED_EDGES = 400;

describe("module graph", () => {
  test("src/ carries no import cycle", () => {
    expect(importCycles()).toEqual([]);
  });

  test("the search is not vacuous - it ran over the real graph", () => {
    const graph = moduleGraph();
    expect(graph.files.length).toBeGreaterThan(MIN_MODULES);
    expect(edgeCount(graph)).toBeGreaterThan(MIN_EDGES);
    for (const [pattern, floor] of [
      [REEXPORT_RE, MIN_REEXPORT_EDGES],
      [BARE_RE, MIN_SIDE_EFFECT_EDGES],
    ] as const) {
      const half = moduleGraph([pattern]);
      expect(edgeCount(half)).toBeGreaterThan(floor);
      // Named, not counted: a declaration kind the graph stopped seeing
      // fails here listing the edges it lost.
      expect(missingEdges(graph, half).join("\n")).toBe("");
    }
  });

  test("a type-only import is an edge, so dropping the keyword cannot close a loop", () => {
    // The stricter reading the docblock claims, measured: the erased
    // declarations are a large minority of the graph, so a `type` keyword
    // is never what stands between the tree and a cycle.
    const strict = edgeCount(moduleGraph());
    const valuesOnly = edgeCount(moduleGraph([VALUE_FROM_RE, BARE_RE]));
    expect(valuesOnly).toBeLessThan(strict);
    expect(strict - valuesOnly).toBeGreaterThan(MIN_ERASED_EDGES);
  });

  test("a deferred import is left out because it is the cure, not the disease", () => {
    // Deferred imports exist in this tree precisely to break the loops
    // this test forbids. Counting them would report those cures as
    // findings, so the exclusion is asserted rather than assumed.
    const deferred = moduleGraph([...STATIC_PATTERNS, DEFERRED_RE]);
    expect(edgeCount(deferred)).toBeGreaterThan(edgeCount(moduleGraph()));
    expect(importCycles(deferred)).not.toEqual([]);
  });
});

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
 * edge set the file-level graph is built from. A `typeof import("…")`
 * inside a type position pulls in no module at runtime and is not an
 * initialisation-order edge.
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

function moduleFiles(): ReadonlyArray<string> {
  return [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: true })].sort();
}

function importedFiles(file: string, known: ReadonlySet<string>): ReadonlyArray<string> {
  const text = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const re of [FROM_RE, BARE_RE]) {
    for (const match of text.matchAll(new RegExp(re))) {
      const target = resolve(dirname(file), match[1]!);
      // Non-module relative imports (`../../package.json`) are data, not
      // graph edges, and are dropped by the known-file check.
      if (known.has(target)) out.add(target);
    }
  }
  return [...out];
}

/**
 * Every strongly connected component with more than one member, as
 * repo-relative paths. Tarjan's algorithm, iterative so a deep import
 * chain cannot overflow the stack.
 */
function importCycles(): ReadonlyArray<ReadonlyArray<string>> {
  const files = moduleFiles();
  const known = new Set(files);
  const edges = new Map<string, ReadonlyArray<string>>();
  for (const file of files) edges.set(file, importedFiles(file, known));

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
      if (lowlink.get(frame.node)! === index.get(frame.node)!) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(relative(ROOT, member));
          if (member === frame.node) break;
        }
        if (component.length > 1) components.push(component.sort());
      }
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!));
      }
    }
  }
  return components;
}

describe("module graph", () => {
  test("src/ carries no import cycle", () => {
    expect(importCycles()).toEqual([]);
  });
});

/**
 * Census over the long operations, and what they say while they run.
 *
 * The previous release's whole argument was that a mechanism which must
 * be called by hand is a mechanism that will be missed, and that the
 * answer is declaration plus a census. This is that census for the
 * progress spine, built on the same syntactic technique the write-site
 * and destructive-site censuses use: enumerate the population from the
 * source rather than from a hand-kept list, and fail when a member
 * appears without a declaration.
 *
 * The population is defined by the repository's own statement of what is
 * long: an options interface that accepts `safeguard?: Safeguard` is an
 * interface for an operation someone already judged worth guarding with a
 * deadline, and an operation worth a deadline is an operation worth
 * reporting on. So the rule is: **an interface that takes a safeguard
 * takes a progress sink, or carries a written reason why it cannot.**
 *
 * Two further rules keep the stream honest rather than merely present:
 *
 *   - every `stage:` literal handed to the counter is an IDENTIFIER, not
 *     prose. The event shape cannot enforce this in the type system, so
 *     it is enforced here - the same reason the advisory rail refuses
 *     caller-supplied sentences rather than documenting that it would
 *     prefer not to receive them.
 *   - the sink type is synchronous. Four of the five operations are
 *     synchronous functions and cannot await one; a `Promise`-returning
 *     sink would compile and then silently drop every event's completion.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..", "..", "src");

/** Directories with no operation code in them. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/**
 * The spine itself. It DEFINES the counter rather than emitting stages,
 * so its interpolated error messages are not stage identifiers and
 * scanning it would report the mechanism as a violation of its own rule.
 */
const SPINE_MODULE = "core/brain/progress.ts";

/**
 * Interfaces that take a safeguard and deliberately take no sink.
 *
 * A written reason per entry, on the pattern the write-site census uses:
 * an exemption a reader cannot reconstruct is indistinguishable from an
 * oversight. Keep this list short; an entry here is a claim that the
 * operation genuinely has nothing to report, not that wiring it was
 * inconvenient.
 */
const DECLARED_EXEMPTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // Deliberately empty. Every operation that carries a deadline today
  // also carries a sink, including the ones that only FORWARD both to a
  // pass they wrap - forwarding is cheaper than an exemption and leaves
  // no reader wondering why one staged run is silent.
]);

/** Every `.ts` file under `src/`, in a stable order. */
function sourceFiles(dir: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

interface InterfaceBlock {
  readonly name: string;
  readonly file: string;
  readonly body: string;
}

/**
 * Every `interface X { ... }` block in `source`, matched by brace depth.
 *
 * A regex alone cannot find the closing brace of a block that contains
 * nested object types, and this census would silently under-report if it
 * stopped at the first `}`.
 */
function interfaceBlocks(source: string, file: string): ReadonlyArray<InterfaceBlock> {
  const out: InterfaceBlock[] = [];
  const header = /(?:export\s+)?interface\s+(\w+)[^{]*\{/g;
  let match = header.exec(source);
  while (match !== null) {
    const open = match.index + match[0].length;
    let depth = 1;
    let i = open;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    out.push({ name: match[1] ?? "", file, body: source.slice(open, i - 1) });
    match = header.exec(source);
  }
  return out;
}

const FILES = sourceFiles(SRC_ROOT);
const REPO_RELATIVE = (file: string): string => relative(SRC_ROOT, file).split(sep).join("/");

describe("progress census", () => {
  test("every options interface that takes a safeguard takes a progress sink", () => {
    const missing: string[] = [];
    let guarded = 0;

    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("safeguard?:")) continue;
      for (const block of interfaceBlocks(source, file)) {
        if (!/\breadonly safeguard\?:/.test(block.body)) continue;
        guarded += 1;
        if (/\breadonly onProgress\?:/.test(block.body)) continue;
        if (DECLARED_EXEMPTIONS.has(block.name)) continue;
        missing.push(`${REPO_RELATIVE(file)}: ${block.name}`);
      }
    }

    // A census that found nothing passes for the wrong reason.
    expect(guarded).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("every declared exemption names an interface that still exists", () => {
    const declared = new Set<string>();
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("safeguard?:")) continue;
      for (const block of interfaceBlocks(source, file)) {
        if (/\breadonly safeguard\?:/.test(block.body)) declared.add(block.name);
      }
    }
    const stale = [...DECLARED_EXEMPTIONS.keys()].filter((name) => !declared.has(name));
    expect(stale).toEqual([]);
  });

  test("every exemption carries a reason a reader can act on", () => {
    for (const [name, reason] of DECLARED_EXEMPTIONS) {
      // Long enough to be an argument rather than a label. The
      // destructive-site census uses the same floor for the same reason.
      expect(reason.length).toBeGreaterThanOrEqual(80);
      expect(reason).not.toMatch(/\bTODO\b|\bfor now\b|\blater\b/i);
      expect(name).not.toBe("");
    }
  });

  test("no stage identifier is prose", () => {
    // Identifiers and integers only: the human sentence is rendered at
    // the edge from the identifier. A stage with a space in it would mean
    // a caller had started writing sentences onto a structured stream.
    const offenders: string[] = [];
    const stageLiteral = /\bstart\(\s*(?:[A-Z_]+\.\w+|"([^"]*)")|advance\(\s*"([^"]*)"/g;
    for (const file of FILES) {
      if (REPO_RELATIVE(file) === SPINE_MODULE) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("progressCounter(")) continue;
      let match = stageLiteral.exec(source);
      while (match !== null) {
        const literal = match[1] ?? match[2];
        if (literal !== undefined && !/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(literal)) {
          offenders.push(`${REPO_RELATIVE(file)}: ${JSON.stringify(literal)}`);
        }
        match = stageLiteral.exec(source);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every stage constant maps to identifier values", () => {
    // The emitters that hoist their stages into a frozen object are
    // checked through the object rather than the call site, so the rule
    // above cannot be evaded by naming the literal.
    const offenders: string[] = [];
    const stageObject = /const \w*STAGE = Object\.freeze\(\{([^}]*)\}/g;
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      let match = stageObject.exec(source);
      while (match !== null) {
        for (const value of (match[1] ?? "").matchAll(/"([^"]*)"/g)) {
          const literal = value[1] ?? "";
          if (!/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(literal)) {
            offenders.push(`${REPO_RELATIVE(file)}: ${JSON.stringify(literal)}`);
          }
        }
        match = stageObject.exec(source);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sink is synchronous everywhere it is declared", () => {
    // Four of the five long operations are synchronous functions. An
    // async sink would typecheck and then drop every event's completion
    // on the floor, which is a silent failure of exactly the kind this
    // spine exists to remove.
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (!line.includes("onProgress?:")) continue;
        if (/Promise</.test(line)) offenders.push(`${REPO_RELATIVE(file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

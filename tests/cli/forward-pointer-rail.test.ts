/**
 * The advisory rail is the only mechanism that emits a forward pointer
 * (no-dead-ends, phase 3, item 2).
 *
 * `advisory-rail.ts` opens by stating that every forward-pointer line the
 * CLI prints passes "through this module, and through nothing else".
 * That was an aspiration, not a fact: hand-written pointers survived in
 * five stdout call sites, one of them in the same file as a migrated one,
 * so `clusters list` printed `- run: ...` while `clusters run` printed
 * `next: ...`. The census in `terminal-state-census.test.ts` classifies
 * which STATES have an exit; nothing stopped a second MECHANISM from
 * reappearing beside the rail. This file is that ratchet.
 *
 * ## How a pointer is detected, structurally
 *
 * A forward pointer is a literal naming THIS TOOL'S OWN INVOCATION that
 * reaches stdout on a success path. Both halves are structural facts
 * about the source, not words in any language:
 *
 *   - the invocation is the binary name `o2b` followed by verb tokens;
 *   - "reaches stdout" is the callee: `ok`, `info` and
 *     `process.stdout.write` are the CLI's stdout writers, while every
 *     refusal goes to stderr through `fail`, `failWith`, `usageError` or
 *     `process.stderr.write`. The refusal family is therefore outside the
 *     population BY CONSTRUCTION - it is never filtered out by matching
 *     on what the message says.
 *
 * Two SHAPES inside that population are not pointers, and each is
 * subtracted by a rule rather than by an entry per instance, because both
 * recur every time a verb is added:
 *
 *   - a **usage grammar**: the text after the invocation carries this
 *     CLI's optional-group bracket or its alternation bar. A next command
 *     never can - it is one exact invocation, and a test below pins that
 *     against the whole registry.
 *   - a **self-label**: the literal opens with the invocation followed
 *     immediately by a colon, which is a command naming its own output
 *     line, not naming somewhere to go.
 *
 * ## The limit, stated rather than discovered
 *
 * The scan reads the arguments of a writer CALL. A literal that reaches
 * stdout indirectly - returned by a renderer the caller writes, or pushed
 * into an array joined later - is outside what a per-call-site scan can
 * see. `o2b search status` was such a site and is migrated here; the
 * `install` plan renderers legitimately name per-target commands the
 * registry cannot hold and are out of reach of both this ratchet and the
 * rail.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { resolveNextStep } from "../../src/core/brain/next-step.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI_ROOT = join(REPO_ROOT, "src", "cli");

/**
 * The CLI's stdout writers. `okJson` and `writeJson` are deliberately
 * absent: they serialise a payload, and a next command belongs in that
 * payload as a field, which is a different mechanism with its own test.
 */
const STDOUT_WRITER_RE = /(?:\bok|\binfo|process\.stdout\.write)\(/g;

/** This tool's own invocation: the binary name plus its verb tokens. */
const INVOCATION_RE = /\bo2b(?:\s+[a-z][a-z0-9-]*)+/g;

/**
 * This CLI's usage notation: an optional group or an alternation. A
 * `nextCommand` is one exact invocation and carries neither - pinned
 * against the whole registry by a test below.
 */
const USAGE_NOTATION_RE = /[[|]/;

/** A source-level string delimiter. */
const QUOTE_RE = /['"`]$/;

/**
 * Sites where a literal invocation reaches stdout and the rail genuinely
 * cannot carry it. `count` pins how many such literals the site holds, so
 * a NEW hand-written pointer in an already-sanctioned file fails here
 * instead of hiding behind its neighbour's reason.
 */
interface SanctionedPointer {
  readonly count: number;
  readonly reason: string;
}

const SANCTIONED: Readonly<Record<string, SanctionedPointer>> = Object.freeze({
  "src/cli/brain/verbs/protect.ts :: o2b brain protect": {
    count: 1,
    reason:
      "provenance header of a generated artifact, not a pointer: the preview writes the deny-rule " +
      "file to stdout for redirection and names, in a comment line, the command that produced it. " +
      "The operator has already run it; there is nothing forward about it.",
  },
  "src/cli/main.ts :: o2b search check": {
    count: 1,
    reason:
      "part of the semantic-search configuration template, whose two commands are the verification " +
      "sequence AFTER the operator edits the keys printed immediately above them. Neither is " +
      "runnable until that edit happens, and the rail resolves one structural command per code - it " +
      "cannot express an ordered pair conditioned on a manual step.",
  },
  "src/cli/main.ts :: o2b search index": {
    count: 1,
    reason:
      "the second half of that same configuration template (`o2b search index --embeddings`). It is " +
      "listed for the identical reason and is counted separately so a new hand-written pointer " +
      "naming this verb in this module cannot hide behind the template's entry.",
  },
  "src/cli/main.ts :: o2b install-cli": {
    count: 1,
    reason:
      "`o2b uninstall --help` prose describing what `--remove-cli` removes, by naming the command " +
      "that created those symlinks in the past. It is a mention of a command already run, not a " +
      "command to run next, and routing it through the rail would advise the operator to reinstall " +
      "the very symlinks the paragraph is about removing.",
  },
});

/** A reason has to say something; a placeholder cannot reach this. */
const MIN_REASON_LENGTH = 80;

const readSource = (path: string): string => readFileSync(path, "utf8");

function cliFiles(dir: string = CLI_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cliFiles(abs));
    else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/**
 * The argument text of a call whose opening paren sits at `start`.
 * Quote-aware, so a paren inside a string literal cannot unbalance the
 * scan and a multi-line argument (an array joined into one write) is
 * read whole.
 */
function argumentText(text: string, start: number): string {
  let depth = 1;
  let quote: string | null = null;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    i += 1;
  }
  return text.slice(start, i - 1);
}

/**
 * True when the invocation at `at` inside `args` is one of the two
 * non-pointer shapes: a usage grammar, or the command labelling its own
 * output line. Both are read from the source text around the match, not
 * from what the sentence says.
 */
function isNotAPointer(args: string, at: number, invocation: string): boolean {
  const before = args.slice(0, at);
  const after = args.slice(at + invocation.length);
  // Usage grammar: bounded to the invocation's own line, so a bracket
  // somewhere else in a multi-line argument cannot excuse it.
  const restOfLine = after.split("\n", 1)[0]!;
  if (USAGE_NOTATION_RE.test(restOfLine)) return true;
  // Self-label: the literal opens with the invocation, and a colon
  // follows it immediately.
  return QUOTE_RE.test(before) && after.startsWith(":");
}

/** Every invocation literal written to stdout from `text`. */
function pointersIn(text: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const match of text.matchAll(STDOUT_WRITER_RE)) {
    const args = argumentText(text, match.index! + match[0].length);
    for (const invocation of args.matchAll(INVOCATION_RE)) {
      if (isNotAPointer(args, invocation.index!, invocation[0])) continue;
      found.push(invocation[0]);
    }
  }
  return found;
}

/** `<relative path> :: <invocation>` -> how many times it was measured. */
function census(): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const path of cliFiles()) {
    const rel = relative(REPO_ROOT, path).split("\\").join("/");
    for (const invocation of pointersIn(readSource(path))) {
      const key = `${rel} :: ${invocation}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe("the rail is the only forward-pointer mechanism", () => {
  test("no unsanctioned invocation literal reaches stdout", () => {
    const unsanctioned = [...census().keys()]
      .filter((key) => SANCTIONED[key] === undefined)
      .toSorted();
    // Named, not counted: the failure message is the work to be done.
    expect(unsanctioned.join("\n")).toBe("");
  });

  test("every sanctioned site still exists and holds exactly what it declares", () => {
    const measured = census();
    for (const [key, entry] of Object.entries(SANCTIONED)) {
      expect(`${key} measured: ${measured.get(key) ?? 0}`).toBe(`${key} measured: ${entry.count}`);
    }
  });

  test("every sanctioned reason is specific", () => {
    for (const [key, entry] of Object.entries(SANCTIONED)) {
      expect(`${key} reason is specific: ${entry.reason.trim().length >= MIN_REASON_LENGTH}`).toBe(
        `${key} reason is specific: true`,
      );
    }
  });

  test("the detector is not vacuous - it still matches the shapes it removed", () => {
    // The exact literals this change migrated. A regex that stopped
    // matching would otherwise sweep the whole tree clean.
    const removed = [
      'ok("no dream bundles - run: o2b brain dream stage");',
      'else ok("no cluster notes yet - run: o2b brain clusters run");',
      'ok("tune: no valid tuned parameters persisted - run: o2b brain tune run --dataset <path>");',
      'ok("resolve with: o2b brain tiers restore <path> --apply  (or accept <path>)");',
      'process.stdout.write("  next: o2b search index   # build the vault search index\\n");',
    ];
    for (const line of removed) {
      expect(`${line} detected: ${pointersIn(line).length}`).toBe(`${line} detected: 1`);
    }
    // And a refusal naming a command is NOT a forward pointer.
    expect(pointersIn('return fail("run o2b brain init first");')).toEqual([]);
    expect(pointersIn('process.stderr.write("usage: o2b brain dream\\n");')).toEqual([]);
  });

  test("the two subtracted shapes are subtracted, and only those", () => {
    // A usage grammar carries this CLI's optional-group bracket or its
    // alternation bar.
    expect(
      pointersIn('process.stdout.write("usage: o2b secrets list|status [args...]\\n");'),
    ).toEqual([]);
    expect(
      pointersIn('process.stdout.write("usage: o2b brain snapshot <verb> [args...]\\n");'),
    ).toEqual([]);
    // A self-label opens the line with the invocation and a colon.
    expect(pointersIn("process.stdout.write(`o2b discipline: job created\\n`);")).toEqual([]);
    // Neither rule excuses a bare pointer that merely starts the line...
    expect(pointersIn('ok("o2b brain clusters run");')).toEqual(["o2b brain clusters run"]);
    // ...nor one whose own arguments use the angle-bracket placeholder
    // shape a real next command does use.
    expect(pointersIn('ok("run: o2b brain tune run --dataset <path>");')).toEqual([
      "o2b brain tune run",
    ]);
  });

  test("no registered next command could be mistaken for a usage grammar", () => {
    // The usage-notation rule is only sound while this holds.
    const offenders = [...DIAGNOSTIC_SIGNALS.values()]
      .filter((signal) => USAGE_NOTATION_RE.test(signal.nextCommand))
      .map((signal) => `${signal.code}: ${signal.nextCommand}`);
    expect(offenders.toSorted().join("\n")).toBe("");
  });

  test("the sanctioned table stays an exception", () => {
    // Every measured site is sanctioned (test one), so the table's size
    // IS the number of unmigrated sites. Four is the ceiling this change
    // leaves behind; a fifth needs its own argument.
    expect(Object.keys(SANCTIONED).length).toBeLessThanOrEqual(4);
  });
});

describe("the migrated codes resolve to a structural command", () => {
  test("each new registry code names its exit", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["dream-bundles-absent", "o2b brain dream stage"],
      ["cluster-notes-absent", "o2b brain clusters run"],
      ["recall-tuning-absent", "o2b brain tune run --dataset <path>"],
      ["tier-drift-restore", "o2b brain tiers restore <path> --apply"],
      ["tier-drift-accept", "o2b brain tiers accept <path>"],
    ];
    for (const [code, command] of expected) {
      expect(`${code} -> ${resolveNextStep(code)?.nextCommand ?? "(unregistered)"}`).toBe(
        `${code} -> ${command}`,
      );
    }
  });
});

describe("the migrated verbs emit through the rail", () => {
  let tmp: string;
  let vault: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-pointer-rail-"));
    vault = join(tmp, "vault");
    configPath = join(tmp, "config.yaml");
    for (const key of ["VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG", "VAULT_AGENT_NAME"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
    bootstrapBrain(vault, { configPath });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("brain dream list with no bundles names the stage command", async () => {
    const r = await runCli(["brain", "dream", "list", "--vault", vault]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("next: o2b brain dream stage\n");
    expect(r.stdout).not.toContain("- run:");
  });

  test("brain clusters list names the same exit whether the directory is missing or empty", async () => {
    const missing = await runCli(["brain", "clusters", "list", "--vault", vault]);
    expect(missing.returncode).toBe(0);
    expect(missing.stdout).toContain("next: o2b brain clusters run\n");

    // The empty-directory branch reached the SAME state and previously
    // said nothing forward at all.
    mkdirSync(join(vault, "Brain", "clusters"), { recursive: true });
    const empty = await runCli(["brain", "clusters", "list", "--vault", vault]);
    expect(empty.returncode).toBe(0);
    expect(empty.stdout).toContain("next: o2b brain clusters run\n");
  });

  test("brain tune status with nothing persisted names the tuning run", async () => {
    const r = await runCli(["brain", "tune", "status", "--vault", vault]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("next: o2b brain tune run --dataset <path>\n");
  });

  test("the rail line stays off the machine stream", async () => {
    for (const argv of [
      ["brain", "dream", "list", "--vault", vault, "--json"],
      ["brain", "clusters", "list", "--vault", vault, "--json"],
      ["brain", "tune", "status", "--vault", vault, "--json"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- runCli patches process.stdout in-process, so concurrent invocations would interleave each other's captured output
      const r = await runCli(argv);
      expect(`${argv[1]} exit: ${r.returncode}`).toBe(`${argv[1]} exit: 0`);
      expect(`${argv[1]} clean: ${!r.stdout.includes("next: ")}`).toBe(`${argv[1]} clean: true`);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    }
  });

  test("search status with no index names the indexer through the rail", async () => {
    const r = await runCli(["search", "status", "--vault", vault, "--db", join(tmp, "none.db")]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("next: o2b search index\n");
    expect(r.stdout).not.toContain("Run: o2b search index");
  });
});

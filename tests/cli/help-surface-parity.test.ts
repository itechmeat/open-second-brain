/**
 * The two help surfaces describe one command set (no-dead-ends, phase 3,
 * item 1).
 *
 * `o2b help --json` serialises the command manifest; `o2b help` used to
 * print a hand-written constant. Two lists mean two truths, and the
 * manifest repair that added sixty-four entries widened the gap until the
 * human surface named twelve `brain` verbs out of a hundred and thirty.
 * An operator reading the human surface therefore could not reach most of
 * this tool - a discoverability dead end.
 *
 * The repair is derivation: one renderer over the manifest feeds both. A
 * derived surface cannot disagree with its source by construction, so
 * this file asserts the property that derivation is FOR - it parses the
 * human text back into paths, summaries and flags and requires the result
 * to equal the manifest exactly. A renderer that truncated, wrapped or
 * dropped a level would pass a "both come from the manifest" claim and
 * fail here.
 */

import { describe, expect, test } from "bun:test";

import {
  manifestForJson,
  type CliCommandManifest,
  type CliRootManifest,
} from "../../src/cli/command-manifest.ts";
import { runCli } from "../helpers/run-cli.ts";

/** `  <path>  <summary>` - two-space indent, two-or-more-space gutter. */
const ENTRY_RE = /^ {2}(\S(?:.*?\S)?) {2,}(\S.*)$/;
/** `      flags: --a --b` - the continuation line a flagged entry carries. */
const FLAGS_RE = /^ {6}flags: (.+)$/;

interface ParsedEntry {
  readonly summary: string;
  readonly flags: ReadonlyArray<string>;
}

/** Parse the human help back into `path -> { summary, flags }`. */
function parseHumanHelp(text: string): ReadonlyMap<string, ParsedEntry> {
  const out = new Map<string, ParsedEntry>();
  let last: string | null = null;
  for (const line of text.split("\n")) {
    const flags = FLAGS_RE.exec(line);
    if (flags !== null) {
      expect(`flags line has an owner: ${last !== null}`).toBe("flags line has an owner: true");
      const owner = out.get(last!)!;
      out.set(last!, { summary: owner.summary, flags: flags[1]!.trim().split(/\s+/) });
      continue;
    }
    const entry = ENTRY_RE.exec(line);
    if (entry === null) continue;
    last = entry[1]!;
    out.set(last, { summary: entry[2]!.trimEnd(), flags: [] });
  }
  return out;
}

/** Walk the manifest into the same `path -> { summary, flags }` shape. */
function walkManifest(root: CliRootManifest): ReadonlyMap<string, ParsedEntry> {
  const out = new Map<string, ParsedEntry>();
  const visit = (items: ReadonlyArray<CliCommandManifest>, prefix: string): void => {
    for (const item of items) {
      const path = `${prefix}${item.name}`;
      out.set(path, {
        summary: item.summary,
        // The inherited `--json` flag is stated once in the header rather
        // than repeated on all two hundred entries; parity is asserted over
        // the flags a command DECLARES.
        flags: (item.flags ?? []).filter((f) => f.inherited !== true).map((f) => `--${f.name}`),
      });
      if (item.commands) visit(item.commands, `${path} `);
    }
  };
  visit(root.commands, "");
  return out;
}

async function humanHelp(): Promise<string> {
  const r = await runCli(["help"]);
  expect(r.returncode).toBe(0);
  return r.stdout;
}

describe("o2b help and o2b help --json describe one command set", () => {
  test("every command the manifest models is named by the human help, and nothing else is", async () => {
    const human = parseHumanHelp(await humanHelp());
    const modelled = walkManifest(manifestForJson());
    // Named, not counted: the failure message is the work to be done.
    const missing = [...modelled.keys()].filter((p) => !human.has(p)).toSorted();
    const invented = [...human.keys()].filter((p) => !modelled.has(p)).toSorted();
    expect(missing.join("\n")).toBe("");
    expect(invented.join("\n")).toBe("");
  });

  test("every summary is the manifest's, verbatim", async () => {
    const human = parseHumanHelp(await humanHelp());
    const modelled = walkManifest(manifestForJson());
    const drifted: string[] = [];
    for (const [path, entry] of modelled) {
      const shown = human.get(path);
      if (shown !== undefined && shown.summary !== entry.summary) {
        drifted.push(`${path}\n  manifest: ${entry.summary}\n  help:     ${shown.summary}`);
      }
    }
    expect(drifted.join("\n")).toBe("");
  });

  test("every declared flag is the manifest's, verbatim", async () => {
    const human = parseHumanHelp(await humanHelp());
    const modelled = walkManifest(manifestForJson());
    const drifted: string[] = [];
    for (const [path, entry] of modelled) {
      const shown = human.get(path);
      if (shown === undefined) continue;
      if (shown.flags.join(" ") !== entry.flags.join(" ")) {
        drifted.push(
          `${path}: manifest [${entry.flags.join(" ")}] help [${shown.flags.join(" ")}]`,
        );
      }
    }
    expect(drifted.join("\n")).toBe("");
  });

  test("the parse is not vacuous", async () => {
    // A regex that stopped matching would report two empty sets as equal.
    const human = parseHumanHelp(await humanHelp());
    expect(human.size).toBeGreaterThan(180);
    expect([...human.values()].filter((e) => e.flags.length > 0).length).toBeGreaterThan(10);
  });

  test("the JSON surface serialises the same manifest the human one renders", async () => {
    const r = await runCli(["help", "--json"]);
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(manifestForJson())));
  });
});

describe("the flags the branch added verbs for are advertised", () => {
  /** `path -> declared flag names`, from the JSON surface itself. */
  async function jsonFlags(): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
    const r = await runCli(["help", "--json"]);
    expect(r.returncode).toBe(0);
    return walkManifestFlags(JSON.parse(r.stdout) as CliRootManifest);
  }

  function walkManifestFlags(root: CliRootManifest): ReadonlyMap<string, ReadonlyArray<string>> {
    const out = new Map<string, ReadonlyArray<string>>();
    for (const [path, entry] of walkManifest(root)) out.set(path, entry.flags);
    return out;
  }

  test("brain lint advertises the consolidation flags its summary already mentions", async () => {
    const flags = await jsonFlags();
    expect((flags.get("brain lint") ?? []).toSorted()).toEqual(
      ["--apply", "--consolidate", "--vault", "--yes"].toSorted(),
    );
  });

  test("brain pending apply advertises the dry run this branch gave it", async () => {
    const flags = await jsonFlags();
    expect(flags.get("brain pending apply")).toContain("--dry-run");
  });

  test("brain pending reject advertises its reason, and list advertises neither", async () => {
    const flags = await jsonFlags();
    expect(flags.get("brain pending reject")).toContain("--reason");
    expect(flags.get("brain pending list")).not.toContain("--dry-run");
    expect(flags.get("brain pending list")).not.toContain("--reason");
  });
});

describe("the terse usage names the complete help", () => {
  test("an unknown command lists every top-level verb and where the rest are", async () => {
    const r = await runCli(["no-such-verb"]);
    expect(r.returncode).toBe(2);
    for (const item of manifestForJson().commands) {
      expect(`${item.name} listed: ${r.stderr.includes(item.name)}`).toBe(
        `${item.name} listed: true`,
      );
    }
    expect(r.stderr).toContain("o2b help");
  });
});

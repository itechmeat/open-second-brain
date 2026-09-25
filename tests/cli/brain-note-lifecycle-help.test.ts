/**
 * The two new brain verbs reachable from the CLI's own help (finding C).
 *
 * The defect. `src/cli/brain.ts` dispatches `note-lifecycle` and
 * `scaffold-stub`, and `help-text.ts` mentioned neither. Per
 * `brain.ts:163-171` an unmatched `VERB_HELP[verb]` dumps the whole
 * `BRAIN_HELP` and returns 2, so `o2b brain note-lifecycle --help` was a
 * usage ERROR, and `o2b brain --help` listed neither verb - a
 * discoverability dead end in front of the one surface that deletes
 * files.
 *
 * The manifest half is the same defect on the machine surface: both
 * entries once declared no flags at all while the verbs accepted them,
 * so `o2b help --json` described a command that did not exist. The
 * ratchet below reads the schema each verb hands its parser and requires
 * the manifest to model exactly that set, with the same types - the
 * direction `search-query-flag-manifest.test.ts` uses, so a flag added to
 * the verb alone turns this red.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { nestedCommand } from "../../src/cli/command-manifest.ts";
import { parsedFlagSchema } from "../helpers/parsed-flag-schema.ts";
import { runCli } from "../helpers/run-cli.ts";

const VERBS = ["note-lifecycle", "scaffold-stub"] as const;

describe("verb help", () => {
  for (const verb of VERBS) {
    test(`o2b brain ${verb} --help exits 0 and describes the verb`, async () => {
      const res = await runCli(["brain", verb, "--help"]);
      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain(`o2b brain ${verb}`);
      // Its own usage line, not the whole brain help dumped as a
      // consolation prize.
      expect(res.stdout.startsWith("usage:")).toBe(true);
    });
  }

  test("o2b brain --help lists both verbs", async () => {
    const res = await runCli(["brain", "--help"]);
    expect(res.returncode).toBe(0);
    for (const verb of VERBS) expect(res.stdout).toContain(verb);
  });
});

const VERBS_DIR = join(import.meta.dir, "..", "..", "src", "cli", "brain", "verbs");

/** Where each verb declares its parser schema, and one flag it must carry. */
const PARSED = [
  {
    verb: "note-lifecycle",
    source: "note-lifecycle.ts",
    marker: "export async function cmdBrainNoteLifecycle",
    witness: ["delete-linked", "boolean"],
  },
  {
    verb: "scaffold-stub",
    source: "scaffold-stub.ts",
    marker: "export async function cmdBrainScaffoldStub",
    witness: ["if-exists", "string"],
  },
] as const;

/** Stated once in the help header, not repeated on each entry. */
const INHERITED_FLAG_NAME = "json";

function sortedEntries(schema: ReadonlyMap<string, string>): Array<[string, string]> {
  return [...schema].filter(([name]) => name !== INHERITED_FLAG_NAME).toSorted();
}

describe("the manifest models exactly the flags each verb parses", () => {
  for (const entry of PARSED) {
    test(entry.verb, () => {
      const parsed = parsedFlagSchema({
        file: join(VERBS_DIR, entry.source),
        marker: entry.marker,
        callOpen: "parse(argv, {",
      });
      // Not vacuous: a dead regex would compare two empty sets.
      expect(parsed.get(entry.witness[0])).toBe(entry.witness[1]);
      const modelled = new Map(
        (nestedCommand("brain", entry.verb)?.flags ?? []).map((f) => [f.name, f.type]),
      );
      expect(sortedEntries(modelled)).toEqual(sortedEntries(parsed));
    });
  }
});

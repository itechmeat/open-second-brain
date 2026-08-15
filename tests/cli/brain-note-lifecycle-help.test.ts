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
 * entries declared no flags at all while the verbs accept --apply,
 * --confirm, --expect, --strict, --path, --source, --if-exists and
 * --limit, so `o2b help --json` described a command that does not exist.
 * `help-surface-parity.test.ts` compares the human and JSON surfaces to
 * each other; this file compares them to the verbs.
 */

import { describe, expect, test } from "bun:test";

import { runCli } from "../helpers/run-cli.ts";
import { CLI_COMMAND_MANIFEST, type CliCommandManifest } from "../../src/cli/command-manifest.ts";

const VERBS = ["note-lifecycle", "scaffold-stub"] as const;

/** The manifest node for `o2b brain <verb>`. */
function brainVerb(verb: string): CliCommandManifest | undefined {
  return CLI_COMMAND_MANIFEST.commands
    .find((item) => item.name === "brain")
    ?.commands?.find((item) => item.name === verb);
}

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

describe("the manifest declares the flags the verbs actually accept", () => {
  test("note-lifecycle", () => {
    const declared = (brainVerb("note-lifecycle")?.flags ?? []).map((f) => f.name).toSorted();
    expect(declared).toEqual(["apply", "config", "confirm", "expect", "strict", "vault"]);
  });

  test("scaffold-stub", () => {
    const declared = (brainVerb("scaffold-stub")?.flags ?? []).map((f) => f.name).toSorted();
    expect(declared).toEqual(["apply", "config", "if-exists", "limit", "path", "source", "vault"]);
  });
});

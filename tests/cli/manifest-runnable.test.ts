/**
 * The command manifest's `runnable` field, held to what each command does.
 *
 * A command with subcommands is either a namespace (run bare, it answers
 * with its usage) or one that also runs by itself (`o2b dream queue`
 * lists the queue). The feature catalog covers every leaf and every
 * runnable command, so a command the manifest calls a namespace while it
 * runs would be a surface no feature claims. This census runs every
 * command with subcommands and fails when the field and the behavior
 * disagree, in either direction.
 *
 * A bare run alone cannot tell a namespace from a runnable command that
 * needs a positional (`o2b search` without a query is refused too), so a
 * namespace must also refuse a word that is none of its subcommands, and
 * a command whose usage names operations beyond its subcommands (`o2b
 * brain skill-proposals accept`) must be runnable: such a command refuses
 * an unknown word exactly as a namespace does, and only its usage tells.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectSurfaces } from "../../scripts/feature-catalog.ts";
import { CLI_COMMAND_MANIFEST, type CliCommandManifest } from "../../src/cli/command-manifest.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/**
 * How a runnable command is run when its bare form needs input: `search`
 * runs a query given as its positional, `brain skill-proposals` takes its
 * operation as a positional, and `mcp` serves until stopped, so its probe
 * stands in for it. Every other runnable command runs bare.
 */
const RUN_WITH: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  mcp: ["mcp", "--probe"],
  search: ["search", "anything"],
  "brain skill-proposals": ["brain", "skill-proposals", "list"],
});

interface Parent {
  readonly path: string;
  readonly runnable: boolean;
  readonly children: ReadonlyArray<string>;
}

/** A word no command takes as a subcommand or an operation. */
const PROBE_WORD = "census-probe-word";

/** A refusal: a usage error (2) or a failed command (1). */
function refused(code: number): boolean {
  return code === 1 || code === 2;
}

function parents(): Parent[] {
  const out: Parent[] = [];
  const visit = (cmds: ReadonlyArray<CliCommandManifest>, prefix: string[]): void => {
    for (const c of cmds) {
      const path = [...prefix, c.name];
      if ((c.commands?.length ?? 0) > 0) {
        out.push({
          path: path.join(" "),
          runnable: c.runnable === true,
          children: (c.commands ?? []).map((child) => child.name),
        });
        visit(c.commands ?? [], path);
      }
    }
  };
  visit(CLI_COMMAND_MANIFEST.commands, []);
  return out;
}

let root: string;
let env: Record<string, string>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "o2b-manifest-runnable-"));
  const vault = join(root, "vault");
  mkdirSync(vault);
  env = {
    HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"),
    LOCALAPPDATA: join(root, "state"),
    VAULT_DIR: vault,
  };
  const init = await runCli(
    ["init", "--vault", vault, "--agent-name", "census", "--timezone", "UTC"],
    { env },
  );
  expect({ code: init.returncode, stderr: init.stderr }).toEqual({ code: 0, stderr: "" });
  // A query needs an index to answer from.
  const index = await runCli(["search", "index"], { env });
  expect({ code: index.returncode, stderr: index.stderr }).toEqual({ code: 0, stderr: "" });
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe("the manifest's runnable commands", () => {
  test("every RUN_WITH entry names a runnable command", () => {
    const runnable = new Set(
      parents()
        .filter((p) => p.runnable)
        .map((p) => p.path),
    );
    expect(Object.keys(RUN_WITH).filter((path) => !runnable.has(path))).toEqual([]);
  });

  test("a command whose usage names operations beyond its subcommands is runnable", () => {
    // The operations come from the usage strings of src/cli/ (the feature
    // catalog's scan): a namespace names only its subcommands.
    const byPath = new Map(parents().map((p) => [p.path, p]));
    const mislabelled = collectSurfaces()
      .cli.verbs.filter((verb) => byPath.get(verb.path)?.runnable === false)
      .flatMap((verb) => {
        const children = new Set(byPath.get(verb.path)?.children ?? []);
        const extra = verb.positional_operations.filter((op) => !children.has(op));
        return extra.length > 0 ? [`${verb.path}: ${extra.join(", ")}`] : [];
      });
    expect(mislabelled).toEqual([]);
  });

  for (const parent of parents()) {
    if (parent.runnable) {
      test(`${parent.path} runs by itself`, async () => {
        const args = RUN_WITH[parent.path] ?? parent.path.split(" ");
        const result = await runCli(args, { env });
        expect({ args, code: result.returncode, stderr: result.stderr.slice(0, 300) }).toEqual({
          args,
          code: 0,
          stderr: expect.any(String),
        });
      });
    } else {
      test(`${parent.path} is a namespace: bare or given a word that is no subcommand, it refuses`, async () => {
        // In turn: an in-process run holds the process's streams.
        const bare = await runCli(parent.path.split(" "), { env });
        const probed = await runCli([...parent.path.split(" "), PROBE_WORD], { env });
        expect({
          path: parent.path,
          bare: refused(bare.returncode),
          probed: refused(probed.returncode),
        }).toEqual({ path: parent.path, bare: true, probed: true });
      });
    }
  }
});

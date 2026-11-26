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
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
}

function parents(): Parent[] {
  const out: Parent[] = [];
  const visit = (cmds: ReadonlyArray<CliCommandManifest>, prefix: string[]): void => {
    for (const c of cmds) {
      const path = [...prefix, c.name];
      if ((c.commands?.length ?? 0) > 0) {
        out.push({ path: path.join(" "), runnable: c.runnable === true });
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
      test(`${parent.path} is a namespace: bare, it refuses with its usage`, async () => {
        const result = await runCli(parent.path.split(" "), { env });
        expect({
          path: parent.path,
          refused: result.returncode === 1 || result.returncode === 2,
        }).toEqual({
          path: parent.path,
          refused: true,
        });
      });
    }
  }
});

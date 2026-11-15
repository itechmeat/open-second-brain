/**
 * The topics guide (`docs/topics.md`, task 3.6) runs as written: every
 * command of its `doc-test: topics` block goes through the real CLI in a
 * child process, in order, against a fresh store with no vault, and must
 * exit 0. `<topic>` is replaced by the id `create` printed and `<record>`
 * by the record id the last command printed, as the guide says. Every verb
 * the guide lists by name in the block is run; the test also checks that
 * the page `show` printed has the rename and the decision.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 6);

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GUIDE = join(REPO_ROOT, "docs", "topics.md");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "main.ts");

let parent: string | undefined;
afterEach(() => {
  if (parent !== undefined)
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  parent = undefined;
});

/** The command lines of the guide's `doc-test: topics` block. */
function guideCommands(): string[] {
  const lines = readFileSync(GUIDE, "utf8").split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === "<!-- doc-test: topics -->");
  expect(at).toBeGreaterThan(-1);
  expect(lines[at + 1]!.trim().startsWith("```")).toBe(true);
  const out: string[] = [];
  for (let i = at + 2; !lines[i]!.trim().startsWith("```"); i++) {
    if (lines[i]!.trim() !== "") out.push(lines[i]!.trim());
  }
  return out;
}

/** Split a command line into words, honouring double quotes. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

function run(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): { code: number; out: string } {
  const child = Bun.spawnSync([process.execPath, CLI_ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLI_SPAWN_BUDGET_MS,
  });
  return {
    code: child.exitCode ?? -1,
    out: `${child.stdout.toString()}${child.stderr.toString()}`,
  };
}

describe("docs/topics.md", () => {
  test("the guide names the one verb that does not write as you", () => {
    const guide = readFileSync(GUIDE, "utf8");
    const sentence = guide
      .split("\n")
      .find((l) => l.includes("Commands you run (`o2b topic ...`)"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("except `o2b topic record`");
    expect(sentence).toContain("`--as-human`");
  });

  test("the listed CLI verbs run as written", () => {
    parent = mkdtempSync(join(tmpdir(), "o2b-topics-guide-"));
    const config = join(parent, "config.yaml");
    writeFileSync(config, "");
    const env = {
      OPEN_SECOND_BRAIN_CONFIG: config,
      OPEN_SECOND_BRAIN_STORE_ROOT: join(parent, "store"),
      O2B_DEVICE_ID: "laptop",
      HOME: join(parent, "home"),
      XDG_STATE_HOME: join(parent, "state"),
      LOCALAPPDATA: join(parent, "state"),
      VAULT_DIR: "",
    };
    expect(run(["store", "init"], env).code).toBe(0);
    let topic: string | null = null;
    let record: string | null = null;
    let page = "";
    const verbs = new Set<string>();
    for (const line of guideCommands()) {
      const argv = words(line);
      expect(argv.slice(0, 2)).toEqual(["o2b", "topic"]);
      verbs.add(argv[2]!);
      const args = argv
        .slice(1)
        .map((w) => (w === "<topic>" ? topic! : w === "<record>" ? record! : w));
      const result = run(args, env);
      expect({ line, code: result.code, out: result.code === 0 ? "" : result.out }).toEqual({
        line,
        code: 0,
        out: "",
      });
      const printed = /: topic ([0-9A-Z]{26}), record ([0-9A-Z]{26})/.exec(result.out);
      if (printed !== null) {
        topic ??= printed[1]!;
        record = printed[2]!;
      }
      if (argv[2] === "show") page = result.out;
    }
    expect([...verbs].toSorted()).toEqual(
      [
        "archive",
        "create",
        "list",
        "record",
        "rename",
        "review",
        "show",
        "status",
        "undo",
      ].toSorted(),
    );
    expect(page).toContain("# Brain store and topics");
    expect(page).toContain("- Keep one shard per device and month");
    expect(page).toContain("Status: Waiting");
  });
});

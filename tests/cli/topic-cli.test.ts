/**
 * The `o2b topic` verbs the guide does not run (review fix of task 3.5):
 * `goal` (and `--clear`), `assign`, `unassign`, `merge --into`,
 * `split --into --items` and `link --to` (and `--remove`), each through
 * the real CLI in a child process against a fresh store, its effect read
 * back with `show --json`. A command is the user asking, so every record
 * it writes carries human authority.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readPartition } from "../../src/core/store/state-digest.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 4);

const CLI_ENTRY = resolve(import.meta.dir, "..", "..", "src", "cli", "main.ts");
let parent: string;
let env: Record<string, string>;

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "o2b-topic-cli-"));
  const config = join(parent, "config.yaml");
  writeFileSync(config, "");
  env = {
    OPEN_SECOND_BRAIN_CONFIG: config,
    OPEN_SECOND_BRAIN_STORE_ROOT: join(parent, "store"),
    O2B_DEVICE_ID: "laptop",
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
    VAULT_DIR: "",
  };
  expect(cli(["store", "init"]).code).toBe(0);
});
afterAll(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function cli(args: ReadonlyArray<string>): { code: number; out: string } {
  const child = Bun.spawnSync([process.execPath, CLI_ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLI_SPAWN_BUDGET_MS,
  });
  return { code: child.exitCode ?? -1, out: `${child.stdout}${child.stderr}` };
}

function json(args: ReadonlyArray<string>): Record<string, unknown> {
  const result = cli([...args, "--json"]);
  expect({ args, code: result.code }).toEqual({ args, code: 0 });
  return JSON.parse(result.out) as Record<string, unknown>;
}

const create = (title: string): string =>
  json(["topic", "create", title, "--scope", "project:o2b"])["topic"] as string;
const show = (topic: string): Record<string, unknown> =>
  json(["topic", "show", topic])["topic"] as Record<string, unknown>;
const itemTexts = (topic: string): string[] =>
  (show(topic)["items"] as Array<{ text: string }>).map((i) => i.text);

describe("o2b topic verbs", () => {
  test("goal, assign, unassign, link, split and merge do what their flags say", () => {
    const store = create("Store");
    const docs = create("Docs");

    json(["topic", "goal", store, "Ship phase 3"]);
    expect(show(store)["goal"]).toBe("Ship phase 3");
    json(["topic", "goal", store, "--clear"]);
    expect(show(store)["goal"]).toBeNull();

    // An id that names no note, signal or decision event is refused, and nothing is written.
    const record = "01KA0000000000000000000009";
    const refused = cli(["topic", "assign", store, record, "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain(`no note, signal or decision event with id ${record}`);
    json(["topic", "unassign", store, record]);

    json(["topic", "link", store, "--to", docs]);
    expect(show(docs)["links"]).toEqual([store]);
    json(["topic", "link", store, "--to", docs, "--remove"]);
    expect(show(docs)["links"]).toEqual([]);

    json(["topic", "record", store, "decision", "--text", "Keep JSONL", "--item", "d1"]);
    json(["topic", "record", store, "decision", "--text", "Write the guide", "--item", "d2"]);
    json(["topic", "split", store, "--into", docs, "--items", "d2"]);
    const texts = (topic: string) =>
      (show(topic)["items"] as Array<{ text: string }>).map((i) => i.text);
    expect(texts(store)).toEqual(["Keep JSONL"]);
    expect(texts(docs)).toEqual(["Write the guide"]);

    json(["topic", "merge", docs, "--into", store]);
    expect(show(docs)["id"]).toBe(store);
    expect(texts(store).toSorted()).toEqual(["Keep JSONL", "Write the guide"]);

    const authorities = readPartition(join(parent, "store", "shared"))
      .filter((s) => s.stream === "topics")
      .flatMap((s) => s.records)
      .map((r) => [r.kind, r.body["authority"]]);
    expect(
      authorities.filter(([kind]) => kind !== "decision").every(([, a]) => a === "human"),
    ).toBe(true);
    expect(authorities.filter(([kind]) => kind === "decision").map(([, a]) => a)).toEqual([
      "agent",
      "agent",
    ]);
  });

  test("split --owner names which merged topic's item moves when two share its id", () => {
    const one = create("Owner one");
    const two = create("Owner two");
    const dest = create("Owner dest");
    json(["topic", "record", one, "milestone", "--text", "One's", "--item", "m1"]);
    json(["topic", "record", two, "milestone", "--text", "Two's", "--item", "m1"]);
    json(["topic", "merge", one, "--into", two]);
    const ambiguous = cli(["topic", "split", two, "--into", dest, "--items", "m1"]);
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.out).toContain("name its owner");
    json(["topic", "split", two, "--into", dest, "--items", "m1", "--owner", one]);
    expect(itemTexts(dest)).toEqual(["One's"]);
    expect(itemTexts(two)).toEqual(["Two's"]);
  });

  test("a verb without the flag it needs is refused with a usage error", () => {
    const store = create("Lonely");
    expect(cli(["topic", "merge", store]).code).toBe(1);
    expect(cli(["topic", "goal", store]).code).toBe(2);
  });
});

describe("o2b topic help and an incomplete review", () => {
  test("topic --help prints the topic usage", () => {
    const result = cli(["topic", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("usage: o2b topic list");
  });

  test("a review over a partly unreadable topics shard says so and exits non-zero", () => {
    const store = create("Broken soon");
    void store;
    const dir = join(parent, "store", "shared", "topics", "laptop");
    const shard = join(dir, readdirSync(dir)[0]!);
    const lines = readFileSync(shard, "utf8").split("\n");
    writeFileSync(shard, [lines[0], "{broken", ...lines.slice(1)].join("\n"));
    const result = cli(["topic", "review"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("review incomplete");
  });
});

/**
 * `o2b brain obligation` acts only on the obligation that stores the
 * title it is given: a title that only keys like a stored one (other
 * punctuation) completes and archives nothing.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-obligation-title-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function obligation(...args: string[]) {
  return runCli(["brain", "obligation", ...args, "--vault", vault, "--agent", "tester", "--json"]);
}

describe("o2b brain obligation: a title names only its own obligation", () => {
  test("done and remove by a title that only keys alike leave the stored page as it was", async () => {
    expect(
      (await obligation("add", "--title", "Water the plants", "--cadence", "weekly")).returncode,
    ).toBe(0);
    const page = join(vault, "Brain", "obligations", "water-the-plants.md");
    const before = readFileSync(page, "utf8");

    const shown = await obligation("show", "--title", "Water, the plants");
    expect(JSON.parse(shown.stdout).present).toBe(false);
    expect((await obligation("done", "--title", "Water, the plants")).returncode).not.toBe(0);
    expect((await obligation("remove", "--title", "Water, the plants")).returncode).not.toBe(0);
    expect(readFileSync(page, "utf8")).toBe(before);

    const done = await obligation("done", "--title", "Water the plants");
    expect(done.returncode).toBe(0);
    expect(JSON.parse(done.stdout).obligation.slug).toBe("water-the-plants");
    expect((await obligation("remove", "--slug", "water-the-plants")).returncode).toBe(0);
    expect(existsSync(page)).toBe(false);
  });
});

/**
 * `o2b brain state` CLI surface (t_b0c9d0a3): the overwrite-only
 * exact-state lane - set overwrites, get/list read, clear removes.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-state-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("set overwrites, get and list read, clear removes", async () => {
  const set1 = await runCli([
    "brain",
    "state",
    "set",
    "--vault",
    vault,
    "--aspect",
    "branch",
    "--value",
    "feat/x",
  ]);
  expect(set1.returncode).toBe(0);

  const set2 = await runCli([
    "brain",
    "state",
    "set",
    "--vault",
    vault,
    "--aspect",
    "branch",
    "--value",
    "feat/y",
  ]);
  expect(set2.returncode).toBe(0);

  const get = await runCli([
    "brain",
    "state",
    "get",
    "--vault",
    vault,
    "--aspect",
    "branch",
    "--json",
  ]);
  expect(get.returncode).toBe(0);
  expect(JSON.parse(get.stdout).value).toBe("feat/y");

  const list = await runCli(["brain", "state", "list", "--vault", vault, "--json"]);
  expect(JSON.parse(list.stdout).aspects.map((a: { aspect: string }) => a.aspect)).toEqual([
    "branch",
  ]);

  const clear = await runCli([
    "brain",
    "state",
    "clear",
    "--vault",
    vault,
    "--aspect",
    "branch",
    "--json",
  ]);
  expect(JSON.parse(clear.stdout).cleared).toBe(true);

  const getAfter = await runCli([
    "brain",
    "state",
    "get",
    "--vault",
    vault,
    "--aspect",
    "branch",
    "--json",
  ]);
  expect(JSON.parse(getAfter.stdout).present).toBe(false);
});

test("set without --aspect is a usage error (exit 2)", async () => {
  const res = await runCli(["brain", "state", "set", "--vault", vault, "--value", "x"]);
  expect(res.returncode).toBe(2);
});

test("unknown subcommand is a usage error (exit 2)", async () => {
  const res = await runCli(["brain", "state", "frobnicate", "--vault", vault]);
  expect(res.returncode).toBe(2);
});

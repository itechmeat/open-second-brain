/**
 * CLI surface for the Vault portability suite (v0.22.0):
 * `o2b brain codec | sources | graph-export | graph-import` and
 * `o2b vault profile | map`. Locks argument shape, --json, and exit
 * codes; the underlying cores have their own unit coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-vps-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function bootstrap(): Promise<void> {
  expect(
    (
      await runCli(["init", "--vault", vault, "--name", "T"], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      })
    ).returncode,
  ).toBe(0);
  expect(
    (
      await runCli(["brain", "init", "--vault", vault], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      })
    ).returncode,
  ).toBe(0);
}

describe("o2b brain codec", () => {
  test("compress | expand round-trips via stdin", async () => {
    const text = "line\n\n\n\n\nbody";
    const c = await runCli(["brain", "codec", "--compress"], { stdin: text });
    expect(c.returncode).toBe(0);
    const e = await runCli(["brain", "codec", "--expand"], { stdin: c.stdout });
    expect(e.returncode).toBe(0);
    expect(e.stdout).toBe(text);
  });
});

describe("o2b brain sources / graph", () => {
  test("sources --json on a fresh vault", async () => {
    await bootstrap();
    const r = await runCli(["brain", "sources", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout).sources).toEqual([]);
  });

  test("graph-export then graph-import round-trips a user page", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks to [[Other]].\n");
    const exp = await runCli(["brain", "graph-export"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(exp.returncode).toBe(0);
    const graphFile = join(tmp, "graph.json");
    writeFileSync(graphFile, exp.stdout);
    const imp = await runCli(["brain", "graph-import", graphFile, "--mode", "skip", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(imp.returncode).toBe(0);
    // Note already exists -> skipped (idempotent).
    expect(JSON.parse(imp.stdout).skipped).toContain("Note.md");
  });

  test("graph-import rejects an unknown --mode", async () => {
    await bootstrap();
    writeFileSync(join(tmp, "g.json"), '{"version":"1","nodes":[]}');
    const r = await runCli(["brain", "graph-import", join(tmp, "g.json"), "--mode", "bogus"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
  });
});

describe("o2b vault profile / map", () => {
  test("profile create / switch / list", async () => {
    await bootstrap();
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    expect(
      (await runCli(["vault", "profile", "create", "work", "/srv/v/work"], { env })).returncode,
    ).toBe(0);
    expect((await runCli(["vault", "profile", "switch", "work"], { env })).returncode).toBe(0);
    const list = await runCli(["vault", "profile", "list", "--json"], { env });
    expect(list.returncode).toBe(0);
    expect(JSON.parse(list.stdout).active).toBe("work");
  });

  test("map --json shows the default token table", async () => {
    await bootstrap();
    const r = await runCli(["vault", "map", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout).inbox).toBe("inbox");
  });
});

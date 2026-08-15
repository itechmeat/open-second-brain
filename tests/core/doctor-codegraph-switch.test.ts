/**
 * The switch that turns the codegraph partner check off
 * (nothing-runs-unwatched, unit U12).
 *
 * `doctor()` has accepted `partner.codegraph.disabled` since the partner
 * check was written, and nothing ever set it: no flag, no env var, no
 * config key reached that field, so the option was a declared surface with
 * no producer. The consequence is measurable rather than cosmetic. When
 * the partner CLI is on PATH, `checkCodegraph` spawns `codegraph status -j
 * <repo>` on every `o2b doctor`, which costs ~0.7 s against a warm HOME
 * and ~5 s against a cold one (the partner caches under HOME). CI has no
 * such binary, so the check returns null there and the cost is invisible
 * to it - which is why this only ever hurt workstations.
 *
 * The spawn is what the assertions below watch, through a fake `codegraph`
 * on PATH that records having been called. A test that only read the
 * returned message would pass just as happily against a check that ran the
 * partner and then discarded the answer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY,
  PARTNER_CODEGRAPH_DISABLED_ENV,
} from "../../src/core/config.ts";
import { doctor } from "../../src/core/doctor.ts";

let tmp: string;
let repo: string;
let vault: string;
let configPath: string;
let sentinel: string;
let savedPath: string | undefined;
let savedFlag: string | undefined;

/** A directory that passes `isCodeProject` and looks already indexed. */
function makeIndexedRepo(dir: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
  return dir;
}

/**
 * A `codegraph` executable that records every invocation and answers like
 * an indexed project, so a check that spawns it gets a usable answer AND
 * leaves a trace.
 */
function makeFakeCodegraph(binDir: string, sentinelPath: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "codegraph");
  writeFileSync(
    script,
    ["#!/bin/sh", `echo "$@" >> "${sentinelPath}"`, "echo '{\"initialized\":true}'", ""].join("\n"),
    "utf8",
  );
  chmodSync(script, 0o755);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-codegraph-switch-"));
  repo = makeIndexedRepo(join(tmp, "repo"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  sentinel = join(tmp, "spawned.log");
  makeFakeCodegraph(join(tmp, "bin"), sentinel);
  savedPath = process.env["PATH"];
  savedFlag = process.env[PARTNER_CODEGRAPH_DISABLED_ENV];
  process.env["PATH"] = join(tmp, "bin");
  delete process.env[PARTNER_CODEGRAPH_DISABLED_ENV];
});

afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedFlag === undefined) delete process.env[PARTNER_CODEGRAPH_DISABLED_ENV];
  else process.env[PARTNER_CODEGRAPH_DISABLED_ENV] = savedFlag;
  rmSync(tmp, { recursive: true, force: true });
});

function codegraphCheck(): { name: string; ok: boolean; message: string } | undefined {
  return doctor({ vault, config: configPath, cwd: repo }).find((r) => r.name === "code_graph");
}

describe("the codegraph partner check can be turned off", () => {
  test("with the switch unset the partner is spawned - so the watch is not vacuous", () => {
    const check = codegraphCheck();
    expect(existsSync(sentinel)).toBe(true);
    expect(check?.ok).toBe(true);
  });

  test("the env var stops the spawn", () => {
    process.env[PARTNER_CODEGRAPH_DISABLED_ENV] = "true";
    codegraphCheck();
    expect(existsSync(sentinel)).toBe(false);
  });

  test("the config key stops the spawn, with no env var set", () => {
    writeFileSync(configPath, `${PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY}: "true"\n`, "utf8");
    codegraphCheck();
    expect(existsSync(sentinel)).toBe(false);
  });

  test("an explicit caller option still wins over the resolved default", () => {
    process.env[PARTNER_CODEGRAPH_DISABLED_ENV] = "true";
    const results = doctor({
      vault,
      config: configPath,
      cwd: repo,
      partner: { codegraph: { disabled: false } },
    });
    expect(existsSync(sentinel)).toBe(true);
    expect(results.some((r) => r.name === "code_graph")).toBe(true);
  });
});

describe("a check that did not run says so", () => {
  test("the disabled check reports itself rather than vanishing from the report", () => {
    // Silence would be indistinguishable from a machine with no codegraph
    // and from a directory that is not a code project - three different
    // facts, one empty report.
    process.env[PARTNER_CODEGRAPH_DISABLED_ENV] = "true";
    const check = codegraphCheck();
    expect(check).toBeDefined();
    expect(check?.message).toContain(PARTNER_CODEGRAPH_DISABLED_ENV);
    expect(check?.message).toContain(PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY);
    // Not a fault of the operator's making: an install they deliberately
    // told the doctor to leave alone must not fail the doctor.
    expect(check?.ok).toBe(true);
  });
});

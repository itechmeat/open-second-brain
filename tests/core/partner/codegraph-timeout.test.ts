/**
 * A partner that never answers (nothing-runs-unwatched, review finding 8).
 *
 * `checkCodegraph` spawns the partner CLI SYNCHRONOUSLY and `doctor()` has
 * three callers: the CLI, the MCP `vault_health` tool and the OpenClaw
 * extension. Issued with no `timeout`, a partner that wedges - a stale
 * lock, an NFS stall, an index rebuild that never returns - blocks all
 * three for as long as it wedges, with no deadline and no refusal.
 *
 * These tests spawn a REAL process, because that is the only way to fail
 * for the intended reason: a fake `runStatusJson` returning a timeout
 * record would pass just as happily against a check that still has no
 * bound at all. The fake `codegraph` on PATH is a `sh` script that sleeps
 * far longer than the budget the check is given.
 *
 * The second thing asserted here is the DISTINCTION. "The partner said the
 * index is stale" and "the partner never answered" are different facts,
 * and a build that reports the second as the first sends an operator to
 * `codegraph init` over a process that is still running.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkCodegraph,
  CODEGRAPH_CLI,
  CODEGRAPH_PARTNER_TIMEOUT_MS,
  defaultDetectProjectPathSupport,
  defaultRunStatusJson,
} from "../../../src/core/partner/codegraph.ts";

let tmp: string;
let repo: string;
let vault: string;
let savedPath: string | undefined;

/** How long the fake partner hangs: long enough that only a bound ends it. */
const HANG_SECONDS = 30;

/** The budget the check is given in these tests. Short, and still a real wait. */
const BUDGET_MS = 400;

/** A directory that passes `isCodeProject` and looks already indexed. */
function makeIndexedRepo(dir: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
  return dir;
}

/** A `codegraph` on PATH that accepts every argument and never answers. */
function makeHangingCodegraph(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, CODEGRAPH_CLI.bin);
  writeFileSync(script, `#!/bin/sh\nsleep ${HANG_SECONDS}\n`, "utf8");
  chmodSync(script, 0o755);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-codegraph-timeout-"));
  repo = makeIndexedRepo(join(tmp, "repo"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  makeHangingCodegraph(join(tmp, "bin"));
  savedPath = process.env["PATH"];
  // PREPENDED rather than replaced: the fake shadows any real partner on
  // this machine, and `sh` still has to find `sleep`.
  process.env["PATH"] = `${join(tmp, "bin")}:${savedPath ?? ""}`;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  rmSync(tmp, { recursive: true, force: true });
});

describe("the partner consult is bounded", () => {
  test("a status query that never answers returns, and says it did not answer", () => {
    const started = Date.now();
    const result = defaultRunStatusJson(repo, BUDGET_MS);
    const waited = Date.now() - started;

    // Without a bound this call does not return for HANG_SECONDS.
    expect(waited).toBeLessThan(HANG_SECONDS * 1000);
    expect(result.ok).toBe(false);
    expect("unanswered" in result).toBe(true);
  });

  test("the check reports a probe that did not complete, not an index that failed", () => {
    const started = Date.now();
    const check = checkCodegraph({ cwd: repo, vault }, { timeoutMs: BUDGET_MS });
    const waited = Date.now() - started;

    expect(waited).toBeLessThan(HANG_SECONDS * 1000);
    expect(check).not.toBeNull();
    expect(check!.ok).toBe(false);
    // The distinction this test exists for: the message must not read as
    // the partner having answered, and must not send the operator to
    // `codegraph init` over a process that is still running.
    expect(check!.message).toContain("did not answer");
    expect(check!.message).toContain(String(BUDGET_MS));
    expect(check!.message).not.toContain("not indexed");
    expect(check!.message).not.toContain("status failed");
  });

  test("the help probe is bounded too, and a probe that timed out claims nothing", () => {
    const started = Date.now();
    const supported = defaultDetectProjectPathSupport(BUDGET_MS);
    expect(Date.now() - started).toBeLessThan(HANG_SECONDS * 1000);
    expect(supported).toBe(false);
  });

  test("a wedged partner is asked once, not once per project", () => {
    // Two projects and a partner that hangs: a per-project retry would
    // multiply the wait by the project count, which is how a bound stops
    // bounding anything.
    const second = makeIndexedRepo(join(tmp, "repo-b"));
    const started = Date.now();
    const check = checkCodegraph(
      { cwd: repo, vault, scanExtraPaths: [second] },
      { timeoutMs: BUDGET_MS, detectProjectPathSupport: () => true },
    );
    const waited = Date.now() - started;

    expect(check!.ok).toBe(false);
    expect(check!.message).toContain("not consulted");
    // One budget plus slack, not two.
    expect(waited).toBeLessThan(BUDGET_MS * 2);
  });

  test("the default budget is a bound rather than a target", () => {
    // Pinned so a later edit cannot quietly remove the deadline by
    // setting it to something no partner could exceed.
    expect(CODEGRAPH_PARTNER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CODEGRAPH_PARTNER_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

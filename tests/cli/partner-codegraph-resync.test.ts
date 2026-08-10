/**
 * `o2b partner codegraph resync --cron-template` and the health exit on
 * `o2b partner codegraph report`.
 *
 * Both surfaces are strictly read-only, and the resync verb is the sharper
 * case: it exists to make a re-index happen on a cadence WITHOUT this
 * project ever writing into the partner's store. So the load-bearing
 * assertion is not what it prints but what it does not do - the directory
 * listings before and after a run are compared, and the run that omits the
 * required flag is required to fail rather than quietly do nothing.
 *
 * The emitted script is asserted as text, in order: a gate that ran after
 * the indexer would be no gate at all, and a missing-parser branch that
 * exited zero would be a gate that passes what it could not read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCodegraphResyncTemplate } from "../../src/cli/partner-codegraph-cron.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-resync-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A directory the code-project scan recognises: `.git/` plus a manifest. */
function makeRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "package.json"), "{}\n");
  return repo;
}

/** Every path under `root`, recursively, as a sorted list. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  };
  walk(root, "");
  return out.toSorted();
}

describe("the resync recipe renders", () => {
  test("the interval as cron, the recipe name, the scheduler and the indexer", () => {
    const body = renderCodegraphResyncTemplate("/srv/projects/demo", "6h");
    expect(body).toContain("# interval: 6 hours");
    expect(body).toContain("0 */6 * * *    ~/.local/bin/osb-codegraph-resync.sh");
    expect(body).toContain("--name osb-codegraph-resync");
    expect(body).toContain("hermes cron create");
    expect(body).toContain('codegraph init "$project"');
    expect(body).toContain('project="/srv/projects/demo"');
  });

  test("the wrong-root guard precedes the indexer invocation", () => {
    const body = renderCodegraphResyncTemplate("/srv/projects/demo", "6h");
    const guard = body.indexOf("cache-root-mismatch");
    const indexer = body.indexOf('codegraph init "$project"');
    expect(guard).toBeGreaterThan(-1);
    expect(indexer).toBeGreaterThan(-1);
    expect(`guard before indexer: ${guard < indexer}`).toBe("guard before indexer: true");
  });

  test("the missing-parser branch exits non-zero instead of matching loosely", () => {
    const body = renderCodegraphResyncTemplate("/srv/projects/demo", "6h");
    const branch = body.slice(body.indexOf("if ! command -v jq"), body.indexOf("health=$(cd "));
    expect(branch).toContain("exit 1");
    expect(branch).not.toContain("exit 0");
    // No grep fallback: the reindex recipe has one, and copying it here
    // would let a host without jq index on an unread health verdict.
    expect(body).not.toContain("grep -Eq");
  });

  test("an unparseable health report aborts rather than reading as no mismatch", () => {
    // The gate used to be a bare `if`, which collapses every non-zero exit
    // into one answer: jq exits 5 on a parse error, `if` reads that as
    // false, and the recipe re-indexed over a root nobody verified. The
    // status is now read explicitly and only a literal 1 is a pass.
    const body = renderCodegraphResyncTemplate("/srv/projects/demo", "6h");
    expect(body).toContain("mismatch_status=$?");
    expect(body).toContain(`if [ "$mismatch_status" -eq 0 ]; then`);
    expect(body).toContain(`elif [ "$mismatch_status" -ne 1 ]; then`);
    // Both arms abort; neither falls through to the indexer.
    const gate = body.slice(
      body.indexOf("mismatch_status=0"),
      body.indexOf("# 2. Change detection"),
    );
    expect(gate.match(/exit 1/gu)?.length).toBe(2);
    expect(gate).toContain("aborting rather than re-indexing blind");
  });

  test("the stamp is written only after the post-index health gate passes", () => {
    const body = renderCodegraphResyncTemplate("/srv/projects/demo", "6h");
    const gate = body.indexOf("--fail-on-health");
    const stamp = body.indexOf('>"$stamp_file"');
    expect(gate).toBeGreaterThan(-1);
    expect(`gate before stamp: ${gate < stamp}`).toBe("gate before stamp: true");
    // The stamp lives on the operator's host, outside the vault and outside
    // the partner's index directory.
    expect(body).toContain("${XDG_STATE_HOME:-$HOME/.local/state}/open-second-brain");
  });

  test("two repositories get two stamp files", () => {
    const a = renderCodegraphResyncTemplate("/srv/projects/alpha", "6h");
    const b = renderCodegraphResyncTemplate("/srv/projects/beta", "6h");
    expect(a).toContain("osb-codegraph-resync-srv-projects-alpha.stamp");
    expect(b).toContain("osb-codegraph-resync-srv-projects-beta.stamp");
  });
});

describe("o2b partner codegraph resync (CLI)", () => {
  test("--cron-template prints the recipe and writes nothing anywhere", async () => {
    const repo = makeRepo("repo");
    const before = listTree(tmp);
    const res = await runCli(["partner", "codegraph", "resync", "--cron-template"], { cwd: repo });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("cat >~/.local/bin/osb-codegraph-resync.sh");
    expect(res.stdout).toContain(`project="${repo}"`);
    expect(listTree(tmp)).toEqual(before);
  });

  test("--project names the repository without a scan", async () => {
    const repo = makeRepo("named");
    const before = listTree(tmp);
    const res = await runCli(
      ["partner", "codegraph", "resync", "--cron-template", "--project", repo],
      { cwd: tmp },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain(`project="${repo}"`);
    expect(listTree(tmp)).toEqual(before);
  });

  test("--interval renders that cadence", async () => {
    const repo = makeRepo("repo");
    const res = await runCli(
      ["partner", "codegraph", "resync", "--cron-template", "--interval", "1d"],
      { cwd: repo },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("0 0 */1 * *");
  });

  test("omitting --cron-template is a usage error that leaves no index behind", async () => {
    const repo = makeRepo("repo");
    const before = listTree(tmp);
    const res = await runCli(["partner", "codegraph", "resync"], { cwd: repo });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("requires --cron-template");
    expect(res.stdout).toBe("");
    expect(existsSync(join(repo, ".codegraph"))).toBe(false);
    expect(listTree(tmp)).toEqual(before);
  });

  test("an interval cron cannot express exits 1 with the inherited parser error", async () => {
    const repo = makeRepo("repo");
    const res = await runCli(
      ["partner", "codegraph", "resync", "--cron-template", "--interval", "90m"],
      { cwd: repo },
    );
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("h unit");
  });

  test("a --project that is not a directory is refused", async () => {
    const res = await runCli(
      ["partner", "codegraph", "resync", "--cron-template", "--project", join(tmp, "missing")],
      { cwd: tmp },
    );
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("is not a readable directory");
  });

  test("no code project in scope is named, not rendered as an empty recipe", async () => {
    const bare = join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
    const res = await runCli(
      ["partner", "codegraph", "resync", "--cron-template", "--vault", join(bare, "vault")],
      { cwd: bare },
    );
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("no code project in scope");
  });

  test("positional arguments are rejected", async () => {
    const repo = makeRepo("repo");
    const res = await runCli(["partner", "codegraph", "resync", "extra"], { cwd: repo });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("does not accept positional arguments");
  });

  test("the verb is reachable from the usage block on an unknown subcommand", async () => {
    const res = await runCli(["partner", "codegraph", "bogus"], { cwd: tmp });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("o2b partner codegraph resync --cron-template");
  });
});

describe("o2b partner codegraph report --fail-on-health", () => {
  test("exits non-zero when health could not be established", async () => {
    // No codegraph index exists under the fixture repo, so the report has
    // no health block. A gate that could not measure must not pass.
    const repo = makeRepo("repo");
    const res = await runCli(
      ["partner", "codegraph", "report", "--vault", join(tmp, "vault"), "--fail-on-health"],
      { cwd: repo },
    );
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("--fail-on-health");
    expect(res.stderr).toContain("never measured");
    // The report itself is still printed - the flag changes the exit, not
    // whether the operator gets to see the answer.
    expect(res.stdout).toContain("index: ");
  });

  test("the flagless default is unchanged", async () => {
    const repo = makeRepo("repo");
    const res = await runCli(["partner", "codegraph", "report", "--vault", join(tmp, "vault")], {
      cwd: repo,
    });
    expect(res.returncode).toBe(0);
    expect(res.stderr).toBe("");
  });

  test("--json still emits the same report under the flag", async () => {
    const repo = makeRepo("repo");
    const res = await runCli(
      [
        "partner",
        "codegraph",
        "report",
        "--vault",
        join(tmp, "vault"),
        "--json",
        "--fail-on-health",
      ],
      { cwd: repo },
    );
    expect(res.returncode).toBe(1);
    const report = JSON.parse(res.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.project).toBe(repo);
  });
});

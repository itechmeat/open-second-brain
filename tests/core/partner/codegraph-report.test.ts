import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCodegraphReport,
  readCargoWorkspace,
} from "../../../src/core/partner/codegraph-report.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-codegraph-report-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(dir: string, manifest = "package.json", body = "{}\n"): string {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, manifest), body);
  return dir;
}

function makeIndexed(dir: string): void {
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  writeFileSync(join(dir, ".codegraph", "codegraph.db"), "");
}

const WORKSPACE_TOML = `[workspace]
resolver = "2"
members = [
  "crates/core",
  "crates/cli",
  "tools/xtask",
]

[workspace.package]
version = "0.1.0"
`;

describe("readCargoWorkspace", () => {
  test("no Cargo.toml -> null with explicit reason", () => {
    const repo = makeRepo(join(tmp, "node-app"));
    const r = readCargoWorkspace(repo);
    expect(r.workspace).toBeNull();
    expect(r.reason).toContain("no Cargo.toml");
  });

  test("Cargo.toml without [workspace] -> null with reason", () => {
    const repo = makeRepo(join(tmp, "crate"), "Cargo.toml", '[package]\nname = "x"\n');
    const r = readCargoWorkspace(repo);
    expect(r.workspace).toBeNull();
    expect(r.reason.toLowerCase()).toContain("workspace");
  });

  test("structural [workspace] with members -> members reported", () => {
    const repo = makeRepo(join(tmp, "ws"), "Cargo.toml", WORKSPACE_TOML);
    const r = readCargoWorkspace(repo);
    expect(r.workspace).not.toBeNull();
    expect(r.workspace!.members).toEqual(["crates/core", "crates/cli", "tools/xtask"]);
    expect(r.workspace!.memberCount).toBe(3);
    expect(r.workspace!.manifestPath).toBe(join(repo, "Cargo.toml"));
  });

  test("inline members array on one line", () => {
    const repo = makeRepo(join(tmp, "ws2"), "Cargo.toml", '[workspace]\nmembers = ["a", "b"]\n');
    const r = readCargoWorkspace(repo);
    expect(r.workspace!.members).toEqual(["a", "b"]);
  });

  test("[workspace] table present but no members -> empty members, not null", () => {
    const repo = makeRepo(join(tmp, "ws3"), "Cargo.toml", '[workspace]\nresolver = "2"\n');
    const r = readCargoWorkspace(repo);
    expect(r.workspace).not.toBeNull();
    expect(r.workspace!.members).toEqual([]);
    expect(r.workspace!.memberCount).toBe(0);
  });

  test("members under [workspace.package] sub-table are not collected", () => {
    const body = '[workspace]\nresolver = "2"\n\n[workspace.package]\nmembers = ["nope"]\n';
    const repo = makeRepo(join(tmp, "ws-sub"), "Cargo.toml", body);
    const r = readCargoWorkspace(repo);
    expect(r.workspace).not.toBeNull();
    expect(r.workspace!.members).toEqual([]);
  });

  test("members under an array-of-tables after [workspace] are not collected", () => {
    const body = '[workspace]\nresolver = "2"\n\n[[bin]]\nmembers = ["nope"]\n';
    const repo = makeRepo(join(tmp, "ws-aot"), "Cargo.toml", body);
    const r = readCargoWorkspace(repo);
    expect(r.workspace).not.toBeNull();
    expect(r.workspace!.members).toEqual([]);
  });

  test("members of a later table are not mistaken for workspace members", () => {
    const body = '[workspace]\nresolver = "2"\n\n[some.other]\nmembers = ["nope"]\n';
    const repo = makeRepo(join(tmp, "ws4"), "Cargo.toml", body);
    const r = readCargoWorkspace(repo);
    expect(r.workspace!.members).toEqual([]);
  });
});

describe("buildCodegraphReport", () => {
  test("no code project in scope -> honest empty report", () => {
    mkdirSync(join(tmp, "vault"));
    const r = buildCodegraphReport(
      { cwd: tmp, vault: join(tmp, "vault") },
      { whichCodegraph: () => null },
    );
    expect(r.schema_version).toBe(1);
    expect(r.project).toBeNull();
    expect(r.index.state).toBe("no_project");
    expect(r.cargo_workspace).toBeNull();
    expect(r.cargo_workspace_reason.length).toBeGreaterThan(0);
  });

  test("code project, codegraph CLI absent -> index state absent (no throw)", () => {
    const repo = makeRepo(join(tmp, "repo"), "Cargo.toml", WORKSPACE_TOML);
    const r = buildCodegraphReport(
      { cwd: repo, vault: join(tmp, "vault") },
      { whichCodegraph: () => null },
    );
    expect(r.project).toBe(repo);
    expect(r.cli.available).toBe(false);
    expect(r.index.state).toBe("absent");
    expect(r.cargo_workspace).not.toBeNull();
    expect(r.cargo_workspace!.members).toEqual(["crates/core", "crates/cli", "tools/xtask"]);
  });

  test("code project + CLI + no .codegraph/ -> not_indexed", () => {
    const repo = makeRepo(join(tmp, "repo"), "Cargo.toml", WORKSPACE_TOML);
    const r = buildCodegraphReport(
      { cwd: repo, vault: join(tmp, "vault") },
      { whichCodegraph: () => "/usr/bin/codegraph" },
    );
    expect(r.cli.available).toBe(true);
    expect(r.cli.path).toBe("/usr/bin/codegraph");
    expect(r.index.state).toBe("not_indexed");
  });

  test("code project + CLI + indexed + status ok -> indexed with counts", () => {
    const repo = makeRepo(join(tmp, "repo"), "Cargo.toml", WORKSPACE_TOML);
    makeIndexed(repo);
    const r = buildCodegraphReport(
      { cwd: repo, vault: join(tmp, "vault") },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        runStatusJson: () => ({
          ok: true,
          data: { initialized: true, nodeCount: 12, fileCount: 3, edgeCount: 40 },
        }),
      },
    );
    expect(r.index.state).toBe("indexed");
    expect(r.index.node_count).toBe(12);
    expect(r.index.file_count).toBe(3);
    expect(r.index.edge_count).toBe(40);
  });

  test("status error surfaces as error state with reason", () => {
    const repo = makeRepo(join(tmp, "repo"), "Cargo.toml", WORKSPACE_TOML);
    makeIndexed(repo);
    const r = buildCodegraphReport(
      { cwd: repo, vault: join(tmp, "vault") },
      {
        whichCodegraph: () => "/usr/bin/codegraph",
        runStatusJson: () => ({ ok: false, error: "stale lock" }),
      },
    );
    expect(r.index.state).toBe("error");
    expect(r.index.reason).toContain("stale lock");
  });

  test("non-Rust project -> cargo_workspace null with reason", () => {
    const repo = makeRepo(join(tmp, "node-app"));
    const r = buildCodegraphReport(
      { cwd: repo, vault: join(tmp, "vault") },
      { whichCodegraph: () => null },
    );
    expect(r.cargo_workspace).toBeNull();
    expect(r.cargo_workspace_reason).toContain("no Cargo.toml");
  });
});

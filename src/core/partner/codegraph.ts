/**
 * Partner integration with codegraph (https://github.com/colbymchenry/codegraph).
 *
 * OSB never installs, initializes, or writes data for codegraph. This
 * module only detects presence and reports back through the standard
 * doctor `CheckResult` shape so agents (and humans) know whether the
 * partner tool is available, indexed, or missing in the current scope.
 *
 * Detection scope is intentionally narrow: the current working directory
 * plus the top-level siblings of the vault's parent (where users often
 * keep their code projects next to the vault) plus any explicit extras
 * from config. No deep filesystem walk.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CheckResult } from "../types.ts";

const CODE_MANIFESTS: ReadonlyArray<string> = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "tsconfig.json",
  "Gemfile",
  "composer.json",
  "build.gradle",
  "pom.xml",
];

const DEFAULT_LIMIT = 50;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Heuristic check: does `dir` look like a code project root?
 * Requires BOTH a `.git/` directory AND at least one recognised
 * manifest file (the two-signal rule rejects a stray `package.json`
 * inside a notes folder).
 */
export function isCodeProject(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    if (!isDir(join(dir, ".git"))) return false;
    return CODE_MANIFESTS.some((m) => existsSync(join(dir, m)));
  } catch {
    return false;
  }
}

export interface FindCodeProjectsOptions {
  readonly cwd: string;
  readonly vault: string;
  readonly scanExtraPaths?: ReadonlyArray<string>;
  readonly limit?: number;
}

/**
 * Walk the candidate scope (cwd + top-level siblings of `dirname(vault)`
 * + explicit extras) and return every path that passes `isCodeProject`.
 * The scan is bounded at `limit` inspected directories (default 50)
 * so a huge vault parent cannot slow doctor down.
 */
export function findCodeProjects(opts: FindCodeProjectsOptions): string[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const seen = new Set<string>();
  const found: string[] = [];
  let scanned = 0;

  const consider = (raw: string): void => {
    if (scanned >= limit) return;
    const path = resolve(raw);
    if (seen.has(path)) return;
    seen.add(path);
    if (!isDir(path)) return;
    scanned += 1;
    if (isCodeProject(path)) found.push(path);
  };

  consider(opts.cwd);

  const vaultParent = dirname(resolve(opts.vault));
  if (isDir(vaultParent)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(vaultParent);
    } catch {
      entries = [];
    }
    entries.sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (scanned >= limit) break;
      consider(join(vaultParent, name));
    }
  }

  for (const extra of opts.scanExtraPaths ?? []) {
    if (scanned >= limit) break;
    consider(extra);
  }

  return found;
}

export interface CodegraphStatusData {
  readonly initialized: boolean;
  readonly nodeCount?: number;
  readonly fileCount?: number;
  readonly edgeCount?: number;
}

export type CodegraphStatusResult =
  | { readonly ok: true; readonly data: CodegraphStatusData }
  | { readonly ok: false; readonly error: string };

export interface CodegraphCheckDeps {
  readonly whichCodegraph?: () => string | null;
  readonly runStatusJson?: (projectPath: string) => CodegraphStatusResult;
}

export interface CodegraphCheckOptions {
  readonly cwd: string;
  readonly vault: string;
  readonly scanExtraPaths?: ReadonlyArray<string>;
  readonly limit?: number;
  readonly disabled?: boolean;
}

export function defaultWhichCodegraph(): string | null {
  if (typeof Bun !== "undefined" && typeof (Bun as { which?: unknown }).which === "function") {
    const found = (Bun as unknown as { which: (cmd: string) => string | null }).which("codegraph");
    return found ?? null;
  }
  return null;
}

export function defaultRunStatusJson(projectPath: string): CodegraphStatusResult {
  try {
    const proc = Bun.spawnSync({
      cmd: ["codegraph", "status", "-j", projectPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    if (!proc.success) {
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout) as CodegraphStatusData;
          return { ok: true, data: parsed };
        } catch {}
      }
      return { ok: false, error: stderr || `codegraph status exited ${proc.exitCode}` };
    }
    if (!stdout) {
      return { ok: false, error: stderr || "empty status output" };
    }
    const parsed = JSON.parse(stdout) as CodegraphStatusData;
    return { ok: true, data: parsed };
  } catch (exc) {
    return { ok: false, error: (exc as Error).message ?? String(exc) };
  }
}

/**
 * Doctor-grade check for codegraph partnership. Returns `null` (skip,
 * no doctor output) when the current scope is not a code project, when the
 * user has explicitly disabled the check, or when the codegraph CLI is not
 * installed — codegraph is an optional partner OSB never installs, so its
 * absence must not fail doctor.
 *
 * Non-null results carry a single `code_graph` `CheckResult` describing
 * one of three states: `not_indexed`, `ok`, or `error`.
 */
export function checkCodegraph(
  opts: CodegraphCheckOptions,
  deps?: CodegraphCheckDeps,
): CheckResult | null {
  if (opts.disabled) return null;

  const projects = findCodeProjects(opts);
  if (projects.length === 0) return null;

  const project = projects[0]!;
  const whichFn = deps?.whichCodegraph ?? defaultWhichCodegraph;
  const cliPath = whichFn();

  if (!cliPath) {
    // codegraph is an optional partner OSB never installs. If the CLI is not
    // on PATH there is nothing to check — skip silently rather than failing
    // doctor, so `o2b doctor` stays green for users (and CI) without codegraph.
    return null;
  }

  const indexDir = join(project, ".codegraph");
  if (!isDir(indexDir)) {
    return {
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: codegraph init ${project})`,
    };
  }

  const runFn = deps?.runStatusJson ?? defaultRunStatusJson;
  const status = runFn(project);
  if (!status.ok) {
    return {
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: codegraph status failed: ${status.error}`,
    };
  }

  if (!status.data.initialized) {
    return {
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: codegraph init ${project})`,
    };
  }

  const nodes = status.data.nodeCount ?? 0;
  const files = status.data.fileCount ?? 0;
  return {
    name: "code_graph",
    ok: true,
    message: `code project at ${project}: indexed (${nodes} nodes, ${files} files)`,
  };
}

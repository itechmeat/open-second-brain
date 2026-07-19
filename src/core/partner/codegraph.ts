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

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CheckResult } from "../types.ts";
import { isDir } from "../fs-utils.ts";
import { assessGraphHealth, summarizeGraphHealth } from "./codegraph-health.ts";

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

/**
 * The root the index was built for vs. the root it is being read from.
 * `codegraph status -j` emits this block only when they differ (e.g. the
 * index lives at the repo root but is queried from a git worktree). Its
 * presence is the raw signal behind the graph-health `cache-root-mismatch`
 * finding.
 */
export interface CodegraphWorktreeMismatch {
  readonly worktreeRoot: string;
  readonly indexRoot: string;
}

export interface CodegraphStatusData {
  readonly initialized: boolean;
  readonly nodeCount?: number;
  readonly fileCount?: number;
  readonly edgeCount?: number;
  /** Absolute root the index was built for (`status.projectPath`). */
  readonly projectPath?: string;
  /** Present only when the index root differs from the queried root. */
  readonly worktreeMismatch?: CodegraphWorktreeMismatch;
  /**
   * Optional partner-provided graph diagnostics. Base `codegraph status`
   * does not emit these today; the graph-health gate consumes them when a
   * richer status surface provides them, and treats their absence as
   * "not measured" (no finding), never as zero.
   */
  readonly danglingRefs?: number;
  readonly selfLoops?: number;
}

export type CodegraphStatusResult =
  | { readonly ok: true; readonly data: CodegraphStatusData }
  | { readonly ok: false; readonly error: string };

export interface CodegraphCheckDeps {
  readonly whichCodegraph?: () => string | null;
  readonly runStatusJson?: (projectPath: string) => CodegraphStatusResult;
  /**
   * Feature probe: does the partnered codegraph accept a per-query project
   * path, so status can be threaded per project across a multi-project
   * workspace? When it does not, checkCodegraph degrades to the first project
   * only (see {@link defaultDetectProjectPathSupport}).
   */
  readonly detectProjectPathSupport?: () => boolean;
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

/**
 * Structural probe for per-query project-path support: does `codegraph status
 * --help` document a positional path argument (`[path]`)? The token is the
 * partner CLI's own usage marker for "you may pass a project path here"; when
 * present, status/queries can be threaded per project across a multi-project
 * workspace. This matches a documented usage token, not natural-language text,
 * and fails closed (returns false) on any spawn/read error so a probe failure
 * degrades to today's single-project behavior rather than throwing.
 */
const CODEGRAPH_PROJECT_PATH_USAGE_TOKEN = /\[path\]/;

export function defaultDetectProjectPathSupport(): boolean {
  try {
    const proc = Bun.spawnSync({
      cmd: ["codegraph", "status", "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const help = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
    return CODEGRAPH_PROJECT_PATH_USAGE_TOKEN.test(help);
  } catch {
    return false;
  }
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

  const whichFn = deps?.whichCodegraph ?? defaultWhichCodegraph;
  const cliPath = whichFn();

  if (!cliPath) {
    // codegraph is an optional partner OSB never installs. If the CLI is not
    // on PATH there is nothing to check — skip silently rather than failing
    // doctor, so `o2b doctor` stays green for users (and CI) without codegraph.
    return null;
  }

  // Single-project workspace: byte-identical to before. No project_path probe
  // runs (there is nothing to thread across), so behavior and output are
  // exactly today's.
  if (projects.length === 1) {
    return evaluateProjectStatus(projects[0]!, deps);
  }

  // Multi-project workspace. Threading status per project is only sound when
  // the partner accepts a per-query project path; otherwise every query would
  // report whatever project the CLI infers from its own cwd, so we degrade to
  // the first project and say so explicitly.
  const detectFn = deps?.detectProjectPathSupport ?? defaultDetectProjectPathSupport;
  if (!detectFn()) {
    const first = evaluateProjectStatus(projects[0]!, deps);
    return {
      name: "code_graph",
      ok: first.ok,
      message: `${first.message}; note: codegraph CLI has no per-query project_path support - reported 1 of ${projects.length} discovered projects only`,
    };
  }

  const results = projects.map((project) => evaluateProjectStatus(project, deps));
  const header = `${projects.length} code projects:`;
  return {
    name: "code_graph",
    ok: results.every((r) => r.ok),
    message: [header, ...results.map((r) => `- ${r.message}`)].join("\n"),
  };
}

/**
 * Evaluate one project's codegraph status into a `code_graph` CheckResult,
 * threading the project path into the status query. This is the exact
 * per-project logic (not-indexed / status-failed / indexed + graph-health) that
 * the single-project path returns verbatim, so a single-project workspace stays
 * byte-identical and a multi-project aggregate reuses one implementation.
 */
function evaluateProjectStatus(project: string, deps?: CodegraphCheckDeps): CheckResult {
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
  const base = `code project at ${project}: indexed (${nodes} nodes, ${files} files)`;

  // Read-only graph-health gate. Runs after the partner has indexed the graph
  // and before OSB surfaces trust it. Findings are non-blocking: the graph is
  // present and usable, so `ok` stays true (a cache-root mismatch, common in
  // worktree checkouts, must not fail `o2b doctor`) - but the summary is
  // appended so an operator sees the warning and can drill in via
  // `o2b partner codegraph report`.
  const health = assessGraphHealth({
    nodeCount: nodes,
    edgeCount: status.data.edgeCount ?? 0,
    ...(status.data.danglingRefs !== undefined ? { danglingRefs: status.data.danglingRefs } : {}),
    ...(status.data.selfLoops !== undefined ? { selfLoops: status.data.selfLoops } : {}),
    indexRoot: resolveRealpath(
      status.data.worktreeMismatch?.indexRoot ?? status.data.projectPath ?? null,
    ),
    worktreeRoot: resolveRealpath(status.data.worktreeMismatch?.worktreeRoot ?? project),
  });

  return {
    name: "code_graph",
    ok: true,
    message: health.ok
      ? base
      : `${base}; graph-health: ${summarizeGraphHealth(health)} - run: o2b partner codegraph report`,
  };
}

/**
 * Resolve a path through symlinks so the cache-root-mismatch comparison treats
 * a real checkout and its symlinked worktree as the same root. Falls back to
 * the raw value when the path is missing or unreadable (a missing path is not
 * a topology mismatch worth warning about here).
 */
function resolveRealpath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

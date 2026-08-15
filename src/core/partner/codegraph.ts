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

import {
  PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY,
  PARTNER_CODEGRAPH_DISABLED_ENV,
} from "../config.ts";
import type { CheckResult } from "../types.ts";
import { isDir, statOrAbsent } from "../fs-utils.ts";
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
 * The partner CLI's own vocabulary, in one place.
 *
 * These four tokens are the entire surface OSB knows about codegraph, and
 * they were previously written out five times across two modules - the
 * spawn arguments here, and the remediation sentence `run: codegraph init
 * <path>` in two separately worded messages. A partner that renames a
 * subcommand would have had to be chased through every copy, and the two
 * copies of the remediation could drift into saying different things about
 * the same repair.
 *
 * The invariant this constant serves is unchanged and absolute: OSB never
 * installs, initializes, or writes data for codegraph. `initSubcommand`
 * exists so OSB can *quote* the command an operator (or their crontab) runs
 * themselves, never so OSB can run it.
 */
export const CODEGRAPH_CLI = Object.freeze({
  /** Executable name looked up on PATH. */
  bin: "codegraph",
  /** Subcommand that reports index state. */
  statusSubcommand: "status",
  /** Flag making the status subcommand emit JSON. */
  statusJsonFlag: "-j",
  /** Subcommand that builds an index for a project root. */
  initSubcommand: "init",
} as const);

/**
 * The `codegraph init <path>` command line, as text. Quoted in operator-facing
 * remediation and in the resync cron recipe; never spawned by this project.
 */
export function codegraphInitCommand(projectPath: string): string {
  return `${CODEGRAPH_CLI.bin} ${CODEGRAPH_CLI.initSubcommand} ${projectPath}`;
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

/**
 * What asking the partner for one project's status produced.
 *
 * Three arms, not two. `unanswered` is separate from `error` because the
 * two are different facts about the world and only one of them is about
 * the index: a partner that exited non-zero has told us something, and a
 * partner that never returned has told us nothing at all. Collapsing them
 * sends an operator to `codegraph init` over a process that is still
 * running. This is the same distinction `DOCTOR_EXIT.probeIncomplete`
 * draws one release earlier - a probe that did not complete is not a probe
 * that failed.
 */
export interface CodegraphUnanswered {
  readonly ok: false;
  /** Present only on this arm; the field the guard below discriminates on. */
  readonly unanswered: true;
  /** The deadline that expired, in milliseconds, as the message quotes it. */
  readonly waitedMs: number;
}

export type CodegraphStatusResult =
  | { readonly ok: true; readonly data: CodegraphStatusData }
  | { readonly ok: false; readonly error: string }
  | CodegraphUnanswered;

/**
 * Whether the partner never answered.
 *
 * A guard rather than a `kind` field on all three arms, because the two
 * existing arms are a published shape that tests and the report module
 * build by hand; narrowing on a member unique to the new arm adds the
 * distinction without rewriting what already answers.
 */
export function isCodegraphUnanswered(
  result: CodegraphStatusResult,
): result is CodegraphUnanswered {
  return result.ok === false && "unanswered" in result;
}

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
  /**
   * Deadline for each partner invocation, defaulting to
   * {@link CODEGRAPH_PARTNER_TIMEOUT_MS}.
   *
   * It lives on the deps rather than on {@link CodegraphCheckOptions}
   * because it is a seam, not a setting: nothing in the product produces a
   * value for it, and a configurable deadline nobody configures would be
   * one more declared surface with no producer. What it buys is a test
   * that can hang a real partner and watch a real bound end it, instead of
   * asserting against a fake that returns the record the bound would have
   * produced.
   */
  readonly timeoutMs?: number;
}

export interface CodegraphCheckOptions {
  readonly cwd: string;
  readonly vault: string;
  readonly scanExtraPaths?: ReadonlyArray<string>;
  readonly limit?: number;
  readonly disabled?: boolean;
}

/**
 * The lookup path and environment the partner is resolved and run against.
 *
 * Both are read from `process.env` AT CALL TIME and passed explicitly,
 * because `Bun.which` and `Bun.spawn*` otherwise resolve a command against
 * the PATH this process was STARTED with. A long-lived process that
 * updated its own PATH - the MCP server, a host embedding this module,
 * a test standing up a fake partner - would find the binary the snapshot
 * named and never the one the environment now points at, and would report
 * that stale binary's answer as this machine's state.
 */
function partnerEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

export function defaultWhichCodegraph(): string | null {
  if (typeof Bun !== "undefined" && typeof (Bun as { which?: unknown }).which === "function") {
    const found = (
      Bun as unknown as {
        which: (cmd: string, opts?: { PATH?: string | undefined }) => string | null;
      }
    ).which(CODEGRAPH_CLI.bin, { PATH: partnerEnv()["PATH"] });
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

/** The universal flag that makes a CLI print its own usage. */
const HELP_FLAG = "--help";

/**
 * How long any single partner invocation may take before it is stopped.
 *
 * Both spawns are SYNCHRONOUS and `doctor()` has three callers - the CLI,
 * the MCP `vault_health` tool and the OpenClaw extension - so an unbounded
 * one blocks whichever of them asked, for as long as the partner is stuck.
 * The bound existed nowhere: a wedged partner (a stale lock, an index
 * rebuild that never returns, a stalled network filesystem) hung the
 * doctor with no deadline, no refusal and no record.
 *
 * Ten seconds because this is a CEILING and not a target: a warm
 * `codegraph status -j` over a 27k-node index on the machine this was
 * measured on answers in ~0.7 s, and the partner's own config docblock
 * names seconds against a cold HOME. An order of magnitude of headroom
 * keeps a slow-but-working partner reporting its answer, while a partner
 * that is not coming back stops being everyone else's problem.
 */
export const CODEGRAPH_PARTNER_TIMEOUT_MS = 10_000;

/** Bun reports a killed-by-deadline spawn with its own flag; typed once here. */
function timedOut(proc: { readonly exitedDueToTimeout?: boolean }): boolean {
  return proc.exitedDueToTimeout === true;
}

/**
 * @param timeoutMs deadline for the spawn; see {@link CODEGRAPH_PARTNER_TIMEOUT_MS}.
 *   A probe that times out returns `false` for the same reason a probe
 *   that throws does - the caller degrades to the first project and says
 *   so - and the sentence it produces claims only that support was not
 *   REPORTED, never that the partner lacks it.
 */
export function defaultDetectProjectPathSupport(
  timeoutMs: number = CODEGRAPH_PARTNER_TIMEOUT_MS,
): boolean {
  try {
    const proc = Bun.spawnSync({
      cmd: [CODEGRAPH_CLI.bin, CODEGRAPH_CLI.statusSubcommand, HELP_FLAG],
      stdout: "pipe",
      stderr: "pipe",
      env: partnerEnv(),
      timeout: timeoutMs,
    });
    if (timedOut(proc)) return false;
    const help = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
    return CODEGRAPH_PROJECT_PATH_USAGE_TOKEN.test(help);
  } catch {
    return false;
  }
}

export function defaultRunStatusJson(
  projectPath: string,
  timeoutMs: number = CODEGRAPH_PARTNER_TIMEOUT_MS,
): CodegraphStatusResult {
  try {
    const proc = Bun.spawnSync({
      cmd: [
        CODEGRAPH_CLI.bin,
        CODEGRAPH_CLI.statusSubcommand,
        CODEGRAPH_CLI.statusJsonFlag,
        projectPath,
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: partnerEnv(),
      timeout: timeoutMs,
    });
    // Checked BEFORE the output is read, because a partner killed at the
    // deadline usually wrote nothing and would otherwise be reported as
    // "empty status output" - a sentence about what it said, over a
    // process that never said anything.
    if (timedOut(proc)) return { ok: false, unanswered: true, waitedMs: timeoutMs };
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    if (!proc.success) {
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout) as CodegraphStatusData;
          return { ok: true, data: parsed };
        } catch {}
      }
      return {
        ok: false,
        error:
          stderr ||
          `${CODEGRAPH_CLI.bin} ${CODEGRAPH_CLI.statusSubcommand} exited ${proc.exitCode}`,
      };
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
 * Doctor-grade check for codegraph partnership. Returns `null` (skip, no
 * doctor output) when the current scope is not a code project or when the
 * codegraph CLI is not installed — codegraph is an optional partner OSB
 * never installs, so its absence must not fail doctor.
 *
 * Non-null results carry a single `code_graph` `CheckResult` describing
 * one of four states: `disabled`, `not_indexed`, `ok`, or `error`.
 *
 * `disabled` reports itself instead of returning null, because the switch
 * that produces it would otherwise be a setting that silently does
 * nothing visible: an operator who turned the check off, one whose machine
 * has no codegraph, and one standing in a directory that is not a code
 * project would all read the same empty report. Those two remaining
 * silences are NOT distinguished here, and saying so is the honest form of
 * this docblock: separating them means emitting a `code_graph` line on
 * every machine without the partner, CI included, which is a change to the
 * base doctor output rather than to this switch.
 */
export function checkCodegraph(
  opts: CodegraphCheckOptions,
  deps?: CodegraphCheckDeps,
): CheckResult | null {
  if (opts.disabled) return codegraphDisabledResult();

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
    return evaluateProjectStatus(projects[0]!, deps).result;
  }

  // Multi-project workspace. Threading status per project is only sound when
  // the partner accepts a per-query project path; otherwise every query would
  // report whatever project the CLI infers from its own cwd, so we degrade to
  // the first project and say so explicitly.
  const detectFn =
    deps?.detectProjectPathSupport ?? (() => defaultDetectProjectPathSupport(partnerTimeout(deps)));
  if (!detectFn()) {
    const first = evaluateProjectStatus(projects[0]!, deps).result;
    return {
      name: "code_graph",
      ok: first.ok,
      // "did not report" rather than "has no": the probe reads the
      // partner's own usage text, and a probe that failed or ran out of
      // time reads exactly like a partner without the feature. Saying the
      // stronger thing would be claiming what was not established.
      message: `${first.message}; note: codegraph CLI did not report per-query project_path support - reported 1 of ${projects.length} discovered projects only`,
    };
  }

  // A partner that has already failed to answer once is not asked again:
  // per-project retries would multiply the deadline by the project count,
  // which is how a bound stops bounding anything. The projects that were
  // consequently never consulted are named rather than dropped.
  const results: CheckResult[] = [];
  let unanswered = false;
  for (const project of projects) {
    if (unanswered) {
      results.push({
        name: "code_graph",
        ok: false,
        message:
          `code project at ${project}: not consulted - ${CODEGRAPH_CLI.bin} did not answer for ` +
          "an earlier project in this workspace, so nothing is claimed here about this index",
      });
      continue;
    }
    const evaluated = evaluateProjectStatus(project, deps);
    unanswered = evaluated.unanswered;
    results.push(evaluated.result);
  }
  const header = `${projects.length} code projects:`;
  return {
    name: "code_graph",
    ok: results.every((r) => r.ok),
    message: [header, ...results.map((r) => `- ${r.message}`)].join("\n"),
  };
}

/** The deadline this call runs under. */
function partnerTimeout(deps?: CodegraphCheckDeps): number {
  return deps?.timeoutMs ?? CODEGRAPH_PARTNER_TIMEOUT_MS;
}

/**
 * The `disabled` arm.
 *
 * `ok` is a two-valued field and this state is neither of its two
 * meanings, so the message carries what the flag cannot: which switch
 * turned the check off, and that nothing was asked of the partner. `true`
 * is the lesser wrong of the two - `false` would fail `o2b doctor` for an
 * operator who deliberately asked it to leave the partner alone, turning
 * a preference into a defect. Giving the doctor a third stream so this
 * state stops borrowing `ok` at all is a change to every consumer of
 * {@link CheckResult} (the CLI, the MCP payload, the OpenClaw extension)
 * and is named here rather than smuggled in with a switch.
 */
function codegraphDisabledResult(): CheckResult {
  return {
    name: "code_graph",
    ok: true,
    message:
      `check disabled by ${PARTNER_CODEGRAPH_DISABLED_ENV} / ` +
      `${PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY}: ${CODEGRAPH_CLI.bin} was not consulted, ` +
      "so nothing is claimed here about any index",
  };
}

/** One project's verdict, plus whether the partner failed to answer for it. */
interface EvaluatedProject {
  readonly result: CheckResult;
  /**
   * True when the partner ran out of time rather than answering. Carried
   * beside the result rather than parsed back out of its message, because
   * the aggregate above changes what it DOES on this fact.
   */
  readonly unanswered: boolean;
}

/**
 * Evaluate one project's codegraph status into a `code_graph` CheckResult,
 * threading the project path into the status query. This is the exact
 * per-project logic (not-indexed / no-answer / status-failed / indexed +
 * graph-health) that the single-project path returns verbatim, so a
 * single-project workspace stays byte-identical and a multi-project
 * aggregate reuses one implementation.
 */
function evaluateProjectStatus(project: string, deps?: CodegraphCheckDeps): EvaluatedProject {
  const indexDir = join(project, ".codegraph");
  // Stat'ed rather than probed with `isDir`, which answers `false` both for
  // an index that was never built and for one this process cannot look at.
  // Only the first is "not indexed", and it is the only one `codegraph
  // init` clears - telling an operator to re-init an index that is already
  // there sends them past the permission fault that is the actual cause.
  let indexed: boolean;
  try {
    indexed = statOrAbsent(indexDir)?.isDirectory() === true;
  } catch (exc) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: index directory unreadable: ${(exc as Error).message ?? exc}`,
      fix: `chmod u+rx "${indexDir}"`,
    });
  }
  if (!indexed) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: ${codegraphInitCommand(project)})`,
    });
  }

  const runFn =
    deps?.runStatusJson ?? ((path: string) => defaultRunStatusJson(path, partnerTimeout(deps)));
  const status = runFn(project);
  if (isCodegraphUnanswered(status)) {
    // `ok: false` is the lesser wrong of the two values this field has,
    // for the mirror of the reason `codegraphDisabledResult` chooses
    // `true`: reporting a wedged partner as a pass would be the silent
    // no-op, and the doctor has no third stream to put "did not complete"
    // on without changing every consumer of `CheckResult`. The message
    // therefore carries the distinction the flag cannot.
    return {
      result: {
        name: "code_graph",
        ok: false,
        message:
          `code project at ${project}: ${CODEGRAPH_CLI.bin} ` +
          `${CODEGRAPH_CLI.statusSubcommand} did not answer within ${status.waitedMs}ms and was ` +
          "stopped, so NOTHING is claimed here about this index - a probe that did not complete " +
          "is not an index that failed",
        fix: `${CODEGRAPH_CLI.bin} ${CODEGRAPH_CLI.statusSubcommand} ${CODEGRAPH_CLI.statusJsonFlag} ${project}`,
      },
      unanswered: true,
    };
  }
  if (!status.ok) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: codegraph status failed: ${status.error}`,
    });
  }

  if (!status.data.initialized) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: ${codegraphInitCommand(project)})`,
    });
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

  return answered({
    name: "code_graph",
    ok: true,
    message: health.ok
      ? base
      : `${base}; graph-health: ${summarizeGraphHealth(health)} - run: o2b partner codegraph report`,
  });
}

/** A verdict the partner (or the filesystem) actually produced. */
function answered(result: CheckResult): EvaluatedProject {
  return { result, unanswered: false };
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

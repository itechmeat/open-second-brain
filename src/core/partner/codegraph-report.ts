/**
 * Read-only operational-readability report for the codegraph partner
 * (https://github.com/colbymchenry/codegraph).
 *
 * This surface answers "is a code project in scope, is codegraph indexing
 * it, and - for Rust - which Cargo workspace members were declared" WITHOUT
 * installing, initializing, extracting, or mutating anything. It composes the
 * existing code-project discovery and status helpers with a small structural
 * `Cargo.toml` reader.
 *
 * It deliberately does NOT run `codegraph`/`graphify` extraction and does NOT
 * fabricate `crate_depends_on` edges into the Open Second Brain graph: a missing
 * CLI, a missing index, or a non-Rust project are all honest report states, not
 * errors and not silent no-ops.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  defaultRunStatusJson,
  defaultWhichCodegraph,
  findCodeProjects,
  type CodegraphStatusResult,
} from "./codegraph.ts";

export interface CargoWorkspace {
  readonly manifestPath: string;
  readonly members: string[];
  readonly memberCount: number;
}

export interface CargoWorkspaceResult {
  readonly workspace: CargoWorkspace | null;
  readonly reason: string;
}

/**
 * Structural read of a project's `Cargo.toml` for workspace membership.
 *
 * Parses only the `[workspace]` table's `members = [...]` array - no full TOML
 * evaluation, no dependency resolution. Returns `workspace: null` with an
 * explicit reason when there is no `Cargo.toml` or no `[workspace]` table.
 */
export function readCargoWorkspace(projectDir: string): CargoWorkspaceResult {
  const manifestPath = join(projectDir, "Cargo.toml");
  if (!existsSync(manifestPath)) {
    return { workspace: null, reason: "no Cargo.toml in project root (not a Rust project)" };
  }

  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (exc) {
    return { workspace: null, reason: `Cargo.toml unreadable: ${(exc as Error).message}` };
  }

  const lines = text.split(/\r?\n/);
  let currentTable: string | null = null;
  let members: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = stripComment(line).trim();
    if (stripped.length === 0) continue;

    if (stripped.startsWith("[")) {
      // Any table header changes scope, including `[[array-of-tables]]`
      // (matchTableHeader returns null for those, never "workspace"). The
      // `members` key is only valid directly under the top-level `[workspace]`
      // table, so sub-tables like `[workspace.package]` must not collect it.
      currentTable = matchTableHeader(stripped);
      continue;
    }

    if (currentTable !== "workspace") continue;

    const key = matchKey(stripped);
    if (key !== "members") continue;

    // An unterminated array (malformed manifest) yields what we parsed so far
    // rather than scanning the rest of the file.
    members = collectArray(lines, i).values;
    break;
  }

  if (!inWorkspaceTablePresent(text)) {
    return {
      workspace: null,
      reason: "Cargo.toml present but has no [workspace] table (single-crate project)",
    };
  }

  return {
    workspace: {
      manifestPath,
      members: members ?? [],
      memberCount: (members ?? []).length,
    },
    reason: "ok",
  };
}

function inWorkspaceTablePresent(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripComment(raw).trim();
    if (matchTableHeader(stripped) === "workspace") return true;
  }
  return false;
}

function stripComment(line: string): string {
  // Structural-only: a `#` outside a string starts a comment. Cargo workspace
  // member entries are simple quoted paths, so we honor quotes minimally.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function matchTableHeader(stripped: string): string | null {
  if (!stripped.startsWith("[") || stripped.startsWith("[[")) return null;
  const end = stripped.indexOf("]");
  if (end < 0) return null;
  return stripped.slice(1, end).trim();
}

function matchKey(stripped: string): string | null {
  const eq = stripped.indexOf("=");
  if (eq < 0) return null;
  return stripped.slice(0, eq).trim();
}

/** Collect a possibly multi-line `members = [ "a", "b" ]` array as raw strings. */
function collectArray(
  lines: ReadonlyArray<string>,
  startIdx: number,
): { values: string[]; complete: boolean } {
  let buf = "";
  for (let i = startIdx; i < lines.length; i++) {
    buf += stripComment(lines[i]!);
    if (buf.includes("]")) {
      const open = buf.indexOf("[");
      const close = buf.indexOf("]", open + 1);
      if (open >= 0 && close > open) {
        return { values: extractStrings(buf.slice(open + 1, close)), complete: true };
      }
    }
    buf += "\n";
  }
  return { values: extractStrings(buf), complete: false };
}

function extractStrings(inner: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

export type CodegraphIndexState = "no_project" | "absent" | "not_indexed" | "indexed" | "error";

export interface CodegraphReport {
  readonly schema_version: 1;
  readonly project: string | null;
  readonly cli: { readonly available: boolean; readonly path: string | null };
  readonly index: {
    readonly state: CodegraphIndexState;
    readonly node_count?: number;
    readonly file_count?: number;
    readonly edge_count?: number;
    readonly reason?: string;
  };
  readonly cargo_workspace: CargoWorkspace | null;
  readonly cargo_workspace_reason: string;
}

export interface CodegraphReportOptions {
  readonly cwd: string;
  readonly vault: string;
  readonly scanExtraPaths?: ReadonlyArray<string>;
  readonly limit?: number;
}

export interface CodegraphReportDeps {
  readonly whichCodegraph?: () => string | null;
  readonly runStatusJson?: (projectPath: string) => CodegraphStatusResult;
  readonly readCargoWorkspace?: (projectDir: string) => CargoWorkspaceResult;
}

/**
 * Build a schema-versioned, read-only partner report. Never throws on the
 * normal "partner absent / not indexed / not Rust" states - those are values,
 * not failures - so CLI and MCP wrappers can render them directly.
 */
export function buildCodegraphReport(
  opts: CodegraphReportOptions,
  deps?: CodegraphReportDeps,
): CodegraphReport {
  const projects = findCodeProjects(opts);
  const whichFn = deps?.whichCodegraph ?? defaultWhichCodegraph;
  const cliPath = whichFn();
  const cli = { available: cliPath !== null, path: cliPath };

  if (projects.length === 0) {
    return {
      schema_version: 1,
      project: null,
      cli,
      index: { state: "no_project", reason: "no code project in scope" },
      cargo_workspace: null,
      cargo_workspace_reason: "no code project in scope",
    };
  }

  const project = projects[0]!;
  const cargoFn = deps?.readCargoWorkspace ?? readCargoWorkspace;
  const cargo = cargoFn(project);

  const index = resolveIndexState(project, cliPath, deps);

  return {
    schema_version: 1,
    project,
    cli,
    index,
    cargo_workspace: cargo.workspace,
    cargo_workspace_reason: cargo.reason,
  };
}

function resolveIndexState(
  project: string,
  cliPath: string | null,
  deps?: CodegraphReportDeps,
): CodegraphReport["index"] {
  if (cliPath === null) {
    return { state: "absent", reason: "codegraph CLI not on PATH (optional partner)" };
  }
  if (!existsSync(join(project, ".codegraph"))) {
    return { state: "not_indexed", reason: `run: codegraph init ${project}` };
  }
  const runFn = deps?.runStatusJson ?? defaultRunStatusJson;
  const status = runFn(project);
  if (!status.ok) {
    return { state: "error", reason: status.error };
  }
  if (!status.data.initialized) {
    return { state: "not_indexed", reason: `run: codegraph init ${project}` };
  }
  return {
    state: "indexed",
    node_count: status.data.nodeCount ?? 0,
    file_count: status.data.fileCount ?? 0,
    edge_count: status.data.edgeCount ?? 0,
  };
}

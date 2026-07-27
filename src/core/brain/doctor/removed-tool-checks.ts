/**
 * References to MCP tools removed in the 1.0.0 deprecation sweep.
 *
 * One reason to change: the removed-surface table. The scan exists so an
 * operator upgrading an old vault learns each migration from the doctor
 * output rather than from a tombstone error at call time.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { REMOVED_TOOLS } from "../../removed-surfaces.ts";
import { brainDirs } from "../paths.ts";
import type { DoctorCheck } from "./check.ts";

/** Word-boundary regex per removed tool name, compiled once. */
const REMOVED_TOOL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze(
  Object.keys(REMOVED_TOOLS).map((name) => ({
    name,
    // \b treats `_` as a word character, so `my_brain_digestion` does
    // not match `brain_digest` but `call brain_digest.` does.
    pattern: new RegExp(`\\b${name}\\b`),
  })),
);

/** Hard cap so a pathological vault cannot flood the doctor report. */
const REMOVED_TOOL_MAX_WARNINGS = 50;

/** Root instruction files the scan reads beside the Brain tree. */
const ROOT_INSTRUCTION_FILES: ReadonlyArray<string> = Object.freeze(["CLAUDE.md", "AGENTS.md"]);

/**
 * Scan vault-side text surfaces for references to MCP tools removed
 * in 1.0.0. Scope is exactly what the doctor can see locally:
 *
 *   - every Markdown file under `Brain/` (recursive),
 *   - root instruction files (`CLAUDE.md`, `AGENTS.md`),
 *   - installed skills under `.claude/skills/` (recursive `.md`).
 *
 * One warning per file lists every removed name it mentions with the
 * replacement spelling, mirroring the server-side tombstone error.
 */
export const removedToolReferenceCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues }) {
    const candidates: string[] = [];
    const dirs = brainDirs(vault);
    collectMarkdownFiles(dirs.brain, candidates);
    for (const name of ROOT_INSTRUCTION_FILES) {
      const p = join(vault, name);
      try {
        if (existsSync(p) && statSync(p).isFile()) candidates.push(p);
      } catch {
        // One unreadable root file must not disable the whole scan.
      }
    }
    collectMarkdownFiles(join(vault, ".claude", "skills"), candidates);

    let emitted = 0;
    for (const path of candidates) {
      if (emitted >= REMOVED_TOOL_MAX_WARNINGS) return;
      let body: string;
      try {
        body = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const hits: string[] = [];
      for (const { name, pattern } of REMOVED_TOOL_PATTERNS) {
        if (pattern.test(body)) hits.push(name);
      }
      if (hits.length === 0) continue;
      const replacements = hits
        .map((name) => {
          const record = REMOVED_TOOLS[name]!;
          return `${name} -> ${record.target} view="${record.view}"`;
        })
        .join("; ");
      issues.push({
        severity: "warning",
        code: "removed-tool-reference",
        message:
          `${relative(vault, path)} references tool(s) removed in 1.0.0: ` +
          `${replacements} (see docs/updating.md)`,
      });
      emitted += 1;
    }
  },
};

/** Recursive `.md` collection, fail-soft on unreadable directories. */
function collectMarkdownFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdownFiles(p, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
}

/**
 * References to MCP tools removed in the 1.0.0 deprecation sweep.
 *
 * One reason to change: the removed-surface table. The scan exists so an
 * operator upgrading an old vault learns each migration from the doctor
 * output rather than from a tombstone error at call time.
 */

import { statSync } from "node:fs";
import { join, relative } from "node:path";

import { REMOVED_TOOLS } from "../../removed-surfaces.ts";
import { brainDirs } from "../paths.ts";
import type { DoctorCheck } from "./check.ts";
import {
  readSweptDir,
  readSweptFile,
  reportSweptFailure,
  reportSweptSkip,
  SWEEP_ORIGIN,
  type SweepOrigin,
  type SweptPath,
} from "./unreadable-path.ts";

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

/** Subsystem name the scan reports an unreadable path under. */
const REMOVED_TOOL_SITE = "brain.doctor.removedToolReference";

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
 *
 * A directory it cannot list and a file it cannot open are reported as
 * uncertainty rather than skipped: an unscanned surface produces no
 * warning, which is the same output as a surface that mentions nothing
 * removed, and only one of those means the vault has no migration left
 * to do.
 */
export const removedToolReferenceCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues, uncertain }) {
    const candidates: string[] = [];
    const dirs = brainDirs(vault);
    const swept: SweptPath = {
      site: REMOVED_TOOL_SITE,
      consequence:
        "it was not scanned for references to tools removed in 1.0.0, so any migration it " +
        "still needs is missing from this report",
      uncertain,
    };
    collectMarkdownFiles(dirs.brain, candidates, swept, SWEEP_ORIGIN.root);
    for (const name of ROOT_INSTRUCTION_FILES) {
      const p = join(vault, name);
      try {
        if (statSync(p).isFile()) candidates.push(p);
      } catch (err) {
        // One unreadable root file must not disable the whole scan - but
        // it is not the same answer as a vault that has no CLAUDE.md.
        reportSweptFailure(p, "instruction file stat failed", err, swept, SWEEP_ORIGIN.root);
      }
    }
    collectMarkdownFiles(join(vault, ".claude", "skills"), candidates, swept, SWEEP_ORIGIN.root);

    let emitted = 0;
    for (const path of candidates) {
      if (emitted >= REMOVED_TOOL_MAX_WARNINGS) return;
      // Every candidate was listed by the walk a moment ago, so an
      // ENOENT here is a file that vanished under it.
      const body = readSweptFile(path, swept, SWEEP_ORIGIN.discovered);
      if (body === null) continue;
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

/**
 * Recursive `.md` collection; an unreadable directory is reported, not
 * dropped. No `existsSync` gate stands in front of the listing: that
 * call returns false for a permission denial on a PARENT component
 * exactly as it does for an absent directory, so it answered the
 * absent-or-unreadable question the sweep is here to ask - and answered
 * it wrong for the vault whose `.claude/` an operator locked down.
 *
 * An entry that is neither a regular file nor a directory - a symlink,
 * which `Dirent` reports as neither - is named rather than skipped. The
 * link is deliberately not followed (the store's rule: a reader that
 * follows a link has already left it), so its Markdown is content this
 * scan did not read, which is what the uncertainty stream is for.
 */
function collectMarkdownFiles(
  dir: string,
  out: string[],
  swept: SweptPath,
  origin: SweepOrigin,
): void {
  const entries = readSweptDir(dir, swept, origin);
  if (entries === null) return;
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(p, out, swept, SWEEP_ORIGIN.discovered);
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.endsWith(".md")) out.push(p);
      continue;
    }
    reportSweptSkip(
      p,
      entry.isSymbolicLink()
        ? "entry is a symbolic link, which no sweep follows out of the store"
        : "entry is neither a regular file nor a directory",
      swept,
    );
  }
}

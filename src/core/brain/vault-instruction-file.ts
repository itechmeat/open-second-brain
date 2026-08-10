/**
 * Vault-root instruction file reader.
 *
 * Reads a user-authored Markdown file at the vault root (default
 * `VAULT.md`) and returns its content plus a vault-relative path.
 * `brain_context` surfaces this alongside the auto-generated
 * `active.md` so agents see operator-curated session context.
 *
 * Distinct from `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` which the
 * v0.10.16 instruction-file-ceiling check tracks - those are
 * runtime-injected by tools; this one is Open Second Brain's own
 * surface.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { loadBrainConfig, resolveLinkGraph } from "./policy.ts";

/** Frozen result of {@link readVaultInstructionFile}. */
export interface VaultInstructionEntry {
  /** Vault-relative path of the file that was read. */
  readonly path: string;
  /** Full file content. */
  readonly content: string;
  /** Newline-delimited line count. Empty file = 0; trailing newline does not double-count. */
  readonly lines: number;
}

/**
 * Read the vault-root instruction file. Name defaults to the
 * `link_graph.vault_instruction_file` config slot (or `VAULT.md`
 * when not configured). Caller may override by passing `name`.
 *
 * Returns `null` when the file is absent, or when it is present but
 * refused by one of the boundary guards below (a symlink, a path that
 * resolves outside the vault, something that is not a regular file) -
 * in each of those cases the operator named something this reader will
 * not treat as an instruction file.
 *
 * Throws on a relative path that escapes the vault, an absolute-path
 * name, an empty name, and on a file that EXISTS but cannot be read.
 * The last one used to return `null` as well, which made an unreadable
 * instruction file indistinguishable from a vault that has none: the
 * field vanished from `brain_context` and the operator was told nothing.
 */
export function readVaultInstructionFile(
  vault: string,
  name?: string,
): VaultInstructionEntry | null {
  const resolvedName = resolveName(vault, name);
  if (isAbsolute(resolvedName)) {
    throw new Error(
      `vault_instruction_file must be vault-relative, got absolute path: ${resolvedName}`,
    );
  }
  if (resolvedName.length === 0) {
    throw new Error("vault_instruction_file must not be empty");
  }
  if (resolvedName.split(/[\\/]/).includes("..")) {
    throw new Error(`vault_instruction_file must not contain '..' segments: ${resolvedName}`);
  }
  const full = join(vault, resolvedName);
  if (!existsSync(full)) return null;
  let content: string;
  try {
    // Resolve the vault root once so the boundary check is
    // immune to the vault path itself being a symlink.
    const vaultReal = realpathSync(vault);
    // Reject symlinks at the candidate path - a symlink at
    // `<vault>/VAULT.md` pointing outside the vault would
    // otherwise bypass the relative-path guards via the
    // symlink-following `statSync` + `readFileSync` below.
    if (lstatSync(full).isSymbolicLink()) return null;
    const fullReal = realpathSync(full);
    const rel = relative(vaultReal, fullReal);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }
    const st = statSync(fullReal);
    if (!st.isFile()) return null;
    content = readFileSync(fullReal, "utf8");
  } catch (err) {
    // `existsSync` already said the file is there, so this is a failure
    // to read it rather than an absence. Reporting it as `null` would
    // put a permission error and an empty vault on the same wire.
    throw new Error(
      `vault instruction file ${full} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const lines = countLines(content);
  return Object.freeze({
    path: resolvedName,
    content,
    lines,
  });
}

function resolveName(vault: string, override?: string): string {
  if (override !== undefined) return override.trim();
  try {
    const cfg = loadBrainConfig(vault);
    return resolveLinkGraph(cfg).vault_instruction_file;
  } catch {
    return "VAULT.md";
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  // `\n` count == line count for both trailing-newline and
  // no-trailing-newline files. "line\nline\n" → 2; "line\nline" → 2.
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a) count++;
  }
  // Trailing chunk without `\n` still counts as a line.
  if (content.charCodeAt(content.length - 1) !== 0x0a) count++;
  return count;
}

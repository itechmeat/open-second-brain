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

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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
 * Returns `null` when the file is absent. Throws on a relative
 * path that escapes the vault or an absolute-path name (we never
 * resolve outside the vault root).
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
    throw new Error(
      `vault_instruction_file must not contain '..' segments: ${resolvedName}`,
    );
  }
  const full = join(vault, resolvedName);
  if (!existsSync(full)) return null;
  let content: string;
  try {
    const st = statSync(full);
    if (!st.isFile()) return null;
    content = readFileSync(full, "utf8");
  } catch {
    return null;
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

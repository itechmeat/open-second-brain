/**
 * Claude Code memory backend (Agent Write Contract Suite, t_53f9f67f).
 *
 * Pure delegation to the existing `claude-memory-*` modules - no logic
 * moves, no behavior changes. The adapter exists so the import flow
 * resolves its format functions through the registry seam; with the
 * default backend the output stays byte-identical to calling the
 * modules directly (regression-tested).
 */

import { readdirSync } from "node:fs";

import { defaultMemoryDir } from "../claude-memory-paths.ts";
import { parseClaudeMemoryFile } from "../claude-memory-parser.ts";
import { renderPreferenceFromMemory, slugifyMemoryName } from "../claude-memory-render.ts";
import type { MemoryRenderInput, MemorySourceBackend, MemorySourceParse } from "./types.ts";

export const claudeMemoryBackend: MemorySourceBackend = Object.freeze({
  id: "claude",
  label: "Claude Code",
  discoverMemoryDir(vault: string): string {
    return defaultMemoryDir(vault);
  },
  discoverMemoryFiles(dir: string): string[] {
    // One memory file per `.md`, minus the human-facing index. Sorted for a
    // deterministic import order - identical to the walk the core used before
    // the seam widened.
    return readdirSync(dir)
      .toSorted()
      .filter((name) => name !== "MEMORY.md" && name.endsWith(".md"));
  },
  parseMemoryEntries(text: string): MemorySourceParse[] {
    // A Claude memory file is exactly one entry (feedback or skip).
    return [parseClaudeMemoryFile(text)];
  },
  renderPreference(input: MemoryRenderInput): string {
    return renderPreferenceFromMemory(input);
  },
  slugifyName(name: string): string {
    return slugifyMemoryName(name);
  },
});

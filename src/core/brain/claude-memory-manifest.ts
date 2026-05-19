import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";

export interface ClaudeMemoryManifestEntry {
  readonly pref_id: string;
  readonly sha256: string;
  readonly imported_at: string;
}

export interface ClaudeMemoryManifest {
  readonly version: 1;
  readonly imports: Readonly<Record<string, ClaudeMemoryManifestEntry>>;
}

function manifestPath(vault: string): string {
  return join(vault, "Brain", ".imports", "claude-memory.json");
}

/**
 * Load the import-history sidecar. Treats a missing file as "empty
 * manifest" — first-time imports rely on this. Type-validates the
 * parsed `imports` field defensively: a malformed file (hand-edited
 * to non-object, truncated, etc.) returns the empty shape rather than
 * propagating an unknown blob into the rest of the import pipeline.
 */
export function loadManifest(vault: string): ClaudeMemoryManifest {
  const p = manifestPath(vault);
  if (!existsSync(p)) return { version: 1, imports: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { version: 1, imports: {} };
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof (raw as { imports?: unknown }).imports !== "object" ||
    (raw as { imports?: unknown }).imports === null ||
    Array.isArray((raw as { imports?: unknown }).imports)
  ) {
    return { version: 1, imports: {} };
  }
  return {
    version: 1,
    imports: (raw as { imports: Record<string, ClaudeMemoryManifestEntry> }).imports,
  };
}

export function saveManifest(vault: string, m: ClaudeMemoryManifest): void {
  const p = manifestPath(vault);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(m, null, 2) + "\n");
}

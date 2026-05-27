/**
 * Sidecar manifest I/O for install adapters.
 *
 * Records exactly what each install wrote to disk, so `uninstall`
 * removes only OSB-owned content and never user-authored config.
 * One file per vault at `<vault>/.open-second-brain/install.lock.json`.
 *
 * Schema (`schema_version: 1`):
 *
 * ```
 * {
 *   "schema_version": 1,
 *   "installs": {
 *     "<target>": { ...ManifestEntry }
 *   }
 * }
 * ```
 *
 * Unknown top-level keys are tolerated (forward-compat). Unknown
 * `schema_version` is a hard error — refuse to read.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import type { ManifestEntry } from "./types.ts";

const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([1]);

export interface Manifest {
  readonly schema_version: 1;
  readonly installs: Record<string, ManifestEntry>;
}

export function manifestPath(vault: string): string {
  return join(vault, ".open-second-brain", "install.lock.json");
}

export function readManifest(vault: string): Manifest {
  const path = manifestPath(vault);
  if (!existsSync(path)) {
    return { schema_version: 1, installs: {} };
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `install manifest is corrupted JSON: ${path}\n` + `Original error: ${(e as Error).message}`,
      { cause: e },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`install manifest is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  const sv = obj["schema_version"];
  if (typeof sv !== "number" || !SUPPORTED_SCHEMA_VERSIONS.has(sv)) {
    throw new Error(
      `install manifest schema_version ${sv} not supported (expected one of ${Array.from(SUPPORTED_SCHEMA_VERSIONS).join(", ")}): ${path}`,
    );
  }
  const installs = (obj["installs"] ?? {}) as Record<string, ManifestEntry>;
  return { schema_version: 1, installs };
}

export function recordEntry(vault: string, entry: ManifestEntry): void {
  const current = readManifest(vault);
  const next: Manifest = {
    schema_version: 1,
    installs: { ...current.installs, [entry.target]: entry },
  };
  writeManifest(vault, next);
}

export function removeEntry(vault: string, target: string): void {
  const current = readManifest(vault);
  if (!(target in current.installs)) return;
  const installs = { ...current.installs };
  delete installs[target];
  writeManifest(vault, { schema_version: 1, installs });
}

function writeManifest(vault: string, m: Manifest): void {
  const path = manifestPath(vault);
  // ensureDir is handled by atomicWriteFileSync via mkdirSync — but the
  // helper does not create the parent. Call mkdir explicitly.
  const dir = dirname(path);
  ensureDir(dir);
  const json = JSON.stringify(m, null, 2) + "\n";
  atomicWriteFileSync(path, json);
}

function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
}

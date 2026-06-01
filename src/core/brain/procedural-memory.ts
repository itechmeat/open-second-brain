import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { parseFrontmatter } from "../vault.ts";
import {
  proceduralMemoryIndexPath,
  proceduralMemoryUsagePath,
} from "./paths.ts";

export type ProceduralEntryKind = "skill" | "runbook" | "procedure";

export interface ProceduralMemoryEntry {
  readonly id: string;
  readonly kind: ProceduralEntryKind;
  readonly sourcePath: string;
  readonly title: string;
  readonly triggers: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly source: string | null;
  readonly version: string | null;
  readonly lastUsedAt: string | null;
  readonly usedCount: number;
}

export interface ProceduralReconcileOptions {
  readonly roots: ReadonlyArray<string>;
}

export interface ProceduralReconcileResult {
  readonly total: number;
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
}

export function reconcileProceduralMemory(
  vault: string,
  opts: ProceduralReconcileOptions,
): ProceduralReconcileResult {
  const prev = new Map(
    listProceduralMemory(vault).map((entry) => [entry.id, entry] as const),
  );
  const usage = readUsageMap(vault);
  const next = collectEntries(vault, opts.roots).map((entry) => {
    const old = prev.get(entry.id);
    const used = usage.get(entry.id);
    return {
      ...entry,
      lastUsedAt: used?.lastUsedAt ?? old?.lastUsedAt ?? null,
      usedCount: used?.usedCount ?? old?.usedCount ?? 0,
    } satisfies ProceduralMemoryEntry;
  });

  const nextById = new Map(next.map((entry) => [entry.id, entry] as const));
  let added = 0;
  let updated = 0;

  for (const entry of next) {
    const old = prev.get(entry.id);
    if (!old) {
      added++;
      continue;
    }
    if (JSON.stringify(old) !== JSON.stringify(entry)) {
      updated++;
    }
  }

  let removed = 0;
  for (const id of prev.keys()) {
    if (!nextById.has(id)) removed++;
  }

  writeIndex(vault, next);
  return { total: next.length, added, updated, removed };
}

export function listProceduralMemory(
  vault: string,
): ReadonlyArray<ProceduralMemoryEntry> {
  const path = proceduralMemoryIndexPath(vault);
  if (!existsSync(path)) return Object.freeze([]);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      entries?: Array<ProceduralMemoryEntry>;
    };
    if (!Array.isArray(parsed.entries)) return Object.freeze([]);
    return Object.freeze(parsed.entries);
  } catch {
    return Object.freeze([]);
  }
}

export function markProceduralMemoryUsed(
  vault: string,
  id: string,
  now: Date = new Date(),
): ProceduralMemoryEntry | null {
  const entries = listProceduralMemory(vault);
  const target = entries.find((entry) => entry.id === id);
  if (!target) return null;

  const next = entries.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          usedCount: entry.usedCount + 1,
          lastUsedAt: now.toISOString(),
        }
      : entry,
  );
  writeIndex(vault, next);

  const usage = readUsageMap(vault);
  const prev = usage.get(id);
  usage.set(id, {
    usedCount: (prev?.usedCount ?? 0) + 1,
    lastUsedAt: now.toISOString(),
  });
  writeUsageMap(vault, usage);

  return next.find((entry) => entry.id === id) ?? null;
}

function collectEntries(
  vault: string,
  roots: ReadonlyArray<string>,
): ProceduralMemoryEntry[] {
  const out: ProceduralMemoryEntry[] = [];

  for (const root of roots) {
    const safeRoot = ensureInsideVault(root, vault);
    if (!existsSync(safeRoot)) continue;

    for (const filePath of walkMarkdown(safeRoot)) {
      const rel = toVaultRelative(vault, filePath);
      const detectedKind = detectKind(rel);
      if (detectedKind === null) continue;

      const [fm, body] = parseFrontmatter(filePath);
      const title = extractTitle(body, rel);
      const id = entryId(rel);
      out.push({
        id,
        kind: detectedKind,
        sourcePath: rel,
        title,
        triggers: asStringArray(fm["triggers"]),
        tags: asStringArray(fm["tags"]),
        permissions: asStringArray(fm["permissions"]),
        source: asStringOrNull(fm["source"]),
        version: asStringOrNull(fm["version"]),
        lastUsedAt: null,
        usedCount: 0,
      });
    }
  }

  return out.toSorted((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
}

function detectKind(vaultRelPath: string): ProceduralEntryKind | null {
  if (vaultRelPath.startsWith("Brain/procedures/")) return "procedure";
  if (vaultRelPath.endsWith("/SKILL.md")) return "skill";
  if (
    vaultRelPath.endsWith(".prompt.md") ||
    vaultRelPath.endsWith("runbook.md")
  )
    return "runbook";
  return null;
}

function extractTitle(body: string, fallbackPath: string): string {
  for (const line of body.split("\n")) {
    if (line.startsWith("# ")) {
      const title = line.slice(2).trim();
      if (title) return title;
    }
  }
  const parts = fallbackPath.split("/");
  return parts[parts.length - 1] ?? fallbackPath;
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(path);
      } else if (st.isFile() && name.endsWith(".md")) {
        out.push(path);
      }
    }
  }

  return out;
}

function toVaultRelative(vault: string, absPath: string): string {
  const rel = relative(vault, absPath).replaceAll("\\", "/");
  return rel;
}

function entryId(sourcePath: string): string {
  const hash = createHash("sha256")
    .update(sourcePath, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `pmem-${hash}`;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof value === "string" && value.trim().length > 0)
    return [value.trim()];
  return [];
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function writeIndex(
  vault: string,
  entries: ReadonlyArray<ProceduralMemoryEntry>,
): void {
  const path = proceduralMemoryIndexPath(vault);
  mkdirSync(ensureInsideVault(dirname(path), vault), { recursive: true });
  const payload = JSON.stringify(
    {
      schema_version: 1,
      entries,
    },
    null,
    2,
  );
  atomicWriteFileSync(path, `${payload}\n`);
}

function readUsageMap(
  vault: string,
): Map<string, { usedCount: number; lastUsedAt: string | null }> {
  const path = proceduralMemoryUsagePath(vault);
  if (!existsSync(path)) return new Map();

  const out = new Map<
    string,
    { usedCount: number; lastUsedAt: string | null }
  >();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = typeof parsed["id"] === "string" ? parsed["id"] : null;
      if (!id) continue;
      out.set(id, {
        usedCount:
          typeof parsed["usedCount"] === "number" ? parsed["usedCount"] : 0,
        lastUsedAt:
          typeof parsed["lastUsedAt"] === "string"
            ? parsed["lastUsedAt"]
            : null,
      });
    } catch {
      continue;
    }
  }
  return out;
}

function writeUsageMap(
  vault: string,
  usage: ReadonlyMap<string, { usedCount: number; lastUsedAt: string | null }>,
): void {
  const path = proceduralMemoryUsagePath(vault);
  mkdirSync(ensureInsideVault(dirname(path), vault), { recursive: true });
  const lines: string[] = [];
  for (const [id, value] of [...usage.entries()].toSorted((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    lines.push(
      JSON.stringify({
        id,
        usedCount: value.usedCount,
        lastUsedAt: value.lastUsedAt,
      }),
    );
  }
  atomicWriteFileSync(
    path,
    `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`,
  );
}

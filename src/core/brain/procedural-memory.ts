import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { parseFrontmatter } from "../vault.ts";
import { rebuildProceduralHints } from "./procedural-hints.ts";
import { rebuildProceduralGraph } from "./procedural-graph.ts";
import { proceduralMemoryIndexPath, proceduralMemoryUsagePath } from "./paths.ts";
import type { ProceduralEntryKind, ProceduralMemoryEntry, ProceduralOutcome } from "./types.ts";

interface UsageRecord {
  readonly usedCount: number;
  readonly lastUsedAt: string | null;
  readonly successCount: number;
  readonly failureCount: number;
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
  const prev = new Map(listProceduralMemory(vault).map((entry) => [entry.id, entry] as const));
  const usage = readUsageMap(vault);
  const next = collectEntries(vault, opts.roots).map((entry) => {
    const old = prev.get(entry.id);
    const used = usage.get(entry.id);
    return {
      ...entry,
      lastUsedAt: used?.lastUsedAt ?? old?.lastUsedAt ?? null,
      usedCount: used?.usedCount ?? old?.usedCount ?? 0,
      successCount: used?.successCount ?? old?.successCount ?? 0,
      failureCount: used?.failureCount ?? old?.failureCount ?? 0,
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
  const graph = rebuildProceduralGraph(vault);
  rebuildProceduralHints(vault, { graph });
  return { total: next.length, added, updated, removed };
}

export function listProceduralMemory(vault: string): ReadonlyArray<ProceduralMemoryEntry> {
  const path = proceduralMemoryIndexPath(vault);
  if (!existsSync(path)) return Object.freeze([]);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      entries?: Array<ProceduralMemoryEntry>;
    };
    if (!Array.isArray(parsed.entries)) return Object.freeze([]);
    // Normalize additive outcome fields so a pre-outcome index (written
    // before t_703f7b18) reads with defaults instead of `undefined`.
    return Object.freeze(
      parsed.entries.map((entry) =>
        Object.freeze({
          ...entry,
          successCount: typeof entry.successCount === "number" ? entry.successCount : 0,
          failureCount: typeof entry.failureCount === "number" ? entry.failureCount : 0,
        }),
      ),
    );
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Validated success rate in [0, 1], or null when the procedure has no
 * recorded outcomes yet. `successes / (successes + failures)`.
 */
export function proceduralSuccessRate(entry: ProceduralMemoryEntry): number | null {
  const total = entry.successCount + entry.failureCount;
  return total > 0 ? entry.successCount / total : null;
}

/**
 * Rank procedures by validated success rate, not raw usage (t_703f7b18).
 * Proven-successful procedures rise, proven-failing ones sink, and
 * procedures with no recorded outcomes sit in a neutral band ordered by
 * the usage prior (usedCount then recency). Deterministic; no LLM.
 */
export function rankProceduralMemory(
  entries: ReadonlyArray<ProceduralMemoryEntry>,
): ReadonlyArray<ProceduralMemoryEntry> {
  const NEUTRAL = 0.5;
  const key = (e: ProceduralMemoryEntry): number => proceduralSuccessRate(e) ?? NEUTRAL;
  return [...entries].toSorted((a, b) => {
    const ra = key(a);
    const rb = key(b);
    if (ra !== rb) return rb - ra;
    if (a.usedCount !== b.usedCount) return b.usedCount - a.usedCount;
    const la = a.lastUsedAt ?? "";
    const lb = b.lastUsedAt ?? "";
    if (la !== lb) return la < lb ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
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
    successCount: prev?.successCount ?? 0,
    failureCount: prev?.failureCount ?? 0,
  });
  writeUsageMap(vault, usage);
  const graph = rebuildProceduralGraph(vault);
  rebuildProceduralHints(vault, { graph });

  return next.find((entry) => entry.id === id) ?? null;
}

/**
 * Record the host-reported OUTCOME of applying a procedure (t_703f7b18).
 * Increments successCount or failureCount on the entry and the usage
 * sidecar; does NOT touch usedCount or lastUsedAt (that is
 * {@link markProceduralMemoryUsed}). The kernel never infers the outcome -
 * it is a structured enum supplied by the host, mirroring
 * `brain_apply_evidence`. Returns the updated entry, or null for an
 * unknown id. The fold is order-insensitive.
 */
export function recordProceduralOutcome(
  vault: string,
  id: string,
  outcome: ProceduralOutcome,
): ProceduralMemoryEntry | null {
  const entries = listProceduralMemory(vault);
  const target = entries.find((entry) => entry.id === id);
  if (!target) return null;

  const next = entries.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          successCount: entry.successCount + (outcome === "success" ? 1 : 0),
          failureCount: entry.failureCount + (outcome === "failure" ? 1 : 0),
        }
      : entry,
  );
  writeIndex(vault, next);

  const usage = readUsageMap(vault);
  const prev = usage.get(id);
  usage.set(id, {
    usedCount: prev?.usedCount ?? target.usedCount,
    lastUsedAt: prev?.lastUsedAt ?? target.lastUsedAt,
    successCount: (prev?.successCount ?? 0) + (outcome === "success" ? 1 : 0),
    failureCount: (prev?.failureCount ?? 0) + (outcome === "failure" ? 1 : 0),
  });
  writeUsageMap(vault, usage);
  const graph = rebuildProceduralGraph(vault);
  rebuildProceduralHints(vault, { graph });

  return next.find((entry) => entry.id === id) ?? null;
}

function collectEntries(vault: string, roots: ReadonlyArray<string>): ProceduralMemoryEntry[] {
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
        successCount: 0,
        failureCount: 0,
      });
    }
  }

  return out.toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function detectKind(vaultRelPath: string): ProceduralEntryKind | null {
  if (vaultRelPath.startsWith("Brain/procedures/")) return "procedure";
  if (vaultRelPath.endsWith("/SKILL.md")) return "skill";
  if (vaultRelPath.endsWith(".prompt.md") || vaultRelPath.endsWith("runbook.md")) return "runbook";
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
  const hash = createHash("sha256").update(sourcePath, "utf8").digest("hex").slice(0, 12);
  return `pmem-${hash}`;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function writeIndex(vault: string, entries: ReadonlyArray<ProceduralMemoryEntry>): void {
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

function readUsageMap(vault: string): Map<string, UsageRecord> {
  const path = proceduralMemoryUsagePath(vault);
  if (!existsSync(path)) return new Map();

  const out = new Map<string, UsageRecord>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = typeof parsed["id"] === "string" ? parsed["id"] : null;
      if (!id) continue;
      out.set(id, {
        usedCount: typeof parsed["usedCount"] === "number" ? parsed["usedCount"] : 0,
        lastUsedAt: typeof parsed["lastUsedAt"] === "string" ? parsed["lastUsedAt"] : null,
        successCount: typeof parsed["successCount"] === "number" ? parsed["successCount"] : 0,
        failureCount: typeof parsed["failureCount"] === "number" ? parsed["failureCount"] : 0,
      });
    } catch {
      continue;
    }
  }
  return out;
}

function writeUsageMap(vault: string, usage: ReadonlyMap<string, UsageRecord>): void {
  const path = proceduralMemoryUsagePath(vault);
  mkdirSync(ensureInsideVault(dirname(path), vault), { recursive: true });
  const lines: string[] = [];
  for (const [id, value] of [...usage.entries()].toSorted((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    // Omit zero outcome counters so an outcome-free vault's usage file stays
    // byte-identical to the pre-t_703f7b18 format.
    const record: Record<string, unknown> = {
      id,
      usedCount: value.usedCount,
      lastUsedAt: value.lastUsedAt,
    };
    if (value.successCount > 0) record["successCount"] = value.successCount;
    if (value.failureCount > 0) record["failureCount"] = value.failureCount;
    lines.push(JSON.stringify(record));
  }
  atomicWriteFileSync(path, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
}

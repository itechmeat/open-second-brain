import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { privateWithheld, withPrivateShown } from "../store/caller-reach.ts";
import { lanePlaceOf } from "../store/lane-paths.ts";
import { opaqueFields } from "../store/operation-privacy.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";

import { ensureInsideVault } from "../path-safety.ts";
import { rebuildProceduralHints } from "./procedural-hints.ts";
import {
  readProceduralState,
  rebuildProceduralGraph,
  writeMachineStateText,
} from "./procedural-graph.ts";
import { proceduralMemoryIndexPath, proceduralMemoryUsagePath } from "./paths.ts";
import type { ProceduralEntryKind, ProceduralMemoryEntry, ProceduralOutcome } from "./types.ts";
import {
  assertLaneWrite,
  laneEntryInPrivate,
  lanePageExists,
  lanePagesInStore,
  listLaneTree,
  parseLanePage,
  writeLaneText,
  readLaneFile,
  readLanePage,
  withLaneLock,
} from "../store/lane-pages.ts";

interface UsageRecord {
  readonly usedCount: number;
  readonly lastUsedAt: string | null;
  readonly successCount: number;
  readonly failureCount: number;
}

export interface ProceduralReconcileOptions {
  readonly roots: ReadonlyArray<string>;
  /**
   * May the caller read the page at this vault-relative path? The index
   * is written in full either way; only the counts this call reports are
   * taken over the pages the caller may read, so they match the counts a
   * vault without the other pages would give. Absent, every page counts.
   */
  readonly include?: (rel: string) => boolean;
}

export interface ProceduralReconcileResult {
  readonly total: number;
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
}

/**
 * Reconcile the index with the procedure pages under `opts.roots`. Built
 * and written whole whatever the caller's reach (design D5 item 4): the
 * index and the projections are what every later caller reads, so a
 * caller below local reach stores what a local run stores; only the
 * counts it is answered are taken over the pages it may read (`include`).
 */
export function reconcileProceduralMemory(
  vault: string,
  opts: ProceduralReconcileOptions,
): ProceduralReconcileResult {
  return withPrivateShown(() => reconcileWhole(vault, opts));
}

function reconcileWhole(
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
  const counted = (entry: ProceduralMemoryEntry): boolean =>
    opts.include?.(entry.sourcePath) ?? true;
  let added = 0;
  let updated = 0;

  for (const entry of next) {
    if (!counted(entry)) continue;
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
  for (const [id, old] of prev) {
    if (!nextById.has(id) && counted(old)) removed++;
  }

  // The counters live in the usage file only: the index is written without
  // them, so counters an older index still carries move into it here,
  // before the index loses them (a failed rebuild after the index write
  // must not leave them nowhere). The file is read again under its lock,
  // and only an entry it does not name takes the index's counters: a tick
  // another process counted since the read above is kept.
  assertLaneWrite(vault);
  withUsageLock(vault, () => {
    const fresh = readUsageMap(vault, true);
    for (const [id, used] of usageOf(next)) if (!fresh.has(id)) fresh.set(id, used);
    writeUsageMap(vault, fresh);
  });
  writeProjections(vault, next, () => writeIndex(vault, next));
  return { total: next.filter(counted).length, added, updated, removed };
}

/**
 * The entries of the index. The index is one store record naming every
 * procedure, which lands in `private` when one entry names a private
 * page, so it is read whole; below local reach an entry is then kept only
 * when its page is no store-held lane entry, or one the caller's fold
 * holds outside the `private` partition (design D5 item 3): a
 * private-partition procedure neither shows nor hides the shared ones.
 */
export function listProceduralMemory(
  vault: string,
  configPath?: string,
): ReadonlyArray<ProceduralMemoryEntry> {
  const entries = withPrivateShown(() => readIndexEntries(vault));
  if (!privateWithheld()) return entries;
  return Object.freeze(
    entries.filter((entry: unknown) => sharedBelowReach(vault, entry, configPath)),
  );
}

/**
 * Whether a caller below local reach may be told of the index row
 * `entry`: a row that is no object or has no string `sourcePath` cannot be
 * judged and is dropped (fail closed), as is one whose judgement fails.
 */
function sharedBelowReach(
  vault: string,
  entry: unknown,
  configPath?: string,
): entry is ProceduralMemoryEntry {
  if (entry === null || typeof entry !== "object") return false;
  const rel = (entry as { readonly sourcePath?: unknown }).sourcePath;
  if (typeof rel !== "string" || rel === "") return false;
  const prefix = `${BRAIN_ROOT_REL}/`;
  try {
    if (!rel.startsWith(prefix) || !lanePagesInStore(vault, configPath)) return true;
    if (lanePlaceOf(rel.slice(prefix.length)) === null) return true;
    const path = join(vault, rel);
    return (
      readLanePage(vault, path, configPath) !== null && !laneEntryInPrivate(vault, path, configPath)
    );
  } catch {
    return false;
  }
}

function readIndexEntries(vault: string): ReadonlyArray<ProceduralMemoryEntry> {
  const path = proceduralMemoryIndexPath(vault);
  if (!lanePageExists(vault, path)) return Object.freeze([]);
  try {
    const parsed = JSON.parse(readLaneFile(vault, path)) as {
      entries?: Array<ProceduralMemoryEntry>;
    };
    if (!Array.isArray(parsed.entries)) return Object.freeze([]);
    const usage = readUsageMap(vault);
    // Normalize additive fields so an older index reads with defaults
    // instead of `undefined`: the outcome counters (pre-t_703f7b18) and the
    // four contract lists (pre no-dead-ends Unit I). The counters come from
    // the usage file; an index written before they moved there still
    // carries its own, read for an entry the usage file does not name.
    return Object.freeze(
      parsed.entries.map((entry) =>
        Object.freeze({
          ...entry,
          ...counters(entry, usage.get(entry.id)),
          prerequisites: asStringArray(entry.prerequisites),
          rollback: asStringArray(entry.rollback),
          sideEffects: asStringArray(entry.sideEffects),
          verification: asStringArray(entry.verification),
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

  return writeUsageTick(vault, entries, target, (current) => ({
    ...current,
    usedCount: current.usedCount + 1,
    lastUsedAt: now.toISOString(),
  }));
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

  return writeUsageTick(vault, entries, target, (current) => ({
    ...current,
    successCount: current.successCount + (outcome === "success" ? 1 : 0),
    failureCount: current.failureCount + (outcome === "failure" ? 1 : 0),
  }));
}

/**
 * Record one tick of `target`'s counters: only the usage file changes, a
 * file of machine state (`paths.ts`). The index, the graph and the hints
 * hold no counter, so a tick appends no store record (task 3.10).
 */
function writeUsageTick(
  vault: string,
  entries: ReadonlyArray<ProceduralMemoryEntry>,
  target: ProceduralMemoryEntry,
  tick: (current: UsageRecord) => UsageRecord,
): ProceduralMemoryEntry {
  assertLaneWrite(vault);
  // Read, counted and written under the usage file's lock, so two ticks,
  // or a tick and a reconcile, of two processes never lose one.
  return withUsageLock(vault, () => {
    // The counters are machine state of every procedure: read on the fold
    // of every partition, whatever the caller's reach (the write rule), so
    // a tick never drops the counters of a procedure held in `private`.
    const usage = withPrivateShown(() => readUsageMap(vault, true));
    for (const [id, used] of usageOf(entries)) if (!usage.has(id)) usage.set(id, used);
    const next = tick(usage.get(target.id) ?? counters(target, undefined));
    usage.set(target.id, next);
    writeUsageMap(vault, usage);
    return { ...target, ...next };
  });
}

/** Run `fn` holding the write lock of this machine's usage file. */
function withUsageLock<T>(vault: string, fn: () => T): T {
  return withLaneLock(vault, proceduralMemoryUsagePath(vault), fn);
}

/** The counters of `entry`: the usage file's when it names the entry, else the index's own. */
function counters(
  entry: Partial<ProceduralMemoryEntry>,
  used: UsageRecord | undefined,
): UsageRecord {
  if (used !== undefined) return used;
  return {
    usedCount: typeof entry.usedCount === "number" ? entry.usedCount : 0,
    lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : null,
    successCount: typeof entry.successCount === "number" ? entry.successCount : 0,
    failureCount: typeof entry.failureCount === "number" ? entry.failureCount : 0,
  };
}

/** The usage records of every entry that has been used or has an outcome. */
function usageOf(entries: ReadonlyArray<ProceduralMemoryEntry>): Map<string, UsageRecord> {
  const out = new Map<string, UsageRecord>();
  for (const entry of entries) {
    const used = counters(entry, undefined);
    const blank =
      used.usedCount === 0 &&
      used.lastUsedAt === null &&
      used.successCount === 0 &&
      used.failureCount === 0;
    if (!blank) out.set(entry.id, used);
  }
  return out;
}

/** Fields of an index entry that are counters and stamps, never page references. */
const PROJECTION_OPAQUE = opaqueFields("lastUsedAt", "usedCount", "successCount", "failureCount");

/**
 * Write the index with `write`, then rebuild the graph and hints, as ONE
 * operation: one privacy verdict over the entries every one of these
 * projections is derived from (an entry naming a private page makes them
 * all private). The graph and the hints are machine state (`paths.ts`), so
 * the verdict reaches the index only, the one store record here.
 */
function writeProjections(
  vault: string,
  entries: ReadonlyArray<ProceduralMemoryEntry>,
  write: () => void,
): void {
  const judgeVault = existsSync(vault) ? vault : null;
  withOperationPrivacy(
    () => rowNamesPrivatePage(judgeVault, { entries }, PROJECTION_OPAQUE),
    () => {
      write();
      const graph = rebuildProceduralGraph(vault);
      rebuildProceduralHints(vault, { graph });
    },
  );
}

function collectEntries(vault: string, roots: ReadonlyArray<string>): ProceduralMemoryEntry[] {
  const out: ProceduralMemoryEntry[] = [];

  for (const root of roots) {
    const safeRoot = ensureInsideVault(root, vault);
    if (!lanePageExists(vault, safeRoot)) continue;

    for (const filePath of walkMarkdown(vault, safeRoot)) {
      const rel = toVaultRelative(vault, filePath);
      const detectedKind = detectKind(rel);
      if (detectedKind === null) continue;

      const [fm, body] = parseLanePage(vault, filePath);
      const title = extractTitle(body, rel);
      const id = proceduralEntryId(rel);
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
        // Execution contract (no-dead-ends, Unit I). Same reader as the
        // trigger/tag/permission lists above: absent frontmatter is an
        // empty list, so a procedure written before the contract existed
        // reads exactly as it did.
        prerequisites: asStringArray(fm["prerequisites"]),
        rollback: asStringArray(fm["rollback"]),
        sideEffects: asStringArray(fm["side_effects"]),
        verification: asStringArray(fm["verification"]),
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

function walkMarkdown(vault: string, root: string): string[] {
  // On a store-only machine `Brain/` is a set of lane records: a root
  // inside it is read from the store only (never the stale legacy tree),
  // and a root that contains it gets the store's pages for that part and
  // a disk walk of the rest. Any other root (the user's `skills/`,
  // `runbooks/`) is walked on disk.
  const brain = join(vault, BRAIN_ROOT_REL);
  const fromStore = lanePagesInStore(vault);
  if (fromStore && isInside(brain, root)) return listLaneTree(vault, root);
  const out: string[] = fromStore && isInside(root, brain) ? [...listLaneTree(vault, brain)] : [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (fromStore && path === brain) continue;
        stack.push(path);
      } else if (st.isFile() && name.endsWith(".md")) {
        out.push(path);
      }
    }
  }

  return out;
}

/** Whether `path` is `dir` or lies below it. */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toVaultRelative(vault: string, absPath: string): string {
  const rel = relative(vault, absPath).replaceAll("\\", "/");
  return rel;
}

/**
 * Join key of a procedural-memory entry: `pmem-` plus the first 12 hex of
 * the sha256 of its VAULT-RELATIVE source path. Pure and lookup-free, so a
 * caller that knows a procedure's path (the skill-proposal accept path
 * knows it from the slug) can address its outcome record without reading
 * the index.
 */
export function proceduralEntryId(sourcePath: string): string {
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

/** The counters an index entry carries: none, they live in the usage file. */
const AT_REST = Object.freeze({
  lastUsedAt: null,
  usedCount: 0,
  successCount: 0,
  failureCount: 0,
});

function writeIndex(vault: string, entries: ReadonlyArray<ProceduralMemoryEntry>): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const path = proceduralMemoryIndexPath(vault);
  // The counters live in the usage file (machine state); the index, a lane
  // record, carries them at rest so a use never changes it.
  const payload = JSON.stringify(
    {
      schema_version: 1,
      entries: entries.map((entry) => ({ ...entry, ...AT_REST })),
    },
    null,
    2,
  );
  writeLaneText(vault, path, `${payload}\n`);
}

/**
 * This machine's usage counters. `locked`: the caller holds the usage
 * file's lock; otherwise a first adoption of the store record takes it.
 */
function readUsageMap(vault: string, locked = false): Map<string, UsageRecord> {
  const text = readProceduralState(
    vault,
    proceduralMemoryUsagePath(vault),
    locked ? undefined : (write) => withUsageLock(vault, write),
  );
  if (text === null) return new Map();

  const out = new Map<string, UsageRecord>();
  for (const line of text.split("\n")) {
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
  writeMachineStateText(path, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
}

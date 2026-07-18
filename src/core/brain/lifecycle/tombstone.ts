/**
 * Cross-type tombstone + supersede lifecycle (Belief lifecycle suite,
 * Track A anchor, t_7d5a3589).
 *
 * A memory of ANY type - preference, signal, learning note - can be
 * tombstoned without deletion: the file gains `_status: tombstoned`,
 * `tombstoned_at`, `tombstone_reason`, and (for a supersede) a
 * `superseded_by` replacement pointer. The bytes stay on disk for
 * audit; recall / inject / active.md / dream exclude tombstoned
 * entries via {@link isTombstoned}.
 *
 * `supersede` is a tombstone that also records where the belief moved:
 * the predecessor is tombstoned and pointed at its successor. A chain
 * of supersessions is walked to its live tip by {@link resolveChainTip}.
 *
 * Idempotency: re-issuing a tombstone on an already-tombstoned file is a
 * byte-identical no-op that returns the existing state and emits no
 * event.
 *
 * Import direction (design invariant): this module imports from
 * `preference.ts` / `types.ts` and the shared vault/log helpers, never
 * the reverse.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { resolveAgentName } from "../../config.ts";
import { sanitiseTextField } from "../../redactor.ts";
import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../vault.ts";
import { appendLogEvent } from "../log.ts";
import { appendDecisionChangeReceipt } from "../decisions/receipts.ts";
import { BRAIN_ROOT_REL } from "../paths.ts";
import { resolveNotePath } from "../note-path.ts";
import { isoSecond } from "../time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_TOMBSTONE_STATUS } from "../types.ts";

// ----- Constants ------------------------------------------------------------

/** On-disk frontmatter key holding a memory's operational status. */
export const LIFECYCLE_STATUS_KEY = "_status";
/** Normalized (un-prefixed) status key produced by `normalizeDerivedKeys`. */
export const LIFECYCLE_STATUS_KEY_NORMALIZED = "status";
/** Frontmatter key: ISO-8601 UTC second the tombstone was applied. */
export const TOMBSTONED_AT_KEY = "tombstoned_at";
/** Frontmatter key: operator-supplied tombstone reason. */
export const TOMBSTONE_REASON_KEY = "tombstone_reason";
/** Frontmatter key: wikilink to the successor that replaced this entry. */
export const SUPERSEDED_BY_KEY = "superseded_by";
/** Default reason stamped when a supersede does not pass an explicit one. */
export const SUPERSEDE_DEFAULT_REASON = "superseded";
/** Cap on tombstone-reason length (mirrors the note-text field cap). */
const REASON_MAX_LEN = 512;
/**
 * Hard cap on chain-walk depth. Guards against a pathological or
 * cyclic `superseded_by` graph turning {@link resolveChainTip} into an
 * unbounded loop; far beyond any realistic supersession depth.
 */
export const MAX_CHAIN_DEPTH = 64;

// ----- Errors ---------------------------------------------------------------

/** Every failure path in this module raises this typed error. */
export class TombstoneError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TombstoneError";
  }
}

// ----- Lifecycle state ------------------------------------------------------

export interface LifecycleState {
  readonly tombstoned: boolean;
  /** ISO-8601 UTC second, or `null` when not tombstoned. */
  readonly tombstonedAt: string | null;
  readonly tombstoneReason: string | null;
  /** Normalized successor wikilink (`[[...]]`), or `null`. */
  readonly supersededBy: string | null;
}

function scalar(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read the lifecycle state carried by a raw frontmatter map (the output
 * of {@link parseFrontmatter}). Tolerant of both the `_status` on-disk
 * shape and the normalized `status` shape so it works whether the caller
 * passed raw or `normalizeDerivedKeys`-processed frontmatter.
 */
export function readLifecycleState(meta: Readonly<Record<string, unknown>>): LifecycleState {
  const status =
    scalar(meta, LIFECYCLE_STATUS_KEY) ?? scalar(meta, LIFECYCLE_STATUS_KEY_NORMALIZED);
  const tombstoned = status === BRAIN_TOMBSTONE_STATUS;
  return {
    tombstoned,
    tombstonedAt: scalar(meta, TOMBSTONED_AT_KEY),
    tombstoneReason: scalar(meta, TOMBSTONE_REASON_KEY),
    supersededBy: scalar(meta, SUPERSEDED_BY_KEY),
  };
}

/**
 * True when a raw frontmatter map marks a tombstoned memory. This is the
 * shared exclusion predicate wired into recall / inject / active.md /
 * dream so a tombstoned (or superseded-non-tip, which is tombstoned with
 * a `superseded_by` pointer) entry stops appearing.
 */
export function isTombstoned(meta: Readonly<Record<string, unknown>>): boolean {
  return readLifecycleState(meta).tombstoned;
}

// ----- Link normalization ---------------------------------------------------

/**
 * Reduce a wikilink / bare id / basename to its bare identifier: strip
 * the `[[ ]]` fence and any `|alias` display suffix, then the `.md`
 * extension and directory components. Returns the trimmed identifier.
 */
export function normalizeChainLink(raw: string): string {
  let value = raw.trim();
  const fence = /^\[\[([^\]]+)\]\]$/.exec(value);
  if (fence) value = fence[1]!.trim();
  const pipe = value.indexOf("|");
  if (pipe >= 0) value = value.slice(0, pipe).trim();
  // Drop directory components and the markdown extension so a stored
  // vault-relative path and a bare basename resolve to the same node.
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (slash >= 0) value = value.slice(slash + 1);
  if (value.toLowerCase().endsWith(".md")) value = value.slice(0, -3);
  return value;
}

/** Render a bare identifier as a canonical wikilink for on-disk storage. */
function toWikilink(raw: string): string {
  return `[[${normalizeChainLink(raw)}]]`;
}

// ----- Tombstone / supersede ------------------------------------------------

export interface TombstoneInput {
  readonly vault: string;
  /** Vault-relative POSIX path of the target memory file. */
  readonly path: string;
  /** Operator-facing reason. Required, non-empty after trim. */
  readonly reason: string;
  /** Optional successor id / wikilink stored as `superseded_by`. */
  readonly supersededBy?: string;
  /** Identity override; resolver default used when omitted or blank. */
  readonly agent?: string;
  /** Wall clock for the timestamps. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Config path for `resolveAgentName`. Optional. */
  readonly configPath?: string;
}

export interface TombstoneResult {
  /** `false` when the file was already tombstoned (no-op). */
  readonly changed: boolean;
  /** Vault-relative POSIX path of the target. */
  readonly path: string;
  readonly state: LifecycleState;
  /** Identity written into the log entry (only when `changed`). */
  readonly agent?: string;
  /** ISO-8601 UTC second of the emitted event (only when `changed`). */
  readonly loggedAt?: string;
}

function relForVault(vault: string, absPath: string): string {
  return relative(vault, absPath).split("\\").join("/");
}

/**
 * Tombstone a memory of any type in place. Sets `_status: tombstoned`
 * plus `tombstoned_at` / `tombstone_reason` (and `superseded_by` when a
 * successor is supplied), preserving the body and all other frontmatter.
 * Idempotent: an already-tombstoned file is left byte-identical and the
 * existing state is returned with `changed: false`.
 */
export function tombstone(input: TombstoneInput): TombstoneResult {
  const reason = sanitiseTextField(input.reason, {
    maxLen: REASON_MAX_LEN,
    singleLine: true,
  }).trim();
  if (!reason) {
    throw new TombstoneError("tombstone: reason is required");
  }

  let abs: string;
  try {
    abs = resolveNotePath(input.vault, input.path, { mustExist: true });
  } catch (err) {
    throw new TombstoneError(
      `tombstone: target does not resolve inside the vault: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const relPath = relForVault(input.vault, abs);
  const [rawMeta, body] = parseFrontmatter(abs);

  const existing = readLifecycleState(rawMeta);
  if (existing.tombstoned) {
    // Idempotent no-op: never rewrite, never log.
    return { changed: false, path: relPath, state: existing };
  }

  const priorStatus =
    scalar(rawMeta, LIFECYCLE_STATUS_KEY) ??
    scalar(rawMeta, LIFECYCLE_STATUS_KEY_NORMALIZED) ??
    "unknown";
  const tombstonedAt = isoSecond(input.now ?? new Date());
  const supersededBy = input.supersededBy ? toWikilink(input.supersededBy) : null;

  const nextMeta: FrontmatterMap = { ...(rawMeta as FrontmatterMap) };
  nextMeta[LIFECYCLE_STATUS_KEY] = BRAIN_TOMBSTONE_STATUS;
  nextMeta[TOMBSTONED_AT_KEY] = tombstonedAt;
  nextMeta[TOMBSTONE_REASON_KEY] = reason;
  if (supersededBy !== null) nextMeta[SUPERSEDED_BY_KEY] = supersededBy;

  try {
    writeFrontmatterAtomic(abs, nextMeta, body, { overwrite: true });
  } catch (err) {
    throw new TombstoneError(`tombstone: failed to write ${relPath}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const explicitAgent = normalizeAgentArgument(input.agent ?? null);
  const agent = explicitAgent ?? resolveAgentName(input.configPath);
  appendLogEvent(input.vault, {
    timestamp: tombstonedAt,
    eventType: BRAIN_LOG_EVENT_KIND.tombstone,
    body: {
      path: relPath,
      reason,
      prior_status: priorStatus,
      ...(supersededBy !== null ? { superseded_by: supersededBy } : {}),
      agent,
    },
  });

  // Belief lifecycle suite (B4): a supersede/tombstone is a belief change,
  // so it emits a decision-change receipt. The receipt's own idempotency
  // key (subject + before + after) makes a replay a no-op, mirroring the
  // tombstone no-op above. Fail-soft: an accountability-log hiccup must
  // never fail the tombstone write itself.
  try {
    appendDecisionChangeReceipt(input.vault, {
      subject: relPath,
      before: `status:${priorStatus}`,
      after:
        supersededBy !== null
          ? `status:tombstoned superseded_by:${supersededBy}`
          : "status:tombstoned",
      actor: agent,
      rationale: reason,
      reasonCode: supersededBy !== null ? "supersede" : "tombstone",
      ...(supersededBy !== null ? { alternatives: [priorStatus] } : {}),
      ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
    });
  } catch {
    // Receipt is best-effort accountability; the tombstone frontmatter and
    // its `tombstone` log event remain authoritative.
  }

  return {
    changed: true,
    path: relPath,
    state: {
      tombstoned: true,
      tombstonedAt,
      tombstoneReason: reason,
      supersededBy,
    },
    agent,
    loggedAt: tombstonedAt,
  };
}

export interface SupersedeInput {
  readonly vault: string;
  /** Vault-relative POSIX path of the predecessor being replaced. */
  readonly predecessor: string;
  /** Successor id / wikilink that supersedes the predecessor. */
  readonly successor: string;
  /** Optional reason; defaults to {@link SUPERSEDE_DEFAULT_REASON}. */
  readonly reason?: string;
  readonly agent?: string;
  readonly now?: Date;
  readonly configPath?: string;
}

/**
 * Supersede a predecessor with a successor: tombstone the predecessor and
 * record the replacement pointer. Thin wrapper over {@link tombstone}.
 */
export function supersede(input: SupersedeInput): TombstoneResult {
  const successor = input.successor.trim();
  if (!successor) {
    throw new TombstoneError("supersede: successor is required");
  }
  return tombstone({
    vault: input.vault,
    path: input.predecessor,
    reason: input.reason ?? SUPERSEDE_DEFAULT_REASON,
    supersededBy: successor,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.configPath !== undefined ? { configPath: input.configPath } : {}),
  });
}

// ----- Chain resolution -----------------------------------------------------

export interface ChainLookupEntry {
  /** Successor wikilink / id, or `null` when this node is a tip. */
  readonly supersededBy: string | null;
}

/** Resolve a normalized node id to its chain entry, or `null` if unknown. */
export type ChainLookup = (link: string) => ChainLookupEntry | null;

export interface ResolveChainTipResult {
  /** Normalized identifier of the resolved tip. */
  readonly tip: string;
  /** Number of successor hops walked from the start. */
  readonly steps: number;
  /** True when a cycle short-circuited the walk. */
  readonly cycle: boolean;
  /**
   * True when every hop resolved to a known node. `false` when the walk
   * stopped at an id the lookup could not resolve (dangling successor).
   */
  readonly resolvedAll: boolean;
}

/**
 * Walk a chain of `superseded_by` links from `start` to its live tip.
 * Pure: the caller supplies the {@link ChainLookup}, so this is unit- and
 * property-testable without disk. Cycle- and depth-guarded.
 */
export function resolveChainTip(
  start: string,
  lookup: ChainLookup,
  opts: { readonly maxDepth?: number } = {},
): ResolveChainTipResult {
  const maxDepth = opts.maxDepth ?? MAX_CHAIN_DEPTH;
  const visited = new Set<string>();
  let current = normalizeChainLink(start);
  let steps = 0;
  visited.add(current);

  while (steps < maxDepth) {
    const entry = lookup(current);
    if (entry === null) {
      // Reached an id the lookup cannot resolve (unknown start or a
      // dangling successor): the walk stops at the last known node.
      return { tip: current, steps, cycle: false, resolvedAll: false };
    }
    if (entry.supersededBy === null || entry.supersededBy === "") {
      return { tip: current, steps, cycle: false, resolvedAll: true };
    }
    const next = normalizeChainLink(entry.supersededBy);
    if (visited.has(next)) {
      return { tip: current, steps, cycle: true, resolvedAll: true };
    }
    visited.add(next);
    current = next;
    steps++;
  }
  // Depth cap reached without terminating: treat as a pathological chain.
  return { tip: current, steps, cycle: true, resolvedAll: true };
}

/**
 * Build a {@link ChainLookup} over every markdown file under `Brain/`,
 * keyed by bare basename. Reads each file's frontmatter once. A node
 * that exists but carries no `superseded_by` resolves to a tip entry;
 * an unknown basename resolves to `null`.
 */
export function buildChainLookup(vault: string): ChainLookup {
  const index = new Map<string, ChainLookupEntry>();
  const root = join(vault, BRAIN_ROOT_REL);
  if (existsSync(root)) walk(root, index);
  return (link: string): ChainLookupEntry | null => index.get(normalizeChainLink(link)) ?? null;
}

function walk(dir: string, index: Map<string, ChainLookupEntry>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      walk(full, index);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    let meta: FrontmatterMap;
    try {
      [meta] = parseFrontmatter(full);
    } catch {
      continue;
    }
    const id = normalizeChainLink(entry.name);
    const supersededBy = scalar(meta, SUPERSEDED_BY_KEY);
    index.set(id, { supersededBy });
  }
}

/**
 * Convenience: resolve a chain tip against the live vault. Builds the
 * lookup from disk on each call - callers that resolve many tips in one
 * pass should reuse a {@link buildChainLookup} result via
 * {@link resolveChainTip} directly.
 */
export function resolveChainTipInVault(
  vault: string,
  start: string,
  opts: { readonly maxDepth?: number } = {},
): ResolveChainTipResult {
  return resolveChainTip(start, buildChainLookup(vault), opts);
}

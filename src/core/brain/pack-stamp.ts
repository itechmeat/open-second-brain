/**
 * Provenance stamp and validity window for a context pack
 * (context-integrity-gates, Unit B).
 *
 * A context pack is computed fresh per call and, until now, recorded
 * nothing about the vault state it was derived from. The moment one is
 * PERSISTED - which the anticipatory cache does - a stale pack becomes
 * indistinguishable from a fresh one, and the agent cannot tell a
 * genuine miss from a broken mechanism. This module is the pack's answer
 * to "what was I built from", expressed in the shared vocabulary of
 * `integrity/stamp.ts`.
 *
 * ## Why two tokens, not one
 *
 * `corpus_generation` alone is a LAGGING proxy. `packContext` never
 * reads the search index - it walks the filesystem directly - so a
 * hand-edited memory changes the pack without bumping `index_revision`,
 * and the generation string would still compare equal. Pairing it with a
 * digest over the directories the pack actually walks closes that gap:
 *
 *   - `corpus_generation` observes the index identity that ranking and
 *     semantic recall depend on (model, dimension, schema, revision);
 *   - `brain_tree` observes the bytes the pack itself reads, via path,
 *     mtime and size.
 *
 * `brain_tree` covers the preference and retired directories AND
 * `Brain/_brain.yaml`. The config is not a memory, but `packContext`
 * reads it and its `untrusted_source_delimiting` flag changes the bodies
 * the pack emits - so a pack built before that flag flipped would
 * otherwise compare equal to the vault state after it, which is exactly
 * the staleness this stamp exists to name.
 *
 * `buildManifest` was considered for the second role and rejected: it
 * sha256-hashes every file on every call, which is not affordable on a
 * hook-driven path. Path + mtime + size is.
 *
 * ## A vault with no search index
 *
 * `corpus_generation` is `null` there, and `null` means UNRECORDED - not
 * "matches anything". Two unrecorded sides are not a finding (that is
 * `stamp.ts`'s contract, and it is what lets an index-less vault work at
 * all), so on such a vault `brain_tree` carries the whole load. The
 * moment an index appears or disappears the token moves between `null`
 * and a string, and the comparison names `corpus_generation` explicitly
 * rather than silently agreeing.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import { compareStamps, formatStampMismatch, type StampTokens } from "../integrity/stamp.ts";
import { vaultRelative } from "../path-safety.ts";
import { resolveSearchConfig } from "../search/index.ts";
import { peekCorpusGenerationSync } from "../search/store.ts";
import { defaultConfigPath } from "../config.ts";
import { brainConfigPath, brainDirs } from "./paths.ts";
import { loadIntegrityConfigSafe } from "./policy.ts";
import { listPreferenceFiles } from "./preferences-collect.ts";

/**
 * The stamp's field names. Caller-owned by `stamp.ts`'s contract, so
 * they are named once here and reused by every consumer rather than
 * respelled at each comparison site.
 */
export const PACK_STAMP_FIELD = Object.freeze({
  /** Index identity: embedding model, dimension, schema, revision. */
  corpusGeneration: "corpus_generation",
  /** Digest over the Brain files the pack walks. */
  brainTree: "brain_tree",
} as const);

/** Bytes of the digest kept, in hex characters. */
const BRAIN_TREE_DIGEST_CHARS = 16;

/** Field separator inside one digested line; never valid in a path. */
const DIGEST_FIELD_SEP = "\0";

/**
 * Recorded for a file whose `stat` failed. A distinct RECORDED value,
 * not an omission: a memory that becomes unreadable is a change to the
 * tree the pack walks, and must move the digest.
 */
const UNSTATTABLE = "-1";

/** What a pack was derived from, and how long it stays servable. */
export interface ContextPackStamp {
  /** Tokens identifying the vault state at build time. */
  readonly tokens: StampTokens;
  /** ISO instant the pack was built. */
  readonly generatedAt: string;
  /** ISO instant past which the pack is refused regardless of drift. */
  readonly expiresAt: string;
}

/**
 * Digest over the Brain files a pack walks: `collectCandidates` reads
 * the preferences and retired directories, and this reuses the very same
 * listing helper, so the digest can never cover a different file set
 * than the pack does.
 *
 * Lines are sorted before hashing because `readdirSync` order is not
 * guaranteed stable across filesystems, and an unstable digest would
 * invalidate every cache entry at random.
 */
function brainTreeToken(vault: string): string {
  const dirs = brainDirs(vault);
  const lines: string[] = [];
  for (const dir of [dirs.preferences, dirs.retired]) {
    for (const file of listPreferenceFiles(dir)) {
      lines.push(digestLine(vault, file.path));
    }
  }
  // The config the pack reads. Always digested, present or not: an
  // ABSENT config is a state, and creating one must move the token.
  lines.push(digestLine(vault, brainConfigPath(vault)));
  lines.sort();
  return createHash("sha256")
    .update(lines.join("\n"))
    .digest("hex")
    .slice(0, BRAIN_TREE_DIGEST_CHARS);
}

/**
 * One digested line: vault-relative path, mtime, size. A path that
 * cannot be stat'ed - absent, or unreadable - records {@link UNSTATTABLE}
 * for both, which is a value and not an omission, so the file appearing
 * or disappearing moves the digest.
 */
function digestLine(vault: string, path: string): string {
  let mtime = UNSTATTABLE;
  let size = UNSTATTABLE;
  try {
    const stat = statSync(path);
    mtime = String(Math.trunc(stat.mtimeMs));
    size = String(stat.size);
  } catch {
    /* recorded as UNSTATTABLE above - a state, not an omission */
  }
  return [vaultRelative(path, vault), mtime, size].join(DIGEST_FIELD_SEP);
}

/**
 * Recorded when the index file EXISTS but cannot be opened or queried.
 *
 * A distinct recorded value, not `null`. `null` means unrecorded, and
 * two unrecorded sides are not a finding by `stamp.ts`'s contract - so
 * folding a corrupt index onto "no index" would make a pack stamped
 * before the corruption compare EQUAL to one validated after it. The
 * sentinel keeps the two states apart and makes the repair itself a
 * named drift.
 */
export const CORPUS_GENERATION_UNREADABLE = "index-unreadable";

export interface PackStampSourceOptions {
  /**
   * Config file to resolve the index location through. Defaults to the
   * process's own config path; passed explicitly by callers that have
   * one, and by tests, which must not read the operator's.
   */
  readonly configPath?: string;
}

/**
 * Index path as the search layer itself resolves it, so the stamp
 * observes the database `search()` would read.
 *
 * This goes through `resolveSearchConfig`, not the env variable alone.
 * The env-only form missed the config-file `search_db_path` key, so on a
 * vault configured that way the stamp peeked at a database that was not
 * there: `corpus_generation` read `null` on both the stamping and the
 * validating side, "two unrecorded sides are not a finding" applied, and
 * half the pack stamp was permanently inert while claiming otherwise.
 */
function packIndexPath(vault: string, configPath: string | undefined): string {
  return resolveSearchConfig({ vault, configPath: configPath ?? defaultConfigPath() }).dbPath;
}

/** The live tokens for `vault`, right now. */
export function packStampTokens(vault: string, opts: PackStampSourceOptions = {}): StampTokens {
  const peek = peekCorpusGenerationSync(packIndexPath(vault, opts.configPath));
  const corpusGeneration =
    peek.kind === "read"
      ? peek.value
      : peek.kind === "unreadable"
        ? CORPUS_GENERATION_UNREADABLE
        : null;
  return Object.freeze({
    [PACK_STAMP_FIELD.corpusGeneration]: corpusGeneration,
    [PACK_STAMP_FIELD.brainTree]: brainTreeToken(vault),
  });
}

/**
 * Stamp a pack built at `now`, with the validity window from
 * `integrity.pack_validity_seconds`.
 *
 * The config load is the SAFE form for the same reason every other
 * delivery-path read uses it: a pack must keep working on a vault that
 * has never run `o2b brain init`, and an unreadable config is not a
 * reason to change what the pack returns.
 */
export function buildPackStamp(
  vault: string,
  now: Date,
  opts: PackStampSourceOptions = {},
): ContextPackStamp {
  const validitySeconds = loadIntegrityConfigSafe(vault).pack_validity_seconds;
  return Object.freeze({
    tokens: packStampTokens(vault, opts),
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + validitySeconds * 1_000).toISOString(),
  });
}

/**
 * Why a stamped pack must not be served, or `null` when it may be.
 *
 * The window is checked first and unconditionally: it is the backstop
 * for the changes a token cannot observe, so an expired pack is refused
 * even when every token still matches. An unparseable expiry is refused
 * too - a validity window that cannot be read is not a valid one.
 *
 * The gate is binary here, with no `off` mode, and deliberately: a pack
 * whose stamp no longer matches IS stale, which is unambiguous. Only the
 * two units whose condition is environment-dependent take a mode.
 */
export function packStampRefusal(
  recorded: ContextPackStamp,
  live: StampTokens,
  now: Date,
): string | null {
  const expiresMs = Date.parse(recorded.expiresAt);
  if (!Number.isFinite(expiresMs) || now.getTime() >= expiresMs) {
    return `pack validity window expired at ${recorded.expiresAt} (now ${now.toISOString()})`;
  }
  const drift = compareStamps(recorded.tokens, live);
  if (drift.length === 0) return null;
  return `source stamp drifted: ${drift.map(formatStampMismatch).join("; ")}`;
}

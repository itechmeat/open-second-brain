/**
 * Helpers for building short-lived vault directories for search tests.
 */

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  classifyVaultIgnoreRule,
  DEFAULT_VAULT_IGNORE_PATHS,
  type VaultIgnoreRule,
} from "../../src/core/vault-scope/defaults.ts";
import type { ResolvedSearchConfig, ResolvedEmbeddingConfig } from "../../src/core/search/types.ts";

export function createTempVault(prefix: string): {
  vault: string;
  dbPath: string;
  cleanup: () => void;
} {
  const vault = mkdtempSync(join(tmpdir(), `osb-${prefix}-`));
  const dbPath = join(vault, ".open-second-brain", "brain.sqlite");
  return {
    vault,
    dbPath,
    cleanup: () => rmSync(vault, { recursive: true, force: true }),
  };
}

export function writeMd(vault: string, relPath: string, content: string): string {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

export function writeSymlink(vault: string, relLink: string, absTarget: string): string {
  const abs = join(vault, relLink);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(absTarget, abs);
  return abs;
}

export function makeConfig(opts: {
  vault: string;
  dbPath: string;
  /**
   * Optional terse shortcut: when provided, each string is classified
   * into a `VaultIgnoreRule` (kind `path` if it contains `/`, else
   * `name`). When omitted, the shared default rule set is used.
   */
  ignorePaths?: ReadonlyArray<string>;
  semantic?: Partial<ResolvedEmbeddingConfig>;
  /** MMR tradeoff; defaults to 0.7. Pass 1 to disable diversification. */
  mmrLambda?: number;
  /** Link-graph traversal depth; defaults to 1. Pass 0 to disable. */
  maxHops?: number;
  /** Query-intent reweighting; defaults to true. */
  intentEnabled?: boolean;
  /** Synonym / query expansion; defaults to false (opt-in). */
  synonymEnabled?: boolean;
  /** Persistent query cache; defaults to false (opt-in). */
  cacheEnabled?: boolean;
  /** Relation-aware recall polarity; defaults to true. */
  relationPolarityEnabled?: boolean;
  /** Learned recall weights from feedback; defaults to false (opt-in). */
  learnedWeightsEnabled?: boolean;
}): ResolvedSearchConfig {
  const baseSemantic: ResolvedEmbeddingConfig = Object.freeze({
    enabled: false,
    provider: "openai-compat",
    baseUrl: null,
    model: null,
    apiKey: null,
    dimension: null,
    timeoutMs: 10_000,
    concurrency: 4,
    batchSize: 32,
    costGateUsd: 0,
  });
  const semantic: ResolvedEmbeddingConfig = Object.freeze({
    ...baseSemantic,
    ...opts.semantic,
  });
  const paths = opts.ignorePaths ?? DEFAULT_VAULT_IGNORE_PATHS;
  const ignoreRules: ReadonlyArray<VaultIgnoreRule> = Object.freeze(
    paths.map(classifyVaultIgnoreRule),
  );
  return Object.freeze({
    vault: opts.vault,
    dbPath: opts.dbPath,
    ignoreRules,
    chunkSize: 800,
    chunkOverlap: 100,
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    fusionMode: "linear" as const,
    rrfK: 60,
    semantic,
    recall: Object.freeze({
      mmrLambda: opts.mmrLambda ?? 0.7,
      maxHops: opts.maxHops ?? 1,
      hopDecay: 0.5,
      maxExpansionPerHit: 3,
      recencyShape: 0.8,
      recencyScale: 30,
      recencyAmplitude: 0.05,
      intentEnabled: opts.intentEnabled ?? true,
      synonymEnabled: opts.synonymEnabled ?? false,
      synonymMaxTerms: 3,
      cacheEnabled: opts.cacheEnabled ?? false,
      cacheTtlSeconds: 300,
      relationPolarityEnabled: opts.relationPolarityEnabled ?? true,
      learnedWeightsEnabled: opts.learnedWeightsEnabled ?? false,
    }),
  });
}

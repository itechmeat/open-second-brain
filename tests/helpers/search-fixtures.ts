/**
 * Helpers for building short-lived vault directories for search tests.
 */

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  ignorePaths?: ReadonlyArray<string>;
  semantic?: Partial<ResolvedEmbeddingConfig>;
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
  });
  const semantic: ResolvedEmbeddingConfig = Object.freeze({ ...baseSemantic, ...(opts.semantic ?? {}) });
  return Object.freeze({
    vault: opts.vault,
    dbPath: opts.dbPath,
    ignorePaths: Object.freeze([
      ...(opts.ignorePaths ?? [
        ".git",
        "node_modules",
        ".open-second-brain",
        ".obsidian/cache",
        ".trash",
        ".stversions",
      ]),
    ]),
    chunkSize: 800,
    chunkOverlap: 100,
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    semantic,
  });
}
